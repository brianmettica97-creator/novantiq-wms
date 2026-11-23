// Entorno de la escena: cielo, terreno, edificio (con corte automático de paredes),
// iluminación de la nave y post-procesado según el nivel de calidad.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { L, aisleY, AISLE_LETTERS } from '../../packages/engine/layout.js';
import { PALETTE } from '../../packages/engine/renderer.js';
import { RACK_H } from './scene-state.js';
import {
  canvasTex, textTex, concreteTex, asphaltTex, grassTex, claddingTex, innerWallTex, radialTex, verticalFadeTex, truck, trees, mergeStatic,
} from './models3d.js';

export const WALL_H = 10;
export const HORIZON = new THREE.Color('#cfd8e3');

export const QUALITY = {
  alta: { pixelRatio: 2, shadows: 4096, ao: true, bloom: true, cones: true },
  media: { pixelRatio: 1.5, shadows: 2048, ao: false, bloom: true, cones: true },
  baja: { pixelRatio: 1.25, shadows: 0, ao: false, bloom: false, cones: false }, // celulares: sin sombras ni post-procesado
};
export function defaultQuality() {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (coarse) return 'baja'; // celulares y tablets: lo más fluido
  return window.innerWidth < 1100 ? 'media' : 'alta';
}

const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), s3 = new THREE.Vector3(), p3 = new THREE.Vector3();
const DOCK_YS = Array.from({ length: 6 }, (_, k) => L.margin + (k + 0.5) * ((L.H - 2 * L.margin) / 6));
export { DOCK_YS };

// ---------- Cielo ----------
// Panorámica equirectangular pintada en un canvas (degradé, sol y nubes). Va como fondo de la escena:
// el post-procesado (oclusión ambiental) no la toca y es más liviana que una cúpula con geometría.
function skyTexture() {
  const W = 2048, H = 1024;
  const t = canvasTex(W, H, (c) => {
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#2f6bb5'); g.addColorStop(0.3, '#6f9fd6'); g.addColorStop(0.46, '#c3d6ea'); g.addColorStop(0.5, '#e4e9ef'); g.addColorStop(1, '#d5dde6');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    const sx = W * 0.14, sy = H * 0.33; // sol de la tarde
    const sg = c.createRadialGradient(sx, sy, 0, sx, sy, 260);
    sg.addColorStop(0, 'rgba(255,244,214,1)'); sg.addColorStop(0.08, 'rgba(255,236,200,.9)'); sg.addColorStop(1, 'rgba(255,230,190,0)');
    c.fillStyle = sg; c.fillRect(0, 0, W, H);
    let a = 7; const r = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
    for (let k = 0; k < 70; k++) { // bancos de nubes cerca del horizonte
      const cx = r() * W, cy = H * (0.22 + r() * 0.24), n = 6 + Math.floor(r() * 8), sc = 0.6 + r() * 1.2;
      for (let j = 0; j < n; j++) {
        const x = cx + (r() - 0.5) * 160 * sc, y = cy + (r() - 0.5) * 24 * sc, rad = (22 + r() * 40) * sc;
        const cg = c.createRadialGradient(x, y, 0, x, y, rad);
        cg.addColorStop(0, 'rgba(255,255,255,.55)'); cg.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = cg; c.beginPath(); c.ellipse(x, y, rad * 1.6, rad, 0, 0, 7); c.fill();
      }
    }
  });
  t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}
