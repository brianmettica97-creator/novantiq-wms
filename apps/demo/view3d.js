// Vista 3D del depósito con Three.js. Lee el mismo estado de la simulación que el mapa 2D
// (packages/engine/simulation.js) y comparte el objeto `view` (modo, nivel, zonas, hover, selección).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { L, rackY, aisleY, AISLE_LETTERS } from '../../packages/engine/layout.js';
import { locColor, PALETTE } from '../../packages/engine/renderer.js';
import { zoneOf } from '../../packages/engine/slotting.js';
import {
  LEVEL_H, RACK_H, TRAVEL_FORK_H, slotBaseY, slotCenter, handleState, forkHeight, reachAmount,
  facingHeading, palletVisuals, loadHeight, lerpAngle,
} from './scene-state.js';

const PALLET_W = 1.2, PALLET_D = 1.0, PALLET_H = 0.144; // pallet europeo
const CX = L.dockX / 2, CZ = L.H / 2;
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3();
const tmpC = new THREE.Color(), tmpV = new THREE.Vector3();
const LOAD_UP = new THREE.Matrix4().makeTranslation(0, PALLET_H, 0), LOAD_DOWN = new THREE.Matrix4().makeTranslation(0, -PALLET_H, 0);
const tmpS2 = new THREE.Matrix4();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

// ---------- Texturas generadas (sin archivos externos) ----------
function canvasTex(w, h, draw, repeat) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}
function noise(ctx, w, h, base, amp, n) {
  ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const v = Math.random() * amp - amp / 2;
    ctx.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}
