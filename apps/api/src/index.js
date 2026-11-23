import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { z } from 'zod';
import { pool, tx } from './db.js';
import { SQL } from './services/queries.js';
import * as ops from './services/operations.js';

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || true }));
app.use(express.json({ limit: '1mb' }));

const http = createServer(app);
const io = new Server(http, { cors: { origin: process.env.CORS_ORIGIN?.split(',') || '*' } });

// Contexto por request. En producción tenant/usuario salen del JWT; acá de headers para la demo.
app.use((req, _res, next) => {
  req.ctx = {
    tenantId: req.header('x-tenant-id') || process.env.DEFAULT_TENANT_ID,
    warehouseId: req.header('x-warehouse-id') || process.env.DEFAULT_WAREHOUSE_ID,
    userId: req.header('x-user-id') || null,
  };
  next();
});

const room = (ctx) => `wh:${ctx.warehouseId}`;
const emit = (ctx, event, payload) => io.to(room(ctx)).emit(event, payload);
const h = (fn) => (req, res, next) => fn(req, res).catch(next);

// ---------- Lectura ----------
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/mapa', h(async (req, res) => {
  const rows = await tx(req.ctx.tenantId, (c) => c.query(SQL.mapa, [req.ctx.warehouseId]).then((r) => r.rows));
  res.json(rows);
}));

app.get('/api/kpis', h(async (req, res) => {
  const data = await tx(req.ctx.tenantId, async (c) => {
    await c.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_ocupacion').catch(() => {});
    const k = (await c.query(SQL.kpis, [req.ctx.warehouseId])).rows[0];
    const productividad = (await c.query(SQL.productividad, [req.ctx.warehouseId])).rows;
    const vencimientos = (await c.query(
      `SELECT * FROM v_vencimientos_proximos WHERE warehouse_id = $1 ORDER BY dias_restantes LIMIT 20`, [req.ctx.warehouseId])).rows;
    return { ...k, ocupacion: k.ubicaciones ? Number(k.pallets) / Number(k.ubicaciones) : 0, productividad, vencimientos };
  });
  res.json(data);
}));

app.get('/api/pallets/:lpn', h(async (req, res) => {
  const row = await tx(req.ctx.tenantId, async (c) => (await c.query(
    `SELECT p.*, l.codigo AS ubicacion, s.codigo AS sku, s.descripcion, s.clase_abc, lo.numero_lote, lo.fecha_vencimiento, pc.cantidad, pc.estado_calidad
     FROM pallets p LEFT JOIN locations l ON l.id = p.location_id JOIN pallet_contents pc ON pc.pallet_id = p.id
     JOIN skus s ON s.id = pc.sku_id LEFT JOIN lots lo ON lo.id = pc.lot_id
     WHERE p.tenant_id = $1 AND p.lpn_code = $2`, [req.ctx.tenantId, req.params.lpn])).rows[0]);
  if (!row) return res.status(404).json({ error: 'Pallet no encontrado' });
  res.json(row);
}));

app.get('/api/pallets/:lpn/historial', h(async (req, res) => {
  const rows = await tx(req.ctx.tenantId, async (c) => (await c.query(
    `SELECT m.created_at, m.tipo, lf.codigo AS desde, lt.codigo AS hacia, u.nombre AS operario, m.metros_recorridos
     FROM stock_movements m JOIN pallets p ON p.id = m.pallet_id
     LEFT JOIN locations lf ON lf.id = m.from_location_id LEFT JOIN locations lt ON lt.id = m.to_location_id
     LEFT JOIN users u ON u.id = m.user_id
     WHERE p.tenant_id = $1 AND p.lpn_code = $2 ORDER BY m.created_at`, [req.ctx.tenantId, req.params.lpn])).rows);
  res.json(rows);
}));

// ---------- Operación ----------
const recepcionSchema = z.object({
  dockCodigo: z.string(), skuCodigo: z.string().optional(), ean: z.string().optional(),
  cantidad: z.number().int().positive(), lote: z.string().optional(), vencimiento: z.string().optional(),
}).refine((b) => b.skuCodigo || b.ean, 'Indicá skuCodigo o ean');

app.post('/api/recepciones', h(async (req, res) => {
  const body = recepcionSchema.parse(req.body);
  const r = await tx(req.ctx.tenantId, (c) => ops.recibirPallet(c, req.ctx, body));
  emit(req.ctx, 'tarea:nueva', { taskId: r.taskId });
  emit(req.ctx, 'mapa:cambio', {});
  res.status(201).json(r);
}));

