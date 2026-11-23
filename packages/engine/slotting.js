// Motor de slotting: zonas A/B/C por cercanía al muelle, putaway inteligente,
// sugerencias de reubicación y el "índice de recorrido" que mide el ahorro.

export const WORK_DAYS_PER_MONTH = 26;

function skuStockCounts(st) {
  const c = new Map();
  for (const p of st.palletMap.values()) if (p.locId != null) c.set(p.skuId, (c.get(p.skuId) || 0) + 1);
  return c;
}

// Umbrales de score que delimitan la zona A y la zona B
export function computeThresholds(st) {
  const byClass = { A: 0, B: 0, C: 0 };
  for (const p of st.palletMap.values()) byClass[st.skuMap.get(p.skuId).abc]++;
  const sorted = [...st.locations].sort((a, b) => a.score - b.score);
  const nA = Math.min(sorted.length - 1, Math.ceil(byClass.A * 1.12));
  const nB = Math.min(sorted.length - 1, nA + Math.ceil(byClass.B * 1.12));
  st.thrA = sorted[nA].score;
  st.thrB = sorted[nB].score;
  return { thrA: st.thrA, thrB: st.thrB };
}

export function zoneOf(st, loc) {
  return loc.score <= st.thrA ? 'A' : loc.score <= st.thrB ? 'B' : 'C';
}

// Metros promedio por picking (ida y vuelta desde el muelle), ponderado por rotación
export function travelIndex(st) {
  const sum = new Map(), cnt = new Map();
  for (const p of st.palletMap.values()) {
    if (p.locId == null || p.status === 'CUARENTENA') continue;
    const loc = st.locations[p.locId];
    sum.set(p.skuId, (sum.get(p.skuId) || 0) + loc.score);
    cnt.set(p.skuId, (cnt.get(p.skuId) || 0) + 1);
  }
  let num = 0, den = 0;
  for (const [skuId, s] of sum) {
    const sku = st.skuMap.get(skuId);
    num += sku.ppd * (s / cnt.get(skuId)) * 2;
    den += sku.ppd;
  }
  return den ? num / den : 0;
}

function freeLocations(st) {
  return st.locations.filter((l) => l.palletId == null && !l.reserved);
}

// ¿Dónde guardo un pallet que acaba de llegar?
export function choosePutawayLocation(st, sku, smart) {
  const free = freeLocations(st);
  if (!free.length) return null;
  if (!smart) return st.rng.pick(free); // "donde haya lugar" (lo que pasa hoy sin WMS)
  free.sort((a, b) => a.score - b.score);
  const want = sku.abc;
  if (want === 'A') return free[0];
  const minScore = want === 'B' ? st.thrA : st.thrB;
  return free.find((l) => l.score > minScore) || free[free.length - 1];
}

// Sugerencias de reubicación con ahorro estimado en metros por mes
export function computeSuggestions(st, max = 40) {
  computeThresholds(st);
  const counts = skuStockCounts(st);
  const busy = st.targetedPallets;
  const free = freeLocations(st).sort((a, b) => a.score - b.score);
  const freeA = free.filter((l) => l.score <= st.thrA);
  const freeFar = free.filter((l) => l.score > st.thrB);

  const ppdPallet = (p) => st.skuMap.get(p.skuId).ppd / (counts.get(p.skuId) || 1);
  const stored = [...st.palletMap.values()].filter((p) => p.locId != null && !busy.has(p.id) && p.status !== 'CUARENTENA');

  const misplacedA = stored
    .filter((p) => st.skuMap.get(p.skuId).abc === 'A' && st.locations[p.locId].score > st.thrA)
    .sort((a, b) => (st.locations[b.locId].score - st.thrA) * ppdPallet(b) - (st.locations[a.locId].score - st.thrA) * ppdPallet(a));
  const cInA = stored
    .filter((p) => st.skuMap.get(p.skuId).abc === 'C' && st.locations[p.locId].score <= st.thrA)
    .sort((a, b) => st.locations[a.locId].score - st.locations[b.locId].score);

  const out = [];
  let ia = 0;
  for (const p of misplacedA) {
    if (out.length >= max) break;
    const to = freeA[ia];
    if (!to) break;
    ia++;
    const from = st.locations[p.locId];
    out.push({
      kind: 'A_CERCA', palletId: p.id, fromId: from.id, toId: to.id,
      savings: Math.round((from.score - to.score) * 2 * ppdPallet(p) * WORK_DAYS_PER_MONTH),
    });
  }
  // Si no hay huecos en la zona A, liberar lugar sacando productos C de ahí
  let ic = 0;
  const needSpace = misplacedA.length > ia;
  for (const p of needSpace ? cInA : []) {
    if (out.length >= max) break;
    const to = freeFar[ic++];
    if (!to) break;
    const from = st.locations[p.locId];
    out.push({ kind: 'C_LIBERA', palletId: p.id, fromId: from.id, toId: to.id, savings: 0 });
  }
  out.sort((a, b) => b.savings - a.savings);
  st.suggestions = out;
  return out;
}
