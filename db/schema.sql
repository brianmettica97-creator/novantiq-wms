-- =====================================================================
--  NOVANTIQ WMS · Esquema PostgreSQL (v1)
--  Multi-tenant · Movimientos inmutables · Asignación de tareas sin choques
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- Tipos ----------------------------------------------------
CREATE TYPE zone_type        AS ENUM ('RECEPCION','ALMACEN','PICKING','MUELLE','CUARENTENA','FRIO');
CREATE TYPE dock_type        AS ENUM ('ENTRADA','SALIDA','MIXTO');
CREATE TYPE location_type    AS ENUM ('RACK_SELECTIVO','PISO','DRIVE_IN','PICKING','VIRTUAL');
CREATE TYPE location_status  AS ENUM ('ACTIVA','BLOQUEADA','MANTENIMIENTO');
CREATE TYPE rotation_rule    AS ENUM ('FEFO','FIFO','LIFO');
CREATE TYPE abc_class        AS ENUM ('A','B','C');
CREATE TYPE pallet_status    AS ENUM ('EN_RECEPCION','ALMACENADO','EN_TRANSITO','EN_STAGING','DESPACHADO');
CREATE TYPE quality_status   AS ENUM ('DISPONIBLE','RESERVADO','CUARENTENA','DANADO');
CREATE TYPE movement_type    AS ENUM ('RECEPCION','PUTAWAY','MOVE','REPOSICION','PICK','DESPACHO','AJUSTE');
CREATE TYPE task_type        AS ENUM ('PUTAWAY','PICK','REPOSICION','MOVE','CONTEO','CARGA');
CREATE TYPE task_status      AS ENUM ('PENDIENTE','ASIGNADA','EN_CURSO','COMPLETADA','CANCELADA');
CREATE TYPE order_status     AS ENUM ('BORRADOR','PENDIENTE','EN_PROCESO','COMPLETA','CANCELADA');
CREATE TYPE user_role        AS ENUM ('ADMIN','SUPERVISOR','CLARKISTA','RECEPCIONISTA');
CREATE TYPE equipment_type   AS ENUM ('CLARK_CONTRAPESO','RETRACTIL','ZORRA_ELECTRICA');
CREATE TYPE suggestion_status AS ENUM ('PROPUESTA','ACEPTADA','RECHAZADA','EJECUTADA');

-- ---------- Estructura física ---------------------------------------
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      text NOT NULL,
  plan        text NOT NULL DEFAULT 'base',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE warehouses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  nombre      text NOT NULL,
  direccion   text,
  ancho_m     numeric(8,2),
  largo_m     numeric(8,2)
);

CREATE TABLE zones (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  codigo        text NOT NULL,
  tipo          zone_type NOT NULL,
  temp_min      numeric(5,2),
  temp_max      numeric(5,2),
  UNIQUE (warehouse_id, codigo)
);

CREATE TABLE docks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  codigo        text NOT NULL,
  tipo          dock_type NOT NULL,
  x numeric(8,2) NOT NULL, y numeric(8,2) NOT NULL,
  UNIQUE (warehouse_id, codigo)
);

CREATE TABLE locations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  warehouse_id       uuid NOT NULL REFERENCES warehouses(id),
  zone_id            uuid REFERENCES zones(id),
  codigo             text NOT NULL,          -- ej: C-06-14-2 (pasillo-rack-columna-nivel)
  pasillo            text, rack int, columna int, nivel int,
  x numeric(8,2), y numeric(8,2), z numeric(8,2),
  tipo               location_type NOT NULL DEFAULT 'RACK_SELECTIVO',
  capacidad_pallets  int NOT NULL DEFAULT 1,
  peso_max_kg        numeric(8,2) DEFAULT 1200,  -- por posición (pallet sobre vigas); en el piso, límite del pallet
  viga_codigo        text,                       -- par de vigas (un nivel de una bahía): comparten carga
  viga_max_kg        numeric(8,2) DEFAULT 2000,
  modulo_codigo      text,                       -- bahía completa (todos los niveles sobre vigas)
  modulo_max_kg      numeric(8,2) DEFAULT 5400,
  alto_max_cm        int DEFAULT 180,
  distancia_a_muelle numeric(8,2),           -- precalculada: clave del slotting
  slot_score         numeric(8,2),           -- distancia + penalización por altura
  pick_sequence      int,                    -- orden de recorrido en serpentina
  estado             location_status NOT NULL DEFAULT 'ACTIVA',
  UNIQUE (warehouse_id, codigo)
);
CREATE INDEX locations_libres_idx ON locations (warehouse_id, estado, slot_score);

-- ---------- Catálogo -------------------------------------------------
CREATE TABLE clients (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  nombre     text NOT NULL
);

