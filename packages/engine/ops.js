// Capa de gestión sobre la simulación: lo que necesitan el dueño, el supervisor y el operario
// además de mover pallets. Observa la simulación con st.onEvent y no cambia cómo se mueven los clarks
// (salvo los ajustes de inventario y el bloqueo de un equipo con checklist en falla, que son intencionales).
//
// - Historia de cada pallet (quién, qué, cuándo)
// - Inventario cíclico: exactitud de stock y ajustes
// - Recepción contra remito: diferencias de cajas, vencimiento corto, lote no declarado
// - Clientes: facturación estimada y plata en riesgo por vencimiento
// - Tablet: PIN, checklist pre-uso, escaneo correcto / equivocado (bloqueo FEFO), problemas
// - Resumen del turno y proyección de ocupación
import { makeRng } from './rng.js';
import { addLog, fmtClock } from './simulation.js';

/** Tarifas y valores de EJEMPLO (en el piloto salen del contrato con cada cliente). */
export const TARIFAS = { almacenajePalletDia: 1900, entradaPallet: 6500, salidaPallet: 6500 };
export const VALOR_CAJA = { Bebidas: 9000, 'Almacén': 14000, 'Lácteos UAT': 11000, Limpieza: 12000, 'Perfumería': 22000, Mascotas: 30000, Bazar: 15000 };
export const PIN_DEMO = '1234';
export const CHECKLIST = ['Frenos y freno de mano', 'Horquillas y cadenas sin daños', 'Batería cargada, sin pérdidas', 'Bocina, baliza y luz azul', 'Sin pérdidas de aceite'];
export const PROBLEMAS = {
  OCUPADA: 'Ubicación ocupada',
  DANADO: 'Pallet dañado (con foto)',
  FALTANTE: 'No está el pallet',
  ETIQUETA: 'Etiqueta ilegible',
};
export const COUNT_PER_HOUR = 30;     // ubicaciones que cuenta un operario de inventario por hora
export const DIFF_RATE = 0.03;        // % de pallets con diferencia física al iniciar (realista: 2–5 %)
export const MIN_VIDA_UTIL = 0.5;     // se acepta mercadería con al menos 50 % de vida útil
const PROVEEDORES = ['Bebidas del Sur SA', 'Molinos Pampa', 'Lácteos La Serena', 'Química Hogar SRL', 'Cosmética Andina', 'Alimentos Patagonia'];
const SAMPLE_EVERY = 600;

export const money = (n) => '$ ' + Math.round(n).toLocaleString('es-AR');
const pct = (v) => (v * 100).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %';

function addMove(ops, palletId, m) {
  if (!ops.ledger.has(palletId)) ops.ledger.set(palletId, []);
  ops.ledger.get(palletId).push(m);
}

export function palletValue(st, p) {
  const sku = st.skuMap.get(p.skuId);
  return (VALOR_CAJA[sku.cat] ?? 12000) * p.qty;
}

export function createOps(st, { seed = 1, diferencias = true } = {}) {
  const rng = makeRng(seed * 7919 + 13); // generador propio: no altera la secuencia de la simulación
  const ops = {
    rng, diferencias,
    ledger: new Map(),
    physical: new Map(),   // palletId → diferencia real que todavía nadie detectó
    lastCount: new Map(),  // locId → t del último conteo
    counted: 0, countedWithDiff: 0, countAcc: 0, countLog: [], adjustments: [],
    trucks: [], truckSeq: 1, openTruck: new Map(), receivingIssues: [],
    clients: new Map(),
    problems: [], fefoOverrides: 0, wrongScans: 0,
    stockHist: [], lastSample: -1,
    lastT: st.t, shiftStart: st.t,
    received: 0, dispatched: 0, relocated: 0,
  };
  for (const c of new Set(st.skus.map((s) => s.client))) ops.clients.set(c, { entradas: 0, salidas: 0, palletDias: 0 });

  for (const p of st.palletMap.values()) {
    const loc = p.locId != null ? st.locations[p.locId] : null;
    addMove(ops, p.id, { t: null, diasAtras: p.receivedDaysAgo, tipo: 'RECEPCION', texto: 'Recibido (registro histórico)', quien: '—' });
    if (loc) addMove(ops, p.id, { t: null, diasAtras: p.receivedDaysAgo, tipo: 'PUTAWAY', texto: `Guardado en ${loc.code}`, quien: '—' });
  }
  // Diferencias físicas que existen y nadie conoce: las va a encontrar el conteo cíclico.
  const stored = rng.shuffle([...st.palletMap.values()].filter((p) => p.locId != null));
  for (const p of stored.slice(0, diferencias ? Math.round(stored.length * DIFF_RATE) : 0)) {
    if (rng() < 0.6 && p.qty > 3) ops.physical.set(p.id, { tipo: 'CAJAS', cajasReales: p.qty - rng.int(1, Math.max(1, Math.floor(p.qty * 0.3))) });
    else ops.physical.set(p.id, { tipo: 'FALTANTE' });
  }
  st.onEvent = (ev) => onEvent(ops, st, ev);
  sampleStock(ops, st, true);
  return ops;
}

