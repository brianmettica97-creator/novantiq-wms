// Texturas procedurales y modelos 3D (sin archivos externos: todo se genera en el navegador).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const PALLET_W = 1.2, PALLET_D = 1.0, PALLET_H = 0.144;

// Generador determinista para que las texturas salgan siempre iguales (importa para grabar video).
function rand(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------- Texturas ----------
export function canvasTex(w, h, draw, repeat, srgb = true) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}
export function noise(ctx, w, h, base, amp, n, seed = 1) {
  const r = rand(seed);
  ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const v = r() * amp - amp / 2;
    ctx.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    ctx.fillRect(r() * w, r() * h, 1 + r() * 2, 1 + r() * 2);
  }
}
export function textTex(text, { w = 512, h = 128, color = '#e2e8f0', bg = null, font = 800, size = 84, family = 'Inter, system-ui, sans-serif' } = {}) {
  return canvasTex(w, h, (c) => {
    if (bg) { c.fillStyle = bg; c.fillRect(0, 0, w, h); }
    c.fillStyle = color; c.font = `${font} ${size}px ${family}`;
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, w / 2, h / 2 + 4);
  });
}

/** Piso de hormigón alisado con juntas cada 5 m. */
export const concreteTex = (rw, rh) => canvasTex(512, 512, (c, w, h) => {
  noise(c, w, h, '#8a8f96', 0.12, 26000, 3);
  const r = rand(9);
  for (let i = 0; i < 40; i++) { // manchas de uso (ruedas, polvo)
    const g = c.createRadialGradient(r() * w, r() * h, 0, r() * w, r() * h, 40 + r() * 80);
    g.addColorStop(0, 'rgba(40,40,45,.10)'); g.addColorStop(1, 'rgba(40,40,45,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  }
  c.strokeStyle = 'rgba(40,44,52,.55)'; c.lineWidth = 2; c.strokeRect(1, 1, w - 2, h - 2);
}, [rw, rh]);
export const asphaltTex = (rw, rh) => canvasTex(256, 256, (c, w, h) => noise(c, w, h, '#3a3d42', 0.2, 9000, 5), [rw, rh]);
export const grassTex = (rw, rh) => canvasTex(256, 256, (c, w, h) => {
  noise(c, w, h, '#5f7d3a', 0.22, 14000, 7);
  const r = rand(11);
  for (let i = 0; i < 30; i++) { c.fillStyle = `rgba(${r() < 0.5 ? '120,140,60' : '70,95,40'},.25)`; c.beginPath(); c.arc(r() * w, r() * h, 10 + r() * 30, 0, 7); c.fill(); }
}, [rw, rh]);
export const woodTex = () => canvasTex(128, 32, (c, w, h) => {
  noise(c, w, h, '#b88a55', 0.15, 900, 13);
  c.strokeStyle = 'rgba(90,55,25,.35)';
  for (let y = 3; y < h; y += 5) { c.beginPath(); c.moveTo(0, y); c.bezierCurveTo(w / 3, y + 2, (2 * w) / 3, y - 2, w, y); c.stroke(); }
});
/** Chapa trapezoidal (fachada) con franja de marca abajo. */
export const claddingTex = (rw) => canvasTex(128, 512, (c, w, h) => {
  const g = c.createLinearGradient(0, 0, w, 0);
  for (let k = 0; k <= 4; k++) { g.addColorStop(k / 4, k % 2 ? '#c9cfd6' : '#aeb6bf'); }
  c.fillStyle = g; c.fillRect(0, 0, w, h);
  c.fillStyle = '#0f3b2e'; c.fillRect(0, h - 70, w, 70);
  c.fillStyle = '#22c55e'; c.fillRect(0, h - 78, w, 8);
}, [rw, 1]);
/** Interior: panel claro con zócalo. */
export const innerWallTex = (rw) => canvasTex(64, 256, (c, w, h) => {
  c.fillStyle = '#c4cad2'; c.fillRect(0, 0, w, h); c.fillStyle = 'rgba(0,0,0,.10)'; c.fillRect(0, 0, 3, h);
  c.fillStyle = '#facc15'; c.fillRect(0, h - 30, w, 6); c.fillStyle = '#374151'; c.fillRect(0, h - 24, w, 24);
}, [rw, 1]);

/**
 * Cajas de cartón apiladas con film: textura clara que después se tiñe por instancia
 * (tonos kraft en modo realista, color del indicador en modo análisis).
 */
export const cartonTex = () => canvasTex(512, 512, (c, w, h) => {
  noise(c, w, h, '#f4ecdc', 0.07, 9000, 17);
  const rows = 5, cols = 3, cw = w / cols, ch = h / rows;
  const r = rand(23);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols + 1; x++) {
    const ox = (y % 2 ? -cw / 2 : 0) + x * cw, oy = y * ch;
    c.fillStyle = `rgba(80,55,30,${0.02 + r() * 0.06})`; c.fillRect(ox + 2, oy + 2, cw - 4, ch - 4);
    c.strokeStyle = 'rgba(70,48,25,.55)'; c.lineWidth = 3; c.strokeRect(ox, oy, cw, ch);
    // impresión de la caja: logo y franja
    c.fillStyle = 'rgba(60,35,20,.55)'; c.fillRect(ox + cw * 0.18, oy + ch * 0.28, cw * 0.36, ch * 0.16);
    c.fillStyle = 'rgba(60,35,20,.35)'; c.fillRect(ox + cw * 0.18, oy + ch * 0.52, cw * 0.6, ch * 0.06);
    c.fillRect(ox + cw * 0.18, oy + ch * 0.64, cw * 0.45, ch * 0.05);
    c.fillStyle = 'rgba(150,40,30,.45)'; c.fillRect(ox + cw * 0.62, oy + ch * 0.26, cw * 0.18, ch * 0.2);
  }
  // etiqueta logística blanca con código de barras
  c.fillStyle = '#ffffff'; c.fillRect(w * 0.08, h * 0.44, w * 0.26, h * 0.13);
  c.fillStyle = '#111'; for (let i = 0; i < 30; i++) c.fillRect(w * 0.095 + i * 5.2, h * 0.5, i % 3 ? 2 : 3.5, h * 0.05);
  c.fillRect(w * 0.095, h * 0.455, w * 0.15, 6);
  // film stretch: brillo diagonal
  const g = c.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, 'rgba(255,255,255,.10)'); g.addColorStop(0.45, 'rgba(255,255,255,0)'); g.addColorStop(0.55, 'rgba(255,255,255,.12)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g; c.fillRect(0, 0, w, h);
});
/** Degradados para luces falsas (conos y manchas en el piso). */
export const radialTex = () => canvasTex(128, 128, (c, w, h) => {
  // alphaMap lee el canal verde: escala de grises opaca, no transparencia
  c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
  const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  g.addColorStop(0, '#fff'); g.addColorStop(0.35, '#737373'); g.addColorStop(1, '#000');
  c.fillStyle = g; c.fillRect(0, 0, w, h);
}, null, false);
export const verticalFadeTex = () => canvasTex(4, 128, (c, w, h) => {
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#fff'); g.addColorStop(0.5, '#595959'); g.addColorStop(1, '#000');
  c.fillStyle = g; c.fillRect(0, 0, w, h);
}, null, false);
export const cloudTex = () => canvasTex(256, 128, (c, w, h) => {
  const r = rand(31);
  for (let i = 0; i < 26; i++) {
    const x = w * (0.15 + r() * 0.7), y = h * (0.45 + r() * 0.25), rad = 20 + r() * 38;
    const g = c.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, rad, 0, 7); c.fill();
  }
});

