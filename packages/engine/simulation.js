import { makeRng } from './rng.js';
import { L, routePath, pathLength } from './layout.js';
import { computeThresholds, travelIndex, choosePutawayLocation, computeSuggestions, WORK_DAYS_PER_MONTH } from './slotting.js';

const OPERATORS = ['Marcos', 'Lucía', 'Diego', 'Romina', 'Julián', 'Sofía', 'Nahuel', 'Carla'];
const CLARK_COLORS = ['#38bdf8', '#f472b6', '#facc15', '#a78bfa', '#34d399', '#fb923c', '#60a5fa', '#e879f9'];

const SPEED_EMPTY = 2.4;   // m/s
const SPEED_LOADED = 1.9;  // m/s
export const HANDLE_BASE = 26;     // s para tomar/dejar un pallet (escaneo incluido)
export const HANDLE_LEVEL = 8;     // s extra por nivel (subir y bajar la torre)

export function createSim(data, opts = {}) {
  const st = {
    ...data,
    rng: makeRng(opts.seed ?? 7),
    t0: 8 * 3600, t: 8 * 3600,
    smart: false,
    tasks: [], taskSeq: 1, palletSeq: data.pallets.length + 1,
    log: [], suggestions: [],
    targetedPallets: new Set(),
    pickMeters: [], taskTimes: [],
    done: 0, picks: 0, putaways: 0, moves: 0,
    history: [], lastHistT: -1, lastSuggT: -1e9,
  };
  st.palletMap = new Map(data.pallets.map((p) => [p.id, p]));
  st.skuMap = new Map(data.skus.map((s) => [s.id, s]));
  const n = opts.clarks ?? 5;
  st.clarks = Array.from({ length: n }, (_, i) => {
    const y = L.margin + ((i + 0.5) * (L.H - 2 * L.margin)) / n;
    return {
      id: i + 1, code: `CLK-${String(i + 1).padStart(2, '0')}`, operator: OPERATORS[i % OPERATORS.length],
      color: CLARK_COLORS[i % CLARK_COLORS.length],
      x: L.mainX, y, aisle: -1, heading: Math.PI,
      phase: 'idle', path: [], wait: 0, task: null, carrying: null,
      meters: 0, tasksDone: 0, busy: 0,
    };
  });
  computeThresholds(st);
  st.baselineIndex = travelIndex(st);
  recordHistory(st, true);
  addLog(st, 'Turno iniciado · ' + n + ' clarks en operación', 'info');
  return st;
}

export function setSmart(st, on) {
  st.smart = on;
  if (on) {
    computeSuggestions(st);
    addLog(st, `Slotting inteligente ACTIVADO · ${st.suggestions.length} reubicaciones sugeridas`, 'smart');
  } else {
    // cancelar reubicaciones pendientes
    st.tasks = st.tasks.filter((t) => {
      if (t.type === 'REPOSICION' && t.state === 'PENDIENTE') { releaseTask(st, t); return false; }
      return true;
    });
    addLog(st, 'Slotting inteligente desactivado', 'info');
  }
}

// Gancho opcional para módulos que observan la operación (historia de pallets, facturación, recepción).
// No altera la simulación: si nadie escucha, no hace nada.
function emit(st, ev) { if (st.onEvent) st.onEvent({ t: st.t, ...ev }); }

export function addLog(st, text, type = 'info') {
  st.log.unshift({ t: st.t, text, type });
  if (st.log.length > 80) st.log.length = 80;
}

function pointOf(st, ref) {
  if (ref.kind === 'loc') return st.locations[ref.id].access;
  return st.docks[ref.id].node;
}

function releaseTask(st, t) {
  if (t.to.kind === 'loc') st.locations[t.to.id].reserved = false;
  if (t.palletId) st.targetedPallets.delete(t.palletId);
}

function newTask(st, fields) {
  const t = { id: st.taskSeq++, state: 'PENDIENTE', created: st.t, ...fields };
  st.tasks.push(t);
  return t;
}

function pickableBySku(st) {
  const m = new Map();
  for (const p of st.palletMap.values()) {
    if (p.locId == null || p.status === 'CUARENTENA' || st.targetedPallets.has(p.id)) continue;
    if (!m.has(p.skuId)) m.set(p.skuId, []);
    m.get(p.skuId).push(p);
  }
  return m;
}