export function buildEnvironment(scene, renderer, { brand = 'CENTRO DE DISTRIBUCIÓN' } = {}) {
  const env = { walls: [], lampCones: null, lampPools: null, movingTruck: null, signMat: null };

  scene.background = skyTexture();
  scene.fog = new THREE.Fog(HORIZON.clone(), 320, 1000);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;

  // ---------- Luces ----------
  scene.add(new THREE.HemisphereLight('#dfe8f5', '#4a4636', 0.9));
  const sun = new THREE.DirectionalLight('#fff1dc', 2.0);
  sun.position.set(L.dockX / 2 + 55, 85, L.H / 2 + 45); sun.target.position.set(L.dockX / 2, 0, L.H / 2);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -75, right: 75, top: 60, bottom: -60, near: 10, far: 260 });
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  env.sun = sun;

  // ---------- Terreno, playón y ruta ----------
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), new THREE.MeshStandardMaterial({ map: grassTex(260, 260), roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.set(L.dockX / 2, -0.06, L.H / 2); ground.receiveShadow = true; scene.add(ground);
  const yardX0 = -8, yardX1 = L.dockX + 40, yardZ0 = -14, yardZ1 = L.H + 14;
  const yard = new THREE.Mesh(new THREE.PlaneGeometry(yardX1 - yardX0, yardZ1 - yardZ0), new THREE.MeshStandardMaterial({ map: asphaltTex(20, 12), roughness: 0.92 }));
  yard.rotation.x = -Math.PI / 2; yard.position.set((yardX0 + yardX1) / 2, -0.03, (yardZ0 + yardZ1) / 2); yard.receiveShadow = true; scene.add(yard);
  const roadX = L.dockX + 50;
  const road = new THREE.Mesh(new THREE.PlaneGeometry(9, 1600), new THREE.MeshStandardMaterial({ map: asphaltTex(2, 180), roughness: 0.9 }));
  road.rotation.x = -Math.PI / 2; road.position.set(roadX, -0.025, L.H / 2); road.receiveShadow = true; scene.add(road);
  const drive = new THREE.Mesh(new THREE.PlaneGeometry(10, 12), road.material);
  drive.rotation.x = -Math.PI / 2; drive.position.set(L.dockX + 45, -0.028, L.H + 8); scene.add(drive);
  // pintura: línea central de la ruta, cajones del playón, flechas
  const paint = new THREE.MeshBasicMaterial({ color: '#e5e7eb' });
  const stripes = [];
  for (let z = -780; z < 800; z += 9) stripes.push([roadX, z, 0.18, 4.5]);
  for (const s of [-1, 1]) stripes.push([roadX + s * 4.2, L.H / 2, 0.15, 1600]);
  for (let k = 0; k < 9; k++) stripes.push([L.dockX + 26, yardZ0 + 4 + k * 4.6, 12, 0.14]);
  for (let k = 0; k < 6; k++) stripes.push([L.dockX + 14, DOCK_YS[k] + 1.7, 14, 0.12], [L.dockX + 14, DOCK_YS[k] - 1.7, 14, 0.12]);
  const st = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), paint, stripes.length);
  stripes.forEach(([x, z, w, d], i) => st.setMatrixAt(i, m4.compose(p3.set(x, -0.02, z), q4.identity(), s3.set(w, 1, d))));
  scene.add(st);

  // árboles: alamedas a lo largo de la ruta y cortina detrás de la nave
  const tp = [];
  for (let z = -160; z < 220; z += 7) tp.push([roadX + 9 + (z % 3), z], [roadX - 9.5, z + 3]);
  for (let x = -60; x < L.dockX + 30; x += 8) tp.push([x, -28 - (x % 5)], [x + 3, L.H + 30 + (x % 4)]);
  for (let z = -20; z < L.H + 30; z += 7) tp.push([-24 - (z % 3), z]);
  scene.add(trees(tp.filter(([x, z]) => !(x > L.dockX + 38 && x < roadX - 6 && z > L.H && z < L.H + 16))));

  // columnas de alumbrado del playón
  const poles = [];
  for (let z = yardZ0 + 6; z < yardZ1; z += 16) poles.push([L.dockX + 37.5, z]);
  const poleM = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.16, 9, 8).translate(0, 4.5, 0), new THREE.MeshStandardMaterial({ color: '#6b7280', metalness: 0.7, roughness: 0.4 }), poles.length);
  const headM = new THREE.InstancedMesh(new THREE.BoxGeometry(1.2, 0.18, 0.5).translate(-0.4, 9, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 4.6, 3.6) }), poles.length);
  poles.forEach(([x, z], i) => { poleM.setMatrixAt(i, m4.makeTranslation(x, 0, z)); headM.setMatrixAt(i, m4.makeTranslation(x, 0, z)); });
  poleM.castShadow = true; scene.add(poleM, headM);

  // ---------- Nave ----------
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(L.dockX, L.H), new THREE.MeshStandardMaterial({ map: concreteTex(L.dockX / 5, L.H / 5), roughness: 0.42, metalness: 0.05 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set(L.dockX / 2, 0, L.H / 2); floor.receiveShadow = true; scene.add(floor);
  const slab = new THREE.Mesh(new THREE.BoxGeometry(L.dockX + 0.6, 0.3, L.H + 0.6), new THREE.MeshStandardMaterial({ color: '#7b818a', roughness: 0.9 }));
  slab.position.set(L.dockX / 2, -0.16, L.H / 2); scene.add(slab);

  // Cada paño de pared tiene cara interior y exterior. Si la cámara está afuera mirando hacia adentro,
  // el paño se oculta (vista de corte); desde adentro o mirando la fachada se ve completo.
  const outMat = (len) => new THREE.MeshStandardMaterial({ map: claddingTex(len / 1.1), roughness: 0.55, metalness: 0.35 });
  const inMat = (len) => new THREE.MeshStandardMaterial({ map: innerWallTex(len / 1.2), roughness: 0.75 });
  function wall(len, x, z, rotY, h = WALL_H, y = h / 2) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rotY;
    const inner = new THREE.Mesh(new THREE.PlaneGeometry(len, h), inMat(len)); inner.position.y = y; inner.receiveShadow = true;
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(len, h), outMat(len)); outer.position.set(0, y, -0.25); outer.rotation.y = Math.PI; outer.receiveShadow = true;
    g.add(inner, outer); g.userData.dynamic = true; scene.add(g);
    const n = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY); // normal hacia afuera
    env.walls.push({ group: g, n, p: new THREE.Vector3(x, 0, z) });
    return g;
  }
  wall(L.dockX, L.dockX / 2, 0, 0);
  wall(L.dockX, L.dockX / 2, L.H, Math.PI);
  wall(L.H, 0, L.H / 2, Math.PI / 2);
  {
    const DOOR_W = 3.2, DOOR_H = 3.6;
    const edges = [0];
    for (const y of DOCK_YS) edges.push(y - DOOR_W / 2, y + DOOR_W / 2);
    edges.push(L.H);
    for (let k = 0; k < edges.length; k += 2) wall(edges[k + 1] - edges[k], L.dockX, (edges[k] + edges[k + 1]) / 2, -Math.PI / 2);
    for (let k = 1; k < edges.length - 1; k += 2) wall(edges[k + 1] - edges[k], L.dockX, (edges[k] + edges[k + 1]) / 2, -Math.PI / 2, WALL_H - DOOR_H, DOOR_H + (WALL_H - DOOR_H) / 2);
  }
  // Techo: solo se ve desde abajo (desde afuera y arriba queda abierto, tipo maqueta en corte).
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(L.dockX, L.H), new THREE.MeshStandardMaterial({
    map: canvasTex(64, 64, (c, w, h) => { c.fillStyle = '#3b4250'; c.fillRect(0, 0, w, h); c.fillStyle = '#2b313c'; c.fillRect(0, 0, w, 6); c.fillRect(0, 0, 6, h); }, [L.dockX / 4, L.H / 4]), roughness: 0.9,
  }));
  roof.rotation.x = Math.PI / 2; roof.position.set(L.dockX / 2, WALL_H, L.H / 2); scene.add(roof);
  // cerchas (vigas del techo)
  const truss = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 0.5, L.H), new THREE.MeshStandardMaterial({ color: '#4b5563', metalness: 0.6, roughness: 0.5 }), Math.floor(L.dockX / 6));
  for (let k = 0; k < truss.count; k++) truss.setMatrixAt(k, m4.makeTranslation(3 + k * 6, WALL_H - 0.3, L.H / 2));
  scene.add(truss);
  env.indoorOnly = [truss]; // se ven solo con la cámara adentro de la nave

  // Fachada de muelles: marquesina y cartel iluminado
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.25, L.H + 2), new THREE.MeshStandardMaterial({ color: '#1f2937', metalness: 0.5, roughness: 0.5 }));
  canopy.position.set(L.dockX + 1.6, 4.7, L.H / 2); canopy.castShadow = true; scene.add(canopy);
  const canopyLights = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 0.05, 0.3), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 4.6, 3.8) }), 6);
  DOCK_YS.forEach((y, k) => canopyLights.setMatrixAt(k, m4.makeTranslation(L.dockX + 2.4, 4.56, y)));
  scene.add(canopyLights);
  env.signMat = new THREE.MeshBasicMaterial({ map: signTex(brand), toneMapped: true });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(26, 2.6), env.signMat);
  sign.position.set(L.dockX + 0.3, 7.4, L.H / 2); sign.rotation.y = Math.PI / 2; scene.add(sign);
  const signBack = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3, 27), new THREE.MeshStandardMaterial({ color: '#0b1220' }));
  signBack.position.set(L.dockX + 0.18, 7.4, L.H / 2); scene.add(signBack);

  // Muelles: portones, niveladoras, topes, semáforo y cartel interior
  DOCK_YS.forEach((y, k) => {
    const inbound = k < 2, code = inbound ? `R${k + 1}` : `D${k - 1}`;
    const col = inbound ? PALETTE.inDock : PALETTE.outDock;
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.2, depthWrite: false }));
    pad.position.set(L.dockX - 1.7, 0.008, y); scene.add(pad);
    const leveler = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.05, 2.4), new THREE.MeshStandardMaterial({ color: '#4b5563', metalness: 0.7, roughness: 0.4 }));
    leveler.position.set(L.dockX - 0.6, 0.03, y); leveler.receiveShadow = true; scene.add(leveler);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.55, 3.3), new THREE.MeshStandardMaterial({ color: '#94a3b8', metalness: 0.6, roughness: 0.35 }));
    door.position.set(L.dockX - 0.2, 3.3, y); scene.add(door);
    for (const z of [y - 1.35, y + 1.35]) {
      const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.4, 0.25), new THREE.MeshStandardMaterial({ color: '#111827' }));
      bumper.position.set(L.dockX + 0.08, 0.9, z); scene.add(bumper);
    }
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(4) }));
    light.position.set(L.dockX + 0.05, 3.9, y + 1.9); scene.add(light);
    const s = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.8), new THREE.MeshBasicMaterial({ map: textTex(`${code} · ${inbound ? 'RECEPCIÓN' : 'DESPACHO'}`, { w: 768, h: 192, size: 78, color: '#0b1220', bg: col }) }));
    s.position.set(L.dockX - 0.05, 4.4, y); s.rotation.y = -Math.PI / 2; scene.add(s);
    const t = truck(k % 3 === 0 ? '#b91c1c' : k % 3 === 1 ? '#1d4ed8' : '#15803d', code, { lights: true });
    t.position.set(L.dockX + 0.25, 0, y); scene.add(t);
  });
  // Camiones esperando turno en el playón y uno que circula por la ruta
  [['#b45309', 0], ['#334155', 1], ['#7c3aed', 2]].forEach(([c, i]) => {
    const t = truck(c, null, { lights: false }); t.position.set(L.dockX + 18, 0, yardZ0 + 6.3 + i * 4.6); scene.add(t);
  });
  env.movingTruck = truck('#0f766e', null, { lights: true });
  mergeStatic(env.movingTruck); env.movingTruck.userData.dynamic = true;
  env.movingTruck.rotation.y = -Math.PI / 2; // circula hacia +z
  scene.add(env.movingTruck);
  env.roadX = roadX;

  // Marcas de piso interiores
  const lineMat = new THREE.MeshBasicMaterial({ color: '#eab308' });
  const lines = [];
  for (let i = 0; i < L.aisles; i++) for (const s of [-1, 1]) lines.push([L.x0, aisleY(i) + s * (L.aisleW / 2 - 0.12), L.rackEndX, aisleY(i) + s * (L.aisleW / 2 - 0.12)]);
  for (const x of [L.rackEndX + 1.2, L.stageX0 - 1]) lines.push([x, L.margin, x, L.H - L.margin]);
  const sx0 = L.stageX0, sx1 = L.dockX - 1.6, sz0 = L.margin, sz1 = L.H - L.margin;
  for (let z = sz0; z < sz1; z += 1.2) { lines.push([sx0, z, sx0, Math.min(z + 0.6, sz1)]); lines.push([sx1, z, sx1, Math.min(z + 0.6, sz1)]); }
  for (let x = sx0; x < sx1; x += 1.2) { lines.push([x, sz0, Math.min(x + 0.6, sx1), sz0]); lines.push([x, sz1, Math.min(x + 0.6, sx1), sz1]); }
  const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), lineMat, lines.length);
  lines.forEach(([x1, z1, x2, z2], k) => {
    const horiz = Math.abs(z2 - z1) < 1e-6;
    im.setMatrixAt(k, m4.compose(p3.set((x1 + x2) / 2, 0.006, (z1 + z2) / 2), q4.identity(), s3.set(horiz ? x2 - x1 : 0.1, 1, horiz ? 0.1 : z2 - z1)));
  });
  scene.add(im);
  const floorLabel = (text, x, z, w, h, rot = 0, opacity = 0.4) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: textTex(text, { w: 1024, size: 90, color: '#ffffff' }), transparent: true, opacity, depthWrite: false }));
    m.rotation.set(-Math.PI / 2, 0, rot); m.position.set(x, 0.01, z); scene.add(m);
  };
  floorLabel('ZONA DE STAGING', L.stageX0 + 1.6, L.H / 2, 22, 2.75, Math.PI / 2, 0.35);
  floorLabel('PASILLO PRINCIPAL', L.mainX, L.H / 2, 22, 2.75, Math.PI / 2, 0.28);
  for (let i = 0; i < L.aisles; i++) {
    floorLabel(AISLE_LETTERS[i], L.backX, aisleY(i), 10, 2.5, 0, 0.9);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.1), new THREE.MeshBasicMaterial({ map: textTex('PASILLO ' + AISLE_LETTERS[i], { w: 512, h: 256, size: 92, color: '#0b1220', bg: '#facc15' }), side: THREE.DoubleSide }));
    sign.position.set(L.rackEndX + 0.8, RACK_H + 1.1, aisleY(i)); sign.rotation.y = Math.PI / 2; scene.add(sign);
  }

  // ---------- Iluminación de la nave: campanas, conos de luz y manchas en el piso ----------
  const lamps = [];
  for (let i = 0; i < L.aisles; i++) for (let x = L.x0 + 2.7; x < L.rackEndX; x += 5.4) lamps.push([x, aisleY(i)]);
  for (let z = L.margin + 3; z < L.H; z += 6.5) lamps.push([L.mainX, z], [L.stageX0 + 2.5, z]);
  const lampY = WALL_H - 0.9;
  const housing = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.28, 0.42, 0.32, 16), new THREE.MeshStandardMaterial({ color: '#374151', metalness: 0.7, roughness: 0.35 }), lamps.length);
  const bulb = new THREE.InstancedMesh(new THREE.CircleGeometry(0.38, 20).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(7, 6.4, 5.2) }), lamps.length);
  const cones = new THREE.InstancedMesh(new THREE.ConeGeometry(2.6, lampY, 24, 1, true).translate(0, -lampY / 2, 0),
    new THREE.MeshBasicMaterial({ color: '#ffe9c4', alphaMap: verticalFadeTex(), transparent: true, opacity: 0.075, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }), lamps.length);
  const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(6, 6).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: '#ffdca8', alphaMap: radialTex(), transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending }), lamps.length);
  lamps.forEach(([x, z], k) => {
    housing.setMatrixAt(k, m4.makeTranslation(x, lampY + 0.16, z));
    bulb.setMatrixAt(k, m4.makeTranslation(x, lampY - 0.005, z));
    cones.setMatrixAt(k, m4.makeTranslation(x, lampY, z));
    pools.setMatrixAt(k, m4.makeTranslation(x, 0.012, z));
  });
  scene.add(housing, bulb, cones, pools);
  env.lampCones = cones; env.lampPools = pools; env.lampBulbs = bulb;
  truss.userData.dynamic = true;
  // todo lo fijo (camiones estacionados, muelles, carteles, playón) se une por material: menos llamadas de dibujo
  env.mergedGroups = mergeStatic(scene);
  return env;
}