// ---------- Geometrías ----------
export function palletGeometry() {
  const parts = [];
  const box = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); parts.push(g); };
  // Las horquillas entran por el lado de 1,0 m (eje z), entre los largueros.
  for (const z of [-0.45, 0, 0.45]) box(PALLET_W, 0.022, 0.1, 0, 0.011, z);
  for (const x of [-0.55, 0, 0.55]) box(0.1, 0.1, PALLET_D, x, 0.072, 0);
  for (let k = 0; k < 6; k++) box(PALLET_W, 0.022, 0.13, 0, 0.133, -0.43 + k * 0.172);
  return mergeGeometries(parts);
}
/** Carga del pallet: cajas con el borde superior levemente biselado (film). Altura 1, base en PALLET_H. */
export function loadGeometry() {
  const g = new THREE.BoxGeometry(PALLET_W - 0.04, 1, PALLET_D - 0.04, 1, 1, 1);
  g.translate(0, 0.5 + PALLET_H, 0);
  return g;
}

export function forklift(color) {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.25 });
  const dark = new THREE.MeshStandardMaterial({ color: '#1f2937', roughness: 0.6, metalness: 0.4 });
  const steel = new THREE.MeshStandardMaterial({ color: '#9ca3af', roughness: 0.3, metalness: 0.85 });
  const rubber = new THREE.MeshStandardMaterial({ color: '#111111', roughness: 0.9 });
  const add = (geo, mat, x, y, z, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };

  add(new THREE.BoxGeometry(1.3, 0.75, 1.15), paint, -0.55, 0.5, 0);
  add(new THREE.BoxGeometry(0.35, 0.95, 1.15), dark, -1.18, 0.55, 0);
  add(new THREE.BoxGeometry(1.32, 0.06, 1.17), new THREE.MeshStandardMaterial({ color: '#facc15', roughness: 0.5 }), -0.55, 0.9, 0);
  for (const z of [-0.47, 0.47]) {
    add(new THREE.BoxGeometry(1.25, 0.2, 0.16), paint, 0.55, 0.14, z);
    const w = add(new THREE.CylinderGeometry(0.11, 0.11, 0.1, 16), rubber, 1.08, 0.11, z); w.rotation.x = Math.PI / 2;
  }
  const drive = add(new THREE.CylinderGeometry(0.18, 0.18, 0.18, 18), rubber, -0.75, 0.18, 0.5); drive.rotation.x = Math.PI / 2;
  for (const [x, z] of [[-0.15, -0.52], [-0.15, 0.52], [-1.05, -0.52], [-1.05, 0.52]]) add(new THREE.BoxGeometry(0.06, 1.35, 0.06), dark, x, 1.55, z);
  add(new THREE.BoxGeometry(1.0, 0.06, 1.15), dark, -0.6, 2.24, 0);
  add(new THREE.BoxGeometry(0.34, 0.42, 0.42), new THREE.MeshStandardMaterial({ color: '#374151' }), -0.7, 1.12, 0);
  add(new THREE.CylinderGeometry(0.17, 0.2, 0.55, 12), new THREE.MeshStandardMaterial({ color: '#f97316', roughness: 0.6 }), -0.62, 1.42, 0);
  add(new THREE.SphereGeometry(0.12, 16, 12), new THREE.MeshStandardMaterial({ color: '#d6a77a' }), -0.6, 1.83, 0);
  add(new THREE.SphereGeometry(0.135, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#fde047' }), -0.6, 1.87, 0);
  const beaconMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 2.2, 0.3) });
  const beacon = add(new THREE.SphereGeometry(0.08, 12, 8), beaconMat, -0.95, 2.33, 0);
  // faro delantero
  add(new THREE.BoxGeometry(0.04, 0.08, 0.14), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 3, 2.6) }), 0.12, 2.1, 0.42);

  const reach = new THREE.Group(); reach.position.x = 0.15; g.add(reach);
  for (const z of [-0.38, 0.38]) add(new THREE.BoxGeometry(0.1, 2.4, 0.12), steel, 0, 1.22, z, reach);
  add(new THREE.BoxGeometry(0.1, 0.1, 0.88), steel, 0, 2.4, 0, reach);
  const inner = new THREE.Group(); reach.add(inner);
  for (const z of [-0.3, 0.3]) add(new THREE.BoxGeometry(0.08, 2.4, 0.08), steel, 0.08, 1.25, z, inner);
  add(new THREE.BoxGeometry(0.08, 0.08, 0.68), steel, 0.08, 2.43, 0, inner);
  const carriage = new THREE.Group(); reach.add(carriage);
  add(new THREE.BoxGeometry(0.06, 0.9, 1.0), dark, 0.16, 0.5, 0, carriage);
  for (const z of [-0.32, 0.32]) {
    add(new THREE.BoxGeometry(1.15, 0.05, 0.12), steel, 0.75, 0.0, z, carriage);
    add(new THREE.BoxGeometry(0.05, 0.5, 0.12), steel, 0.2, 0.25, z, carriage);
  }
  const spot = new THREE.Mesh(new THREE.CircleGeometry(0.35, 24), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 0.8, 3), transparent: true, opacity: 0.7, depthWrite: false }));
  spot.rotation.x = -Math.PI / 2; spot.position.set(3.2, 0.02, 0); g.add(spot);
  return { group: g, reach, inner, carriage, beacon, beaconMat, paint };
}

