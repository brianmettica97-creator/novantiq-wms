# NOVANTIQ WMS

**▶ [Ver la demo en vivo](https://brianmettica97-creator.github.io/novantiq-wms/dist/wms-demo.html)**: depósito simulado en 3D, sin instalar nada (funciona en compu y celular).
**📄 [Guía para revisar la demo y camino al piloto](ROADMAP.md)**

Sistema de gestión de almacenes (WMS) para depósitos con autoelevadores: mapa en vivo,
app para la tablet del clark, putaway y picking FEFO, slotting inteligente ABC y dashboard de KPIs.

## Estructura

```
db/
  schema.sql          Esquema PostgreSQL completo (multi-tenant, RLS, movimientos inmutables)
  seed.sql            Datos de prueba: 300 pallets, 960 ubicaciones, 60 SKUs (generado)
  mock-data.json      Los mismos datos en JSON
packages/engine/      Motor compartido en JS puro (sin dependencias)
  layout.js           Geometría del depósito y rutas por pasillos
  mockdata.js         Generador de datos falsos (semilla → mismo depósito siempre)
  slotting.js         Zonas A/B/C, putaway inteligente, sugerencias y ahorro
  ops.js              Gestión: historia de pallets, inventario cíclico, recepción vs. remito, facturación, tablet, resumen
  simulation.js       Simulación de clarks, tareas y KPIs
  renderer.js         Dibujo del mapa en <canvas>
  adapter.js          Convierte la respuesta de la API en estado para el mapa
apps/api/             API Node (Express + pg + Socket.IO)
apps/web/             Frontend Next.js: dashboard, mapa en vivo y app del clark
apps/demo/            Demo comercial autocontenida
  view3d.js           Vista 3D con Three.js (racks, pallets, clarks retráctiles, muelles y camiones)
  scene-state.js      Animación 3D derivada de la simulación (torre, horquillas, traspaso del pallet)
dist/wms-demo.html    La demo armada en un solo archivo, Three.js incluido (abrir con doble clic)
scripts/              seed.mjs (genera el seed) · build-demo.mjs (arma la demo con esbuild)
tests/                Tests del motor y de la vista 3D (`npm test`, sin base de datos)
```

## Puesta en marcha (en tu compu)

Necesitás Node 20+ y Docker (o un PostgreSQL 16 instalado).

```bash
# 1. Base de datos
docker compose up -d
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/wms
npm run db:schema
npm run db:seed            # genera y carga 300 pallets

# 2. Dependencias
npm install

# 3. API (puerto 4000)
cp apps/api/.env.example apps/api/.env
npm run dev:api

# 4. Web (puerto 3000) — en otra terminal
cp apps/web/.env.example apps/web/.env.local
npm run dev:web
```

- `http://localhost:3000` → dashboard gerencial
- `http://localhost:3000/mapa` → mapa (fuente: simulación demo o API en vivo)
- `http://localhost:3000/clark` → app del clark (probala con un lector USB: funciona como teclado)

Para más pallets: `node scripts/seed.mjs --pallets 800 --seed 7`.

## Demo y tests

```bash
npm run demo:build   # arma dist/wms-demo.html (3D por defecto; botón 2D para el mapa plano)
npm test             # recepción/putaway, picking FEFO, slotting, inventario cíclico, facturación, tablet y animación 3D
```

La vista 3D usa la misma simulación que el mapa 2D. Arrastrá para girar, clic derecho para desplazar,
rueda para acercar; `⇶` recorre los pasillos a la altura del operario. Si el equipo no tiene WebGL, se abre el 2D.
Los tests corren sobre el motor en memoria; los endpoints de la API (SQL) todavía no tienen tests.

## Endpoints principales

| Método | Ruta | Qué hace |
|---|---|---|
| GET  | /api/mapa | Todas las ubicaciones con su pallet, SKU, lote y vencimiento |
| GET  | /api/kpis | Ocupación, tareas, tiempos, vencimientos, productividad por clark |
| POST | /api/recepciones | Recibe un pallet en un muelle y crea la tarea de putaway |
| POST | /api/pedidos | Crea un pedido, reserva stock FEFO y genera tareas de picking |
| POST | /api/tareas/siguiente | Asigna la próxima tarea al clark (sin choques: `SKIP LOCKED`) |
| POST | /api/tareas/:id/confirmar | Doble escaneo: `TOMAR` (ubicación + LPN) y `DEJAR` (destino) |
| POST | /api/tareas/:id/problema | Ubicación ocupada, pallet dañado, faltante |
| POST | /api/slotting/recalcular-abc | Reclasifica A/B/C con los picks de los últimos N días |
| POST | /api/slotting/sugerencias | Calcula reubicaciones con ahorro en metros/mes |
| POST | /api/slotting/aceptar | Convierte las sugerencias en tareas para los clarks |

Eventos de Socket.IO: `mapa:cambio`, `tarea:nueva`, `tarea:asignada`, `alerta`, `clark:posicion`.

## Decisiones de diseño

- **El stock nunca se pisa a mano**: cada cambio es un registro en `stock_movements` (un trigger impide editarlo o borrarlo).
- **Dos clarks nunca agarran la misma tarea**: `FOR UPDATE SKIP LOCKED` y un índice único que impide dos tareas abiertas hacia la misma ubicación.
- **Multi-tenant**: todas las tablas llevan `tenant_id` con Row Level Security. La API fija `app.tenant_id` por transacción
  (en producción conectate con un rol que no sea dueño de las tablas para que RLS aplique).
- **Slotting**: cada ubicación tiene un `slot_score` = distancia real por pasillos al muelle de despacho + penalización por altura.
  Los SKUs A (≈80 % de los picks) van a los scores más bajos.

## Pendiente para producción

Autenticación (JWT por operario + PIN en la tablet), impresión de etiquetas ZPL, modo offline de la PWA,
olas de picking, picking por cajas, inventario cíclico, integración con ERP y particiones mensuales con `pg_partman`.