CREATE TABLE skus (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  client_id             uuid REFERENCES clients(id),
  codigo                text NOT NULL,
  descripcion           text NOT NULL,
  ean                   text,
  unidades_por_caja     int  DEFAULT 1,
  cajas_por_pallet      int  DEFAULT 1,
  peso_kg               numeric(8,2),           -- peso de una caja (kg)
  volumen_m3            numeric(8,3),
  requiere_lote         boolean NOT NULL DEFAULT true,
  requiere_vencimiento  boolean NOT NULL DEFAULT true,
  regla_rotacion        rotation_rule NOT NULL DEFAULT 'FEFO',
  clase_abc             abc_class,
  zona_preferida_id     uuid REFERENCES zones(id),
  UNIQUE (tenant_id, codigo)
);
CREATE INDEX skus_ean_idx ON skus (tenant_id, ean);

CREATE TABLE lots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  sku_id             uuid NOT NULL REFERENCES skus(id),
  numero_lote        text NOT NULL,
  fecha_vencimiento  date,
  fecha_fabricacion  date,
  UNIQUE (sku_id, numero_lote)
);
CREATE INDEX lots_venc_idx ON lots (fecha_vencimiento);

-- ---------- Stock ----------------------------------------------------
CREATE TABLE pallets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  lpn_code      text NOT NULL,
  location_id   uuid REFERENCES locations(id),
  estado        pallet_status NOT NULL DEFAULT 'EN_RECEPCION',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, lpn_code)
);
CREATE INDEX pallets_loc_idx ON pallets (location_id) WHERE estado <> 'DESPACHADO';

CREATE TABLE pallet_contents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  pallet_id       uuid NOT NULL REFERENCES pallets(id) ON DELETE CASCADE,
  sku_id          uuid NOT NULL REFERENCES skus(id),
  lot_id          uuid REFERENCES lots(id),
  cantidad        int  NOT NULL CHECK (cantidad >= 0),
  estado_calidad  quality_status NOT NULL DEFAULT 'DISPONIBLE'
);
CREATE INDEX pc_sku_idx ON pallet_contents (sku_id, estado_calidad, lot_id);

-- Libro contable inmutable de movimientos (particionado por mes)
CREATE TABLE stock_movements (
  id                bigserial,
  tenant_id         uuid NOT NULL,
  tipo              movement_type NOT NULL,
  pallet_id         uuid,
  sku_id            uuid,
  lot_id            uuid,
  cantidad          int,
  from_location_id  uuid,
  to_location_id    uuid,
  task_id           uuid,
  user_id           uuid,
  equipment_id      uuid,
  metros_recorridos numeric(8,2),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
-- Partición por defecto (en producción: pg_partman crea una por mes)
CREATE TABLE stock_movements_default PARTITION OF stock_movements DEFAULT;
CREATE INDEX sm_sku_fecha_idx ON stock_movements (sku_id, created_at);
CREATE INDEX sm_pallet_idx    ON stock_movements (pallet_id);

-- Un movimiento nunca se edita ni se borra
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'stock_movements es inmutable: registrá un AJUSTE'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER sm_inmutable BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------- Órdenes --------------------------------------------------
CREATE TABLE inbound_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  warehouse_id    uuid NOT NULL REFERENCES warehouses(id),
  client_id       uuid REFERENCES clients(id),
  numero          text NOT NULL,
  proveedor       text,
  fecha_esperada  timestamptz,
  dock_id         uuid REFERENCES docks(id),
  estado          order_status NOT NULL DEFAULT 'PENDIENTE',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE inbound_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_order_id   uuid NOT NULL REFERENCES inbound_orders(id) ON DELETE CASCADE,
  sku_id             uuid NOT NULL REFERENCES skus(id),
  cantidad_esperada  int NOT NULL,
  cantidad_recibida  int NOT NULL DEFAULT 0
);

CREATE TABLE outbound_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  warehouse_id    uuid NOT NULL REFERENCES warehouses(id),
  client_id       uuid REFERENCES clients(id),
  numero          text NOT NULL,
  destino         text,
  fecha_despacho  timestamptz,
  prioridad       int NOT NULL DEFAULT 5,
  dock_id         uuid REFERENCES docks(id),
  estado          order_status NOT NULL DEFAULT 'PENDIENTE',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outbound_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbound_order_id  uuid NOT NULL REFERENCES outbound_orders(id) ON DELETE CASCADE,
  sku_id             uuid NOT NULL REFERENCES skus(id),
  cantidad           int NOT NULL,
  cantidad_pickeada  int NOT NULL DEFAULT 0
);
CREATE TABLE reservations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbound_line_id   uuid NOT NULL REFERENCES outbound_lines(id) ON DELETE CASCADE,
  pallet_content_id  uuid NOT NULL REFERENCES pallet_contents(id),
  cantidad           int NOT NULL
);