/** Semirremolque con tractor. Frente del tractor hacia +x. */
export function truck(stripe, label, { lights = true, trailer = '#eef0f3' } = {}) {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: trailer, roughness: 0.45, metalness: 0.15 });
  const dark = new THREE.MeshStandardMaterial({ color: '#1f2937', roughness: 0.8 });
  const rubber = new THREE.MeshStandardMaterial({ color: '#0b0b0b', roughness: 0.9 });
  const chrome = new THREE.MeshStandardMaterial({ color: '#d1d5db', roughness: 0.15, metalness: 1 });
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
  add(new THREE.BoxGeometry(12, 2.7, 2.5), white, 6.3, 2.65, 0);
  add(new THREE.BoxGeometry(12.02, 0.32, 2.52), new THREE.MeshStandardMaterial({ color: stripe, roughness: 0.4 }), 6.3, 1.5, 0);
  add(new THREE.BoxGeometry(12, 0.3, 1.2), dark, 6.3, 1.15, 0);
  for (const x of [9.3, 10.6, 11.9]) for (const z of [-1.0, 1.0]) { const w = add(new THREE.CylinderGeometry(0.5, 0.5, 0.4, 20), rubber, x, 0.5, z); w.rotation.x = Math.PI / 2; }
  // tractor con cabina, parabrisas, parrilla y faros
  const cabMat = new THREE.MeshStandardMaterial({ color: stripe, roughness: 0.3, metalness: 0.35 });
  add(new THREE.BoxGeometry(1.4, 1.2, 2.45), cabMat, 13.5, 1.3, 0);
  add(new THREE.BoxGeometry(2.2, 1.7, 2.45), cabMat, 14.6, 2.55, 0);
  add(new THREE.BoxGeometry(0.06, 0.95, 2.15), new THREE.MeshStandardMaterial({ color: '#0b1220', roughness: 0.05, metalness: 0.9 }), 15.71, 2.85, 0);
  add(new THREE.BoxGeometry(0.08, 0.8, 1.4), chrome, 15.72, 1.55, 0);
  add(new THREE.BoxGeometry(0.2, 0.25, 2.5), dark, 15.75, 0.85, 0);
  for (const z of [-1.3, 1.3]) add(new THREE.BoxGeometry(0.1, 0.35, 0.08), dark, 15.4, 2.6, z);
  if (lights) for (const z of [-0.95, 0.95]) add(new THREE.BoxGeometry(0.06, 0.2, 0.34), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 4.8, 4) }), 15.78, 1.2, z);
  for (const z of [-0.9, 0.9]) add(new THREE.BoxGeometry(0.06, 0.16, 0.2), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.2, 0.15) }), 0.28, 1.2, z);
  for (const x of [13.6, 15.0]) for (const z of [-1.05, 1.05]) { const w = add(new THREE.CylinderGeometry(0.5, 0.5, 0.35, 20), rubber, x, 0.5, z); w.rotation.x = Math.PI / 2; }
  if (label) {
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 1.1), new THREE.MeshBasicMaterial({ map: textTex(label, { color: '#0f172a', size: 70 }), transparent: true }));
    sign.position.set(6.3, 2.75, 1.26); g.add(sign);
    const s2 = sign.clone(); s2.rotation.y = Math.PI; s2.position.z = -1.26; g.add(s2);
  }
  return g;
}

