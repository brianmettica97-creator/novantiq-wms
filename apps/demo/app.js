import { generateMockData } from '../../packages/engine/mockdata.js';
import { createSim, stepSim, getKpis, setSmart, fmtClock } from '../../packages/engine/simulation.js';
import { createView, drawMap, hitTest, drawSparkline, MODES, PALETTE, toWorld, updateTransform } from '../../packages/engine/renderer.js';
import { zoneOf } from '../../packages/engine/slotting.js';
import { createView3D } from './view3d.js';
import { createTour } from './tour.js';
import { routePath, pathLength, AISLE_LETTERS } from '../../packages/engine/layout.js';
import { CAP, rackLoad, weightOf, capacityReport } from '../../packages/engine/capacity.js';
import {
  createOps, stepOps, stockAccuracy, clientReport, occupancyProjection, palletHistory, simulateScan, submitChecklist,
  unblock, reportProblem, authorizeFefo, shiftSummary, checkPin, money, TARIFAS, CHECKLIST, PROBLEMAS, PIN_DEMO,
} from '../../packages/engine/ops.js';

const $ = (id) => document.getElementById(id);
// Formateadores reutilizables: toLocaleString crea uno nuevo en cada llamada y en el celular eso traba la pantalla.
const NF = [0, 1, 2].map((d) => new Intl.NumberFormat('es-AR', { maximumFractionDigits: d, minimumFractionDigits: d }));
const fmt = (n, d = 0) => NF[d].format(n);

let seed = 2026;
let data, st, ops;
const PALLETS = 1500; // ~78 % de ocupación sobre 1.920 posiciones
const view = createView();
view.onContextLost = () => { setTimeout(() => { setDim('2d'); toast('El 3D se quedó sin memoria en este equipo: seguimos en el mapa 2D'); }, 0); };
let speed = 10, running = true, lastFrame = performance.now(), lastUi = 0;

function boot() {
  data = generateMockData({ seed, pallets: PALLETS });
  st = createSim(data, { clarks: 6, seed: seed + 1 });
  ops = createOps(st, { seed });
  sessions.clear(); closeTablet();
  $('whName').textContent = data.warehouse.name + ' · ' + data.locations.length + ' posiciones';
  view.selected = null; view.selectedClark = null;
  $('detail').style.display = 'none';
  clearSearch();
  setSmartUi(false);
  updateUi(true);
}

// ---------- Canvas ----------
const canvas = $('map'), ctx = canvas.getContext('2d');
const spark = $('spark'), sctx = spark.getContext('2d');
let W = 0, H = 0;
function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = $('wrap').getBoundingClientRect();
  W = r.width; H = r.height;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const sr = spark.getBoundingClientRect();
  spark.width = Math.round(sr.width * dpr); spark.height = Math.round(sr.height * dpr);
  if (v3) v3.resize(W, H);
}

// ---------- Vista 3D (Three.js) ----------
let dim = '3d', v3 = null;
function setDim(d) {
  if (d === '3d' && !v3) {
    try {
      let q = null; try { q = localStorage.getItem('wms-demo-quality'); } catch {}
      v3 = createView3D($('wrap'), view, { quality: q || undefined, brand: data.warehouse.name });
      v3.resize(W, H); bind3d(v3.canvas); $('quality').value = v3.quality;
    }
    catch (err) { console.error(err); d = '2d'; toast('Este equipo no soporta WebGL: se muestra el mapa 2D'); }
  }
  dim = d;
  $('wrap').classList.toggle('is3d', d === '3d');
  $('wrap').classList.toggle('is2d', d === '2d');
  document.body.classList.toggle('dim2d', d === '2d');
  renderLegend();
  [...$('dim').children].forEach((b) => b.classList.toggle('on', b.dataset.d === d));
  $('tip').style.display = 'none';
  try { localStorage.setItem('wms-demo-dim', d); } catch {}
}
function hitAt(sx, sy) { return dim === '3d' && v3 ? v3.hitTest(st, sx, sy) : hitTest(st, view, sx, sy); }
function bind3d(cv) {
  let down = null;
  cv.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; $('tip').style.display = 'none'; });
  cv.addEventListener('pointermove', (e) => {
    if (e.buttons) return; // girando o desplazando la cámara
    const r = cv.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const hit = hitAt(sx, sy);
    view.hover = hit && hit.type === 'loc' ? hit.loc : null;
    cv.style.cursor = hit ? 'pointer' : 'grab';
    showTip(hit, sx, sy);
  });
  cv.addEventListener('pointerup', (e) => {
    const click = down && e.button === 0 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5;
    down = null;
    if (!click) return;
    const r = cv.getBoundingClientRect();
    selectHit(hitAt(e.clientX - r.left, e.clientY - r.top));
  });
  cv.addEventListener('pointerleave', () => { view.hover = null; $('tip').style.display = 'none'; });
}
function selectHit(hit) {
  if (!hit) { view.selected = null; $('detail').style.display = 'none'; return; }
  if (hit.type === 'clark') openTablet(hit.clark);
  else { view.selected = hit.loc; showDetail(hit.loc); }
}
$('dim').onclick = (e) => { const b = e.target.closest('button'); if (b) setDim(b.dataset.d); };
new ResizeObserver(resize).observe($('wrap'));
window.addEventListener('resize', resize);

// El reloj de la escena (clock, en ms) avanza con cada cuadro. En modo manual (grabación de video)
// lo avanza __wms.tick(dt) con pasos fijos, así el resultado no depende de la velocidad del equipo.
let clock = 0, manual = false;
function advance(dt) {
  clock += dt * 1000;
  if (running) { stepSim(st, dt * speed); stepOps(ops, st); }
  if (tour.running) tour.tick(dt, clock); else if (document.body.classList.contains('presenting')) endTour();
  if (dim === '3d' && v3) v3.render(st, clock);
  else drawMap(ctx, st, view, W, H, clock, canvas.width / (W || 1));
  if (clock - lastUi > UI_EVERY || clock < lastUi) { updateUi(false); lastUi = clock; }
}
function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!manual) advance(dt);
  requestAnimationFrame(frame);
}


