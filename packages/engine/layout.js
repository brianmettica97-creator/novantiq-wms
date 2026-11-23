// Geometría del depósito (todo en metros). Los pasillos corren de izquierda a derecha
// y los muelles están sobre la pared derecha.

export const L = {
  aisles: 6,        // pasillos A–F
  bays: 40,         // posiciones de pallet por rack (frente)
  levels: 4,        // niveles en altura (0 = piso)
  bayW: 1.35,       // ancho de una posición de pallet
  posPerBay: 2,     // posiciones por bahía: viga de 2,7 m con 2 pallets
  rackD: 1.6,       // profundidad del rack
  aisleW: 3.4,      // ancho de pasillo para clark retráctil
  gap: 0.5,         // espalda con espalda entre racks
  x0: 5,            // donde empiezan los racks
  margin: 2,
  levelPenalty: 4,  // metros "equivalentes" por cada nivel de altura (tiempo de elevación)
};
L.rackEndX = L.x0 + L.bays * L.bayW;
L.backX = 2.5;                    // pasillo de fondo
L.mainX = L.rackEndX + 3.5;       // pasillo principal (frente de racks)
L.stageX0 = L.rackEndX + 7;       // zona de staging
L.dockX = L.rackEndX + 13;        // pared de muelles
L.W = L.dockX + 8;                // incluye playa de camiones
L.unit = L.rackD * 2 + L.aisleW + L.gap;
L.H = L.margin * 2 + L.aisles * L.unit - L.gap;

export const AISLE_LETTERS = 'ABCDEFGHIJ';

export function aisleY(i) {
  return L.margin + i * L.unit + L.rackD + L.aisleW / 2;
}
export function rackY(i, side) {
  return L.margin + i * L.unit + (side === 0 ? 0 : L.rackD + L.aisleW);
}

// Camino por la red de pasillos (sin atravesar racks).
// Un punto es {x, y, aisle}; aisle = -1 significa pasillo principal / muelles.
export function routePath(a, b) {
  if (a.aisle >= 0 && b.aisle >= 0) {
    if (a.aisle === b.aisle) return [{ x: b.x, y: b.y }];
    const viaMain = (L.mainX - a.x) + (L.mainX - b.x);
    const viaBack = (a.x - L.backX) + (b.x - L.backX);
    const cx = viaMain <= viaBack ? L.mainX : L.backX;
    return [{ x: cx, y: a.y }, { x: cx, y: b.y }, { x: b.x, y: b.y }];
  }
  return [{ x: L.mainX, y: a.y }, { x: L.mainX, y: b.y }, { x: b.x, y: b.y }];
}

export function pathLength(start, pts) {
  let d = 0, px = start.x, py = start.y;
  for (const p of pts) { d += Math.hypot(p.x - px, p.y - py); px = p.x; py = p.y; }
  return d;
}

export function routeDistance(a, b) {
  return pathLength(a, routePath(a, b));
}

export function buildLayout() {
  const docks = [];
  const nDocks = 6;
  const span = L.H - 2 * L.margin;
  for (let k = 0; k < nDocks; k++) {
    const y = L.margin + (k + 0.5) * (span / nDocks);
    const inbound = k < 2;
    docks.push({
      id: k,
      code: inbound ? `R${k + 1}` : `D${k - 1}`,
      kind: inbound ? 'ENTRADA' : 'SALIDA',
      y,
      node: { x: L.dockX - 3, y, aisle: -1 },
    });
  }
  const outDocks = docks.filter((d) => d.kind === 'SALIDA');

  const locations = [];
  let id = 0;
  for (let i = 0; i < L.aisles; i++) {
    for (let side = 0; side < 2; side++) {
      const rack = i * 2 + side + 1;
      for (let col = 0; col < L.bays; col++) {
        for (let level = 0; level < L.levels; level++) {
          const x = L.x0 + col * L.bayW + L.bayW / 2;
          const access = { x, y: aisleY(i), aisle: i };
          let dist = Infinity;
          for (const d of outDocks) dist = Math.min(dist, routeDistance(access, d.node));
          const seqCol = i % 2 === 0 ? col : L.bays - 1 - col;
          locations.push({
            id: id++,
            code: `${AISLE_LETTERS[i]}-${String(rack).padStart(2, '0')}-${String(col + 1).padStart(2, '0')}-${level}`,
            aisle: i, side, rack, col, level,
            x, access,
            dist: Math.round(dist * 10) / 10,
            score: Math.round((dist + level * L.levelPenalty) * 10) / 10,
            pickSeq: i * L.bays * 2 + seqCol * 2 + side,
            palletId: null,
            reserved: false,
          });
        }
      }
    }
  }
  return { L, docks, locations };
}
