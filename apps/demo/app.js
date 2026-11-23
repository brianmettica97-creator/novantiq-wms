import { generateMockData } from '../../packages/engine/mockdata.js';
import { createSim, stepSim, getKpis, setSmart, fmtClock } from '../../packages/engine/simulation.js';
import { createView, drawMap, hitTest, drawSparkline, MODES, PALETTE, toWorld, updateTransform } from '../../packages/engine/renderer.js';
import { zoneOf } from '../../packages/engine/slotting.js';
import { createView3D } from './view3d.js';

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 0) => n.toLocaleString('es-AR', { maximumFractionDigits: d, minimumFractionDigits: d });

let seed = 2026;
let data, st;
const view = createView();
let speed = 10, running = true, lastFrame = performance.now(), lastUi = 0;

function boot() {
  data = generateMockData({ seed, pallets: 300 });
  st = createSim(data, { clarks: 5, seed: seed + 1 });
  $('whName').textContent = data.warehouse.name + ' · ' + data.locations.length + ' posiciones';
  view.selected = null; view.selectedClark = null;
  $('detail').style.display = 'none';
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
    try { v3 = createView3D($('wrap'), view); v3.resize(W, H); bind3d(v3.canvas); }
    catch (err) { console.error(err); d = '2d'; toast('Este equipo no soporta WebGL: se muestra el mapa 2D'); }
  }
  dim = d;
  $('wrap').classList.toggle('is3d', d === '3d');
  $('wrap').classList.toggle('is2d', d === '2d');
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

function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (running) stepSim(st, dt * speed);
  if (dim === '3d' && v3) v3.render(st, now);
  else drawMap(ctx, st, view, W, H, now, canvas.width / (W || 1));
  if (now - lastUi > 250) { updateUi(false); lastUi = now; }
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
    ['Lote · vencimiento', `${p.lot} · ${p.exp} días`], ['Cajas', p.qty], ['Estado', `<span class="pill" style="background:${PALETTE[p.status]}22;color:${PALETTE[p.status]}">${p.status}</span>`],
  );
  let warn = '';
  if (p && sku.abc === 'A' && z !== 'A' && p.status !== 'CUARENTENA') warn = `<p style="margin-top:10px;font-size:12px;color:#fcd34d">⚠ Producto de alta rotación lejos del muelle. El slotting inteligente lo va a reubicar.</p>`;
  if (p && sku.abc === 'C' && z === 'A') warn = `<p style="margin-top:10px;font-size:12px;color:#fca5a5">⚠ Producto de baja rotación ocupando una posición premium.</p>`;
  $('detail').innerHTML = `<button class="x" id="dx">×</button><small style="color:var(--muted)">UBICACIÓN</small><h3>${loc.code}</h3>` +
    rows.map(([a, b]) => `<div class="row"><span>${a}</span><span>${b}</span></div>`).join('') + (p ? '' : `<p style="margin-top:10px;color:var(--muted)">${loc.reserved ? 'Reservada: hay un clark llevando un pallet.' : 'Ubicación libre.'}</p>`) + warn;
  $('detail').style.display = 'block';
  $('dx').onclick = () => { view.selected = null; $('detail').style.display = 'none'; };
}