// ---------- Interacción con el mapa ----------
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, px: view.panX, py: view.panY, moved: false };
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = 'grabbing';
});
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved) { view.panX = drag.px + dx; view.panY = drag.py + dy; $('tip').style.display = 'none'; return; }
  }
  const hit = hitTest(st, view, sx, sy);
  view.hover = hit && hit.type === 'loc' ? hit.loc : null;
  showTip(hit, sx, sy);
});
canvas.addEventListener('pointerup', (e) => {
  canvas.style.cursor = 'grab';
  const moved = drag && drag.moved; drag = null;
  if (moved) return;
  const r = canvas.getBoundingClientRect();
  selectHit(hitTest(st, view, e.clientX - r.left, e.clientY - r.top));
});
canvas.addEventListener('pointerleave', () => { view.hover = null; $('tip').style.display = 'none'; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
}, { passive: false });

function zoomAt(sx, sy, f) {
  const before = toWorld(view, sx, sy);
  view.zoom = Math.max(0.8, Math.min(5, view.zoom * f));
  // mantener fijo el punto que está bajo el cursor
  updateTransform(view, W, H);
  view.panX += sx - (before.x * view.scale + view.ox);
  view.panY += sy - (before.y * view.scale + view.oy);
}
$('zin').onclick = () => (dim === '3d' && v3 ? v3.zoom(1.3) : zoomAt(W / 2, H / 2, 1.3));
$('zout').onclick = () => (dim === '3d' && v3 ? v3.zoom(1 / 1.3) : zoomAt(W / 2, H / 2, 1 / 1.3));
$('zfit').onclick = () => { if (dim === '3d' && v3) v3.home(); else { view.zoom = 1; view.panX = 0; view.panY = 0; } };
let aisleIdx = 0;
$('zaisle').onclick = () => { if (v3) v3.aisleView(aisleIdx++ % 6); };

function palletHtml(p) {
  const sku = st.skuMap.get(p.skuId);
  return `<b>${p.lpn}</b> · ${sku.desc}<br>Clase <b style="color:${PALETTE[sku.abc]}">${sku.abc}</b> · ${fmt(sku.ppd, 1)} picks/día · vence en ${p.exp} d`;
}

function showTip(hit, sx, sy) {
  const tip = $('tip');
  if (!hit) { tip.style.display = 'none'; return; }
  let html;
  if (hit.type === 'clark') {
    const c = hit.clark;
    html = `<b>${c.code}</b> · ${c.operator}<br>${taskText(c)}`;
  } else {
    const loc = hit.loc;
    const p = loc.palletId != null ? st.palletMap.get(loc.palletId) : null;
    html = `<b>${loc.code}</b> · zona ${zoneOf(st, loc)} · ${fmt(loc.dist)} m al muelle<br>` + (p ? palletHtml(p) : loc.reserved ? 'Reservada: pallet en camino' : 'Ubicación libre');
  }
  tip.innerHTML = html;
  tip.style.display = 'block';
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = Math.min(W - tw - 8, sx + 14) + 'px';
  tip.style.top = Math.min(H - th - 8, sy + 14) + 'px';
}

function showDetail(loc) {
  const p = loc.palletId != null ? st.palletMap.get(loc.palletId) : null;
  const sku = p ? st.skuMap.get(p.skuId) : null;
  const z = zoneOf(st, loc);
  const zc = z === 'A' ? PALETTE.A : z === 'B' ? PALETTE.B : PALETTE.C;
  const rows = [
    ['Pasillo / rack', `${loc.code.split('-')[0]} / ${loc.rack}`], ['Columna · nivel', `${loc.col + 1} · ${loc.level}`],
    ['Distancia al muelle', `${fmt(loc.dist)} m`], ['Zona de slotting', `<span class="pill" style="background:${zc}22;color:${zc}">${z}</span>`],
  ];
  if (p) rows.push(
    ['Pallet (LPN)', `<b>${p.lpn}</b>`], ['Producto', sku.desc], ['SKU · cliente', `${sku.code} · ${sku.client}`],
    ['Rotación', `<span class="pill" style="background:${PALETTE[sku.abc]}22;color:${PALETTE[sku.abc]}">${sku.abc}</span> ${fmt(sku.ppd, 1)} picks/día`],
    ['Lote · vencimiento', `${p.lot} · ${p.exp} días`], ['Cajas · peso', `${p.qty} · <b>${fmt(weightOf(st, p))} kg</b>`], ['Estado', `<span class="pill" style="background:${PALETTE[p.status]}22;color:${PALETTE[p.status]}">${p.status}</span>`],
  );
  rows.push(...loadRows(loc));
  let warn = '';
  if (p && sku.abc === 'A' && z !== 'A' && p.status !== 'CUARENTENA') warn = `<p style="margin-top:10px;font-size:12px;color:#fcd34d">⚠ Producto de alta rotación lejos del muelle. El slotting inteligente lo va a reubicar.</p>`;
  if (p && sku.abc === 'C' && z === 'A') warn = `<p style="margin-top:10px;font-size:12px;color:#fca5a5">⚠ Producto de baja rotación ocupando una posición premium.</p>`;
  $('detail').innerHTML = `<button class="x" id="dx">×</button><small style="color:var(--muted)">UBICACIÓN</small><h3>${loc.code}</h3>` +
    rows.map(([a, b]) => `<div class="row"><span>${a}</span><span>${b}</span></div>`).join('') + (p ? '' : `<p style="margin-top:10px;color:var(--muted)">${loc.reserved ? 'Reservada: hay un clark llevando un pallet.' : 'Ubicación libre.'}</p>`) + warn + historyHtml(loc, p);
  $('detail').style.display = 'block';
  $('dx').onclick = () => { view.selected = null; $('detail').style.display = 'none'; };
}