function signTex(brand) {
  return canvasTex(2048, 205, (c, w, h) => {
    c.fillStyle = '#0b1220'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#22c55e'; c.fillRect(0, h - 14, w, 14);
    c.font = '800 112px Inter, system-ui, sans-serif'; c.textBaseline = 'middle';
    const a = 'NOVANTIQ', b = '  ·  ' + brand.toUpperCase();
    const wa = c.measureText(a).width; c.font = '600 92px Inter, system-ui, sans-serif'; const wb = c.measureText(b).width;
    let x = (w - wa - wb) / 2;
    c.font = '800 112px Inter, system-ui, sans-serif'; c.fillStyle = '#f8fafc'; c.fillText(a, x, h / 2); x += wa;
    c.font = '600 92px Inter, system-ui, sans-serif'; c.fillStyle = '#86efac'; c.fillText(b, x, h / 2 + 4);
  });
}
export function setBrand(env, brand) { env.signMat.map = signTex(brand); env.signMat.needsUpdate = true; }

/** Paredes en corte: se ocultan las que quedan entre la cámara (afuera) y lo que se mira (adentro). */
export function updateCutaway(env, camera, target) {
  const inside = (v) => v.x > 0 && v.x < L.dockX && v.z > 0 && v.z < L.H;
  const camInside = inside(camera.position) && camera.position.y < WALL_H;
  const tgtInside = inside(target);
  for (const o of env.indoorOnly) o.visible = camInside;
  for (const w of env.walls) {
    const outside = s3.copy(camera.position).sub(w.p).dot(w.n) > 0;
    w.group.visible = camInside || !(outside && tgtInside);
  }
}