-- ---------- Ejecución ------------------------------------------------
CREATE TABLE users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  nombre     text NOT NULL,
  rol        user_role NOT NULL,
  pin_hash   text,
  activo     boolean NOT NULL DEFAULT true
);

CREATE TABLE equipment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  codigo        text NOT NULL,
  tipo          equipment_type NOT NULL,
  altura_max_cm int NOT NULL DEFAULT 600,
  x numeric(8,2), y numeric(8,2),            -- última posición conocida
  UNIQUE (warehouse_id, codigo)
);

CREATE TABLE equipment_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id  uuid NOT NULL REFERENCES equipment(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  login_at      timestamptz NOT NULL DEFAULT now(),
  logout_at     timestamptz
);

CREATE TABLE tasks (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  warehouse_id           uuid NOT NULL REFERENCES warehouses(id),
  tipo                   task_type NOT NULL,
  pallet_id              uuid REFERENCES pallets(id),
  from_location_id       uuid REFERENCES locations(id),
  to_location_id         uuid REFERENCES locations(id),
  from_dock_id           uuid REFERENCES docks(id),
  to_dock_id             uuid REFERENCES docks(id),
  prioridad              int NOT NULL DEFAULT 5,       -- 1 = urgente
  estado                 task_status NOT NULL DEFAULT 'PENDIENTE',
  assigned_user_id       uuid REFERENCES users(id),
  assigned_equipment_id  uuid REFERENCES equipment(id),
  origen_tipo            text,
  origen_id              uuid,
  metros_estimados       numeric(8,2),
  created_at             timestamptz NOT NULL DEFAULT now(),
  started_at             timestamptz,
  completed_at           timestamptz
);
CREATE INDEX tasks_pendientes_idx ON tasks (warehouse_id, prioridad, created_at)
  WHERE estado = 'PENDIENTE';
-- Una ubicación destino no puede tener dos tareas abiertas a la vez
CREATE UNIQUE INDEX tasks_destino_unico ON tasks (to_location_id)
  WHERE estado IN ('PENDIENTE','ASIGNADA','EN_CURSO') AND to_location_id IS NOT NULL;

-- ---------- Slotting -------------------------------------------------
CREATE TABLE sku_velocity (
  sku_id         uuid NOT NULL REFERENCES skus(id),
  warehouse_id   uuid NOT NULL REFERENCES warehouses(id),
  periodo_desde  date NOT NULL,
  periodo_hasta  date NOT NULL,
  cant_picks     int NOT NULL,
  cant_unidades  int NOT NULL,
  picks_por_dia  numeric(10,3) NOT NULL,
  clase_abc      abc_class NOT NULL,
  PRIMARY KEY (sku_id, warehouse_id, periodo_hasta)
);

CREATE TABLE slotting_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  nombre        text NOT NULL,
  condicion     jsonb NOT NULL,   -- {"clase":"A"}
  accion        jsonb NOT NULL,   -- {"slot_score_max":30,"niveles":[0,1]}
  prioridad     int NOT NULL DEFAULT 10
);

