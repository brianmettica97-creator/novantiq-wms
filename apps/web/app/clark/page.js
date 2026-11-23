'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';

// App para la tablet del autoelevador. El lector de códigos funciona como teclado:
// "tipea" el código y manda Enter, así que alcanza con un input que siempre tenga foco.
const TIPOS = { PUTAWAY: 'GUARDADO', PICK: 'PICKING · DESPACHO', REPOSICION: 'REUBICACIÓN', MOVE: 'MOVIMIENTO' };

function beep(ok) {
  try {
    const a = new AudioContext(), o = a.createOscillator();
    o.frequency.value = ok ? 880 : 220; o.connect(a.destination); o.start(); o.stop(a.currentTime + (ok ? 0.12 : 0.35));
    navigator.vibrate?.(ok ? 60 : [120, 60, 120]);
  } catch { /* sin audio */ }
}

export default function Clark() {
  const [equipo, setEquipo] = useState('CLK-01');
  const [tarea, setTarea] = useState(null);
  const [paso, setPaso] = useState('TOMAR');     // TOMAR → (escanea ubicación y LPN) → DEJAR
  const [scanUbi, setScanUbi] = useState(null);
  const [msg, setMsg] = useState('');
  const [flash, setFlash] = useState('');
  const input = useRef(null);

  useEffect(() => { const t = setInterval(() => input.current?.focus(), 800); return () => clearInterval(t); }, []);

  function feedback(ok, text) {
    beep(ok); setMsg(text); setFlash(ok ? 'flash-ok' : 'flash-ko'); setTimeout(() => setFlash(''), 500);
  }

  async function pedirTarea() {
    try {
      const t = await api('/api/tareas/siguiente', { method: 'POST', body: { equipmentCodigo: equipo } });
      setTarea(t); setPaso(t?.estado === 'EN_CURSO' ? 'DEJAR' : 'TOMAR'); setScanUbi(null);
      setMsg(t ? '' : 'No hay tareas pendientes');
    } catch (e) { feedback(false, e.message); }
  }

  async function onScan(code) {
    if (!tarea) return;
    const origen = tarea.desde_ubicacion || tarea.desde_muelle;
    const destino = tarea.hacia_ubicacion || tarea.hacia_muelle;
    try {
      if (paso === 'TOMAR' && !scanUbi) {
        if (code !== origen) return feedback(false, `Ubicación incorrecta. Andá a ${origen}`);
        setScanUbi(code); return feedback(true, 'Ubicación OK · ahora escaneá el pallet');
      }
      if (paso === 'TOMAR') {
        await api(`/api/tareas/${tarea.id}/confirmar`, { method: 'POST', body: { paso: 'TOMAR', scanUbicacion: scanUbi, scanLpn: code } });
        setPaso('DEJAR'); return feedback(true, `Pallet tomado · llevalo a ${destino}`);
      }
      await api(`/api/tareas/${tarea.id}/confirmar`, { method: 'POST', body: { paso: 'DEJAR', scanUbicacion: code } });
      feedback(true, 'Tarea completada ✔');
      setTarea(null); setTimeout(pedirTarea, 600);
    } catch (e) { feedback(false, e.message); }
  }

  async function problema() {
    if (!tarea) return;
    await api(`/api/tareas/${tarea.id}/problema`, { method: 'POST', body: { motivo: 'UBICACION_OCUPADA' } });
    feedback(false, 'Problema reportado al supervisor'); setTarea(null);
  }

  const destino = tarea ? (paso === 'TOMAR' ? (tarea.desde_ubicacion || 'MUELLE ' + tarea.desde_muelle) : (tarea.hacia_ubicacion || 'MUELLE ' + tarea.hacia_muelle)) : null;

  return (
    <main className={`clark ${flash}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#8193ad', fontWeight: 700 }}>
        <span>Equipo <input value={equipo} onChange={(e) => setEquipo(e.target.value)} style={{ width: 90, background: 'none', color: '#fff', border: 0, fontWeight: 700 }} /></span>
        <span>{msg}</span>
      </div>
      {!tarea && <button className="big" style={{ background: '#16a34a', color: '#fff' }} onClick={pedirTarea}>PEDIR TAREA</button>}
      {tarea && (
        <>
          <div style={{ color: '#22c55e', fontWeight: 800, letterSpacing: '.1em' }}>{TIPOS[tarea.tipo]}</div>
          <div style={{ color: '#8193ad', fontWeight: 700 }}>{paso === 'TOMAR' ? (scanUbi ? 'ESCANEÁ EL PALLET' : 'ANDÁ A') : 'LLEVALO A'}</div>
          <div className="dest">{destino}</div>
          <div style={{ fontSize: 20 }}><b>{tarea.lpn_code}</b> · {tarea.descripcion} · clase {tarea.clase_abc} · lote {tarea.numero_lote}</div>
          <input ref={input} className="scan" autoFocus placeholder="Escaneá el código…"
            onKeyDown={(e) => { if (e.key === 'Enter' && e.currentTarget.value) { onScan(e.currentTarget.value.trim().toUpperCase()); e.currentTarget.value = ''; } }} />
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            <button className="big" style={{ background: '#1e293b', color: '#fff' }} onClick={pedirTarea}>↻ ACTUALIZAR</button>
            <button className="big" style={{ background: '#7f1d1d', color: '#fecaca' }} onClick={problema}>⚠ PROBLEMA</button>
          </div>
        </>
      )}
    </main>
  );
}