function clientOf(st, p) { return st.skuMap.get(p.skuId).client; }

function onEvent(ops, st, ev) {
  const p = ev.pallet;
  if (ev.type === 'RECEPCION') return receive(ops, st, p, ev.dock);
  const who = ev.clark ? `${ev.clark.code} · ${ev.clark.operator}` : '—';
  if (ev.type === 'PUTAWAY') {
    ops.received++; ops.clients.get(clientOf(st, p)).entradas++;
    addMove(ops, p.id, { t: ev.t, tipo: 'PUTAWAY', texto: `Guardado en ${ev.toTxt}`, quien: who });
  } else if (ev.type === 'PICK') {
    ops.dispatched++; ops.clients.get(clientOf(st, p)).salidas++;
    ops.physical.delete(p.id);
    addMove(ops, p.id, { t: ev.t, tipo: 'PICK', texto: `Despachado ${ev.fromTxt} → ${ev.toTxt} · ${ev.task.order}`, quien: who });
  } else if (ev.type === 'REPOSICION') {
    ops.relocated++;
    addMove(ops, p.id, { t: ev.t, tipo: 'REPOSICION', texto: `Reubicado ${ev.fromTxt} → ${ev.toTxt} (slotting)`, quien: who });
  }
}

// ---------- Recepción contra remito ----------
function receive(ops, st, p, dock) {
  const rng = ops.rng;
  let truck = ops.openTruck.get(dock.id);
  if (!truck) {
    truck = {
      id: ops.truckSeq, remito: `0001-${String(48210 + ops.truckSeq * 7).padStart(8, '0')}`,
      proveedor: PROVEEDORES[(ops.truckSeq * 5 + dock.id) % PROVEEDORES.length], dock: dock.code,
      esperado: rng.int(6, 12), recibidos: 0, diferencias: [], llegada: st.t, estado: 'DESCARGANDO',
    };
    ops.truckSeq++;
    ops.openTruck.set(dock.id, truck);
    ops.trucks.unshift(truck);
    if (ops.trucks.length > 12) ops.trucks.length = 12;
  }
  truck.recibidos++;
  const sku = st.skuMap.get(p.skuId);
  const r = ops.diferencias ? rng() : 1;
  let diff = null;
  if (r < 0.03) {
    const faltan = rng.int(2, Math.max(2, Math.floor(p.qty * 0.15)));
    diff = { tipo: 'CAJAS', texto: `Llegaron ${p.qty - faltan} de ${p.qty} cajas` };
    p.qty -= faltan;
  } else if (r < 0.05) {
    p.exp = rng.int(12, Math.max(13, Math.floor(sku.shelfLife * MIN_VIDA_UTIL) - 1));
    diff = { tipo: 'VENCIMIENTO', texto: `Vence en ${p.exp} d (mínimo aceptado ${Math.round(sku.shelfLife * MIN_VIDA_UTIL)} d) · aceptado por supervisor` };
  } else if (r < 0.06) {
    diff = { tipo: 'LOTE', texto: `Lote ${p.lot} no figura en el remito` };
  }
  addMove(ops, p.id, { t: st.t, tipo: 'RECEPCION', texto: `Recibido en muelle ${dock.code} · remito ${truck.remito} (${truck.proveedor})`, quien: 'Recepción' });
  if (diff) {
    const d = { ...diff, t: st.t, lpn: p.lpn, desc: sku.desc, remito: truck.remito };
    truck.diferencias.push(d);
    ops.receivingIssues.unshift(d);
    if (ops.receivingIssues.length > 30) ops.receivingIssues.length = 30;
    addMove(ops, p.id, { t: st.t, tipo: 'DIFERENCIA', texto: diff.texto, quien: 'Recepción' });
    addLog(st, `Remito ${truck.remito}: ${p.lpn} ${diff.texto.toLowerCase()}`, 'warn');
  }
  if (truck.recibidos >= truck.esperado) {
    truck.estado = truck.diferencias.length ? 'CON DIFERENCIAS' : 'OK';
    truck.cierre = st.t;
    ops.openTruck.delete(dock.id);
  }
}

