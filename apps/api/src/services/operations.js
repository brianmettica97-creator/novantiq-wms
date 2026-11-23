import { SQL } from './queries.js';
import { one } from '../db.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function umbrales(client, warehouseId) {
  const u = await one(client, SQL.umbrales, [warehouseId]);
  return { a: Number(u.umbral_a), b: Number(u.umbral_b) };
}

async function nextLpn(client, tenantId) {
  const r = await one(client, `SELECT COALESCE(max(substring(lpn_code from 5)::int), 0) + 1 AS n FROM pallets WHERE tenant_id = $1`, [tenantId]);
  return `LPN-${String(r.n).padStart(6, '0')}`;
}

// ---------- Recepción: crea el pallet en el muelle y su tarea de putaway ----------
export async function recibirPallet(client, ctx, { dockCodigo, skuCodigo, ean, cantidad, lote, vencimiento }) {
  const sku = await one(client,
    `SELECT id, clase_abc FROM skus WHERE tenant_id = $1 AND (codigo = $2 OR ean = $3)`, [ctx.tenantId, skuCodigo || null, ean || null]);
  if (!sku) throw new HttpError(404, 'SKU no encontrado');
  const dock = await one(client, `SELECT id, x, y FROM docks WHERE warehouse_id = $1 AND codigo = $2`, [ctx.warehouseId, dockCodigo]);
  if (!dock) throw new HttpError(404, 'Muelle no encontrado');

  let lotId = null;
  if (lote) {
    const l = await one(client,
      `INSERT INTO lots (tenant_id, sku_id, numero_lote, fecha_vencimiento) VALUES ($1,$2,$3,$4)
       ON CONFLICT (sku_id, numero_lote) DO UPDATE SET fecha_vencimiento = COALESCE(EXCLUDED.fecha_vencimiento, lots.fecha_vencimiento)
       RETURNING id`, [ctx.tenantId, sku.id, lote, vencimiento || null]);
    lotId = l.id;
  }
  const lpn = await nextLpn(client, ctx.tenantId);
  const pallet = await one(client,
    `INSERT INTO pallets (tenant_id, warehouse_id, lpn_code, estado) VALUES ($1,$2,$3,'EN_RECEPCION') RETURNING id, lpn_code`,
    [ctx.tenantId, ctx.warehouseId, lpn]);
  await client.query(
    `INSERT INTO pallet_contents (tenant_id, pallet_id, sku_id, lot_id, cantidad) VALUES ($1,$2,$3,$4,$5)`,
    [ctx.tenantId, pallet.id, sku.id, lotId, cantidad]);
  await client.query(
    `INSERT INTO stock_movements (tenant_id, tipo, pallet_id, sku_id, lot_id, cantidad, user_id) VALUES ($1,'RECEPCION',$2,$3,$4,$5,$6)`,
    [ctx.tenantId, pallet.id, sku.id, lotId, cantidad, ctx.userId || null]);

  const u = await umbrales(client, ctx.warehouseId);
  const destino = await one(client, SQL.ubicacionPutaway, [ctx.warehouseId, sku.clase_abc || 'C', u.a, u.b]);
  if (!destino) throw new HttpError(409, 'No hay ubicaciones libres');
  const task = await one(client,
    `INSERT INTO tasks (tenant_id, warehouse_id, tipo, pallet_id, from_dock_id, to_location_id, prioridad, origen_tipo)
     VALUES ($1,$2,'PUTAWAY',$3,$4,$5,3,'RECEPCION') RETURNING id`,
    [ctx.tenantId, ctx.warehouseId, pallet.id, dock.id, destino.id]);
  return { pallet, destino: destino.codigo, taskId: task.id };
}