export function updateEnvironment(env, now) {
  const t = (now / 1000) % 60;
  const z = -300 + (t / 60) * 650; // un camión cruza por la ruta cada minuto
  env.movingTruck.position.set(env.roadX + 2.1, 0, z);
}

// ---------- Post-procesado ----------
const VignetteShader = {
  uniforms: { tDiffuse: { value: null }, strength: { value: 0.32 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float strength; varying vec2 vUv;
    void main(){ vec4 c = texture2D(tDiffuse, vUv); vec2 d = vUv - 0.5; float v = 1.0 - dot(d, d) * strength * 2.6;
    c.rgb *= clamp(v, 0.0, 1.0); c.rgb = mix(c.rgb, c.rgb * vec3(1.03, 1.0, 0.95), 0.6); gl_FragColor = c; }`,
};

export function createPipeline(renderer, scene, camera, env, quality) {
  const Q = QUALITY[quality] || QUALITY.media;
  renderer.setPixelRatio(Math.min(Q.pixelRatio, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = Q.shadows > 0;
  if (Q.shadows) { env.sun.shadow.mapSize.set(Q.shadows, Q.shadows); env.sun.shadow.map?.dispose(); env.sun.shadow.map = null; }
  env.sun.castShadow = Q.shadows > 0;
  env.lampCones.visible = Q.cones;
  if (!Q.bloom && !Q.ao) return { quality, render: () => renderer.render(scene, camera), setSize() {}, dispose() {} };
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  let ao = null;
  if (Q.ao) { ao = new GTAOPass(scene, camera, size.x, size.y); ao.blendIntensity = 0.85; ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.4, thickness: 1.2, scale: 1.1 }); composer.addPass(ao); }
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.6, 0.5, 1.6); // umbral alto: solo brillan las luces
  composer.addPass(bloom);
  composer.addPass(new ShaderPass(VignetteShader));
  composer.addPass(new OutputPass());
  return {
    quality,
    render: () => composer.render(),
    setSize(w, h) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); },
    dispose() { composer.dispose(); rt.dispose(); },
  };
}