/** Árboles instanciados: álamos/cipreses (conos) y copas redondas. */
export function trees(positions, seed = 3) {
  const r = rand(seed);
  const g = new THREE.Group();
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.25, 2, 6).translate(0, 1, 0), new THREE.MeshStandardMaterial({ color: '#5b4330', roughness: 0.9 }), positions.length);
  const cyp = positions.filter((_, i) => i % 3 !== 0), round = positions.filter((_, i) => i % 3 === 0);
  const cone = new THREE.InstancedMesh(new THREE.ConeGeometry(1.1, 7, 8).translate(0, 5, 0), new THREE.MeshStandardMaterial({ color: '#2f5d2b', roughness: 0.85 }), cyp.length);
  const ball = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.4, 1).translate(0, 4.2, 0), new THREE.MeshStandardMaterial({ color: '#4c7a32', roughness: 0.9, flatShading: true }), round.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  positions.forEach(([x, z], i) => { const k = 0.8 + r() * 0.5; trunk.setMatrixAt(i, m.compose(p.set(x, 0, z), q.identity(), s.set(k, k, k))); });
  cyp.forEach(([x, z], i) => { const k = 0.8 + r() * 0.6; cone.setMatrixAt(i, m.compose(p.set(x, 0, z), q.identity(), s.set(k, k * (0.9 + r() * 0.4), k))); });
  round.forEach(([x, z], i) => { const k = 0.7 + r() * 0.6; ball.setMatrixAt(i, m.compose(p.set(x, 0, z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6), s.set(k, k, k))); });
  for (const im of [trunk, cone, ball]) { im.castShadow = true; im.receiveShadow = true; g.add(im); }
  return g;
}