// ---------- Pedido de salida: reserva FEFO y genera tareas de picking ----------
export async function crearPedido(client, ctx, { numero, destino, dockCodigo, prioridad = 5, lineas }) {
  const dock = await one(client, `SELECT id FROM docks WHERE warehouse_id = $1 AND codigo = $2 AND tipo <> 'ENTRADA'`, [ctx.warehouseId, dockCodigo]);
  if (!dock) throw new HttpError(404, 'Muelle de despacho no encontrado');
  const order = await one(client,
    `INSERT INTO outbound_orders (tenant_id, warehouse_id, numero, destino, prioridad, dock_id, estado)
     VALUES ($1,$2,$3,$4,$5,$6,'EN_PROCESO') RETURNING id`,
    [ctx.tenantId, ctx.warehouseId, numero, destino, prioridad, dock.id]);
  const tareas = [], faltantes = [];
  for (const { skuCodigo, pallets: cant } of lineas) {
    const sku = await one(client, `SELECT id FROM skus WHERE tenant_id = $1 AND codigo = $2`, [ctx.tenantId, skuCodigo]);
    if (!sku) { faltantes.push({ skuCodigo, motivo: 'SKU inexistente' }); continue; }
    const line = await one(client,
      `INSERT INTO outbound_lines (outbound_order_id, sku_id, cantidad) VALUES ($1,$2,$3) RETURNING id`, [order.id, sku.id, cant]);
    for (let i = 0; i < cant; i++) {
      const p = await one(client, SQL.palletFefo, [ctx.warehouseId, sku.id]);
      if (!p) { faltantes.push({ skuCodigo, motivo: 'sin stock disponible', pendientes: cant - i }); break; }
      await client.query(`UPDATE pallet_contents SET estado_calidad = 'RESERVADO' WHERE id = $1`, [p.content_id]);
      await client.query(`INSERT INTO reservations (outbound_line_id, pallet_content_id, cantidad) VALUES ($1,$2,$3)`, [line.id, p.content_id, p.cantidad]);
      const t = await one(client,
        `INSERT INTO tasks (tenant_id, warehouse_id, tipo, pallet_id, from_location_id, to_dock_id, prioridad, origen_tipo, origen_id)
         VALUES ($1,$2,'PICK',$3,$4,$5,$6,'PEDIDO',$7) RETURNING id`,
        [ctx.tenantId, ctx.warehouseId, p.pallet_id, p.location_id, dock.id, prioridad, order.id]);
      tareas.push(t.id);
    }
  }
  return { orderId: order.id, tareas, faltantes };
}

// ---------- Clark: pedir la próxima tarea ----------
export async function tomarTarea(client, ctx, { equipmentCodigo, x = 0, y = 0 }) {
  const eq = await one(client, `SELECT id FROM equipment WHERE warehouse_id = $1 AND codigo = $2`, [ctx.warehouseId, equipmentCodigo]);
  if (!eq) throw new HttpError(404, 'Equipo no encontrado');
  const abierta = await one(client,
    `SELECT id FROM tasks WHERE assigned_equipment_id = $1 AND estado IN ('ASIGNADA','EN_CURSO') LIMIT 1`, [eq.id]);
  const id = abierta ? abierta.id : (await one(client, SQL.proximaTarea, [ctx.warehouseId, eq.id, ctx.userId || null, x, y]))?.id;
  if (!id) return null;
  return one(client, SQL.detalleTarea, [id]);
}