function loadBar(v, cap) {
  const u = v / cap, c = u < 0.8 ? '#22c55e' : u < 0.95 ? '#f59e0b' : '#ef4444';
  return `<span style="display:inline-flex;align-items:center;gap:6px">${fmt(v)} / ${fmt(cap)} kg <i style="display:inline-block;width:46px;height:6px;border-radius:3px;background:#1e293b;overflow:hidden"><i style="display:block;height:100%;width:${Math.min(100, u * 100).toFixed(0)}%;background:${c}"></i></i></span>`;
}
function loadRows(loc) {
  const r = rackLoad(st, loc);
  if (loc.level === 0) return [['Capacidad (piso)', `hasta ${fmt(CAP.floorKg)} kg por pallet`]];
  return [['Carga de la viga', loadBar(r.beam, r.beamCap)], ['Carga del módulo', loadBar(r.module, r.moduleCap)]];
}
function whenTxt(m) { return m.t == null ? `hace ${m.diasAtras} d` : fmtClock(m.t); }
function historyHtml(loc, p) {
  const last = ops.lastCount.get(loc.id);
  const counted = `<div class="row"><span>Último conteo</span><span>${last == null ? 'pendiente' : 'hoy ' + fmtClock(last)}</span></div>`;
  if (!p) return counted;
  const h = palletHistory(ops, p.id).slice(0, 6);
  return counted + `<div class="hist"><small style="color:var(--muted);font-weight:700">HISTORIA DEL PALLET</small>` +
    h.map((m) => `<div><time>${whenTxt(m)}</time>${m.texto}${m.quien !== '—' ? ` · <span style="color:var(--muted)">${m.quien}</span>` : ''}</div>`).join('') + '</div>';
}