// ---------- Inventario cíclico ----------
const CLASS_RANK = { A: 0, B: 1, C: 2 };
function nextToCount(ops, st) {
  let best = null, bestKey = null;
  for (const loc of st.locations) {
    if (loc.reserved) continue;
    const p = loc.palletId != null ? st.palletMap.get(loc.palletId) : null;
    if (p && st.targetedPallets.has(p.id)) continue; // no contar lo que un clark está por mover
    const last = ops.lastCount.get(loc.id) ?? -Infinity;
    const cls = p ? CLASS_RANK[st.skuMap.get(p.skuId).abc] : 3; // primero lo que más rota
    if (!best || last < bestKey[0] || (last === bestKey[0] && (cls < bestKey[1] || (cls === bestKey[1] && loc.id < best.id)))) {
      best = loc; bestKey = [last, cls];
    }
  }
  return best;
}

export function countLocation(ops, st, loc) {
  ops.counted++;
  ops.lastCount.set(loc.id, st.t);
  const p = loc.palletId != null ? st.palletMap.get(loc.palletId) : null;
  const d = p ? ops.physical.get(p.id) : null;
  let entry = { t: st.t, code: loc.code, ok: true, texto: p ? `${p.lpn} OK` : 'Vacía OK' };
  if (d) {
    ops.countedWithDiff++;
    ops.physical.delete(p.id);
    if (d.tipo === 'CAJAS') {
      const before = p.qty;
      p.qty = d.cajasReales;
      entry = { t: st.t, code: loc.code, ok: false, texto: `${p.lpn}: sistema ${before} cajas, hay ${d.cajasReales} → ajustado` };
      addMove(ops, p.id, { t: st.t, tipo: 'AJUSTE', texto: `Conteo cíclico: ${before} → ${d.cajasReales} cajas`, quien: 'Inventario' });
    } else {
      st.palletMap.delete(p.id);
      loc.palletId = null;
      entry = { t: st.t, code: loc.code, ok: false, texto: `${p.lpn} no está en la ubicación → baja y se investiga` };
      addMove(ops, p.id, { t: st.t, tipo: 'AJUSTE', texto: `Conteo cíclico: no encontrado en ${loc.code}. Baja de stock`, quien: 'Inventario' });
    }
    ops.adjustments.unshift(entry);
    addLog(st, `Conteo cíclico ${loc.code}: ${entry.texto}`, 'warn');
  }
  ops.countLog.unshift(entry);
  if (ops.countLog.length > 30) ops.countLog.length = 30;
  return entry;
}

function sampleStock(ops, st, force) {
  const slot = Math.floor(st.t / SAMPLE_EVERY);
  if (!force && slot === ops.lastSample) return;
  ops.lastSample = slot;
  let occupied = 0;
  for (const l of st.locations) if (l.palletId != null) occupied++;
  ops.stockHist.push({ t: st.t, occupied });
  if (ops.stockHist.length > 200) ops.stockHist.shift();
}

/** Avanza la capa de gestión hasta el reloj actual de la simulación. Llamar después de stepSim. */
export function stepOps(ops, st) {
  const dt = st.t - ops.lastT;
  if (dt <= 0) return;
  ops.lastT = st.t;
  const byClient = new Map();
  for (const p of st.palletMap.values()) if (p.locId != null) { const c = clientOf(st, p); byClient.set(c, (byClient.get(c) || 0) + 1); }
  for (const [c, n] of byClient) ops.clients.get(c).palletDias += (n * dt) / 86400;
  ops.countAcc += (dt * COUNT_PER_HOUR) / 3600;
  while (ops.countAcc >= 1) { ops.countAcc--; const loc = nextToCount(ops, st); if (loc) countLocation(ops, st, loc); }
  sampleStock(ops, st, false);
}