const concreteTex = () => canvasTex(256, 256, (c, w, h) => {
  noise(c, w, h, '#5b6472', 0.16, 9000);
  c.strokeStyle = 'rgba(20,24,32,.55)'; c.lineWidth = 2; c.strokeRect(0, 0, w, h); // juntas cada 5 m
}, [L.dockX / 5, L.H / 5]);
const asphaltTex = () => canvasTex(128, 128, (c, w, h) => noise(c, w, h, '#22262d', 0.2, 4000), [16, 12]);
const woodTex = () => canvasTex(128, 32, (c, w, h) => {
  noise(c, w, h, '#b88a55', 0.15, 900);
  c.strokeStyle = 'rgba(90,55,25,.35)';
  for (let y = 3; y < h; y += 5) { c.beginPath(); c.moveTo(0, y); c.bezierCurveTo(w / 3, y + 2, (2 * w) / 3, y - 2, w, y); c.stroke(); }
});
// Cajas apiladas con film stretch: textura neutra que se tiñe con el color de cada pallet.
const cartonTex = () => canvasTex(128, 128, (c, w, h) => {
  noise(c, w, h, '#e9e4dc', 0.08, 1500);
  c.strokeStyle = 'rgba(60,45,30,.55)'; c.lineWidth = 2;
  for (let y = 0; y <= h; y += h / 4) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  for (let r = 0; r < 4; r++) for (let x = (r % 2 ? w / 6 : 0); x <= w; x += w / 3) {
    c.beginPath(); c.moveTo(x, (r * h) / 4); c.lineTo(x, ((r + 1) * h) / 4); c.stroke();
  }
  c.fillStyle = 'rgba(255,255,255,.18)'; c.fillRect(0, h * 0.42, w, 6); // cinta
});
function textTex(text, { w = 512, h = 128, color = '#e2e8f0', bg = null, font = 800, size = 84 } = {}) {
  return canvasTex(w, h, (c) => {
    if (bg) { c.fillStyle = bg; c.fillRect(0, 0, w, h); }
    c.fillStyle = color; c.font = `${font} ${size}px Inter, system-ui, sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, w / 2, h / 2 + 4);
  });
}

// ---------- Geometrías ----------
function palletGeometry() {
  const parts = [];
  const box = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); parts.push(g); };
  // Las horquillas entran por el lado de 1,0 m (eje z), entre los largueros.
  for (const z of [-0.45, 0, 0.45]) box(PALLET_W, 0.022, 0.1, 0, 0.011, z);            // tablas inferiores
  for (const x of [-0.55, 0, 0.55]) box(0.1, 0.1, PALLET_D, x, 0.072, 0);              // tacos / largueros
  for (let k = 0; k < 6; k++) box(PALLET_W, 0.022, 0.13, 0, 0.133, -0.43 + k * 0.172); // tablas superiores
  return mergeGeometries(parts);
}

function forklift(color) {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: '#1f2937', roughness: 0.7, metalness: 0.3 });
  const steel = new THREE.MeshStandardMaterial({ color: '#9ca3af', roughness: 0.35, metalness: 0.8 });
  const rubber = new THREE.MeshStandardMaterial({ color: '#111111', roughness: 0.9 });
  const add = (geo, mat, x, y, z, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; };

  // chasis y contrapeso (atrás, -x)
  add(new THREE.BoxGeometry(1.3, 0.75, 1.15), paint, -0.55, 0.5, 0);
  add(new THREE.BoxGeometry(0.35, 0.95, 1.15), dark, -1.18, 0.55, 0);
  add(new THREE.BoxGeometry(1.32, 0.06, 1.17), new THREE.MeshStandardMaterial({ color: '#facc15', roughness: 0.6 }), -0.55, 0.9, 0);
  // brazos estabilizadores (retráctil) y ruedas
  for (const z of [-0.47, 0.47]) {
    add(new THREE.BoxGeometry(1.25, 0.2, 0.16), paint, 0.55, 0.14, z);
    const w = add(new THREE.CylinderGeometry(0.11, 0.11, 0.1, 16), rubber, 1.08, 0.11, z);
    w.rotation.x = Math.PI / 2;
  }
  const drive = add(new THREE.CylinderGeometry(0.18, 0.18, 0.18, 18), rubber, -0.75, 0.18, 0.5);
  drive.rotation.x = Math.PI / 2;
  // cabina: techo protector con cuatro parantes
  for (const [x, z] of [[-0.15, -0.52], [-0.15, 0.52], [-1.05, -0.52], [-1.05, 0.52]]) add(new THREE.BoxGeometry(0.06, 1.35, 0.06), dark, x, 1.55, z);
  add(new THREE.BoxGeometry(1.0, 0.06, 1.15), dark, -0.6, 2.24, 0);
  // operario con chaleco reflectivo y casco
  add(new THREE.BoxGeometry(0.34, 0.42, 0.42), new THREE.MeshStandardMaterial({ color: '#374151' }), -0.7, 1.12, 0); // asiento
  add(new THREE.CylinderGeometry(0.17, 0.2, 0.55, 12), new THREE.MeshStandardMaterial({ color: '#f97316', roughness: 0.6 }), -0.62, 1.42, 0);
  add(new THREE.SphereGeometry(0.12, 16, 12), new THREE.MeshStandardMaterial({ color: '#d6a77a' }), -0.6, 1.83, 0);
  add(new THREE.SphereGeometry(0.135, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#fde047' }), -0.6, 1.87, 0);
  // baliza
  const beacon = add(new THREE.SphereGeometry(0.08, 12, 8), new THREE.MeshStandardMaterial({ color: '#f59e0b', emissive: '#f59e0b', emissiveIntensity: 1 }), -0.95, 2.33, 0);

  // mástil: exterior fijo, interior telescópico, carro con horquillas (todo se desplaza con el "reach")
  const reach = new THREE.Group(); reach.position.x = 0.15; g.add(reach);
  for (const z of [-0.38, 0.38]) add(new THREE.BoxGeometry(0.1, 2.4, 0.12), steel, 0, 1.22, z, reach);
  add(new THREE.BoxGeometry(0.1, 0.1, 0.88), steel, 0, 2.4, 0, reach);
  const inner = new THREE.Group(); reach.add(inner);
  for (const z of [-0.3, 0.3]) add(new THREE.BoxGeometry(0.08, 2.4, 0.08), steel, 0.08, 1.25, z, inner);
  add(new THREE.BoxGeometry(0.08, 0.08, 0.68), steel, 0.08, 2.43, 0, inner);
  const carriage = new THREE.Group(); reach.add(carriage);
  add(new THREE.BoxGeometry(0.06, 0.9, 1.0), dark, 0.16, 0.5, 0, carriage); // respaldo de carga
  for (const z of [-0.32, 0.32]) {
    add(new THREE.BoxGeometry(1.15, 0.05, 0.12), steel, 0.75, 0.0, z, carriage);
    add(new THREE.BoxGeometry(0.05, 0.5, 0.12), steel, 0.2, 0.25, z, carriage);
  }
  // punto azul de seguridad proyectado al piso
  const spot = new THREE.Mesh(new THREE.CircleGeometry(0.35, 24), new THREE.MeshBasicMaterial({ color: '#3b82f6', transparent: true, opacity: 0.55, depthWrite: false }));
  spot.rotation.x = -Math.PI / 2; spot.position.set(3.2, 0.02, 0); g.add(spot);
  return { group: g, reach, inner, carriage, beacon, paint };
}

function truck(color, label) {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: '#e5e7eb', roughness: 0.55, metalness: 0.1 });
  const dark = new THREE.MeshStandardMaterial({ color: '#1f2937', roughness: 0.8 });
  const rubber = new THREE.MeshStandardMaterial({ color: '#0b0b0b', roughness: 0.9 });
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
  add(new THREE.BoxGeometry(12, 2.7, 2.5), white, 6.3, 2.65, 0);            // semirremolque
  add(new THREE.BoxGeometry(12.02, 0.35, 2.52), new THREE.MeshStandardMaterial({ color }), 6.3, 1.55, 0);
  add(new THREE.BoxGeometry(12, 0.3, 1.2), dark, 6.3, 1.15, 0);             // chasis
  for (const x of [9.3, 10.6, 11.9]) for (const z of [-1.0, 1.0]) {
    const w = add(new THREE.CylinderGeometry(0.5, 0.5, 0.4, 20), rubber, x, 0.5, z); w.rotation.x = Math.PI / 2;
  }
  // tractor
  add(new THREE.BoxGeometry(2.4, 2.7, 2.45), new THREE.MeshStandardMaterial({ color: '#334155', roughness: 0.4, metalness: 0.4 }), 14.4, 2.0, 0);
  add(new THREE.BoxGeometry(0.05, 1.0, 2.1), new THREE.MeshStandardMaterial({ color: '#93c5fd', roughness: 0.1, metalness: 0.6 }), 15.62, 2.6, 0);
  for (const x of [13.6, 15.0]) for (const z of [-1.05, 1.05]) {
    const w = add(new THREE.CylinderGeometry(0.5, 0.5, 0.35, 20), rubber, x, 0.5, z); w.rotation.x = Math.PI / 2;
  }
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 1.1), new THREE.MeshBasicMaterial({ map: textTex(label, { color: '#0f172a', size: 70 }), transparent: true }));
  sign.position.set(6.3, 2.7, 1.26); g.add(sign);
  const sign2 = sign.clone(); sign2.rotation.y = Math.PI; sign2.position.z = -1.26; g.add(sign2);
  return g;
}

export function createView3D(container, view) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(1.75, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  const canvas = renderer.domElement;
  canvas.className = 'map3d';
  container.prepend(canvas); // debajo del tooltip, el zoom y el detalle

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#070b14');
  scene.fog = new THREE.Fog('#070b14', 140, 300);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.3, 700);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2 - 0.04; controls.minDistance = 5; controls.maxDistance = 190;
  controls.screenSpacePanning = false;
  const HOME = { pos: new THREE.Vector3(CX - 18, 48, CZ + 62), target: new THREE.Vector3(CX + 2, 0, CZ) };
  function home() { camera.position.copy(HOME.pos); controls.target.copy(HOME.target); controls.update(); }
  home();

  // ---------- Luces ----------
  scene.add(new THREE.HemisphereLight('#dbe4f0', '#2a3344', 1.1));
  const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
  sun.position.set(CX + 35, 70, CZ + 30); sun.target.position.set(CX, 0, CZ);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 45, bottom: -45, near: 10, far: 170 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  // ---------- Edificio ----------
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(L.dockX, L.H), new THREE.MeshStandardMaterial({ map: concreteTex(), roughness: 0.85, metalness: 0.05 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set(L.dockX / 2, 0, L.H / 2); floor.receiveShadow = true; scene.add(floor);
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(40, L.H + 30), new THREE.MeshStandardMaterial({ map: asphaltTex(), roughness: 0.95 }));
  apron.rotation.x = -Math.PI / 2; apron.position.set(L.dockX + 20, -0.02, L.H / 2); apron.receiveShadow = true; scene.add(apron);

  // Paredes que solo se ven desde adentro: al mirar desde afuera no tapan la nave.
  const WALL_H = 10;
  const wallMat = new THREE.MeshStandardMaterial({ color: '#94a3b8', roughness: 0.8, side: THREE.FrontSide });
  const wallTex = canvasTex(64, 256, (c, w, h) => { c.fillStyle = '#9aa6b6'; c.fillRect(0, 0, w, h); c.fillStyle = 'rgba(0,0,0,.14)'; c.fillRect(0, 0, 4, h); c.fillStyle = '#3b4a63'; c.fillRect(0, h - 26, w, 26); }, [1, 1]);
  wallTex.wrapS = THREE.RepeatWrapping;
  function wall(len, x, z, rotY, h = WALL_H, y = h / 2, repeat = len / 1.2) {
    const t = wallTex.clone(); t.needsUpdate = true; t.repeat.set(repeat, 1);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, h), wallMat.clone()); m.material.map = t;
    m.position.set(x, y, z); m.rotation.y = rotY; m.receiveShadow = true; scene.add(m); return m;
  }
  wall(L.dockX, L.dockX / 2, 0, 0);                    // fondo (z = 0), mira hacia +z
  wall(L.dockX, L.dockX / 2, L.H, Math.PI);            // frente
  wall(L.H, 0, L.H / 2, Math.PI / 2);                  // izquierda
  // pared de muelles con aberturas

  {
    const DOOR_W = 3.2, DOOR_H = 3.6;
    const edges = [0];
    for (let k = 0; k < 6; k++) { const y = L.margin + (k + 0.5) * ((L.H - 2 * L.margin) / 6); edges.push(y - DOOR_W / 2, y + DOOR_W / 2); }
    edges.push(L.H);
    for (let k = 0; k < edges.length; k += 2) { const a = edges[k], b = edges[k + 1]; wall(b - a, L.dockX, (a + b) / 2, -Math.PI / 2, WALL_H, WALL_H / 2, (b - a) / 1.2); }
    for (let k = 1; k < edges.length - 1; k += 2) {
      const a = edges[k], b = edges[k + 1];
      wall(b - a, L.dockX, (a + b) / 2, -Math.PI / 2, WALL_H - DOOR_H, DOOR_H + (WALL_H - DOOR_H) / 2, 2);
    }
  }

  // Marcas de piso (líneas amarillas de pasillo, staging)
  const lineMat = new THREE.MeshBasicMaterial({ color: '#eab308' });
  const lines = [];
  for (let i = 0; i < L.aisles; i++) for (const s of [-1, 1]) lines.push([L.x0, aisleY(i) + s * (L.aisleW / 2 - 0.12), L.rackEndX, aisleY(i) + s * (L.aisleW / 2 - 0.12)]);
  for (const x of [L.rackEndX + 1.2, L.stageX0 - 1]) lines.push([x, L.margin, x, L.H - L.margin]);
  const sx0 = L.stageX0, sx1 = L.dockX - 1.6, sz0 = L.margin, sz1 = L.H - L.margin;
  for (let z = sz0; z < sz1; z += 1.2) { lines.push([sx0, z, sx0, Math.min(z + 0.6, sz1)]); lines.push([sx1, z, sx1, Math.min(z + 0.6, sz1)]); }
  for (let x = sx0; x < sx1; x += 1.2) { lines.push([x, sz0, Math.min(x + 0.6, sx1), sz0]); lines.push([x, sz1, Math.min(x + 0.6, sx1), sz1]); }
  {
    const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), lineMat, lines.length);
    lines.forEach(([x1, z1, x2, z2], k) => {
      const horiz = Math.abs(z2 - z1) < 1e-6;
      tmpS.set(horiz ? x2 - x1 : 0.1, 1, horiz ? 0.1 : z2 - z1);
      im.setMatrixAt(k, tmpM.compose(tmpP.set((x1 + x2) / 2, 0.006, (z1 + z2) / 2), tmpQ.identity(), tmpS));
    });
    scene.add(im);
  }
  function floorLabel(text, x, z, w, h, rot = 0, opacity = 0.4) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: textTex(text, { w: 1024, size: 90, color: '#ffffff' }), transparent: true, opacity, depthWrite: false }));
    m.rotation.set(-Math.PI / 2, 0, rot); m.position.set(x, 0.01, z); scene.add(m); return m;
  }
  floorLabel('ZONA DE STAGING', L.stageX0 + 1.6, L.H / 2, 22, 2.75, Math.PI / 2, 0.3);
  floorLabel('PASILLO PRINCIPAL', L.mainX, L.H / 2, 22, 2.75, Math.PI / 2, 0.22);
  for (let i = 0; i < L.aisles; i++) {
    floorLabel(AISLE_LETTERS[i], L.backX, aisleY(i), 10, 2.5, 0, 0.9);
    // cartel colgante de pasillo
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.1), new THREE.MeshBasicMaterial({ map: textTex('PASILLO ' + AISLE_LETTERS[i], { w: 512, h: 256, size: 92, color: '#0b1220', bg: '#facc15' }), side: THREE.DoubleSide }));
    sign.position.set(L.rackEndX + 0.8, RACK_H + 1.1, aisleY(i)); sign.rotation.y = Math.PI / 2; scene.add(sign);
    // tira de luz LED sobre el pasillo
    const led = new THREE.Mesh(new THREE.BoxGeometry(L.rackEndX - L.x0, 0.08, 0.25), new THREE.MeshBasicMaterial({ color: '#94a3b8', transparent: true, opacity: 0.5 }));
    led.position.set((L.x0 + L.rackEndX) / 2, WALL_H - 0.6, aisleY(i)); scene.add(led);
  }

  // ---------- Racks selectivos (parantes azules, vigas naranjas) ----------
  const steelBlue = new THREE.MeshStandardMaterial({ color: '#1d4ed8', roughness: 0.45, metalness: 0.55 });
  const beamOrange = new THREE.MeshStandardMaterial({ color: '#ea580c', roughness: 0.5, metalness: 0.4 });
  const nRacks = L.aisles * 2, nFrames = L.bays + 1;
  const uprights = new THREE.InstancedMesh(new THREE.BoxGeometry(0.09, RACK_H, 0.09), steelBlue, nRacks * nFrames * 2);
  const bracesPerFrame = 5;
  const braceLen = Math.hypot(L.rackD - 0.1, RACK_H / bracesPerFrame);
  const braces = new THREE.InstancedMesh(new THREE.BoxGeometry(0.035, braceLen, 0.035), steelBlue, nRacks * nFrames * bracesPerFrame);
  const beamLevels = L.levels - 1;
  const beams = new THREE.InstancedMesh(new THREE.BoxGeometry(L.bayW - 0.09, 0.13, 0.05), beamOrange, nRacks * L.bays * beamLevels * 2);
  const guards = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.45, L.rackD + 0.2), new THREE.MeshStandardMaterial({ color: '#facc15', roughness: 0.6 }), nRacks * 2);
  let ku = 0, kb = 0, kbr = 0, kg = 0;
  for (let i = 0; i < L.aisles; i++) for (let side = 0; side < 2; side++) {
    const z0 = rackY(i, side) + 0.05, z1 = rackY(i, side) + L.rackD - 0.05;
    for (let c = 0; c < nFrames; c++) {
      const x = L.x0 + c * L.bayW;
      for (const z of [z0, z1]) uprights.setMatrixAt(ku++, tmpM.makeTranslation(x, RACK_H / 2, z));
      for (let b = 0; b < bracesPerFrame; b++) {
        const dir = b % 2 ? 1 : -1;
        tmpQ.setFromAxisAngle(new THREE.Vector3(1, 0, 0), dir * Math.atan2(L.rackD - 0.1, RACK_H / bracesPerFrame));
        braces.setMatrixAt(kbr++, tmpM.compose(tmpP.set(x, (b + 0.5) * (RACK_H / bracesPerFrame), (z0 + z1) / 2), tmpQ, tmpS.set(1, 1, 1)));
      }
      if (c < L.bays) for (let lv = 1; lv <= beamLevels; lv++) for (const z of [z0, z1]) beams.setMatrixAt(kb++, tmpM.makeTranslation(x + L.bayW / 2, lv * LEVEL_H, z));
    }
    for (const x of [L.x0 - 0.25, L.rackEndX + 0.25]) guards.setMatrixAt(kg++, tmpM.makeTranslation(x, 0.225, (z0 + z1) / 2));
  }
  for (const m of [uprights, braces, beams, guards]) { m.castShadow = true; m.receiveShadow = true; scene.add(m); }

  // ---------- Muelles ----------
  for (let k = 0; k < 6; k++) {
    const y = L.margin + (k + 0.5) * ((L.H - 2 * L.margin) / 6);
    const inbound = k < 2, code = inbound ? `R${k + 1}` : `D${k - 1}`;
    const col = inbound ? PALETTE.inDock : PALETTE.outDock;
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.18, depthWrite: false }));
    pad.position.set(L.dockX - 1.7, 0.008, y); scene.add(pad);
    const leveler = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.05, 2.4), new THREE.MeshStandardMaterial({ color: '#4b5563', metalness: 0.6, roughness: 0.5 }));
    leveler.position.set(L.dockX - 0.6, 0.03, y); leveler.receiveShadow = true; scene.add(leveler);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.5, 3.2), new THREE.MeshStandardMaterial({ color: '#64748b', metalness: 0.5, roughness: 0.4 }));
    door.position.set(L.dockX - 0.2, 3.35, y); scene.add(door);
    for (const z of [y - 1.35, y + 1.35]) {
      const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.4, 0.25), new THREE.MeshStandardMaterial({ color: '#111827' }));
      bumper.position.set(L.dockX + 0.08, 0.9, z); scene.add(bumper);
    }
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshBasicMaterial({ color: col }));
    light.position.set(L.dockX - 0.1, 3.9, y + 1.9); scene.add(light);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.8), new THREE.MeshBasicMaterial({ map: textTex(`${code} · ${inbound ? 'RECEPCIÓN' : 'DESPACHO'}`, { w: 768, h: 192, size: 78, color: '#0b1220', bg: col }) }));
    sign.position.set(L.dockX - 0.05, 4.4, y); sign.rotation.y = -Math.PI / 2; scene.add(sign);
    const t = truck(col, code); t.position.set(L.dockX + 0.25, 0, y); scene.add(t);

  }

  // ---------- Zonas de slotting (tinte de piso bajo los racks) ----------
  const nLocs = L.aisles * 2 * L.bays * L.levels;
  const zoneMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(L.bayW, L.rackD + 0.5).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.32, depthWrite: false }), L.aisles * 2 * L.bays);
  zoneMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(zoneMesh.count * 3), 3);
  scene.add(zoneMesh);

  // ---------- Pallets ----------
  const EXTRA = 16; // pallets en horquillas
  const palletGeo = palletGeometry();
  const palletMesh = new THREE.InstancedMesh(palletGeo, new THREE.MeshStandardMaterial({ map: woodTex(), roughness: 0.85 }), nLocs + EXTRA);
  const loadGeo = new THREE.BoxGeometry(PALLET_W - 0.04, 1, PALLET_D - 0.04); loadGeo.translate(0, 0.5 + PALLET_H, 0);
  const loadMesh = new THREE.InstancedMesh(loadGeo, new THREE.MeshStandardMaterial({ map: cartonTex(), roughness: 0.38, metalness: 0.02 }), nLocs + EXTRA);
  loadMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array((nLocs + EXTRA) * 3), 3);
  const ghostMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(PALLET_W, 1.3, PALLET_D).translate(0, 0.65, 0), new THREE.MeshStandardMaterial({ color: PALETTE.reservedSlot, transparent: true, opacity: 0.22, depthWrite: false }), nLocs);
  for (const m of [palletMesh, loadMesh]) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; scene.add(m); }
  ghostMesh.frustumCulled = false; scene.add(ghostMesh);
  // Volumen invisible de cada ubicación para el puntero (incluye ubicaciones vacías).
  const pickMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(L.bayW - 0.15, LEVEL_H - 0.15, L.rackD).translate(0, (LEVEL_H - 0.15) / 2, 0), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }), nLocs);
  scene.add(pickMesh);
  let pickLevel = null;

  // Resaltados: hover, selección y destino de cada clark
  const boxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
  const mkOutline = (color, opacity = 1) => { const o = new THREE.LineSegments(boxEdges, new THREE.LineBasicMaterial({ color, transparent: true, opacity })); o.visible = false; scene.add(o); return o; };
  const hoverBox = mkOutline('#ffffff', 0.65), selBox = mkOutline('#ffffff', 1);
  function placeOutline(o, loc, pad = 0.08) {
    if (!loc) { o.visible = false; return; }
    const c = slotCenter(loc);
    o.position.set(c.x, slotBaseY(loc.level) - pad / 2, c.z);
    o.scale.set(L.bayW - 0.2 + pad, LEVEL_H - 0.25 + pad, L.rackD - 0.1 + pad);
    o.visible = true;
  }

  // ---------- Clarks ----------
  let clarkObjs = [];
  let builtFor = null;
  function buildClarks(st) {
    for (const o of clarkObjs) { scene.remove(o.f.group, o.line, o.target, o.label); }
    clarkObjs = st.clarks.map((c) => {
      const f = forklift(c.color);
      f.group.traverse((m) => { m.userData.clarkId = c.id; });
      scene.add(f.group);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 12), 3));
      const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: c.color, dashSize: 1.1, gapSize: 0.8, transparent: true, opacity: 0.6 }));
      line.frustumCulled = false; scene.add(line);
      const target = mkOutline(c.color, 0.9);
      const lt = canvasTex(128, 128, (x) => {
        x.fillStyle = c.color; x.beginPath(); x.arc(64, 64, 58, 0, Math.PI * 2); x.fill();
        x.fillStyle = '#0b1220'; x.font = '800 72px Inter, system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(c.id), 64, 68);
      });
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: lt, depthTest: false }));
      label.scale.set(0.9, 0.9, 1); label.renderOrder = 10; scene.add(label);
      return { c, f, line, target, label, heading: c.heading };
    });
    builtFor = st;
  }

  // ---------- Actualización por cuadro ----------
  let lastZones = 0, lastW = 0, lastH = 0;
  function palletColor(st, p) {
    const loc = { palletId: p.id, reserved: false };
    return view.mode === 'ocupacion' ? PALETTE.occupied : locColor(st, loc, view.mode);
  }
  function setPallet(i, x, y, z, rotY, pallet, sku, color) {
    tmpQ.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rotY);
    palletMesh.setMatrixAt(i, tmpM.compose(tmpP.set(x, y, z), tmpQ, tmpS.set(1, 1, 1)));
    // la carga escala solo en altura: la base del pallet queda fija
    tmpM.multiply(LOAD_UP).multiply(tmpS2.makeScale(1, loadHeight(pallet, sku), 1)).multiply(LOAD_DOWN);
    loadMesh.setMatrixAt(i, tmpM);
    loadMesh.setColorAt(i, tmpC.set(color));
  }

  function update(st, now) {
    if (builtFor !== st) buildClarks(st);
    const lf = view.level === 'all' ? null : Number(view.level);
    const vis = palletVisuals(st);

    // zonas A/B
    if (now - lastZones > 800 || zoneMesh.userData.show !== view.showZones) {
      lastZones = now; zoneMesh.userData.show = view.showZones;
      let k = 0;
      for (const loc of st.locations) {
        if (loc.level !== 0) continue;
        const z = st.thrA != null ? zoneOf(st, loc) : 'C';
        const c = slotCenter(loc);
        zoneMesh.setMatrixAt(k, view.showZones && z !== 'C' ? tmpM.makeTranslation(c.x, 0.004, c.z) : HIDDEN);
        zoneMesh.setColorAt(k, tmpC.set(z === 'A' ? '#22c55e' : '#f59e0b').multiplyScalar(z === 'A' ? 1 : 0.55));
        k++;
      }
      zoneMesh.instanceMatrix.needsUpdate = true; zoneMesh.instanceColor.needsUpdate = true;
    }

    // pallets en racks y reservas
    for (const loc of st.locations) {
      const i = loc.id;
      const shown = lf == null || loc.level === lf;
      const p = shown ? vis.slots.get(loc.id) : null;
      const c = slotCenter(loc);
      const y = slotBaseY(loc.level);
      if (p) {
        setPallet(i, c.x, y, c.z, 0, p, st.skuMap.get(p.skuId), palletColor(st, p));
        ghostMesh.setMatrixAt(i, HIDDEN);
      } else {
        palletMesh.setMatrixAt(i, HIDDEN); loadMesh.setMatrixAt(i, HIDDEN);
        ghostMesh.setMatrixAt(i, shown && loc.reserved ? tmpM.makeTranslation(c.x, y, c.z) : HIDDEN);
      }
    }
    if (pickLevel !== view.level) {
      pickLevel = view.level;
      for (const loc of st.locations) {
        const c = slotCenter(loc);
        pickMesh.setMatrixAt(loc.id, lf == null || loc.level === lf ? tmpM.makeTranslation(c.x, slotBaseY(loc.level), c.z) : HIDDEN);
      }
      pickMesh.instanceMatrix.needsUpdate = true; pickMesh.computeBoundingSphere();
    }

    // clarks
    const pulse = 0.5 + 0.5 * Math.sin(now / 220);
    clarkObjs.forEach((o, k) => {
      const { c, f } = o;
      const h = handleState(st, c);
      const wantHeading = h ? facingHeading(st, h.ref) : c.heading;
      o.heading = lerpAngle(o.heading, wantHeading, 0.18);
      f.group.position.set(c.x, 0, c.y);
      f.group.rotation.y = -o.heading;
      const fh = h ? forkHeight(h.level, h.p) : TRAVEL_FORK_H;
      f.carriage.position.y = fh;
      f.inner.position.y = Math.max(0, fh - 1.1);
      f.reach.position.x = 0.15 + (h && h.ref.kind === 'loc' ? reachAmount(h.p) * 0.75 : 0);
      f.beacon.material.color.set(c.blocked ? '#ef4444' : '#f59e0b');
      f.beacon.material.emissive.set(c.blocked ? '#ef4444' : '#f59e0b');
      f.beacon.material.emissiveIntensity = c.blocked ? 3 : c.task ? (Math.sin(now / 120 + k) > 0 ? 2.2 : 0.2) : 0.3;
      o.label.position.set(c.x, 3.1, c.y);
      o.label.scale.setScalar(view.selectedClark === c ? 0.95 : 0.65);

      const p = vis.carried.get(c.id);
      const idx = nLocs + k;
      if (p) {
        f.group.updateMatrixWorld(true);
        const wp = tmpV.set(0.78, 0.03, 0).applyMatrix4(f.carriage.matrixWorld);
        setPallet(idx, wp.x, wp.y, wp.z, -o.heading + Math.PI / 2, p, st.skuMap.get(p.skuId), palletColor(st, p));
      } else { palletMesh.setMatrixAt(idx, HIDDEN); loadMesh.setMatrixAt(idx, HIDDEN); }

      // recorrido planificado
      const pos = o.line.geometry.attributes.position;
      const pts = [{ x: c.x, y: c.y }, ...c.path].slice(0, 12);
      pts.forEach((pt, j) => pos.setXYZ(j, pt.x, 0.05, pt.y));
      pos.needsUpdate = true;
      o.line.geometry.setDrawRange(0, pts.length > 1 ? pts.length : 0);
      o.line.computeLineDistances();
      o.line.material.opacity = view.selectedClark === c ? 0.95 : 0.55;

      // destino activo
      const ref = c.task ? (c.phase === 'toFrom' || c.phase === 'handle1' ? c.task.from : c.task.to) : null;
      if (ref && ref.kind === 'loc') { placeOutline(o.target, st.locations[ref.id], 0.25 + pulse * 0.25); o.target.material.opacity = 0.45 + 0.55 * pulse; }
      else o.target.visible = false;
    });
    for (let k = clarkObjs.length; k < EXTRA; k++) { palletMesh.setMatrixAt(nLocs + k, HIDDEN); loadMesh.setMatrixAt(nLocs + k, HIDDEN); }
    for (const m of [palletMesh, loadMesh, ghostMesh]) m.instanceMatrix.needsUpdate = true;
    loadMesh.instanceColor.needsUpdate = true;

    placeOutline(hoverBox, view.hover && view.hover !== view.selected ? view.hover : null);
    placeOutline(selBox, view.selected, 0.14);
  }

  // ---------- API pública ----------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  return {
    canvas,
    resize(w, h) {
      if (w === lastW && h === lastH) return;
      lastW = w; lastH = h;
      renderer.setSize(w, h, false);
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
    },
    render(st, now) {
      update(st, now);
      controls.update();
      renderer.render(scene, camera);
    },
    /** Mismo contrato que hitTest() del mapa 2D: {type:'clark', clark} | {type:'loc', loc} | null */
    hitTest(st, sx, sy) {
      ndc.set((sx / lastW) * 2 - 1, -(sy / lastH) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const targets = [pickMesh, ...clarkObjs.map((o) => o.f.group)];
      const hit = raycaster.intersectObjects(targets, true)[0];
      if (!hit) return null;
      if (hit.object.userData.clarkId != null) return { type: 'clark', clark: st.clarks.find((c) => c.id === hit.object.userData.clarkId) };
      if (hit.object === pickMesh && hit.instanceId != null) return { type: 'loc', loc: st.locations[hit.instanceId] };
      return null;
    },
    zoom(f) {
      const d = camera.position.clone().sub(controls.target);
      const len = Math.max(controls.minDistance, Math.min(controls.maxDistance, d.length() / f));
      camera.position.copy(controls.target).add(d.setLength(len));
    },
    home,
    /** Vista a la altura del operario, en la cabecera de un pasillo. */
    aisleView(i = 0) {
      controls.target.set((L.x0 + L.rackEndX) / 2, 2, aisleY(i));
      camera.position.set(L.rackEndX + 9, 5.5, aisleY(i) + 1.2);
    },
    /** Acerca la cámara a un punto del depósito (x, z en metros). */
    focus(x, z, dist = 7) {
      controls.target.set(x, 1.2, z);
      camera.position.set(x + dist, dist * 0.45, z + 0.4); // a lo largo del pasillo
    },
    dispose() { renderer.dispose(); canvas.remove(); },
  };
}