// ---------- Tablet del clark ----------
let tabletClark = null;
const TYPE_LABEL = { PICK: 'PICKING · DESPACHO', PUTAWAY: 'GUARDADO · PUTAWAY', REPOSICION: 'REUBICACIÓN · SLOTTING' };
const TYPE_COLOR = { PICK: '#38bdf8', PUTAWAY: '#a78bfa', REPOSICION: '#22c55e' };
function refName(ref) { return ref.kind === 'loc' ? st.locations[ref.id].code : 'MUELLE ' + st.docks[ref.id].code; }
function taskText(c) {
  if (!c.task) return 'Esperando tarea…';
  const t = c.task;
  const verb = c.phase === 'toFrom' ? 'Yendo a buscar' : c.phase === 'handle1' ? 'Tomando pallet en' : c.phase === 'toTo' ? 'Llevando a' : 'Dejando en';
  const where = c.phase === 'toFrom' || c.phase === 'handle1' ? refName(t.from) : refName(t.to);
  return `${t.type === 'PICK' ? 'Picking' : t.type === 'PUTAWAY' ? 'Putaway' : 'Reubicación'} · ${verb} ${where}`;
}
function openTablet(c) {
  tabletClark = c; view.selectedClark = c;
  $('tabletModal').classList.add('open');
  renderTablet();
}
function renderTablet() {
  const c = tabletClark; if (!c) return;
  const t = c.task;
  let body;
  if (!t) body = `<div class="type" style="color:var(--muted)">SIN TAREA</div><div class="dest" style="font-size:40px">Esperando…</div>`;
  else {
    const p = st.palletMap.get(t.palletId) || c.carrying;
    const sku = p ? st.skuMap.get(p.skuId) : null;
    const goingFrom = c.phase === 'toFrom' || c.phase === 'handle1';
    const dest = goingFrom ? refName(t.from) : refName(t.to);
    const stepIdx = { toFrom: 0, handle1: 1, toTo: 2, handle2: 3 }[c.phase];
    const steps = ['Ir a origen', 'Escanear y tomar', 'Ir a destino', 'Escanear y dejar'];
    body = `<div class="type" style="color:${TYPE_COLOR[t.type]}">${TYPE_LABEL[t.type]}</div>
      <div style="color:var(--muted);font-weight:700;margin-top:6px">${goingFrom ? 'TOMÁ EL PALLET EN' : 'LLEVALO A'}</div>
      <div class="dest">${dest}</div>
      <div class="info">
        <div><small>Pallet</small><b>${p ? p.lpn : '-'}</b></div>
        <div><small>Producto</small><b style="font-size:14px">${sku ? sku.desc : '-'}</b></div>
        <div><small>Lote · vence</small><b>${p ? p.lot + ' · ' + p.exp + 'd' : '-'}</b></div>
        <div><small>Rotación</small><b style="color:${sku ? PALETTE[sku.abc] : '#fff'}">${sku ? 'Clase ' + sku.abc : '-'}</b></div>
      </div>
      <div class="steps">${steps.map((s, i) => `<span class="${i === stepIdx ? 'on' : i < stepIdx ? 'done' : ''}">${s}</span>`).join('')}</div>
      <div class="acts"><button class="ok">✓ CONFIRMAR</button><button class="ko">⚠ PROBLEMA</button></div>`;
  }
  $('tablet').innerHTML = `<button class="close" id="tclose">×</button>
    <div class="top"><span>${c.code} · ${c.operator}</span><span>${fmtClock(st.t)} · ${c.tasksDone} tareas hoy</span></div>${body}`;
  $('tclose').onclick = closeTablet;
}
function closeTablet() { tabletClark = null; view.selectedClark = null; $('tabletModal').classList.remove('open'); }
$('tabletModal').addEventListener('click', (e) => { if (e.target.id === 'tabletModal') closeTablet(); });

// ---------- Panel ----------
function updateUi(force) {
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
  const sdpr = spark.width / (spark.getBoundingClientRect().width || 1);
  drawSparkline(sctx, st.history, k.baseline, spark.width / sdpr, spark.height / sdpr, '#22c55e', sdpr);

  $('clarks').innerHTML = k.clarks.map(({ c, perHour }) => `
    <div class="clk ${view.selectedClark === c ? 'sel' : ''}" data-id="${c.id}">
      <div class="dot" style="background:${c.color}">${c.id}</div>
      <div><b>${c.code}</b> · ${c.operator}<div class="t">${taskText(c)}</div></div>
      <div class="r"><b>${fmt(perHour, 0)}/h</b>${fmt(c.meters / 1000, 1)} km</div>
    </div>`).join('');
  $('expN').textContent = k.expiring.length;
  $('alerts').innerHTML = k.expiring.slice(0, 5).map(({ p, sku, loc }) => `
    <div class="alert"><span><b>${loc.code}</b> ${sku.desc}</span><span style="color:${p.exp < 10 ? '#ef4444' : '#f59e0b'};font-weight:700;white-space:nowrap">${p.exp} días</span></div>`).join('') || '<div style="color:var(--muted)">Sin alertas</div>';
  $('feed').innerHTML = st.log.slice(0, 12).map((l) => `<div class="${l.type === 'smart' ? 'smart' : ''}"><time>${fmtClock(l.t)}</time>${l.text}</div>`).join('');
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
  $('legend').innerHTML = MODES[view.mode].legend.map(([t, c]) => `<span><i style="background:${c}"></i>${t}</span>`).join('') +
    (view.showZones ? `<span><i style="background:rgba(34,197,94,.25);border:1px dashed #22c55e"></i>Zona A (cerca de despacho)</span>` : '');
}
$('modes').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  view.mode = b.dataset.m;
  [...$('modes').children].forEach((x) => x.classList.toggle('on', x === b));
  renderLegend();
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
  if (e.key === 'Escape') { closeTablet(); $('dataModal').classList.remove('open'); }
  if (e.key === ' ' && e.target === document.body) { e.preventDefault(); $('play').click(); }
  if (e.key.toLowerCase() === 's' && e.target === document.body) $('smartBtn').click();
});

// API mínima para grabar el video de demo
window.__wms = { get st() { return st; }, get dim() { return dim; }, setDim, focusClark: (i, d) => { const c = st.clarks[i]; if (v3) v3.focus(c.x, c.y, d); },view,setSpeed: (s) => { speed = s; }, smart: () => $('smartBtn').click(), openTablet: (i) => openTablet(st.clarks[i]), closeTablet, selectLoc: (code) => { const l = st.locations.find((x) => x.code === code); view.selected = l; showDetail(l); }, step: (s) => stepSim(st, s) };

renderLegend();
boot();
resize();
let savedDim = '3d';
try { savedDim = localStorage.getItem('wms-demo-dim') || '3d'; } catch {}
setDim(savedDim);
requestAnimationFrame(frame);
