import { L, rackY, aisleY, AISLE_LETTERS } from './layout.js';
import { zoneOf } from './slotting.js';
import { beamUse } from './capacity.js';

export const LOAD_COLORS = ['#14b8a6', '#22c55e', '#f59e0b', '#ef4444'];
export function loadColor(u) { return u < 0.5 ? LOAD_COLORS[0] : u < 0.8 ? LOAD_COLORS[1] : u < 0.95 ? LOAD_COLORS[2] : LOAD_COLORS[3]; }

export const PALETTE = {
  bg: '#070b14', floor: '#0e1626', floorLine: 'rgba(148,163,184,0.06)', wall: '#334155',
  rack: '#1e293b', rackEdge: '#3b4a63', empty: '#131c2e', text: '#94a3b8', textStrong: '#e2e8f0',
  A: '#22c55e', B: '#f59e0b', C: '#ef4444',
  DISPONIBLE: '#38bdf8', RESERVADO: '#a78bfa', CUARENTENA: '#f97316',
  occupied: '#3b82f6', reservedSlot: '#64748b',
  zoneA: 'rgba(34,197,94,0.13)', zoneB: 'rgba(245,158,11,0.06)',
  inDock: '#38bdf8', outDock: '#22c55e',
};

export const MODES = {
  rotacion: { label: 'Rotación ABC', legend: [['A · alta rotación', PALETTE.A], ['B · media', PALETTE.B], ['C · baja', PALETTE.C], ['Vacía', PALETTE.empty]] },
  estado: { label: 'Estado', legend: [['Disponible', PALETTE.DISPONIBLE], ['Reservado', PALETTE.RESERVADO], ['Cuarentena', PALETTE.CUARENTENA], ['Vacía', PALETTE.empty]] },
  vencimiento: { label: 'Vencimiento', legend: [['< 30 días', '#ef4444'], ['30–90 días', '#f59e0b'], ['90–180 días', '#a3e635'], ['> 180 días', '#14b8a6']] },
  ocupacion: { label: 'Ocupación', legend: [['Ocupada', PALETTE.occupied], ['Reservada (en camino)', PALETTE.reservedSlot], ['Libre', PALETTE.empty]] },
  carga: { label: 'Carga (kg)', legend: [['Viga < 50 %', '#14b8a6'], ['50–80 %', '#22c55e'], ['80–95 %', '#f59e0b'], ['> 95 % de su capacidad', '#ef4444']] },
};

export function createView() {
  return { zoom: 1, panX: 0, panY: 0, mode: 'rotacion', level: 'all', hover: null, selected: null, selectedClark: null, showZones: true, scale: 1, ox: 0, oy: 0 };
}

export function updateTransform(view, w, h) {
  const base = Math.min(w / L.W, h / L.H) * 0.98;
  view.scale = base * view.zoom;
  view.ox = (w - L.W * view.scale) / 2 + view.panX;
  view.oy = (h - L.H * view.scale) / 2 + view.panY;
}

export function toWorld(view, sx, sy) {
  return { x: (sx - view.ox) / view.scale, y: (sy - view.oy) / view.scale };
}

function locRect(loc, levelFilter) {
  const x = L.x0 + loc.col * L.bayW + 0.12;
  const w = L.bayW - 0.24;
  const y = rackY(loc.aisle, loc.side) + 0.12;
  const h = L.rackD - 0.24;
  if (levelFilter !== 'all') return { x, y, w, h };
  const sw = w / L.levels;
  return { x: x + loc.level * sw + 0.04, y, w: sw - 0.08, h };
}

export function locColor(st, loc, mode) {
  const p = loc.palletId != null ? st.palletMap.get(loc.palletId) : null;
  if (mode === 'ocupacion') return p ? PALETTE.occupied : loc.reserved ? PALETTE.reservedSlot : PALETTE.empty;
  if (mode === 'carga') return p || loc.reserved ? (loc.id == null ? PALETTE.occupied : loadColor(beamUse(st, loc))) : PALETTE.empty;
  if (!p) return loc.reserved ? PALETTE.reservedSlot : PALETTE.empty;
  if (mode === 'rotacion') return PALETTE[st.skuMap.get(p.skuId).abc];
  if (mode === 'estado') return PALETTE[p.status];
  if (mode === 'vencimiento') return p.exp < 30 ? '#ef4444' : p.exp < 90 ? '#f59e0b' : p.exp < 180 ? '#a3e635' : '#14b8a6';
  return PALETTE.empty;
}