CREATE TABLE slotting_suggestions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id           uuid NOT NULL REFERENCES warehouses(id),
  sku_id                 uuid NOT NULL REFERENCES skus(id),
  pallet_id              uuid NOT NULL REFERENCES pallets(id),
  from_location_id       uuid NOT NULL REFERENCES locations(id),
  to_location_id         uuid NOT NULL REFERENCES locations(id),
  ahorro_metros_mes      numeric(10,2),
  estado                 suggestion_status NOT NULL DEFAULT 'PROPUESTA',
  task_id                uuid REFERENCES tasks(id),
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- ---------- Capacidad de carga de los racks -------------------------
-- Peso de un pallet: tara + cajas × peso por caja.
CREATE OR REPLACE FUNCTION peso_pallet(p_pallet uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT 25 + COALESCE(sum(pc.cantidad * COALESCE(s.peso_kg, 0)), 0)
  FROM pallet_contents pc JOIN skus s ON s.id = pc.sku_id
  WHERE pc.pallet_id = p_pallet
$$;

-- ¿Entra un pallet de p_kg en la ubicación sin superar la posición, el par de vigas ni el módulo?
-- Cuenta los pallets guardados y los que van en camino (tareas abiertas hacia ese módulo).
-- p_excluir: el propio pallet (si ya está en el módulo o tiene la tarea hacia esa ubicación).
CREATE OR REPLACE FUNCTION cabe_en_ubicacion(p_location uuid, p_kg numeric, p_excluir uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH l AS (SELECT * FROM locations WHERE id = p_location),
  carga AS (
    SELECT x.viga_codigo, x.nivel, peso_pallet(p.id) AS kg
    FROM l JOIN locations x ON x.warehouse_id = l.warehouse_id AND x.modulo_codigo = l.modulo_codigo
    JOIN pallets p ON p.location_id = x.id AND p.estado <> 'DESPACHADO'
    WHERE p.id IS DISTINCT FROM p_excluir
    UNION ALL
    SELECT x.viga_codigo, x.nivel, peso_pallet(t.pallet_id)
    FROM l JOIN locations x ON x.warehouse_id = l.warehouse_id AND x.modulo_codigo = l.modulo_codigo
    JOIN tasks t ON t.to_location_id = x.id AND t.estado IN ('PENDIENTE','ASIGNADA','EN_CURSO')
    WHERE t.pallet_id IS DISTINCT FROM p_excluir)
  SELECT p_kg <= l.peso_max_kg
     AND (l.nivel = 0 OR l.modulo_codigo IS NULL OR (
          p_kg + COALESCE((SELECT sum(kg) FROM carga WHERE viga_codigo = l.viga_codigo), 0) <= l.viga_max_kg
      AND p_kg + COALESCE((SELECT sum(kg) FROM carga WHERE nivel > 0), 0) <= l.modulo_max_kg))
  FROM l
$$;

-- Última barrera: ningún movimiento puede dejar un pallet donde el rack no lo aguanta.
CREATE OR REPLACE FUNCTION trg_capacidad_rack() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location_id IS NOT NULL AND NEW.location_id IS DISTINCT FROM OLD.location_id
     AND NOT cabe_en_ubicacion(NEW.location_id, peso_pallet(NEW.id), NEW.id) THEN
    RAISE EXCEPTION 'La ubicación no soporta el peso del pallet % (% kg)', NEW.lpn_code, round(peso_pallet(NEW.id))
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pallets_capacidad BEFORE UPDATE OF location_id ON pallets
  FOR EACH ROW EXECUTE FUNCTION trg_capacidad_rack();

-- Carga por viga para el dashboard
CREATE VIEW v_carga_vigas AS
SELECT l.warehouse_id, l.viga_codigo, max(l.viga_max_kg) AS capacidad_kg,
       round(COALESCE(sum(peso_pallet(p.id)), 0)) AS carga_kg,
       round(100 * COALESCE(sum(peso_pallet(p.id)), 0) / NULLIF(max(l.viga_max_kg), 0), 1) AS uso_pct
FROM locations l
LEFT JOIN pallets p ON p.location_id = l.id AND p.estado <> 'DESPACHADO'
WHERE l.nivel > 0 AND l.viga_codigo IS NOT NULL
GROUP BY l.warehouse_id, l.viga_codigo;

-- ---------- Vistas para el dashboard --------------------------------
CREATE MATERIALIZED VIEW mv_ocupacion AS
SELECT l.warehouse_id,
       count(*)                                         AS ubicaciones,
       count(p.id)                                      AS ocupadas,
       round(100.0 * count(p.id) / NULLIF(count(*),0),1) AS ocupacion_pct
FROM locations l
LEFT JOIN pallets p ON p.location_id = l.id AND p.estado = 'ALMACENADO'
WHERE l.tipo <> 'VIRTUAL'
GROUP BY l.warehouse_id;
CREATE UNIQUE INDEX ON mv_ocupacion (warehouse_id);

CREATE VIEW v_vencimientos_proximos AS
SELECT p.warehouse_id, p.lpn_code, l.codigo AS ubicacion, s.codigo AS sku, s.descripcion,
       lo.numero_lote, lo.fecha_vencimiento,
       (lo.fecha_vencimiento - current_date) AS dias_restantes
FROM pallet_contents pc
JOIN pallets p  ON p.id = pc.pallet_id AND p.estado = 'ALMACENADO'
JOIN skus s     ON s.id = pc.sku_id
JOIN lots lo    ON lo.id = pc.lot_id
LEFT JOIN locations l ON l.id = p.location_id
WHERE lo.fecha_vencimiento <= current_date + 60;

-- ---------- Seguridad multi-tenant (RLS) ----------------------------
-- La API hace: SET app.tenant_id = '<uuid>' al tomar la conexión.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['warehouses','zones','docks','locations','clients','skus','lots',
                           'pallets','pallet_contents','inbound_orders','outbound_orders',
                           'users','equipment','tasks']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                     USING (tenant_id = current_setting('app.tenant_id', true)::uuid)$p$, t);
  END LOOP;
END $$;
