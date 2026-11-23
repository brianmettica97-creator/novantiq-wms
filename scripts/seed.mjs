// Genera db/seed.sql y db/mock-data.json con el mismo generador que usa la demo.
// Uso: node scripts/seed.mjs [--pallets 1500] [--seed 2026]
//      psql "$DATABASE_URL" -f db/schema.sql && psql "$DATABASE_URL" -f db/seed.sql
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMockData } from '../packages/engine/mockdata.js';
import { L } from '../packages/engine/layout.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const data = generateMockData({ seed: arg('--seed', 2026), pallets: arg('--pallets', 1500) });

const q = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const out = [];
const ins = (table, rows) => {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  for (let i = 0; i < rows.length; i += 500) {
    out.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES\n` +
      rows.slice(i, i + 500).map((r) => '(' + cols.map((c) => q(r[c])).join(', ') + ')').join(',\n') + ';');
  }
};

const TENANT = '00000000-0000-4000-8000-000000000001';
const WH = '00000000-0000-4000-8000-000000000002';
out.push('BEGIN;');
ins('tenants', [{ id: TENANT, nombre: 'Logística Demo SA', plan: 'pro' }]);
ins('warehouses', [{ id: WH, tenant_id: TENANT, nombre: data.warehouse.name, direccion: 'Ezeiza, Buenos Aires', ancho_m: +L.W.toFixed(2), largo_m: +L.H.toFixed(2) }]);

const zone = { ALMACEN: randomUUID(), RECEPCION: randomUUID(), MUELLE: randomUUID(), CUARENTENA: randomUUID() };
ins('zones', Object.entries(zone).map(([tipo, id]) => ({ id, tenant_id: TENANT, warehouse_id: WH, codigo: tipo, tipo })));

const dockIds = data.docks.map(() => randomUUID());
ins('docks', data.docks.map((d, i) => ({ id: dockIds[i], tenant_id: TENANT, warehouse_id: WH, codigo: d.code, tipo: d.kind, x: +L.dockX.toFixed(2), y: +d.y.toFixed(2) })));

const locIds = data.locations.map(() => randomUUID());
ins('locations', data.locations.map((l, i) => ({
  id: locIds[i], tenant_id: TENANT, warehouse_id: WH, zone_id: zone.ALMACEN, codigo: l.code,
  pasillo: l.code[0], rack: l.rack, columna: l.col + 1, nivel: l.level,
  x: +l.x.toFixed(2), y: +l.access.y.toFixed(2), z: l.level * 1.6,
  tipo: 'RACK_SELECTIVO', distancia_a_muelle: l.dist, slot_score: l.score, pick_sequence: l.pickSeq,
})));

const clientIds = {};
for (const s of data.skus) clientIds[s.client] ||= randomUUID();
ins('clients', Object.entries(clientIds).map(([nombre, id]) => ({ id, tenant_id: TENANT, nombre })));

const skuIds = new Map(data.skus.map((s) => [s.id, randomUUID()]));
ins('skus', data.skus.map((s) => ({
  id: skuIds.get(s.id), tenant_id: TENANT, client_id: clientIds[s.client], codigo: s.code, descripcion: s.desc, ean: s.ean,
  cajas_por_pallet: s.casesPerPallet, regla_rotacion: 'FEFO', clase_abc: s.abc,
})));

const today = new Date();
const day = (n) => new Date(today.getTime() + n * 86400000).toISOString().slice(0, 10);
const lotKey = new Map(), lots = [];
for (const p of data.pallets) {
  const key = p.skuId + '|' + p.lot;
  if (!lotKey.has(key)) {
    const id = randomUUID(); lotKey.set(key, id);
    lots.push({ id, tenant_id: TENANT, sku_id: skuIds.get(p.skuId), numero_lote: p.lot, fecha_vencimiento: day(p.exp), fecha_fabricacion: day(p.exp - data.skus[p.skuId - 1].shelfLife) });
  }
}
ins('lots', lots);

const palletIds = data.pallets.map(() => randomUUID());
ins('pallets', data.pallets.map((p, i) => ({ id: palletIds[i], tenant_id: TENANT, warehouse_id: WH, lpn_code: p.lpn, location_id: locIds[p.locId], estado: 'ALMACENADO' })));
ins('pallet_contents', data.pallets.map((p, i) => ({
  tenant_id: TENANT, pallet_id: palletIds[i], sku_id: skuIds.get(p.skuId), lot_id: lotKey.get(p.skuId + '|' + p.lot), cantidad: p.qty,
  estado_calidad: p.status,
})));

// Historial de velocidad (base del ABC)
ins('sku_velocity', data.skus.map((s) => ({
  sku_id: skuIds.get(s.id), warehouse_id: WH, periodo_desde: day(-90), periodo_hasta: day(0),
  cant_picks: s.picks90, cant_unidades: s.picks90 * 3, picks_por_dia: s.ppd, clase_abc: s.abc,
})));

// Movimientos de recepción históricos
ins('stock_movements', data.pallets.map((p, i) => ({
  tenant_id: TENANT, tipo: 'RECEPCION', pallet_id: palletIds[i], sku_id: skuIds.get(p.skuId), cantidad: p.qty,
  to_location_id: locIds[p.locId], created_at: new Date(today.getTime() - p.receivedDaysAgo * 86400000).toISOString(),
})));

// Operarios y equipos
const ops = ['Marcos', 'Lucía', 'Diego', 'Romina', 'Julián'];
ins('users', [
  { tenant_id: TENANT, nombre: 'Supervisor Demo', rol: 'SUPERVISOR' },
  ...ops.map((n) => ({ tenant_id: TENANT, nombre: n, rol: 'CLARKISTA' })),
]);
ins('equipment', ops.map((_, i) => ({ tenant_id: TENANT, warehouse_id: WH, codigo: `CLK-0${i + 1}`, tipo: i < 3 ? 'RETRACTIL' : 'CLARK_CONTRAPESO', altura_max_cm: i < 3 ? 900 : 550 })));

ins('slotting_rules', [
  { warehouse_id: WH, nombre: 'Clase A cerca de despacho', condicion: '{"clase":"A"}', accion: '{"zona":"A","niveles":[0,1]}', prioridad: 1 },
  { warehouse_id: WH, nombre: 'Clase C al fondo y en altura', condicion: '{"clase":"C"}', accion: '{"zona":"C"}', prioridad: 3 },
]);
out.push('REFRESH MATERIALIZED VIEW mv_ocupacion;');
out.push('COMMIT;');

writeFileSync(join(root, 'db/seed.sql'), `-- Generado por scripts/seed.mjs · ${data.pallets.length} pallets · semilla ${data.seed}\n` + out.join('\n\n') + '\n');
writeFileSync(join(root, 'db/mock-data.json'), JSON.stringify({
  tenant_id: TENANT, warehouse_id: WH, warehouse: data.warehouse, docks: data.docks.map(({ node, ...d }) => d),
  skus: data.skus.map(({ history, ...s }) => s),
  pallets: data.pallets.map((p) => ({ ...p, ubicacion: data.locations[p.locId].code })),
}, null, 1));
console.log(`OK · db/seed.sql (${data.pallets.length} pallets, ${data.locations.length} ubicaciones, ${data.skus.length} SKUs)`);