export function hitTest(st, view, sx, sy) {
  const w = toWorld(view, sx, sy);
  for (const c of st.clarks) if (Math.hypot(c.x - w.x, c.y - w.y) < 1.6) return { type: 'clark', clark: c };
  if (w.x < L.x0 || w.x > L.rackEndX) return null;
  const col = Math.floor((w.x - L.x0) / L.bayW);
  for (let i = 0; i < L.aisles; i++) {
    for (let side = 0; side < 2; side++) {
      const y0 = rackY(i, side);
      if (w.y >= y0 && w.y <= y0 + L.rackD) {
        let level = view.level === 'all' ? Math.floor(((w.x - L.x0 - col * L.bayW) / L.bayW) * L.levels) : Number(view.level);
        level = Math.max(0, Math.min(L.levels - 1, level));
        const idx = (((i * 2 + side) * L.bays) + col) * L.levels + level;
        return { type: 'loc', loc: st.locations[idx] };
      }
    }
  }
  return null;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function drawClark(ctx, st, c, s, selected, mode) {
  ctx.save();
  ctx.translate(c.x * s, c.y * s);
  ctx.rotate(c.heading);
  const len = 2.3 * s, wid = 1.25 * s;
  if (selected) {
    ctx.beginPath(); ctx.arc(0, 0, 2.4 * s, 0, Math.PI * 2);
    ctx.fillStyle = c.color + '33'; ctx.fill();
  }
  // horquillas
  ctx.fillStyle = '#cbd5e1';
  ctx.fillRect(len * 0.45, -wid * 0.32, len * 0.5, wid * 0.12);
  ctx.fillRect(len * 0.45, wid * 0.2, len * 0.5, wid * 0.12);
  // pallet transportado
  if (c.carrying) {
    const sku = st.skuMap.get(c.carrying.skuId);
    ctx.fillStyle = mode === 'estado' ? PALETTE[c.carrying.status] : PALETTE[sku.abc];
    roundRect(ctx, len * 0.48, -wid * 0.45, len * 0.48, wid * 0.9, 0.1 * s); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.stroke();
  }
  // cuerpo
  ctx.fillStyle = c.color;
  roundRect(ctx, -len * 0.5, -wid * 0.5, len * 0.95, wid, 0.22 * s); ctx.fill();
  ctx.fillStyle = 'rgba(7,11,20,0.75)';
  roundRect(ctx, -len * 0.2, -wid * 0.32, len * 0.42, wid * 0.64, 0.12 * s); ctx.fill();
  ctx.restore();
  // etiqueta
  ctx.font = `700 ${Math.max(9, 0.95 * s)}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#0b1220';
  ctx.fillText(String(c.id), c.x * s, c.y * s);
}

export function drawMap(ctx, st, view, w, h, now = 0, dpr = 1) {
  updateTransform(view, w, h);
  const s = view.scale;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = PALETTE.bg; ctx.fillRect(0, 0, w, h);
  ctx.translate(view.ox, view.oy);

  // piso y grilla
  ctx.fillStyle = PALETTE.floor;
  ctx.fillRect(0, 0, L.dockX * s, L.H * s);
  ctx.strokeStyle = PALETTE.floorLine; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= L.dockX; x += 5) { ctx.moveTo(x * s, 0); ctx.lineTo(x * s, L.H * s); }
  for (let y = 0; y <= L.H; y += 5) { ctx.moveTo(0, y * s); ctx.lineTo(L.dockX * s, y * s); }
  ctx.stroke();
  ctx.strokeStyle = PALETTE.wall; ctx.lineWidth = Math.max(2, 0.25 * s);
  ctx.strokeRect(0, 0, L.dockX * s, L.H * s);

  // staging
  ctx.fillStyle = 'rgba(148,163,184,0.05)';
  ctx.fillRect(L.stageX0 * s, L.margin * s, (L.dockX - L.stageX0 - 0.6) * s, (L.H - 2 * L.margin) * s);
  ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(148,163,184,0.25)'; ctx.lineWidth = 1;
  ctx.strokeRect(L.stageX0 * s, L.margin * s, (L.dockX - L.stageX0 - 0.6) * s, (L.H - 2 * L.margin) * s);
  ctx.setLineDash([]);

  const fs = Math.max(9, Math.min(13, 0.85 * s));
  ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = PALETTE.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.save(); ctx.translate((L.stageX0 + 1.1) * s, (L.H / 2) * s); ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = 'rgba(148,163,184,0.45)'; ctx.fillText('ZONA DE STAGING', 0, 0); ctx.restore();
  ctx.save(); ctx.translate(L.mainX * s, (L.H / 2) * s); ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = 'rgba(148,163,184,0.35)'; ctx.fillText('PASILLO PRINCIPAL', 0, 0); ctx.restore();

  // zonas de slotting (fondo)
  if (view.showZones && st.thrA != null) {
    for (const loc of st.locations) {
      if (loc.level !== 0) continue;
      const z = zoneOf(st, loc);
      if (z === 'C') continue;
      ctx.fillStyle = z === 'A' ? PALETTE.zoneA : PALETTE.zoneB;
      const x = L.x0 + loc.col * L.bayW, y = rackY(loc.aisle, loc.side);
      ctx.fillRect(x * s, (y - 0.15) * s, L.bayW * s, (L.rackD + 0.3) * s);
    }
  }

  // racks
  for (let i = 0; i < L.aisles; i++) {
    for (let side = 0; side < 2; side++) {
      const y = rackY(i, side);
      ctx.fillStyle = PALETTE.rack;
      ctx.fillRect(L.x0 * s, y * s, (L.rackEndX - L.x0) * s, L.rackD * s);
    }
    ctx.fillStyle = PALETTE.textStrong;
    ctx.font = `800 ${fs + 2}px Inter, system-ui, sans-serif`;
    ctx.fillText(AISLE_LETTERS[i], L.backX * s, aisleY(i) * s);
  }
  const lf = view.level;
  for (const loc of st.locations) {
    if (lf !== 'all' && loc.level !== Number(lf)) continue;
    const r = locRect(loc, lf);
    ctx.fillStyle = locColor(st, loc, view.mode);
    ctx.fillRect(r.x * s, r.y * s, r.w * s, r.h * s);
  }
  // columnas (parantes)
  ctx.strokeStyle = PALETTE.rackEdge; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < L.aisles; i++) for (let side = 0; side < 2; side++) {
    const y = rackY(i, side);
    for (let c = 0; c <= L.bays; c++) { const x = (L.x0 + c * L.bayW) * s; ctx.moveTo(x, y * s); ctx.lineTo(x, (y + L.rackD) * s); }
  }
  ctx.stroke();

  // destinos activos (pulso)
  const pulse = 0.5 + 0.5 * Math.sin(now / 220);
  for (const c of st.clarks) {
    if (!c.task) continue;
    const ref = c.phase === 'toFrom' || c.phase === 'handle1' ? c.task.from : c.task.to;
    if (ref.kind !== 'loc') continue;
    const loc = st.locations[ref.id];
    const r = locRect(loc, lf === 'all' ? 'all' : lf);
    ctx.strokeStyle = c.color; ctx.globalAlpha = 0.45 + 0.55 * pulse; ctx.lineWidth = 2;
    const pad = 0.25 + pulse * 0.25;
    ctx.strokeRect((r.x - pad) * s, (r.y - pad) * s, (r.w + pad * 2) * s, (r.h + pad * 2) * s);
    ctx.globalAlpha = 1;
  }

  // hover / selección
  for (const [loc, col] of [[view.hover, 'rgba(255,255,255,0.7)'], [view.selected, '#ffffff']]) {
    if (!loc) continue;
    const r = locRect(loc, lf);
    ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.strokeRect(r.x * s - 1, r.y * s - 1, r.w * s + 2, r.h * s + 2);
  }

  // muelles y camiones
  for (const d of st.docks) {
    const col = d.kind === 'ENTRADA' ? PALETTE.inDock : PALETTE.outDock;
    const dh = 3.2;
    ctx.fillStyle = col + '33';
    ctx.fillRect((L.dockX - 1.2) * s, (d.y - dh / 2) * s, 1.2 * s, dh * s);
    ctx.fillStyle = col; ctx.fillRect((L.dockX - 0.15) * s, (d.y - dh / 2) * s, 0.3 * s, dh * s);
    // camión
    ctx.fillStyle = '#1f2a3d';
    roundRect(ctx, (L.dockX + 0.6) * s, (d.y - 1.25) * s, 5.2 * s, 2.5 * s, 0.3 * s); ctx.fill();
    ctx.fillStyle = '#2b3a54';
    roundRect(ctx, (L.dockX + 5.9) * s, (d.y - 1.1) * s, 1.4 * s, 2.2 * s, 0.3 * s); ctx.fill();
    ctx.fillStyle = col; ctx.font = `800 ${fs}px Inter, system-ui, sans-serif`;
    ctx.fillText(d.code, (L.dockX + 3.2) * s, (d.y - 0.45) * s);
    ctx.fillStyle = PALETTE.text; ctx.font = `700 ${Math.max(7, fs - 4)}px Inter, system-ui, sans-serif`;
    ctx.fillText(d.kind === 'ENTRADA' ? 'RECEPCIÓN' : 'DESPACHO', (L.dockX + 3.2) * s, (d.y + 0.65) * s);
  }

  // recorridos planificados
  for (const c of st.clarks) {
    if (!c.path.length) continue;
    ctx.strokeStyle = c.color; ctx.globalAlpha = view.selectedClark === c ? 0.95 : 0.5;
    ctx.lineWidth = view.selectedClark === c ? 2.5 : 1.5; ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(c.x * s, c.y * s);
    for (const p of c.path) ctx.lineTo(p.x * s, p.y * s);
    ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  for (const c of st.clarks) drawClark(ctx, st, c, s, view.selectedClark === c, view.mode);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// Mini gráfico del índice de recorrido
export function drawSparkline(ctx, history, baseline, w, h, color = '#22c55e', dpr = 1) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (history.length < 2) return;
  const vals = history.map((p) => p.index);
  const max = Math.max(baseline, ...vals) * 1.05, min = Math.min(...vals) * 0.9;
  const X = (i) => (i / (history.length - 1)) * (w - 4) + 2;
  const Y = (v) => h - 4 - ((v - min) / (max - min || 1)) * (h - 8);
  ctx.strokeStyle = 'rgba(239,68,68,0.6)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, Y(baseline)); ctx.lineTo(w, Y(baseline)); ctx.stroke(); ctx.setLineDash([]);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color + '55'); grad.addColorStop(1, color + '00');
  ctx.beginPath(); ctx.moveTo(X(0), h);
  vals.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
  ctx.lineTo(X(vals.length - 1), h); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath(); vals.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
}