function generateTask(st) {
  const rng = st.rng;
  const outDocks = st.docks.filter((d) => d.kind === 'SALIDA');
  const inDocks = st.docks.filter((d) => d.kind === 'ENTRADA');

  // 1) Reubicaciones del motor de slotting
  if (st.smart && rng() < 0.42) {
    if (!st.suggestions.length && st.t - st.lastSuggT > 120) { computeSuggestions(st); st.lastSuggT = st.t; }
    while (st.suggestions.length) {
      const s = st.suggestions.shift();
      const p = st.palletMap.get(s.palletId);
      const to = st.locations[s.toId];
      if (!p || p.locId !== s.fromId || st.targetedPallets.has(p.id) || to.palletId != null || to.reserved) continue;
      to.reserved = true; st.targetedPallets.add(p.id);
      return newTask(st, { type: 'REPOSICION', palletId: p.id, from: { kind: 'loc', id: s.fromId }, to: { kind: 'loc', id: s.toId }, savings: s.savings, subkind: s.kind });
    }
  }

  // 2) Picking vs. recepción: se balancea para mantener el stock cerca de 300 pallets
  const stock = st.palletMap.size;
  const pPick = Math.max(0.2, Math.min(0.8, 0.5 + (stock - 300) / 40));
  if (rng() < pPick) {
    const bySku = pickableBySku(st);
    const skus = [...bySku.keys()].map((id) => st.skuMap.get(id));
    if (skus.length) {
      const sku = rng.weighted(skus, (s) => s.ppd + 0.05);
      const fefo = bySku.get(sku.id).sort((a, b) => a.exp - b.exp)[0]; // FEFO: primero lo que vence antes
      st.targetedPallets.add(fefo.id);
      const dock = rng.pick(outDocks);
      return newTask(st, { type: 'PICK', palletId: fefo.id, from: { kind: 'loc', id: fefo.locId }, to: { kind: 'dock', id: dock.id }, order: `PED-${String(48000 + st.taskSeq)}` });
    }
  }
  // Recepción + putaway
  const sku = rng.weighted(st.skus, (s) => s.ppd + 0.05);
  const loc = choosePutawayLocation(st, sku, st.smart);
  if (!loc) return null;
  loc.reserved = true;
  const id = st.palletSeq++;
  const p = {
    id, lpn: `LPN-${String(id).padStart(6, '0')}`, skuId: sku.id,
    lot: `L${String(26000 + rng.int(100, 999))}-${String.fromCharCode(65 + rng.int(0, 7))}`,
    exp: Math.round(sku.shelfLife * rng.range(0.75, 0.98)), qty: sku.casesPerPallet,
    status: 'DISPONIBLE', locId: null, receivedDaysAgo: 0, inbound: true,
  };
  st.palletMap.set(id, p);
  st.targetedPallets.add(id);
  const dock = rng.pick(inDocks);
  const task = newTask(st, { type: 'PUTAWAY', palletId: id, from: { kind: 'dock', id: dock.id }, to: { kind: 'loc', id: loc.id } });
  emit(st, { type: 'RECEPCION', task, pallet: p, dock });
  return task;
}

function assign(st, c) {
  const pending = st.tasks.filter((t) => t.state === 'PENDIENTE');
  if (!pending.length) return;
  let best = null, bestCost = Infinity;
  for (const t of pending) {
    const age = st.t - t.created;
    const cost = pathLength(c, routePath(c, pointOf(st, t.from))) - age * 0.15 - (t.type === 'PICK' ? 6 : 0);
    if (cost < bestCost) { bestCost = cost; best = t; }
  }
  best.state = 'EN_CURSO'; best.clarkId = c.id; best.started = st.t; best.meters = 0;
  c.task = best; c.phase = 'toFrom';
  c.path = routePath(c, pointOf(st, best.from));
}

function levelOf(st, ref) { return ref.kind === 'loc' ? st.locations[ref.id].level : 0; }

function finishHandle(st, c) {
  const t = c.task;
  const p = st.palletMap.get(t.palletId);
  if (c.phase === 'handle1') {
    if (t.from.kind === 'loc') { const loc = st.locations[t.from.id]; loc.palletId = null; p.locId = null; }
    c.carrying = p;
    c.phase = 'toTo';
    c.path = routePath(c, pointOf(st, t.to));
    return;
  }
  // handle2: dejar el pallet
  c.carrying = null;
  st.targetedPallets.delete(p.id);
  const sku = st.skuMap.get(p.skuId);
  if (t.to.kind === 'loc') {
    const loc = st.locations[t.to.id];
    loc.palletId = p.id; loc.reserved = false; p.locId = loc.id; p.inbound = false;
  } else {
    st.palletMap.delete(p.id); // despachado
  }
  const dur = st.t - t.started;
  t.state = 'COMPLETADA'; t.done = st.t;
  st.done++; c.tasksDone++;
  st.taskTimes.push(dur); if (st.taskTimes.length > 40) st.taskTimes.shift();
  const fromTxt = t.from.kind === 'loc' ? st.locations[t.from.id].code : 'Muelle ' + st.docks[t.from.id].code;
  const toTxt = t.to.kind === 'loc' ? st.locations[t.to.id].code : 'Muelle ' + st.docks[t.to.id].code;
  if (t.type === 'PICK') {
    st.picks++;
    st.pickMeters.push(t.meters); if (st.pickMeters.length > 30) st.pickMeters.shift();
    addLog(st, `${c.code} despachó ${p.lpn} · ${sku.desc} (${sku.abc}) ${fromTxt} → ${toTxt} · ${Math.round(t.meters)} m`, 'pick');
  } else if (t.type === 'PUTAWAY') {
    st.putaways++;
    addLog(st, `${c.code} guardó ${p.lpn} · ${sku.desc} (${sku.abc}) en ${toTxt}`, 'putaway');
  } else {
    st.moves++;
    addLog(st, `${c.code} reubicó ${p.lpn} (${sku.abc}) ${fromTxt} → ${toTxt}` + (t.savings ? ` · ahorra ~${t.savings} m/mes` : ''), 'smart');
  }
  emit(st, { type: t.type, task: t, pallet: p, clark: c, fromTxt, toTxt });
  st.tasks = st.tasks.filter((x) => x !== t);
  c.task = null; c.phase = 'idle';
}