// ---------- Clark: confirmar con doble escaneo ----------
// paso 'TOMAR': escanea la ubicación/muelle origen y el LPN
// paso 'DEJAR': escanea la ubicación/muelle destino
export async function confirmarPaso(client, ctx, taskId, { paso, scanUbicacion, scanLpn }) {
  const t = await one(client, SQL.detalleTarea + ' FOR UPDATE OF t', [taskId]);
  if (!t) throw new HttpError(404, 'Tarea inexistente');
  if (!['ASIGNADA', 'EN_CURSO'].includes(t.estado)) throw new HttpError(409, `La tarea está ${t.estado}`);

  if (paso === 'TOMAR') {
    const origen = t.desde_ubicacion || t.desde_muelle;
    if (scanUbicacion !== origen) throw new HttpError(422, `Ubicación incorrecta: esperaba ${origen}`);
    if (scanLpn !== t.lpn_code) throw new HttpError(422, `Pallet incorrecto: esperaba ${t.lpn_code}`);
    await client.query(`UPDATE tasks SET estado = 'EN_CURSO', started_at = now() WHERE id = $1`, [taskId]);
    await client.query(`UPDATE pallets SET estado = 'EN_TRANSITO', location_id = NULL WHERE id = $1`, [t.pallet_id]);
    return { ok: true, siguiente: t.hacia_ubicacion || t.hacia_muelle };
  }

  if (paso === 'DEJAR') {
    if (t.estado !== 'EN_CURSO') throw new HttpError(409, 'Primero escaneá el origen y el pallet');
    const destino = t.hacia_ubicacion || t.hacia_muelle;
    if (scanUbicacion !== destino) throw new HttpError(422, `Destino incorrecto: esperaba ${destino}`);
    const content = await one(client, `SELECT sku_id, lot_id, cantidad FROM pallet_contents WHERE pallet_id = $1 LIMIT 1`, [t.pallet_id]);
    const metros = await one(client,
      `SELECT abs(COALESCE(lt.x, dt.x) - COALESCE(lf.x, df.x)) + abs(COALESCE(lt.y, dt.y) - COALESCE(lf.y, df.y)) AS m
       FROM tasks t LEFT JOIN locations lf ON lf.id = t.from_location_id LEFT JOIN docks df ON df.id = t.from_dock_id
       LEFT JOIN locations lt ON lt.id = t.to_location_id LEFT JOIN docks dt ON dt.id = t.to_dock_id WHERE t.id = $1`, [taskId]);
    const tipoMov = { PUTAWAY: 'PUTAWAY', PICK: 'PICK', REPOSICION: 'REPOSICION', MOVE: 'MOVE' }[t.tipo] || 'MOVE';
    if (t.to_location_id) {
      await client.query(`UPDATE pallets SET estado = 'ALMACENADO', location_id = $2 WHERE id = $1`, [t.pallet_id, t.to_location_id]);
    } else {
      await client.query(`UPDATE pallets SET estado = 'EN_STAGING' WHERE id = $1`, [t.pallet_id]);
    }
    await client.query(
      `INSERT INTO stock_movements (tenant_id, tipo, pallet_id, sku_id, lot_id, cantidad, from_location_id, to_location_id,
                                    task_id, user_id, equipment_id, metros_recorridos)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [ctx.tenantId, tipoMov, t.pallet_id, content?.sku_id, content?.lot_id, content?.cantidad, t.from_location_id, t.to_location_id,
        taskId, t.assigned_user_id, t.assigned_equipment_id, metros?.m]);
    await client.query(
      `UPDATE tasks SET estado = 'COMPLETADA', completed_at = now(), metros_estimados = $2 WHERE id = $1`, [taskId, metros?.m]);
    await client.query(`UPDATE slotting_suggestions SET estado = 'EJECUTADA' WHERE task_id = $1`, [taskId]);
    return { ok: true, completada: true };
  }
  throw new HttpError(400, 'paso debe ser TOMAR o DEJAR');
}

// ---------- Clark: reportar un problema ----------
export async function reportarProblema(client, ctx, taskId, { motivo }) {
  const t = await one(client, `SELECT * FROM tasks WHERE id = $1 FOR UPDATE`, [taskId]);
  if (!t) throw new HttpError(404, 'Tarea inexistente');
  await client.query(`UPDATE tasks SET estado = 'CANCELADA' WHERE id = $1`, [taskId]);
  if (motivo === 'UBICACION_OCUPADA' && t.to_location_id) {
    await client.query(`UPDATE locations SET estado = 'BLOQUEADA' WHERE id = $1`, [t.to_location_id]);
  }
  if (motivo === 'PALLET_DANADO' && t.pallet_id) {
    await client.query(`UPDATE pallet_contents SET estado_calidad = 'DANADO' WHERE pallet_id = $1`, [t.pallet_id]);
  }
  return { ok: true };
}

// ---------- Slotting ----------
export async function generarSugerencias(client, ctx, { max = 30 } = {}) {
  const u = await umbrales(client, ctx.warehouseId);
  const { rows } = await client.query(SQL.sugerencias, [ctx.warehouseId, u.a, max]);
  await client.query(`DELETE FROM slotting_suggestions WHERE warehouse_id = $1 AND estado = 'PROPUESTA'`, [ctx.warehouseId]);
  for (const r of rows) {
    await client.query(
      `INSERT INTO slotting_suggestions (warehouse_id, sku_id, pallet_id, from_location_id, to_location_id, ahorro_metros_mes)
       VALUES ($1,$2,$3,$4,$5,$6)`, [ctx.warehouseId, r.sku_id, r.pallet_id, r.from_id, r.to_id, r.ahorro_metros_mes]);
  }
  return { umbrales: u, sugerencias: rows.length, ahorroTotalMetrosMes: Math.round(rows.reduce((s, r) => s + Number(r.ahorro_metros_mes), 0)) };
}

export async function aceptarSugerencias(client, ctx, { ids }) {
  const { rows } = await client.query(
    `SELECT * FROM slotting_suggestions WHERE warehouse_id = $1 AND estado = 'PROPUESTA' AND ($2::uuid[] IS NULL OR id = ANY($2)) FOR UPDATE`,
    [ctx.warehouseId, ids || null]);
  let creadas = 0;
  for (const s of rows) {
    const t = await one(client,
      `INSERT INTO tasks (tenant_id, warehouse_id, tipo, pallet_id, from_location_id, to_location_id, prioridad, origen_tipo, origen_id)
       VALUES ($1,$2,'REPOSICION',$3,$4,$5,7,'SLOTTING',$6)
       ON CONFLICT DO NOTHING RETURNING id`,
      [ctx.tenantId, ctx.warehouseId, s.pallet_id, s.from_location_id, s.to_location_id, s.id]);
    if (t) {
      await client.query(`UPDATE slotting_suggestions SET estado = 'ACEPTADA', task_id = $2 WHERE id = $1`, [s.id, t.id]);
      creadas++;
    }
  }
  return { tareasCreadas: creadas };
}
