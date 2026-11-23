// Todo el SQL del dominio en un solo lugar (fácil de auditar y de testear con psql).

export const SQL = {
  // ---------- Mapa ----------
  mapa: `
    SELECT l.id, l.codigo, l.pasillo, l.rack, l.columna, l.nivel, l.x, l.y,
           l.distancia_a_muelle, l.slot_score, l.estado AS estado_ubicacion,
           p.id AS pallet_id, p.lpn_code, pc.cantidad, pc.estado_calidad,
           s.codigo AS sku, s.descripcion, s.clase_abc, lo.numero_lote, lo.fecha_vencimiento,
           (lo.fecha_vencimiento - current_date) AS dias_vencimiento,
           EXISTS (SELECT 1 FROM tasks t WHERE t.to_location_id = l.id
                   AND t.estado IN ('PENDIENTE','ASIGNADA','EN_CURSO')) AS reservada
    FROM locations l
    LEFT JOIN pallets p ON p.location_id = l.id AND p.estado = 'ALMACENADO'
    LEFT JOIN pallet_contents pc ON pc.pallet_id = p.id
    LEFT JOIN skus s ON s.id = pc.sku_id
    LEFT JOIN lots lo ON lo.id = pc.lot_id
    WHERE l.warehouse_id = $1 AND l.tipo <> 'VIRTUAL'
    ORDER BY l.pasillo, l.rack, l.columna, l.nivel`,

  // ---------- Putaway: mejor ubicación libre según clase ABC ----------
  // $1 warehouse, $2 clase ('A'|'B'|'C'), $3 umbral A, $4 umbral B
  ubicacionPutaway: `
    SELECT l.id, l.codigo, l.slot_score
    FROM locations l
    WHERE l.warehouse_id = $1 AND l.estado = 'ACTIVA' AND l.tipo = 'RACK_SELECTIVO'
      AND NOT EXISTS (SELECT 1 FROM pallets p WHERE p.location_id = l.id AND p.estado <> 'DESPACHADO')
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.to_location_id = l.id AND t.estado IN ('PENDIENTE','ASIGNADA','EN_CURSO'))
      AND CASE $2::text WHEN 'A' THEN true
                        WHEN 'B' THEN l.slot_score > $3
                        ELSE l.slot_score > $4 END
    ORDER BY l.slot_score
    LIMIT 1
    FOR UPDATE SKIP LOCKED`,

  // Umbrales de zona A/B a partir del stock actual por clase
  umbrales: `
    WITH stock AS (
      SELECT s.clase_abc, count(*) AS n
      FROM pallets p JOIN pallet_contents pc ON pc.pallet_id = p.id JOIN skus s ON s.id = pc.sku_id
      WHERE p.warehouse_id = $1 AND p.estado <> 'DESPACHADO' GROUP BY 1),
    ranked AS (
      SELECT slot_score, row_number() OVER (ORDER BY slot_score) AS rn
      FROM locations WHERE warehouse_id = $1 AND tipo = 'RACK_SELECTIVO')
    SELECT
      (SELECT slot_score FROM ranked WHERE rn = GREATEST(1, ceil(COALESCE((SELECT n FROM stock WHERE clase_abc='A'),0) * 1.12))) AS umbral_a,
      (SELECT slot_score FROM ranked WHERE rn = GREATEST(1, ceil((COALESCE((SELECT n FROM stock WHERE clase_abc='A'),0)
                                                                 + COALESCE((SELECT n FROM stock WHERE clase_abc='B'),0)) * 1.12))) AS umbral_b`,

  // ---------- FEFO: pallet a despachar para un SKU ----------
  palletFefo: `
    SELECT p.id AS pallet_id, p.location_id, pc.id AS content_id, pc.cantidad
    FROM pallets p
    JOIN pallet_contents pc ON pc.pallet_id = p.id
    LEFT JOIN lots lo ON lo.id = pc.lot_id
    WHERE p.warehouse_id = $1 AND pc.sku_id = $2 AND p.estado = 'ALMACENADO'
      AND pc.estado_calidad = 'DISPONIBLE'
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.pallet_id = p.id AND t.estado IN ('PENDIENTE','ASIGNADA','EN_CURSO'))
    ORDER BY lo.fecha_vencimiento NULLS LAST, p.created_at
    LIMIT 1
    FOR UPDATE OF p SKIP LOCKED`,

  // ---------- Próxima tarea para un clark (sin choques entre clarks) ----------
  // $1 warehouse, $2 equipo, $3 usuario, $4 x, $5 y (posición actual del clark)
  proximaTarea: `
    WITH candidata AS (
      SELECT t.id
      FROM tasks t
      LEFT JOIN locations lf ON lf.id = t.from_location_id
      LEFT JOIN docks df ON df.id = t.from_dock_id
      WHERE t.warehouse_id = $1 AND t.estado = 'PENDIENTE'
      ORDER BY t.prioridad,
               abs(COALESCE(lf.x, df.x) - $4) + abs(COALESCE(lf.y, df.y) - $5),
               t.created_at
      LIMIT 1
      FOR UPDATE OF t SKIP LOCKED)
    UPDATE tasks t SET estado = 'ASIGNADA', assigned_equipment_id = $2, assigned_user_id = $3
    FROM candidata c WHERE t.id = c.id
    RETURNING t.*`,

  detalleTarea: `
    SELECT t.*, p.lpn_code, s.codigo AS sku, s.descripcion, s.clase_abc, lo.numero_lote, lo.fecha_vencimiento,
           lf.codigo AS desde_ubicacion, lt.codigo AS hacia_ubicacion, df.codigo AS desde_muelle, dt.codigo AS hacia_muelle
    FROM tasks t
    LEFT JOIN pallets p ON p.id = t.pallet_id
    LEFT JOIN pallet_contents pc ON pc.pallet_id = p.id
    LEFT JOIN skus s ON s.id = pc.sku_id
    LEFT JOIN lots lo ON lo.id = pc.lot_id
    LEFT JOIN locations lf ON lf.id = t.from_location_id
    LEFT JOIN locations lt ON lt.id = t.to_location_id
    LEFT JOIN docks df ON df.id = t.from_dock_id
    LEFT JOIN docks dt ON dt.id = t.to_dock_id
    WHERE t.id = $1`,

  // ---------- Slotting ----------
  recalcularAbc: `
    WITH v AS (
      SELECT sku_id, count(*)::numeric AS picks
      FROM stock_movements
      WHERE tipo = 'PICK' AND tenant_id = $1 AND created_at >= now() - make_interval(days => $2::int)
      GROUP BY sku_id),
    acum AS (
      SELECT sku_id, picks, sum(picks) OVER (ORDER BY picks DESC) / NULLIF(sum(picks) OVER (), 0) AS share FROM v)
    UPDATE skus s SET clase_abc = CASE WHEN a.share <= 0.80 THEN 'A' WHEN a.share <= 0.95 THEN 'B' ELSE 'C' END::abc_class
    FROM acum a WHERE a.sku_id = s.id
    RETURNING s.id, s.codigo, s.clase_abc`,

  // Pallets A fuera de la zona A → ubicaciones libres dentro de la zona A
  sugerencias: `
    WITH mal AS (
      SELECT p.id AS pallet_id, s.id AS sku_id, l.id AS from_id, l.slot_score,
             COALESCE(v.picks_por_dia, 0) / GREATEST(1, count(*) OVER (PARTITION BY s.id)) AS ppd_pallet,
             row_number() OVER (ORDER BY (l.slot_score - $2) * COALESCE(v.picks_por_dia, 0) DESC) AS rn
      FROM pallets p
      JOIN pallet_contents pc ON pc.pallet_id = p.id AND pc.estado_calidad <> 'CUARENTENA'
      JOIN skus s ON s.id = pc.sku_id AND s.clase_abc = 'A'
      JOIN locations l ON l.id = p.location_id
      LEFT JOIN LATERAL (SELECT picks_por_dia FROM sku_velocity sv WHERE sv.sku_id = s.id ORDER BY periodo_hasta DESC LIMIT 1) v ON true
      WHERE p.warehouse_id = $1 AND p.estado = 'ALMACENADO' AND l.slot_score > $2),
    libres AS (
      SELECT l.id AS to_id, l.slot_score, row_number() OVER (ORDER BY l.slot_score) AS rn
      FROM locations l
      WHERE l.warehouse_id = $1 AND l.estado = 'ACTIVA' AND l.slot_score <= $2
        AND NOT EXISTS (SELECT 1 FROM pallets p WHERE p.location_id = l.id AND p.estado <> 'DESPACHADO')
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.to_location_id = l.id AND t.estado IN ('PENDIENTE','ASIGNADA','EN_CURSO')))
    SELECT m.pallet_id, m.sku_id, m.from_id, f.to_id,
           round((m.slot_score - f.slot_score) * 2 * m.ppd_pallet * 26, 1) AS ahorro_metros_mes
    FROM mal m JOIN libres f ON f.rn = m.rn
    WHERE m.rn <= $3
    ORDER BY ahorro_metros_mes DESC`,

  // ---------- KPIs ----------
  kpis: `
    SELECT
      (SELECT count(*) FROM locations WHERE warehouse_id = $1 AND tipo <> 'VIRTUAL') AS ubicaciones,
      (SELECT count(*) FROM pallets WHERE warehouse_id = $1 AND estado = 'ALMACENADO') AS pallets,
      (SELECT count(*) FROM tasks WHERE warehouse_id = $1 AND estado = 'PENDIENTE') AS tareas_pendientes,
      (SELECT count(*) FROM tasks WHERE warehouse_id = $1 AND estado = 'COMPLETADA' AND completed_at >= current_date) AS tareas_hoy,
      (SELECT round(avg(extract(epoch FROM completed_at - started_at)))::int FROM tasks
        WHERE warehouse_id = $1 AND estado = 'COMPLETADA' AND completed_at >= current_date) AS segundos_promedio_tarea,
      (SELECT count(*) FROM v_vencimientos_proximos WHERE warehouse_id = $1 AND dias_restantes <= 30) AS vencen_30d,
      (SELECT round(sum(v.picks_por_dia * l.slot_score * 2) / NULLIF(sum(v.picks_por_dia), 0), 1)
         FROM pallets p JOIN pallet_contents pc ON pc.pallet_id = p.id
         JOIN locations l ON l.id = p.location_id
         JOIN LATERAL (SELECT picks_por_dia FROM sku_velocity sv WHERE sv.sku_id = pc.sku_id ORDER BY periodo_hasta DESC LIMIT 1) v ON true
        WHERE p.warehouse_id = $1 AND p.estado = 'ALMACENADO') AS indice_recorrido`,

  productividad: `
    SELECT e.codigo AS equipo, u.nombre AS operario, count(t.id) AS tareas,
           round(avg(extract(epoch FROM t.completed_at - t.started_at)))::int AS seg_promedio,
           round(sum(t.metros_estimados))::int AS metros
    FROM tasks t
    JOIN equipment e ON e.id = t.assigned_equipment_id
    LEFT JOIN users u ON u.id = t.assigned_user_id
    WHERE t.warehouse_id = $1 AND t.estado = 'COMPLETADA' AND t.completed_at >= current_date
    GROUP BY 1, 2 ORDER BY tareas DESC`,
};