function moveClark(c, dt) {
  const v = c.carrying ? SPEED_LOADED : SPEED_EMPTY;
  let budget = v * dt;
  while (budget > 0 && c.path.length) {
    const tgt = c.path[0];
    const dx = tgt.x - c.x, dy = tgt.y - c.y;
    const d = Math.hypot(dx, dy);
    if (d > 0.001) c.heading = Math.atan2(dy, dx);
    if (d <= budget) {
      c.x = tgt.x; c.y = tgt.y; budget -= d; c.path.shift();
      c.meters += d; if (c.task) c.task.meters += d;
    } else {
      c.x += (dx / d) * budget; c.y += (dy / d) * budget;
      c.meters += budget; if (c.task) c.task.meters += budget;
      budget = 0;
    }
  }
  return c.path.length === 0;
}

function stepClark(st, c, dt) {
  if (c.blocked) return; // equipo bloqueado (checklist de seguridad con falla)
  if (c.phase === 'idle') { assign(st, c); if (c.phase === 'idle') return; }
  c.busy += dt;
  if (c.phase === 'toFrom' || c.phase === 'toTo') {
    if (moveClark(c, dt)) {
      const ref = c.phase === 'toFrom' ? c.task.from : c.task.to;
      c.aisle = ref.kind === 'loc' ? st.locations[ref.id].aisle : -1;
      c.wait = HANDLE_BASE + levelOf(st, ref) * HANDLE_LEVEL;
      c.phase = c.phase === 'toFrom' ? 'handle1' : 'handle2';
    }
    return;
  }
  c.wait -= dt;
  if (c.wait <= 0) finishHandle(st, c);
}

function recordHistory(st, force) {
  const slot = Math.floor((st.t - st.t0) / 120);
  if (!force && slot === st.lastHistT) return;
  st.lastHistT = slot;
  st.history.push({ t: st.t, index: travelIndex(st) });
  if (st.history.length > 240) st.history.shift();
}

export function stepSim(st, simSeconds) {
  let remaining = simSeconds;
  while (remaining > 0) {
    const dt = Math.min(0.5, remaining);
    remaining -= dt;
    st.t += dt;
    const pending = st.tasks.filter((t) => t.state === 'PENDIENTE').length;
    for (let k = pending; k < st.clarks.length + 2; k++) if (!generateTask(st)) break;
    for (const c of st.clarks) stepClark(st, c, dt);
    if (Math.floor(st.t) % 60 === 0) computeThresholds(st);
    recordHistory(st, false);
  }
}

export function getKpis(st) {
  const locs = st.locations.length;
  let occupied = 0;
  for (const l of st.locations) if (l.palletId != null) occupied++;
  const byClass = { A: 0, B: 0, C: 0 };
  const expiring = [];
  for (const p of st.palletMap.values()) {
    const sku = st.skuMap.get(p.skuId);
    byClass[sku.abc]++;
    if (p.locId != null && p.exp <= 30) expiring.push({ p, sku, loc: st.locations[p.locId] });
  }
  expiring.sort((a, b) => a.p.exp - b.p.exp);
  const index = travelIndex(st);
  const delta = st.baselineIndex ? (index - st.baselineIndex) / st.baselineIndex : 0;
  const totalPpd = st.skus.reduce((s, k) => s + k.ppd, 0);
  const metersSavedMonth = Math.max(0, (st.baselineIndex - index) * totalPpd * WORK_DAYS_PER_MONTH);
  const hours = (st.t - st.t0) / 3600;
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return {
    locations: locs, occupied, occupancy: occupied / locs,
    stock: st.palletMap.size, byClass,
    index, baseline: st.baselineIndex, delta,
    metersSavedMonth, hoursSavedMonth: metersSavedMonth / ((SPEED_EMPTY + SPEED_LOADED) / 2) / 3600,
    avgPickMeters: avg(st.pickMeters), avgTaskSeconds: avg(st.taskTimes),
    done: st.done, picks: st.picks, putaways: st.putaways, moves: st.moves,
    palletsPerHour: hours > 0.01 ? st.done / hours : 0,
    expiring, pending: st.tasks.filter((t) => t.state === 'PENDIENTE').length,
    suggestions: st.suggestions.length,
    clarks: st.clarks.map((c) => ({
      c, perHour: hours > 0.01 ? c.tasksDone / hours : 0,
      utilization: st.t > st.t0 ? c.busy / (st.t - st.t0) : 0,
    })),
  };
}

export function fmtClock(t) {
  const h = Math.floor(t / 3600) % 24, m = Math.floor((t % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
