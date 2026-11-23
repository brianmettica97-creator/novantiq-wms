// Estado visual de la vista 3D derivado de la simulación (sin Three.js, testeable en Node).
// La simulación no cambia: acá solo se interpreta su estado para animar torres, horquillas y pallets.
import { L, rackY } from '../../packages/engine/layout.js';
import { HANDLE_BASE, HANDLE_LEVEL } from '../../packages/engine/simulation.js';

export const LEVEL_H = 1.8;        // m entre niveles de viga
export const TRAVEL_FORK_H = 0.18; // altura de horquillas al circular
export const TRANSFER_AT = 0.55;   // fracción de la maniobra en que el pallet cambia de lugar
export const RACK_H = (L.levels - 1) * LEVEL_H + 1.9;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

/** Altura (m) de apoyo del pallet en una ubicación. */
export function slotBaseY(level) { return level === 0 ? 0 : level * LEVEL_H + 0.07; }

/** Centro (x, z) de la ubicación en el mundo 3D (z = y de la simulación). */
export function slotCenter(loc) { return { x: loc.x, z: rackY(loc.aisle, loc.side) + L.rackD / 2 }; }

/** Si el clark está maniobrando (tomar/dejar): referencia, nivel y avance 0..1. Si no, null. */
export function handleState(st, c) {
  if (!c.task || (c.phase !== 'handle1' && c.phase !== 'handle2')) return null;
  const ref = c.phase === 'handle1' ? c.task.from : c.task.to;
  const level = ref.kind === 'loc' ? st.locations[ref.id].level : 0;
  const total = HANDLE_BASE + level * HANDLE_LEVEL;
  return { ref, level, p: clamp01(1 - c.wait / total), pickup: c.phase === 'handle1' };
}

/** Altura de las horquillas durante la maniobra: sube, espera, baja. */
export function forkHeight(level, p) {
  const top = slotBaseY(level) + 0.1;
  const up = smooth(0.08, 0.4, p), down = smooth(0.7, 0.95, p);
  return TRAVEL_FORK_H + (top - TRAVEL_FORK_H) * up * (1 - down);
}

/** Extensión del mástil retráctil hacia el rack (0 = retraído, 1 = adentro del rack). */
export function reachAmount(p) { return smooth(0.4, 0.5, p) * (1 - smooth(0.6, 0.7, p)); }

/** Hacia dónde mira el clark mientras maniobra (radianes, mismo sistema que c.heading). */
export function facingHeading(st, ref) {
  if (ref.kind !== 'loc') return 0; // muelles: pared derecha (+x)
  return st.locations[ref.id].side === 0 ? -Math.PI / 2 : Math.PI / 2;
}

/**
 * Qué pallet se ve en cada ubicación y cuál lleva cada clark en las horquillas.
 * La simulación mueve el pallet al terminar la maniobra; acá el traspaso se adelanta a TRANSFER_AT
 * para que coincida con el momento en que la torre está arriba.
 */
export function palletVisuals(st) {
  const slots = new Map(); // locId → pallet
  for (const loc of st.locations) if (loc.palletId != null) slots.set(loc.id, st.palletMap.get(loc.palletId));
  const carried = new Map(); // clarkId → pallet
  for (const c of st.clarks) {
    if (c.carrying) carried.set(c.id, c.carrying);
    const h = handleState(st, c);
    if (!h || h.p < TRANSFER_AT) continue;
    if (h.pickup) {
      const p = st.palletMap.get(c.task.palletId);
      if (h.ref.kind === 'loc') slots.delete(h.ref.id);
      if (p) carried.set(c.id, p);
    } else {
      if (h.ref.kind === 'loc' && c.carrying) slots.set(h.ref.id, c.carrying);
      carried.delete(c.id);
    }
  }
  return { slots, carried };
}

/** Altura de la carga según cuántas cajas quedan (pallet incompleto = carga más baja). */
export function loadHeight(pallet, sku) {
  const full = 1.35;
  return full * Math.max(0.3, Math.min(1, pallet.qty / sku.casesPerPallet));
}

/** Interpola un ángulo por el camino más corto. */
export function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}