// ---------- Indicadores ----------
export function stockAccuracy(ops) { return ops.counted ? 1 - ops.countedWithDiff / ops.counted : null; }

export function clientReport(ops, st) {
  const hours = Math.max(0.25, (st.t - ops.shiftStart) / 3600);
  const rows = [...ops.clients.keys()].map((name) => ({ name, pallets: 0, riesgo: 0, riesgoPallets: 0 }));
  const idx = new Map(rows.map((r) => [r.name, r]));
  for (const p of st.palletMap.values()) {
    if (p.locId == null) continue;
    const r = idx.get(clientOf(st, p));
    r.pallets++;
    if (p.exp <= 30) { r.riesgo += palletValue(st, p); r.riesgoPallets++; }
  }
  for (const r of rows) {
    const c = ops.clients.get(r.name);
    r.entradas = c.entradas; r.salidas = c.salidas;
    r.hoy = c.palletDias * TARIFAS.almacenajePalletDia + c.entradas * TARIFAS.entradaPallet + c.salidas * TARIFAS.salidaPallet;
    const movPorTurno = ((c.entradas * TARIFAS.entradaPallet + c.salidas * TARIFAS.salidaPallet) / hours) * 8;
    r.mes = r.pallets * 30 * TARIFAS.almacenajePalletDia + movPorTurno * 26; // 30 días de almacenaje, 26 turnos
  }
  return rows;
}

export function occupancyProjection(ops, st) {
  const total = st.locations.length;
  const h = ops.stockHist;
  const now = h[h.length - 1];
  // la muestra más vieja dentro de las últimas 2 h, o la anterior a esa ventana si es lo único que hay
  let i = h.findIndex((s) => s.t >= now.t - 2 * 3600);
  if (i > 0 && now.t - h[i].t < 1800) i--;
  const from = h[Math.max(0, i)];
  const hours = (now.t - from.t) / 3600;
  if (hours < 0.5) return { estado: 'MIDIENDO', occupied: now.occupied, total };
  const perShift = ((now.occupied - from.occupied) / hours) * 8;
  const limit = Math.floor(total * 0.9);
  if (perShift <= 1) return { estado: 'ESTABLE', perShift, occupied: now.occupied, total };
  return { estado: 'CRECE', perShift, occupied: now.occupied, total, turnosHasta90: Math.max(0, (limit - now.occupied) / perShift) };
}

// ---------- Tablet del clark ----------
export function checkPin(pin) { return pin === PIN_DEMO; }

/** Checklist pre-uso: con cualquier falla el equipo queda bloqueado y se avisa al supervisor. */
export function submitChecklist(ops, st, c, fallas) {
  if (!fallas.length) { addLog(st, `${c.code} · ${c.operator}: checklist OK, inicia turno`, 'info'); return { ok: true }; }
  c.blocked = true;
  ops.problems.unshift({ t: st.t, clark: c.code, tipo: 'CHECKLIST', texto: `Equipo bloqueado: ${fallas.join(', ')}` });
  addLog(st, `⛔ ${c.code} bloqueado por checklist: ${fallas.join(', ')}. Avisado al supervisor`, 'warn');
  return { ok: false };
}
export function unblock(ops, st, c) {
  c.blocked = false;
  addLog(st, `${c.code}: supervisor revisó el equipo y lo habilitó`, 'info');
}

export function reportProblem(ops, st, c, tipo) {
  const t = c.task;
  const where = t ? (c.phase === 'toFrom' || c.phase === 'handle1' ? t.from : t.to) : null;
  const code = where ? (where.kind === 'loc' ? st.locations[where.id].code : 'Muelle ' + st.docks[where.id].code) : '—';
  const pr = { t: st.t, clark: c.code, tipo, texto: `${PROBLEMAS[tipo]} en ${code}` };
  ops.problems.unshift(pr);
  addLog(st, `⚠ ${c.code} reportó: ${pr.texto}`, 'warn');
  return pr;
}

/**
 * Simula lo que pasa al escanear. `correcto=false` arma un error realista:
 * al tomar, un pallet del mismo SKU que vence después (bloqueo FEFO) o un pallet de otro producto;
 * al dejar, una ubicación distinta a la indicada.
 */