const pedidoSchema = z.object({
  numero: z.string(), destino: z.string().optional(), dockCodigo: z.string(), prioridad: z.number().int().min(1).max(9).optional(),
  lineas: z.array(z.object({ skuCodigo: z.string(), pallets: z.number().int().positive() })).min(1),
});
app.post('/api/pedidos', h(async (req, res) => {
  const r = await tx(req.ctx.tenantId, (c) => ops.crearPedido(c, req.ctx, pedidoSchema.parse(req.body)));
  emit(req.ctx, 'tarea:nueva', { cantidad: r.tareas.length });
  res.status(201).json(r);
}));

app.post('/api/tareas/siguiente', h(async (req, res) => {
  const body = z.object({ equipmentCodigo: z.string(), x: z.number().optional(), y: z.number().optional() }).parse(req.body);
  const t = await tx(req.ctx.tenantId, (c) => ops.tomarTarea(c, req.ctx, body));
  if (!t) return res.status(204).end();
  emit(req.ctx, 'tarea:asignada', { taskId: t.id, equipo: body.equipmentCodigo });
  res.json(t);
}));

app.post('/api/tareas/:id/confirmar', h(async (req, res) => {
  const body = z.object({ paso: z.enum(['TOMAR', 'DEJAR']), scanUbicacion: z.string(), scanLpn: z.string().optional() }).parse(req.body);
  const r = await tx(req.ctx.tenantId, (c) => ops.confirmarPaso(c, req.ctx, req.params.id, body));
  emit(req.ctx, 'mapa:cambio', { taskId: req.params.id, paso: body.paso });
  res.json(r);
}));

app.post('/api/tareas/:id/problema', h(async (req, res) => {
  const body = z.object({ motivo: z.enum(['UBICACION_OCUPADA', 'PALLET_DANADO', 'FALTANTE', 'OTRO']) }).parse(req.body);
  const r = await tx(req.ctx.tenantId, (c) => ops.reportarProblema(c, req.ctx, req.params.id, body));
  emit(req.ctx, 'alerta', { tipo: 'PROBLEMA', taskId: req.params.id, motivo: body.motivo });
  res.json(r);
}));

// ---------- Slotting ----------
app.post('/api/slotting/recalcular-abc', h(async (req, res) => {
  const dias = Number(req.body?.dias || 90);
  const rows = await tx(req.ctx.tenantId, (c) => c.query(SQL.recalcularAbc, [req.ctx.tenantId, dias]).then((r) => r.rows));
  res.json({ actualizados: rows.length });
}));
app.post('/api/slotting/sugerencias', h(async (req, res) => {
  res.json(await tx(req.ctx.tenantId, (c) => ops.generarSugerencias(c, req.ctx, req.body || {})));
}));
app.get('/api/slotting/sugerencias', h(async (req, res) => {
  const rows = await tx(req.ctx.tenantId, async (c) => (await c.query(
    `SELECT ss.id, ss.estado, ss.ahorro_metros_mes, p.lpn_code, s.codigo AS sku, s.descripcion, lf.codigo AS desde, lt.codigo AS hacia
     FROM slotting_suggestions ss JOIN pallets p ON p.id = ss.pallet_id JOIN skus s ON s.id = ss.sku_id
     JOIN locations lf ON lf.id = ss.from_location_id JOIN locations lt ON lt.id = ss.to_location_id
     WHERE ss.warehouse_id = $1 AND ss.estado = 'PROPUESTA' ORDER BY ss.ahorro_metros_mes DESC`, [req.ctx.warehouseId])).rows);
  res.json(rows);
}));
app.post('/api/slotting/aceptar', h(async (req, res) => {
  const r = await tx(req.ctx.tenantId, (c) => ops.aceptarSugerencias(c, req.ctx, req.body || {}));
  emit(req.ctx, 'tarea:nueva', { cantidad: r.tareasCreadas });
  res.json(r);
}));

// ---------- Errores ----------
app.use((err, _req, res, _next) => {
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'Datos inválidos', detalle: err.issues });
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Error interno' });
});

// ---------- Tiempo real ----------
io.on('connection', (socket) => {
  const warehouseId = socket.handshake.auth?.warehouseId || process.env.DEFAULT_WAREHOUSE_ID;
  socket.join(`wh:${warehouseId}`);
  // Posición de los clarks (la tablet la envía cada pocos segundos)
  socket.on('clark:posicion', (p) => socket.to(`wh:${warehouseId}`).emit('clark:posicion', p));
});

const port = Number(process.env.PORT || 4000);
http.listen(port, () => console.log(`NOVANTIQ WMS API escuchando en :${port}`));
process.on('SIGTERM', () => { http.close(); pool.end(); });
