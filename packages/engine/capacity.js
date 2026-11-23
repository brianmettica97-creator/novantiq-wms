// Peso de los pallets y capacidad de carga de los racks.
//
// Rack selectivo: cada bahía (módulo) tiene 2 posiciones de frente y niveles de vigas.
//   - posición sobre vigas: máx. CAP.posKg por pallet
//   - par de vigas (un nivel de una bahía, 2 pallets): máx. CAP.beamKg
//   - módulo completo (todos los niveles sobre vigas de esa bahía): máx. CAP.bayKg
//   - piso (nivel 0): sin viga, solo el límite del pallet (CAP.floorKg)
// Los valores son típicos de racks selectivos y se configuran acá; en un depósito real salen de la
// placa de carga del fabricante del rack.
import { L } from './layout.js';

export const CAP = { posKg: 1200, beamKg: 2000, bayKg: 5400, floorKg: 1500, tareKg: 25, heavyKg: 800 };

export function palletKg(sku, qty) { return CAP.tareKg + qty * (sku.kgCase || 0); }
export function weightOf(st, p) { return palletKg(st.skuMap.get(p.skuId), p.qty); }

/** Índice de la ubicación en st.locations (mismo orden que buildLayout). */
function idx(aisle, side, col, level) { return (((aisle * 2 + side) * L.bays) + col) * L.levels + level; }
export function bayOf(loc) { return Math.floor(loc.col / L.posPerBay); }

/** Peso que hay (o va a haber) en una ubicación: pallet guardado + pallet en camino reservado. */
function kgAt(st, loc) {
  let kg = loc.reservedKg || 0;
  if (loc.palletId != null) { const p = st.palletMap.get(loc.palletId); if (p) kg += weightOf(st, p); }
  return kg;
}

/** Carga actual de la viga (nivel de la bahía) y del módulo de una ubicación. */
export function rackLoad(st, loc) {
  const bay = bayOf(loc), c0 = bay * L.posPerBay;
  let beam = 0, module = 0;
  for (let c = c0; c < c0 + L.posPerBay; c++) {
    for (let lv = 1; lv < L.levels; lv++) {
      const kg = kgAt(st, st.locations[idx(loc.aisle, loc.side, c, lv)]);
      module += kg;
      if (lv === loc.level) beam += kg;
    }
  }
  if (loc.level === 0) beam = kgAt(st, loc);
  return {
    beam, module,
    beamCap: loc.level === 0 ? CAP.floorKg : CAP.beamKg,
    moduleCap: CAP.bayKg,
    posCap: loc.level === 0 ? CAP.floorKg : CAP.posKg,
  };
}

/** ¿Entra un pallet de `kg` en `loc` sin superar la posición, la viga ni el módulo? */
export function canPlace(st, loc, kg) {
  if (loc.level === 0) return kg <= CAP.floorKg;
  if (kg > CAP.posKg) return false;
  const r = rackLoad(st, loc);
  return r.beam + kg <= CAP.beamKg && r.module + kg <= CAP.bayKg;
}

/** Uso de la viga (0..1+) para colorear el mapa. En el piso, peso del pallet sobre el máximo. */
export function beamUse(st, loc) {
  const r = rackLoad(st, loc);
  return loc.level === 0 ? r.beam / CAP.floorKg : r.beam / CAP.beamKg;
}

/** Resumen para indicadores: vigas y módulos por encima del 90 % y excedidos (no debería haber). */
export function capacityReport(st) {
  let beams = 0, beamsHigh = 0, beamsOver = 0, modules = 0, modulesHigh = 0, modulesOver = 0, maxBeam = 0;
  for (let i = 0; i < L.aisles; i++) for (let side = 0; side < 2; side++) for (let bay = 0; bay < L.bays / L.posPerBay; bay++) {
    const first = st.locations[idx(i, side, bay * L.posPerBay, 1)];
    const r = rackLoad(st, first);
    modules++; if (r.module > CAP.bayKg * 0.9) modulesHigh++; if (r.module > CAP.bayKg) modulesOver++;
    for (let lv = 1; lv < L.levels; lv++) {
      const b = rackLoad(st, st.locations[idx(i, side, bay * L.posPerBay, lv)]).beam;
      beams++; maxBeam = Math.max(maxBeam, b / CAP.beamKg);
      if (b > CAP.beamKg * 0.9) beamsHigh++; if (b > CAP.beamKg) beamsOver++;
    }
  }
  return { beams, beamsHigh, beamsOver, modules, modulesHigh, modulesOver, maxBeam };
}