export function simulateScan(ops, st, c, correcto) {
  const t = c.task;
  if (!t) return { ok: false, titulo: 'Sin tarea', texto: 'No hay nada para escanear todavía.' };
  const taking = c.phase === 'toFrom' || c.phase === 'handle1';
  const p = st.palletMap.get(t.palletId) || c.carrying;
  const sku = st.skuMap.get(p.skuId);
  const target = taking ? t.from : t.to;
  const targetTxt = target.kind === 'loc' ? st.locations[target.id].code : 'MUELLE ' + st.docks[target.id].code;
  if (correcto) return { ok: true, titulo: '✓ Correcto', texto: taking ? `${p.lpn} · ${sku.desc} · lote ${p.lot}` : `Destino ${targetTxt} confirmado` };
  ops.wrongScans++;
  if (taking) {
    const later = [...st.palletMap.values()].filter((q) => q.skuId === p.skuId && q.id !== p.id && q.locId != null && q.exp > p.exp)
      .sort((a, b) => a.exp - b.exp)[0];
    if (later && t.type === 'PICK') {
      return {
        ok: false, fefo: true, titulo: '✋ No respeta FEFO',
        texto: `Escaneaste ${later.lpn} (vence en ${later.exp} d). Primero sale ${p.lpn} en ${targetTxt}, que vence en ${p.exp} d.`,
        wrong: later.lpn,
      };
    }
    const other = [...st.palletMap.values()].find((q) => q.skuId !== p.skuId && q.locId != null);
    return { ok: false, titulo: '✗ Pallet equivocado', texto: `Escaneaste ${other.lpn} (${st.skuMap.get(other.skuId).desc}). Buscá ${p.lpn} en ${targetTxt}.`, wrong: other.lpn };
  }
  const near = target.kind === 'loc' ? st.locations[Math.min(st.locations.length - 1, target.id + 4)].code : 'MUELLE D9';
  return { ok: false, titulo: '✗ Ubicación equivocada', texto: `Escaneaste ${near}. El pallet va en ${targetTxt}.` };
}

export function authorizeFefo(ops, st, c, wrongLpn) {
  ops.fefoOverrides++;
  addLog(st, `Supervisor autorizó a ${c.code} despachar ${wrongLpn} fuera de FEFO (queda registrado)`, 'warn');
}

// ---------- Resumen del turno para el dueño ----------
export function shiftSummary(ops, st, whName = 'Depósito') {
  const acc = stockAccuracy(ops);
  const clients = clientReport(ops, st);
  const riesgo = clients.reduce((s, r) => s + r.riesgo, 0);
  const riesgoPallets = clients.reduce((s, r) => s + r.riesgoPallets, 0);
  const facturado = clients.reduce((s, r) => s + r.hoy, 0);
  const proj = occupancyProjection(ops, st);
  const recDiffs = ops.receivingIssues.length;
  const blocked = st.clarks.filter((c) => c.blocked).length;
  const lines = [
    `*${whName} · resumen ${fmtClock(ops.shiftStart)}–${fmtClock(st.t)}*`,
    `📥 Entraron ${ops.received} pallets · 📤 salieron ${ops.dispatched}`,
    `🎯 Exactitud de stock: ${acc == null ? 'sin conteos aún' : pct(acc)} (${ops.counted} ubicaciones contadas, ${ops.countedWithDiff} con diferencia)`,
    `⏳ Por vencer (<30 d): ${riesgoPallets} pallets · ${money(riesgo)}`,
    `🧾 Facturación del día (estimada): ${money(facturado)}`,
    `📦 Ocupación ${pct(proj.occupied / proj.total)}` + (proj.estado === 'CRECE' ? ` · al 90 % en ~${Math.ceil(proj.turnosHasta90)} turnos` : proj.estado === 'ESTABLE' ? ' · estable' : ''),
    `⚠ Problemas: ${ops.problems.length} reportados · ${recDiffs} diferencias en recepción` + (blocked ? ` · ${blocked} equipo(s) bloqueado(s)` : ''),
  ];
  return { acc, riesgo, riesgoPallets, facturado, proj, text: lines.join('\n') };
}

/** Historia de un pallet, de la más reciente a la más vieja. */
export function palletHistory(ops, palletId) { return [...(ops.ledger.get(palletId) || [])].reverse(); }
