// Recorrido guiado: cámara cinematográfica + textos sobre la simulación en vivo.
// Es determinista respecto de su reloj (t en segundos): se puede reproducir en tiempo real
// o avanzar cuadro a cuadro para grabar un video sin saltos.
import { L, aisleY } from '../../packages/engine/layout.js';

const CX = L.dockX / 2, CZ = L.H / 2;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/**
 * ctx: { v3, st(), setLook(l), setMode(m), setSmart(on), setSpeed(x), search(q) → result, clearSearch(),
 *        caption(title, sub, alpha), kpis(on), resultCard(on), end(on), labels(on) }
 */
export function createTour(ctx) {
  let followed = null;
  const S = [
    {
      dur: 8, title: 'NOVANTIQ <em>WMS</em>', sub: 'Tu depósito, en vivo',
      enter() { ctx.setLook('real'); ctx.setMode('rotacion'); ctx.setSpeed(8); ctx.labels(false); ctx.paths(false); },
      cam: (t) => orbit(t, { r0: 190, r1: 120, h0: 70, h1: 42, a0: 2.2, a1: 1.35, target: [CX + 10, 0, CZ] }),
    },
    {
      dur: 7, title: 'Camiones en el <em>andén</em>', sub: 'Recepción y despacho, muelle por muelle',
      cam: (t) => path(t, [L.dockX + 36, 9, CZ + 18], [L.dockX + 20, 4.5, CZ + 8], [L.dockX + 4, 4, CZ + 4], [L.dockX + 2, 3.5, CZ - 8]),
    },
    {
      dur: 8, title: '<em>1.920</em> posiciones', sub: '1.500 pallets, cada uno con ubicación, lote y vencimiento',
      enter() { ctx.paths(true); },
      cam: (t) => path(t, [L.dockX + 20, 30, CZ + 30], [CX + 30, 40, CZ + 34], [CX + 4, 0, CZ], [CX - 4, 0, CZ]),
    },
    {
      dur: 9, title: 'A la altura del <em>operario</em>', sub: 'Racks selectivos, 4 niveles, clarks retráctiles',
      cam: (t) => path(t, [L.rackEndX + 9, 1.8, aisleY(2) + 0.6], [L.rackEndX - 22, 1.7, aisleY(2) + 0.4], [L.rackEndX - 30, 2.4, aisleY(2)], [L.x0 + 4, 2.2, aisleY(2)]),
    },
    {
      dur: 6, title: 'Buscás un <em>producto</em>…', sub: 'Por LPN, código o nombre',
      enter() { ctx.resultCard(false); this.res = ctx.search('Yerba mate'); },
      cam: (t, self) => {
        const loc = self.res?.loc; if (!loc) return null;
        return path(t, [L.rackEndX - 22, 6, aisleY(2)], [loc.x + 18, 14, aisleY(loc.aisle) + 9], [L.rackEndX - 40, 3, aisleY(2)], [loc.x, 2, aisleY(loc.aisle)]);
      },
    },
    {
      dur: 8, title: '…y lo <em>ves</em>.', sub: 'Ubicación exacta, FEFO y el clark más cercano',
      enter() { ctx.resultCard(true); const loc = S[4].res?.loc; if (loc) ctx.v3.flyToLoc(loc, 2.4); },
      cam: () => null,
    },
    {
      dur: 9, title: 'Cada clark sabe <em>qué hacer</em>', sub: 'Tarea, ruta y doble escaneo en la tablet',
      enter() { ctx.resultCard(false); ctx.clearSearch(); ctx.labels(false); followed = pickClark(ctx.st()); },
      cam: (t) => chase(ctx.st(), followed, t),
    },
    {
      dur: 10, title: 'Lo que más sale, <em>más cerca</em>', sub: 'Slotting inteligente: los productos A se acercan al despacho',
      enter() { ctx.labels(false); ctx.setLook('analisis'); ctx.setMode('rotacion'); ctx.setSmart(true); ctx.setSpeed(90); },
      cam: (t) => path(t, [CX - 6, 62, CZ + 22], [CX + 4, 66, CZ + 12], [CX + 2, 0, CZ], [CX + 6, 0, CZ]),
    },
    {
      dur: 8, title: '<em>FEFO</em>: primero sale lo que vence antes', sub: 'Alertas de vencimiento y valor en riesgo',
      enter() { ctx.setMode('vencimiento'); ctx.setSpeed(20); },
      cam: (t) => path(t, [CX + 4, 66, CZ + 12], [L.x0 + 14, 22, aisleY(4) + 16], [CX + 6, 0, CZ], [L.x0 + 18, 2, aisleY(4)]),
    },
    {
      dur: 10, title: 'Indicadores <em>en vivo</em>', sub: 'Ocupación, exactitud de stock, vencimientos y productividad',
      enter() { ctx.setLook('real'); ctx.setMode('rotacion'); ctx.kpis(true); ctx.setSpeed(10); },
      cam: (t) => orbit(t, { r0: 70, r1: 62, h0: 44, h1: 38, a0: 0.9, a1: 0.35, target: [CX, 0, CZ] }),
    },
    {
      dur: 9, title: 'NOVANTIQ <em>WMS</em>', sub: 'Pedí la demo con el plano de tu depósito',
      enter() { ctx.kpis(false); ctx.end(true); ctx.paths(false); },
      cam: (t) => orbit(t, { r0: 95, r1: 175, h0: 40, h1: 70, a0: 0.35, a1: -0.2, target: [CX + 10, 0, CZ] }),
    },
  ];
  let start = 0; for (const s of S) { s.start = start; start += s.dur; }
  const total = start;

  let t = -1, cur = -1;
  function orbit(k, { r0, r1, h0, h1, a0, a1, target }) {
    const e = smooth(k), a = lerp(a0, a1, e), r = lerp(r0, r1, e);
    return { pos: [target[0] + Math.cos(a) * r, lerp(h0, h1, e), target[2] + Math.sin(a) * r], target };
  }
  function path(k, p0, p1, t0, t1) { const e = smooth(k); return { pos: lerp3(p0, p1, e), target: lerp3(t0, t1, e) }; }
  function pickClark(st) {
    return st.clarks.find((c) => !c.blocked && c.task && (c.phase === 'toFrom' || c.phase === 'toTo') && c.path.length) || st.clarks[0];
  }
  let chaseCam = null;
  function chase(st, c, k) {
    const hx = Math.cos(c.heading), hz = Math.sin(c.heading);
    const want = { pos: [c.x - hx * 9, 5.2 - k * 1.6, c.y - hz * 9 + 2.6], target: [c.x + hx * 3, 1.3, c.y + hz * 3] };
    if (!chaseCam) chaseCam = want;
    chaseCam = { pos: lerp3(chaseCam.pos, want.pos, 0.06), target: lerp3(chaseCam.target, want.target, 0.1) };
    return chaseCam;
  }
  function captionAlpha(s, local) { return Math.min(1, local / 0.5, (s.dur - local) / 0.5); }

  return {
    total, steps: S,
    get t() { return t; },
    get running() { return t >= 0 && t < total; },
    start() { t = 0; cur = -1; chaseCam = null; },
    stop() { t = -1; cur = -1; ctx.caption('', '', 0); ctx.kpis(false); ctx.resultCard(false); ctx.end(false); ctx.clearSearch(); ctx.labels(true); ctx.paths(true); },
    /** Avanza dt segundos y posiciona la cámara. Devuelve false al terminar. */
    tick(dt, now) {
      if (t < 0) return false;
      t += dt;
      if (t >= total) { this.stop(); return false; }
      let i = S.findIndex((s) => t >= s.start && t < s.start + s.dur);
      if (i !== cur) { cur = i; if (i === 6) chaseCam = null; S[i].enter?.call(S[i]); }
      const s = S[i], local = t - s.start, k = local / s.dur;
      const cam = s.cam?.(k, s);
      if (cam) ctx.v3.setCamera({ x: cam.pos[0], y: cam.pos[1], z: cam.pos[2] }, { x: cam.target[0], y: cam.target[1], z: cam.target[2] });
      ctx.caption(s.title, s.sub, captionAlpha(s, local), i);
      return true;
    },
  };
}