// ---------- Tablet del clark ----------
// Flujo del operario: PIN → checklist de seguridad → tareas. El lector se simula con botones.
let tabletClark = null;
const sessions = new Map(); // clarkId → { step, pin, checks, msg, problems }
const TYPE_LABEL = { PICK: 'PICKING · DESPACHO', PUTAWAY: 'GUARDADO · PUTAWAY', REPOSICION: 'REUBICACIÓN · SLOTTING' };
const TYPE_COLOR = { PICK: '#38bdf8', PUTAWAY: '#a78bfa', REPOSICION: '#22c55e' };
function refName(ref) { return ref.kind === 'loc' ? st.locations[ref.id].code : 'MUELLE ' + st.docks[ref.id].code; }
function taskText(c) {
  if (c.blocked) return '⛔ Equipo bloqueado por checklist';
  if (!c.task) return 'Esperando tarea…';
  const t = c.task;
  const verb = c.phase === 'toFrom' ? 'Yendo a buscar' : c.phase === 'handle1' ? 'Tomando pallet en' : c.phase === 'toTo' ? 'Llevando a' : 'Dejando en';
  const where = c.phase === 'toFrom' || c.phase === 'handle1' ? refName(t.from) : refName(t.to);
  return `${t.type === 'PICK' ? 'Picking' : t.type === 'PUTAWAY' ? 'Putaway' : 'Reubicación'} · ${verb} ${where}`;
}
function session(c) {
  if (!sessions.has(c.id)) sessions.set(c.id, { step: 'pin', pin: '', checks: {}, msg: null, problems: false });
  return sessions.get(c.id);
}
function openTablet(c) {
  tabletClark = c; view.selectedClark = c;
  $('tabletModal').classList.add('open');
  renderTablet(true);
}
function buzz(ok) { try { navigator.vibrate?.(ok ? 60 : [120, 60, 120]); } catch {} }
function renderTablet(force) {
  const c = tabletClark; if (!c) return;
  const s = session(c);
  if (!force && s.step !== 'task') return; // PIN y checklist solo cambian al tocar
  let body;
  if (s.step === 'pin') {
    body = `<div class="type" style="color:var(--muted)">INGRESO DEL OPERARIO</div>
      <div style="font-size:22px;font-weight:800;margin-top:8px">${c.operator}, ingresá tu PIN</div>
      <div class="pinbox">${[0, 1, 2, 3].map((i) => `<i class="${i < s.pin.length ? 'f' : ''}"></i>`).join('')}</div>
      ${s.msg ? `<div class="msg r">${s.msg.titulo}</div>` : ''}
      <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-act="key" data-k="${n}">${n}</button>`).join('')}
        <button data-act="key" data-k="del">⌫</button><button data-act="key" data-k="0">0</button><span></span></div>
      <p class="demo" style="text-align:center">PIN de la demo: ${PIN_DEMO}</p>`;
  } else if (s.step === 'check') {
    const all = CHECKLIST.every((_, i) => s.checks[i]);
    body = `<div class="type" style="color:#facc15">CHECKLIST PRE-USO · ${c.code}</div>
      <div style="color:var(--muted);margin-top:6px">Revisá el equipo antes de empezar. Con cualquier falla queda bloqueado.</div>
      ${CHECKLIST.map((item, i) => `<div class="chk"><span>${item}</span><span>
        <button data-act="chk" data-i="${i}" data-v="ok" class="${s.checks[i] === 'ok' ? 'sel-ok' : ''}">OK</button>
        <button data-act="chk" data-i="${i}" data-v="ko" class="${s.checks[i] === 'ko' ? 'sel-ko' : ''}">Falla</button></span></div>`).join('')}
      <div class="acts" style="margin-top:14px;grid-template-columns:1fr"><button class="ok" data-act="chkSend" ${all ? '' : 'disabled style="opacity:.4"'}>Confirmar checklist</button></div>`;
  } else if (c.blocked) {
    body = `<div class="type" style="color:#f87171">⛔ EQUIPO BLOQUEADO</div>
      <div class="dest" style="font-size:34px">No usar el ${c.code}</div>
      <p style="color:#fecaca">El checklist marcó una falla. Se avisó al supervisor; el clark no recibe tareas hasta que lo revisen.</p>
      <div class="acts" style="margin-top:14px;grid-template-columns:1fr"><button class="ok" data-act="unblock">Supervisor: equipo revisado, habilitar</button></div>`;
  } else if (!c.task) {
    body = `<div class="type" style="color:var(--muted)">SIN TAREA</div><div class="dest" style="font-size:40px">Esperando…</div>`;
  } else {
    const t = c.task;
    const p = st.palletMap.get(t.palletId) || c.carrying;
    const sku = p ? st.skuMap.get(p.skuId) : null;
    const goingFrom = c.phase === 'toFrom' || c.phase === 'handle1';
    const dest = goingFrom ? refName(t.from) : refName(t.to);
    const stepIdx = { toFrom: 0, handle1: 1, toTo: 2, handle2: 3 }[c.phase];
    const steps = ['Ir a origen', 'Escanear y tomar', 'Ir a destino', 'Escanear y dejar'];
    const m = s.msg && s.msg.until > performance.now() ? s.msg : null;
    body = `<div class="type" style="color:${TYPE_COLOR[t.type]}">${TYPE_LABEL[t.type]}</div>
      <div style="color:var(--muted);font-weight:700;margin-top:6px">${goingFrom ? 'TOMÁ EL PALLET EN' : 'LLEVALO A'}</div>
      <div class="dest">${dest}</div>
      <div class="info">
        <div><small>Pallet</small><b>${p ? p.lpn : '-'}</b></div>
        <div><small>Producto</small><b style="font-size:14px">${sku ? sku.desc : '-'}</b></div>
        <div><small>Lote · vence</small><b>${p ? p.lot + ' · ' + p.exp + 'd' : '-'}</b></div>
        <div><small>Cajas · peso</small><b>${p ? p.qty + ' · ' + fmt(weightOf(st, p)) + ' kg' : '-'}</b></div>
      </div>
      <div class="steps">${steps.map((x, i) => `<span class="${i === stepIdx ? 'on' : i < stepIdx ? 'done' : ''}">${x}</span>`).join('')}</div>
      ${m ? `<div class="msg ${m.ok ? 'g' : 'r'}">${m.titulo}<small>${m.texto}</small></div>` : ''}
      ${m && m.fefo ? `<div class="acts" style="grid-template-columns:1fr;margin-bottom:10px"><button class="ko" data-act="fefo" style="font-size:15px">Pedir autorización al supervisor</button></div>` : ''}
      <div class="demo">Demo: simulá el lector de códigos</div>
      <div class="acts3"><button class="ok" data-act="scan" data-v="ok">✓ Escanear correcto</button><button style="background:#334155;color:#fff" data-act="scan" data-v="ko">✗ Escanear otro</button></div>
      <div class="acts" style="margin-top:10px;grid-template-columns:1fr"><button class="ko" data-act="prob">⚠ Reportar problema</button></div>
      ${s.problems ? `<div class="pgrid">${Object.entries(PROBLEMAS).map(([k, v]) => `<button data-act="probSend" data-p="${k}">${v}</button>`).join('')}</div>` : ''}`;
  }
  $('tablet').innerHTML = `<button class="close" data-act="close">×</button>
    <div class="top"><span>${c.code} · ${c.operator}</span><span>${fmtClock(st.t)} · ${c.tasksDone} tareas hoy</span></div>${body}`;
}
// pointerdown en vez de click: la tablet se redibuja varias veces por segundo mientras hay tarea
$('tablet').addEventListener('pointerdown', (e) => {
  const b = e.target.closest('[data-act]'); if (!b || !tabletClark || b.disabled) return;
  const c = tabletClark, s = session(c), act = b.dataset.act;
  e.preventDefault();
  if (act === 'close') return closeTablet();
  if (act === 'key') {
    s.msg = null;
    if (b.dataset.k === 'del') s.pin = s.pin.slice(0, -1); else if (s.pin.length < 4) s.pin += b.dataset.k;
    if (s.pin.length === 4) {
      if (checkPin(s.pin)) { s.step = 'check'; buzz(true); } else { s.msg = { titulo: 'PIN incorrecto. Probá de nuevo.' }; buzz(false); }
      s.pin = '';
    }
  } else if (act === 'chk') s.checks[b.dataset.i] = b.dataset.v;
  else if (act === 'chkSend') {
    const fallas = CHECKLIST.filter((_, i) => s.checks[i] === 'ko');
    submitChecklist(ops, st, c, fallas);
    s.step = 'task';
    if (fallas.length) toast(`${c.code} bloqueado: se avisó al supervisor`);
  } else if (act === 'unblock') { unblock(ops, st, c); toast(`${c.code} habilitado`); }
  else if (act === 'scan') {
    const r = simulateScan(ops, st, c, b.dataset.v === 'ok');
    s.msg = { ...r, until: performance.now() + 7000 }; buzz(r.ok);
  } else if (act === 'fefo') {
    authorizeFefo(ops, st, c, s.msg.wrong);
    s.msg = { ok: true, titulo: 'Autorizado por supervisor', texto: 'Queda registrado quién autorizó y por qué.', until: performance.now() + 5000 };
  } else if (act === 'prob') s.problems = !s.problems;
  else if (act === 'probSend') {
    const pr = reportProblem(ops, st, c, b.dataset.p);
    s.problems = false;
    s.msg = { ok: true, titulo: 'Problema enviado al supervisor', texto: pr.texto, until: performance.now() + 5000 };
  }
  renderTablet(true);
});
function closeTablet() { tabletClark = null; view.selectedClark = null; $('tabletModal').classList.remove('open'); }
$('tabletModal').addEventListener('click', (e) => { if (e.target.id === 'tabletModal') closeTablet(); });

// ---------- Gestión: inventario, clientes, recepción, problemas ----------
let mgTab = 'inv';
$('mgTabs').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  mgTab = b.dataset.t;
  [...$('mgTabs').children].forEach((x) => x.classList.toggle('on', x === b));
  renderMg();
};
function renderMg() {
  let html = '';
  if (mgTab === 'inv') {
    const acc = stockAccuracy(ops);
    const proj = occupancyProjection(ops, st);
    const projTxt = proj.estado === 'MIDIENDO' ? 'midiendo el ritmo de entradas y salidas…'
      : proj.estado === 'ESTABLE' ? `estable: entra lo mismo que sale (${fmt(proj.occupied / proj.total * 100)} % ocupado)`
        : `crece ${fmt(proj.perShift)} pallets por turno → 90 % en ~${Math.ceil(proj.turnosHasta90)} turnos`;
    const list = (ops.adjustments.length ? ops.adjustments : ops.countLog).slice(0, 5);
    html = `<div class="big2"><b class="${acc == null ? '' : acc >= 0.98 ? 'ok-c' : acc >= 0.95 ? 'wa-c' : 'ko-c'}">${acc == null ? '–' : fmt(acc * 100, 1) + ' %'}</b><span style="color:var(--muted)">exactitud de stock</span></div>
      <div class="note">Inventario cíclico: un operario cuenta ~30 ubicaciones por hora, primero las de productos A, sin cerrar el depósito.
      Hoy: <b>${ops.counted}</b> contadas · <b>${ops.countedWithDiff}</b> con diferencia (ajustadas).</div>
      <div class="note">Ocupación: ${projTxt}</div>
      ${(() => { const c = capacityReport(st); return `<div class="note">Racks: <b class="${c.beamsOver + c.modulesOver ? 'ko-c' : 'ok-c'}">${c.beamsOver + c.modulesOver ? c.beamsOver + ' vigas excedidas' : 'ninguna viga ni módulo excedido'}</b> · ${c.beamsHigh} de ${c.beams} vigas al 90 % o más. Cada pallet se guarda solo donde la posición (${fmt(CAP.posKg)} kg), el par de vigas (${fmt(CAP.beamKg)} kg) y el módulo (${fmt(CAP.bayKg)} kg) lo aguantan.</div>`; })()}
      <div style="margin-top:8px">${ops.adjustments.length ? '<div class="note" style="font-weight:700">Últimos ajustes</div>' : ''}${list.map((x) => `<div class="li"><span><b>${x.code}</b> ${x.texto}</span><span class="${x.ok ? 'ok-c' : 'ko-c'}">${fmtClock(x.t)}</span></div>`).join('') || '<div class="note">Todavía no se contó nada.</div>'}</div>`;
  } else if (mgTab === 'cli') {
    const rows = clientReport(ops, st);
    html = `<table><tr><th>Cliente</th><th>Pallets</th><th>Vence &lt;30d</th><th>Hoy</th><th>Mes (est.)</th></tr>
      ${rows.map((r) => `<tr><td>${r.name}</td><td>${r.pallets}</td><td class="${r.riesgo ? 'wa-c' : ''}">${money(r.riesgo)}</td><td>${money(r.hoy)}</td><td><b>${money(r.mes)}</b></td></tr>`).join('')}</table>
      <div class="note">Tarifas de ejemplo: ${money(TARIFAS.almacenajePalletDia)} por pallet/día · ${money(TARIFAS.entradaPallet)} por entrada · ${money(TARIFAS.salidaPallet)} por salida. Mes = almacenaje de 30 días + movimientos al ritmo de hoy × 26 turnos. Sale solo de los movimientos, sin planillas.</div>`;
  } else if (mgTab === 'rec') {
    html = ops.trucks.slice(0, 6).map((t) => `<div class="li"><span><b>${t.remito}</b> ${t.proveedor} · ${t.dock}<br><span style="color:var(--muted)">${t.recibidos}/${t.esperado} pallets · llegó ${fmtClock(t.llegada)}</span></span>
      <span class="${t.estado === 'OK' ? 'ok-c' : t.estado === 'DESCARGANDO' ? '' : 'wa-c'}" style="text-align:right;font-weight:700">${t.estado}${t.diferencias.length ? `<br>${t.diferencias.length} dif.` : ''}</span></div>`).join('') || '<div class="note">Esperando el primer camión…</div>';
    html += ops.receivingIssues.length ? `<div class="note" style="margin-top:10px;font-weight:700">Diferencias contra remito</div>` +
      ops.receivingIssues.slice(0, 4).map((d) => `<div class="li"><span><b>${d.lpn}</b> ${d.texto}</span><span class="wa-c">${fmtClock(d.t)}</span></div>`).join('') : '';
  } else {
    const blocked = st.clarks.filter((c) => c.blocked);
    html = (blocked.length ? `<div class="li"><span class="ko-c"><b>${blocked.map((c) => c.code).join(', ')}</b> bloqueado(s) por checklist</span><span></span></div>` : '') +
      (ops.problems.slice(0, 6).map((p) => `<div class="li"><span><b>${p.clark}</b> ${p.texto}</span><span class="wa-c">${fmtClock(p.t)}</span></div>`).join('') ||
        `<div class="note">Sin problemas reportados. Abrí la tablet de un clark (PIN ${PIN_DEMO}) y probá “Reportar problema” o el checklist con una falla.</div>`) +
      `<div class="note">Escaneos equivocados detectados: <b>${ops.wrongScans}</b> · salidas fuera de FEFO autorizadas: <b>${ops.fefoOverrides}</b></div>`;
  }
  $('mgBody').innerHTML = html;
}

// ---------- Resumen del turno ----------
$('summaryBtn').onclick = () => {
  const s = shiftSummary(ops, st, data.warehouse.name);
  $('sumPre').textContent = s.text;
  $('sumWa').href = 'https://wa.me/?text=' + encodeURIComponent(s.text);
  $('sumModal').classList.add('open');
};
$('sumClose').onclick = () => $('sumModal').classList.remove('open');
$('sumModal').addEventListener('click', (e) => { if (e.target.id === 'sumModal') $('sumModal').classList.remove('open'); });
$('sumCopy').onclick = async () => {
  try { await navigator.clipboard.writeText($('sumPre').textContent); toast('Resumen copiado'); } catch { toast('No se pudo copiar desde esta vista'); }
};

// ---------- Panel ----------
const TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const UI_EVERY = TOUCH ? 600 : 250; // ms entre actualizaciones del panel
function onScreen(el) { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0; }
function updateUi(force) {
  // En el celular el panel queda debajo del mapa: si no se ve, no se redibuja (solo el reloj y la tablet)
  if (!force && !onScreen(document.querySelector('aside'))) {
    $('clock').textContent = fmtClock(st.t);
    if (tabletClark) renderTablet();
    if ($('kpiov').style.display === 'grid') renderKpiOverlay();
    return;
  }
  const k = getKpis(st);
  $('clock').textContent = fmtClock(st.t);
  $('kOcc').textContent = fmt(k.occupancy * 100, 1) + '%';
  $('kOccS').textContent = `${k.occupied} de ${k.locations} posiciones`;
  $('kOccBar').style.width = (k.occupancy * 100).toFixed(1) + '%';
  $('kStock').textContent = fmt(k.stock);
  $('kStockS').innerHTML = `<span style="color:${PALETTE.A}">A ${k.byClass.A}</span> · <span style="color:${PALETTE.B}">B ${k.byClass.B}</span> · <span style="color:${PALETTE.C}">C ${k.byClass.C}</span>`;
  $('kPph').textContent = fmt(k.palletsPerHour, 0);
  $('kPphS').textContent = `${k.picks} despachos · ${k.putaways} guardados · ${k.moves} reubic.`;
  $('kPick').textContent = k.avgPickMeters ? fmt(k.avgPickMeters) + ' m' : '–';
  $('kPickS').textContent = k.avgTaskSeconds ? `tarea promedio ${fmt(k.avgTaskSeconds / 60, 1)} min` : 'midiendo…';
  $('kIdx').textContent = fmt(k.index, 1);
  $('kBase').textContent = fmt(k.baseline, 1);
  const d = $('kDelta');
  d.textContent = (k.delta <= 0 ? '▼ ' : '▲ ') + fmt(Math.abs(k.delta * 100), 0) + '%';
  d.className = 'delta ' + (k.delta < -0.02 ? 'good' : 'flat');
  $('kSaveM').textContent = fmt(k.metersSavedMonth / 1000, 0) + ' km';
  $('kSaveH').textContent = fmt(k.hoursSavedMonth, 0) + ' h';
  $('sugg').textContent = st.smart ? `${k.suggestions} sugerencias en cola` : '';
  const sw = spark.getBoundingClientRect().width, sdpr = spark.width / (sw || 1);
  if (sw > 0 && spark.width > 0) drawSparkline(sctx, st.history, k.baseline, spark.width / sdpr, spark.height / sdpr, '#22c55e', sdpr);

  $('clarks').innerHTML = k.clarks.map(({ c, perHour }) => `
    <div class="clk ${view.selectedClark === c ? 'sel' : ''}" data-id="${c.id}">
      <div class="dot" style="background:${c.color}">${c.id}</div>
      <div><b>${c.code}</b> · ${c.operator}${c.blocked ? ' <span class="lock">🔒</span>' : ''}<div class="t">${taskText(c)}</div></div>
      <div class="r"><b>${fmt(perHour, 0)}/h</b>${fmt(c.meters / 1000, 1)} km</div>
    </div>`).join('');
  $('expN').textContent = k.expiring.length;
  $('alerts').innerHTML = k.expiring.slice(0, 5).map(({ p, sku, loc }) => `
    <div class="alert"><span><b>${loc.code}</b> ${sku.desc}</span><span style="color:${p.exp < 10 ? '#ef4444' : '#f59e0b'};font-weight:700;white-space:nowrap">${p.exp} días</span></div>`).join('') || '<div style="color:var(--muted)">Sin alertas</div>';
  $('feed').innerHTML = st.log.slice(0, 12).map((l) => `<div class="${l.type === 'smart' ? 'smart' : ''}"><time>${fmtClock(l.t)}</time>${l.text}</div>`).join('');
  const acc = stockAccuracy(ops);
  $('kAcc').textContent = acc == null ? '–' : fmt(acc * 100, 1) + '%';
  $('kAccS').textContent = `${ops.counted} ubic. contadas · ${ops.countedWithDiff} dif.`;
  const cr = clientReport(ops, st);
  $('kRisk').textContent = money(cr.reduce((x, r) => x + r.riesgo, 0));
  $('kRiskS').textContent = `${cr.reduce((x, r) => x + r.riesgoPallets, 0)} pallets · valor de ejemplo`;
  renderMg();
  if ($('kpiov').style.display === 'grid') renderKpiOverlay();
  $('mapInfo').textContent = `${data.locations.length} ubicaciones · 6 pasillos · 4 niveles`;
  if (tabletClark) renderTablet();
  if (view.selected && !force) showDetail(view.selected);
}
$('clarks').addEventListener('click', (e) => {
  const row = e.target.closest('.clk'); if (!row) return;
  openTablet(st.clarks.find((c) => c.id === Number(row.dataset.id)));
});

// ---------- Controles ----------
$('modes').innerHTML = Object.entries(MODES).map(([k, m]) => `<button data-m="${k}" class="${k === view.mode ? 'on' : ''}">${m.label}</button>`).join('');
function renderLegend() {
  $('legend').innerHTML = (dim === '3d' && view.look === 'real' ? '<span style="color:#cbd5e1;font-weight:700">Color en la etiqueta de cada pallet:</span>' : '') + MODES[view.mode].legend.map(([t, c]) => `<span><i style="background:${c}"></i>${t}</span>`).join('') +
    (view.showZones ? `<span><i style="background:rgba(34,197,94,.25);border:1px dashed #22c55e"></i>Zona A (cerca de despacho)</span>` : '');
}
$('modes').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  setMode(b.dataset.m);
};
$('level').onchange = (e) => { view.level = e.target.value; };
$('zones').onchange = (e) => { view.showZones = e.target.checked; renderLegend(); };
$('speed').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  speed = Number(b.dataset.s);
  [...$('speed').children].forEach((x) => x.classList.toggle('on', x === b));
};
$('play').onclick = () => {
  running = !running;
  $('play').textContent = running ? '⏸ Pausa' : '▶ Reanudar';
  $('live').classList.toggle('paused', !running);
  $('live').querySelector('span').textContent = running ? 'EN VIVO' : 'EN PAUSA';
};
function setSmartUi(on) { $('smart').classList.toggle('on', on); }
$('smartBtn').onclick = () => {
  const on = !st.smart;
  setSmart(st, on); setSmartUi(on);
  if (on) toast(`Slotting activado: ${st.suggestions.length} pallets de alta rotación van a acercarse al muelle`);
};
$('reset').onclick = () => boot();

// ---------- Realista / Análisis y calidad ----------
function setLook(l) {
  view.look = l;
  [...$('look').children].forEach((b) => b.classList.toggle('on', b.dataset.l === l));
  renderLegend();
}
$('look').onclick = (e) => { const b = e.target.closest('button'); if (b) setLook(b.dataset.l); };
$('quality').onchange = (e) => {
  if (!v3) return;
  v3.setQuality(e.target.value);
  try { localStorage.setItem('wms-demo-quality', e.target.value); } catch {}
  toast('Calidad gráfica: ' + e.target.selectedOptions[0].text);
};
function setMode(m) {
  view.mode = m;
  [...$('modes').children].forEach((x) => x.classList.toggle('on', x.dataset.m === m));
  renderLegend();
}

// ---------- Buscador ----------
const CLARK_SPEED = 2.4; // m/s vacío
let lastSearch = null;
function findPallets(q) {
  const s = q.trim().toLowerCase(); if (!s) return [];
  const norm = s.replace(/^lpn-?/, '');
  const stored = [...st.palletMap.values()].filter((p) => p.locId != null);
  const byLpn = stored.filter((p) => p.lpn.toLowerCase() === s || p.lpn.toLowerCase().endsWith(norm.padStart(6, '0')) && /^\d+$/.test(norm));
  if (byLpn.length) return byLpn;
  return stored.filter((p) => { const k = st.skuMap.get(p.skuId); return k.code.toLowerCase() === s || k.desc.toLowerCase().includes(s) || k.ean === s; })
    .sort((a, b) => (a.status === 'CUARENTENA') - (b.status === 'CUARENTENA') || a.exp - b.exp); // FEFO
}
function runSearch(q) {
  const list = findPallets(q);
  if (!list.length) { clearSearch(); toast('No se encontró “' + q + '”'); return null; }
  const p = list[0], loc = st.locations[p.locId], sku = st.skuMap.get(p.skuId);
  let best = null;
  for (const c of st.clarks) {
    if (c.blocked) continue;
    const from = { x: c.x, y: c.y, aisle: c.path.length ? -1 : c.aisle };
    const pts = routePath(from, loc.access), d = pathLength(from, pts);
    if (!best || d < best.d) best = { c, d, pts: [{ x: c.x, y: c.y }, ...pts] };
  }
  lastSearch = { q, p, loc, sku, list, best };
  view.selected = null; $('detail').style.display = 'none';
  if (dim === '3d' && v3) { v3.setSearch(loc, best?.pts, clock); if (!tour.running) v3.flyToLoc(loc); }
  else { view.selected = loc; showDetail(loc); }
  renderSearchCard();
  return lastSearch;
}
function renderSearchCard() {
  const r = lastSearch; if (!r) { $('rcard').style.display = 'none'; return; }
  const { p, loc, sku, list, best } = r;
  const eta = best ? Math.round(best.d / CLARK_SPEED) : null;
  $('rcard').innerHTML = `<button class="x" id="rcx">×</button><div class="k">● ENCONTRADO</div>
    <div class="code">${loc.code}</div>
    <div class="where">Pasillo ${AISLE_LETTERS[loc.aisle]} · posición ${loc.col + 1} · nivel ${loc.level}</div>
    <div class="row"><span>Producto</span><span>${sku.desc}</span></div>
    <div class="row"><span>Pallet · lote</span><span>${p.lpn} · ${p.lot}</span></div>
    <div class="row"><span>Vence en</span><span>${p.exp} días · ${p.qty} cajas · ${fmt(weightOf(st, p))} kg</span></div>
    ${list.length > 1 ? `<div class="row"><span>Stock del producto</span><span>${list.length} pallets · este sale primero (FEFO)</span></div>` : ''}
    ${best ? `<div class="eta">🚜 <b>${best.c.code}</b> (${best.c.operator}) está a <b>${fmt(best.d)} m</b> · llega en ~${eta < 90 ? eta + ' s' : fmt(eta / 60, 1) + ' min'}</div>` : ''}`;
  $('rcard').style.display = 'block';
  $('rcx').onclick = clearSearch;
}
function clearSearch() {
  lastSearch = null; $('rcard').style.display = 'none';
  if (v3) v3.setSearch(null);
}
$('searchForm').onsubmit = (e) => { e.preventDefault(); runSearch($('searchQ').value); $('searchQ').blur(); };

// ---------- Recorrido guiado y modo presentación ----------
let resultVisible = false;
const tour = createTour({
  get v3() { return v3; },
  st: () => st,
  setLook, setMode,
  setSmart: (on) => { if (st.smart !== on) { setSmart(st, on); setSmartUi(on); } },
  setSpeed: (x) => { speed = x; [...$('speed').children].forEach((b) => b.classList.toggle('on', Number(b.dataset.s) === x)); },
  search: (q) => runSearch(q),
  clearSearch,
  resultCard: (on) => { resultVisible = on; $('rcard').style.display = on && lastSearch ? 'block' : 'none'; },
  caption: (title, sub, a) => { $('cap').style.opacity = a; if ($('capT').innerHTML !== title) { $('capT').innerHTML = title; $('capS').textContent = sub; } },
  kpis: (on) => { $('kpiov').style.display = on ? 'grid' : 'none'; if (on) renderKpiOverlay(); },
  end: (on) => { $('endc').style.display = on ? 'block' : 'none'; },
  labels: (on) => { view.labels = on; },
  paths: (on) => { view.paths = on; },
});
function renderKpiOverlay() {
  const k = getKpis(st), acc = stockAccuracy(ops), cr = clientReport(ops, st);
  $('kpiov').innerHTML = [
    ['Ocupación', fmt(k.occupancy * 100, 1) + ' %'], ['Exactitud de stock', acc == null ? '–' : fmt(acc * 100, 1) + ' %'],
    ['Por vencer < 30 d', money(cr.reduce((x, r) => x + r.riesgo, 0))], ['Movimientos / hora', fmt(k.palletsPerHour)],
  ].map(([a, b]) => `<div><small>${a}</small><b>${b}</b></div>`).join('');
}
function startTour() {
  if (dim !== '3d') setDim('3d');
  if (!v3) return;
  closeTablet(); clearSearch(); view.selected = null; $('detail').style.display = 'none';
  document.body.classList.add('presenting');
  requestAnimationFrame(() => { resize(); });
  running = true;
  tour.start();
}
function endTour() {
  if (tour.running) tour.stop();
  document.body.classList.remove('presenting');
  $('cap').style.opacity = 0; $('kpiov').style.display = 'none'; $('endc').style.display = 'none';
  setLook('real'); setSmart(st, false); setSmartUi(false); setMode('rotacion');
  requestAnimationFrame(() => { resize(); if (v3) v3.home(); });
}
$('tourBtn').onclick = startTour;
$('exitTour').onclick = endTour;

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 3600);
}

// ---------- Datos mock ----------
function exportData() {
  return {
    deposito: data.warehouse, generado: data.generatedAt, semilla: data.seed,
    muelles: st.docks.map((d) => ({ codigo: d.code, tipo: d.kind })),
    skus: st.skus.map((s) => ({ codigo: s.code, ean: s.ean, descripcion: s.desc, categoria: s.cat, cliente: s.client, picks_90d: s.picks90, picks_por_dia: s.ppd, clase_abc: s.abc })),
    pallets: [...st.palletMap.values()].filter((p) => p.locId != null).map((p) => {
      const s = st.skuMap.get(p.skuId), l = st.locations[p.locId];
      return { lpn: p.lpn, ubicacion: l.code, sku: s.code, descripcion: s.desc, lote: p.lot, vence_en_dias: p.exp, cajas: p.qty, estado: p.status, clase_abc: s.abc, distancia_muelle_m: l.dist };
    }),
  };
}
$('dataBtn').onclick = () => {
  const ex = exportData();
  $('dataSummary').textContent = `${ex.pallets.length} pallets · ${ex.skus.length} SKUs · ${data.locations.length} ubicaciones · semilla ${seed}. Mismo generador que usa el seed de PostgreSQL del proyecto.`;
  $('dataPre').textContent = JSON.stringify({ ...ex, pallets: ex.pallets.slice(0, 12), skus: ex.skus.slice(0, 5) }, null, 2) + '\n… (vista previa)';
  $('dataModal').classList.add('open');
};
$('dataClose').onclick = () => $('dataModal').classList.remove('open');
$('dataModal').addEventListener('click', (e) => { if (e.target.id === 'dataModal') $('dataModal').classList.remove('open'); });
$('copyJson').onclick = async () => {
  try { await navigator.clipboard.writeText(JSON.stringify(exportData(), null, 2)); toast('JSON copiado al portapapeles'); }
  catch { toast('No se pudo copiar desde esta vista'); }
};
$('regen').onclick = () => { seed = Math.floor(Math.random() * 1e6); boot(); $('dataModal').classList.remove('open'); toast('Nuevo depósito generado · semilla ' + seed); };

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeTablet(); $('dataModal').classList.remove('open'); $('sumModal').classList.remove('open'); if (document.body.classList.contains('presenting')) endTour(); }
  if (e.key === ' ' && e.target === document.body) { e.preventDefault(); $('play').click(); }
  if (e.key.toLowerCase() === 's' && e.target === document.body) $('smartBtn').click();
});

// API mínima para grabar el video de demo
window.__wms = { get st() { return st; }, get dim() { return dim; }, setDim, focusClark: (i, d) => { const c = st.clarks[i]; if (v3) v3.focus(c.x, c.y, d); },view,setSpeed: (s) => { speed = s; }, smart: () => $('smartBtn').click(), openTablet: (i) => openTablet(st.clarks[i]), closeTablet, selectLoc: (code) => { const l = st.locations.find((x) => x.code === code); view.selected = l; showDetail(l); }, step: (s) => { stepSim(st, s); stepOps(ops, st); }, get ops() { return ops; },
  get v3() { return v3; }, tour, startTour, endTour, runSearch, clearSearch, setLook, setMode,
  manual: (on) => { manual = on; }, tick: (dt) => advance(dt), get clock() { return clock; }, get running() { return running; }, set running(v) { running = v; } };

renderLegend();
boot();
resize();
let savedDim = '3d';
try { savedDim = localStorage.getItem('wms-demo-dim') || '3d'; } catch {}
setDim(savedDim);
requestAnimationFrame(frame);
