'use client';
import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import {
  generateMockData, createSim, stepSim, setSmart, getKpis, fmtClock,
  createView, drawMap, hitTest, MODES, stateFromApi,
} from '@novantiq-wms/engine';
import { api, API } from '../../lib/api';

// Mapa del depósito. "Demo" corre la simulación local; "En vivo" lee la API y se actualiza por WebSocket.
export default function Mapa() {
  const canvasRef = useRef(null);
  const stRef = useRef(null);
  const viewRef = useRef(createView());
  const [fuente, setFuente] = useState('demo');
  const [mode, setMode] = useState('rotacion');
  const [smart, setSmartUi] = useState(false);
  const [info, setInfo] = useState(null);
  const [hud, setHud] = useState({});

  // Carga de estado según la fuente
  useEffect(() => {
    let socket, cancel = false;
    if (fuente === 'demo') {
      stRef.current = createSim(generateMockData({ pallets: 1500 }), { clarks: 6 });
    } else {
      const load = async () => {
        try { const rows = await api('/api/mapa'); if (!cancel) stRef.current = stateFromApi(rows); }
        catch { setInfo('No se pudo leer la API en ' + API); }
      };
      load();
      socket = io(API);
      socket.on('mapa:cambio', load);
    }
    return () => { cancel = true; socket?.close(); };
  }, [fuente]);

  // Bucle de dibujo
  useEffect(() => {
    const canvas = canvasRef.current, ctx = canvas.getContext('2d');
    let raf, last = performance.now(), lastHud = 0;
    const loop = (now) => {
      const st = stRef.current;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const { width, height } = canvas.getBoundingClientRect();
      if (canvas.width !== Math.round(width * dpr)) { canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); }
      if (st) {
        if (st.rng) stepSim(st, Math.min(0.1, (now - last) / 1000) * 10);
        drawMap(ctx, st, viewRef.current, width, height, now, dpr);
        if (st.rng && now - lastHud > 500) {
          const k = getKpis(st); lastHud = now;
          setHud({ reloj: fmtClock(st.t), idx: k.index, base: k.baseline, delta: k.delta, mph: k.palletsPerHour });
        }
      }
      last = now; raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => { viewRef.current.mode = mode; }, [mode]);

  function onClick(e) {
    const st = stRef.current; if (!st) return;
    const r = e.currentTarget.getBoundingClientRect();
    const hit = hitTest(st, viewRef.current, e.clientX - r.left, e.clientY - r.top);
    if (!hit || hit.type !== 'loc') { viewRef.current.selected = null; setInfo(null); return; }
    viewRef.current.selected = hit.loc;
    const p = hit.loc.palletId != null ? st.palletMap.get(hit.loc.palletId) : null;
    const sku = p ? st.skuMap.get(p.skuId) : null;
    setInfo(p ? `${hit.loc.code} · ${p.lpn} · ${sku.desc} · clase ${sku.abc} · vence en ${p.exp} días` : `${hit.loc.code} · libre`);
  }

  function toggleSmart() {
    const st = stRef.current; if (!st?.rng) return;
    setSmart(st, !smart); setSmartUi(!smart);
  }

  return (
    <main className="page" style={{ gridTemplateRows: 'auto 1fr', height: 'calc(100vh - 55px)' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <select className="btn" value={fuente} onChange={(e) => setFuente(e.target.value)}>
          <option value="demo">Fuente: simulación demo</option>
          <option value="api">Fuente: API en vivo</option>
        </select>
        {Object.entries(MODES).map(([k, m]) => (
          <button key={k} className="btn" style={{ borderColor: mode === k ? '#22c55e' : undefined }} onClick={() => setMode(k)}>{m.label}</button>
        ))}
        {fuente === 'demo' && <button className="btn" onClick={toggleSmart} style={{ background: smart ? '#14532d' : undefined }}>Slotting inteligente: {smart ? 'ON' : 'OFF'}</button>}
        {fuente === 'demo' && hud.reloj && <span style={{ color: '#8193ad' }}>{hud.reloj} · índice {hud.idx?.toFixed(1)} m (inicio {hud.base?.toFixed(1)} m, {(hud.delta * 100).toFixed(0)}%) · {hud.mph?.toFixed(0)} mov/h</span>}
        {info && <span style={{ marginLeft: 'auto' }}>{info}</span>}
      </div>
      <canvas ref={canvasRef} onClick={onClick} style={{ width: '100%', height: '100%', borderRadius: 14, border: '1px solid #1e2a40' }} />
    </main>
  );
}
