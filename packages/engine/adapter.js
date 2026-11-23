import { buildLayout } from './layout.js';
import { computeThresholds } from './slotting.js';

// Convierte la respuesta de GET /api/mapa en el estado que entiende el renderer.
export function stateFromApi(rows, clarks = []) {
  const { docks, locations } = buildLayout();
  const byCode = new Map(locations.map((l) => [l.code, l]));
  const palletMap = new Map(), skuMap = new Map();
  let pid = 1;
  for (const r of rows) {
    const loc = byCode.get(r.codigo);
    if (!loc) continue;
    loc.reserved = !!r.reservada;
    if (!r.pallet_id) continue;
    if (!skuMap.has(r.sku)) skuMap.set(r.sku, { id: r.sku, code: r.sku, desc: r.descripcion, abc: r.clase_abc || 'C', ppd: 0 });
    const p = {
      id: pid++, dbId: r.pallet_id, lpn: r.lpn_code, skuId: r.sku, lot: r.numero_lote,
      exp: r.dias_vencimiento == null ? 9999 : Number(r.dias_vencimiento), qty: r.cantidad,
      status: r.estado_calidad === 'DANADO' ? 'CUARENTENA' : r.estado_calidad, locId: loc.id,
    };
    loc.palletId = p.id;
    palletMap.set(p.id, p);
  }
  const st = { docks, locations, palletMap, skuMap, skus: [...skuMap.values()], clarks, tasks: [] };
  computeThresholds(st);
  return st;
}
