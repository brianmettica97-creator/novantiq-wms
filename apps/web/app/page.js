'use client';
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { api, API } from '../lib/api';

const fmt = (n, d = 0) => Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: d });

export default function Dashboard() {
  const [k, setK] = useState(null);
  const [sug, setSug] = useState([]);
  const [err, setErr] = useState('');

  async function load() {
    try {
      setK(await api('/api/kpis'));
      setSug(await api('/api/slotting/sugerencias'));
      setErr('');
    } catch (e) { setErr('No se pudo conectar con la API (' + API + '). ¿Está corriendo?'); }
  }
  useEffect(() => {
    load();
    const s = io(API);
    s.on('mapa:cambio', load); s.on('tarea:nueva', load);
    const t = setInterval(load, 15000);
    return () => { s.close(); clearInterval(t); };
  }, []);

  async function analizar() { await api('/api/slotting/sugerencias', { method: 'POST', body: { max: 30 } }); load(); }
  async function aceptar() { await api('/api/slotting/aceptar', { method: 'POST', body: {} }); load(); }

  if (err) return <main className="page"><p className="err">{err}</p></main>;
  if (!k) return <main className="page">Cargando…</main>;
  const ahorro = sug.reduce((s, x) => s + Number(x.ahorro_metros_mes), 0);

  return (
    <main className="page">
      <div className="grid">
        <div className="card"><small>Ocupación</small><div className="v">{fmt(k.ocupacion * 100, 1)}%</div>{k.pallets} de {k.ubicaciones} posiciones</div>
        <div className="card"><small>Tareas completadas hoy</small><div className="v">{fmt(k.tareas_hoy)}</div>{k.tareas_pendientes} pendientes</div>
        <div className="card"><small>Tiempo promedio por tarea</small><div className="v">{k.segundos_promedio_tarea ? fmt(k.segundos_promedio_tarea / 60, 1) + ' min' : '–'}</div></div>
        <div className="card"><small>Índice de recorrido</small><div className="v">{fmt(k.indice_recorrido, 1)} m</div>por picking, ponderado por rotación</div>
        <div className="card"><small>Vencen en 30 días</small><div className="v" style={{ color: k.vencen_30d ? '#f59e0b' : undefined }}>{k.vencen_30d}</div>pallets (FEFO)</div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div><small>Slotting inteligente</small><div style={{ marginTop: 4 }}>{sug.length} reubicaciones propuestas · ahorro estimado {fmt(ahorro / 1000, 1)} km/mes de recorrido</div></div>
          <div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={analizar}>Analizar</button><button className="btn" onClick={aceptar} disabled={!sug.length}>Generar tareas</button></div>
        </div>
        <table><thead><tr><th>Pallet</th><th>Producto</th><th>Desde</th><th>Hacia</th><th>Ahorro / mes</th></tr></thead>
          <tbody>{sug.slice(0, 12).map((s) => <tr key={s.id}><td>{s.lpn_code}</td><td>{s.descripcion}</td><td>{s.desde}</td><td>{s.hacia}</td><td>{fmt(s.ahorro_metros_mes)} m</td></tr>)}</tbody></table>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))' }}>
        <div className="card"><small>Productividad por clark (hoy)</small>
          <table><thead><tr><th>Equipo</th><th>Operario</th><th>Tareas</th><th>Prom.</th><th>Metros</th></tr></thead>
            <tbody>{k.productividad.map((p) => <tr key={p.equipo}><td>{p.equipo}</td><td>{p.operario}</td><td>{p.tareas}</td><td>{fmt(p.seg_promedio / 60, 1)} min</td><td>{fmt(p.metros)}</td></tr>)}</tbody></table>
        </div>
        <div className="card"><small>Próximos vencimientos</small>
          <table><thead><tr><th>Ubicación</th><th>Producto</th><th>Lote</th><th>Días</th></tr></thead>
            <tbody>{k.vencimientos.map((v) => <tr key={v.lpn_code}><td>{v.ubicacion}</td><td>{v.descripcion}</td><td>{v.numero_lote}</td><td style={{ color: v.dias_restantes < 15 ? '#ef4444' : '#f59e0b' }}>{v.dias_restantes}</td></tr>)}</tbody></table>
        </div>
      </div>
    </main>
  );
}
