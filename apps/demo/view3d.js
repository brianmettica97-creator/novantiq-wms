// Vista 3D del depósito con Three.js. Lee el mismo estado de la simulación que el mapa 2D
// (packages/engine/simulation.js) y comparte el objeto `view` (modo, nivel, zonas, hover, selección, look).
//
// - Modo "realista": cajas de cartón con su tono natural; el indicador (ABC, vencimiento, estado) va en una
//   etiqueta de color al frente de cada pallet y en las zonas del piso.
// - Modo "análisis": toda la carga se tiñe con el color del indicador (lectura rápida desde arriba).
// - Buscador: haz de luz sobre la ubicación, ruta del clark más cercano y vuelo de cámara.
// - Cámara animable (flyTo) para el recorrido guiado y la grabación de video.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { L, rackY, aisleY } from '../../packages/engine/layout.js';
import { locColor, PALETTE, loadColor } from '../../packages/engine/renderer.js';
import { beamUse, weightOf, CAP } from '../../packages/engine/capacity.js';
import { zoneOf } from '../../packages/engine/slotting.js';
import {
  LEVEL_H, RACK_H, TRAVEL_FORK_H, slotBaseY, slotCenter, handleState, forkHeight, reachAmount,
  facingHeading, palletVisuals, loadHeight, lerpAngle,
} from './scene-state.js';
import { PALLET_W, PALLET_D, PALLET_H, canvasTex, woodTex, cartonTex, palletGeometry, loadGeometry, forklift } from './models3d.js';
import { buildEnvironment, updateCutaway, updateEnvironment, createPipeline, defaultQuality, setBrand, WALL_H } from './environment3d.js';

const CX = L.dockX / 2, CZ = L.H / 2;
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3();
const tmpC = new THREE.Color(), tmpV = new THREE.Vector3(), tmpS2 = new THREE.Matrix4();
const LOAD_UP = new THREE.Matrix4().makeTranslation(0, PALLET_H, 0), LOAD_DOWN = new THREE.Matrix4().makeTranslation(0, -PALLET_H, 0);
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
// Tonos de cartón por SKU (modo realista)
const KRAFT = ['#c79f6a', '#b88d58', '#d6b585', '#e6dfd2', '#a87a4a', '#cdab78', '#efe9df', '#bf9660'];
const COLORS = new Map();
/** THREE.Color cacheado por código y factor de brillo. */
function col(hex, k = 1) {
  const key = k === 1 ? hex : hex + '*' + k;
  let c = COLORS.get(key);
  if (!c) { c = new THREE.Color(hex).multiplyScalar(k); COLORS.set(key, c); }
  return c;
}
/** Sube a la placa de video solo el tramo [a, b] de un atributo instanciado. */
function markRange(attr, a, b) {
  if (b < a) return;
  attr.addUpdateRange(a * attr.itemSize, (b - a + 1) * attr.itemSize);
  attr.needsUpdate = true;
}
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function createView3D(container, view, { quality = defaultQuality(), brand } = {}) {
  view.look = view.look || 'real';
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  const canvas = renderer.domElement;
  canvas.className = 'map3d';
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); view.onContextLost?.(); });
  container.prepend(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.3, 2000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2 - 0.02; controls.minDistance = 3; controls.maxDistance = 260;
  controls.screenSpacePanning = false;
  const HOME = { pos: new THREE.Vector3(CX - 22, 52, CZ + 66), target: new THREE.Vector3(CX + 4, 0, CZ) };

  const env = buildEnvironment(scene, renderer, { brand });
  let pipeline = null, qualityName = quality;

  // ---------- Racks: un marco cada 2 posiciones (viga de 2,7 m con 2 pallets) ----------
  const steelBlue = new THREE.MeshStandardMaterial({ color: '#1e4fd1', roughness: 0.4, metalness: 0.6 });
  const beamOrange = new THREE.MeshStandardMaterial({ color: '#ea580c', roughness: 0.45, metalness: 0.5 });
  const BAY = L.bayW * L.posPerBay, nBays = L.bays / L.posPerBay;
  const nRacks = L.aisles * 2, nFrames = nBays + 1;
  const uprights = new THREE.InstancedMesh(new THREE.BoxGeometry(0.09, RACK_H, 0.09), steelBlue, nRacks * nFrames * 2);
  const bracesPerFrame = 5;
  const braceLen = Math.hypot(L.rackD - 0.1, RACK_H / bracesPerFrame);
  const braces = new THREE.InstancedMesh(new THREE.BoxGeometry(0.035, braceLen, 0.035), steelBlue, nRacks * nFrames * bracesPerFrame);
  const beamLevels = L.levels - 1;
  const beams = new THREE.InstancedMesh(new THREE.BoxGeometry(BAY - 0.09, 0.13, 0.05), beamOrange, nRacks * nBays * beamLevels * 2);
  const guards = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.45, L.rackD + 0.2), new THREE.MeshStandardMaterial({ color: '#facc15', roughness: 0.6 }), nRacks * 2);
  let ku = 0, kb = 0, kbr = 0, kg = 0;
  const braceAxis = new THREE.Vector3(1, 0, 0);
  for (let i = 0; i < L.aisles; i++) for (let side = 0; side < 2; side++) {
    const z0 = rackY(i, side) + 0.05, z1 = rackY(i, side) + L.rackD - 0.05;
    for (let c = 0; c < nFrames; c++) {
      const x = L.x0 + c * BAY;
      for (const z of [z0, z1]) uprights.setMatrixAt(ku++, tmpM.makeTranslation(x, RACK_H / 2, z));
      for (let b = 0; b < bracesPerFrame; b++) {
        tmpQ.setFromAxisAngle(braceAxis, (b % 2 ? 1 : -1) * Math.atan2(L.rackD - 0.1, RACK_H / bracesPerFrame));
        braces.setMatrixAt(kbr++, tmpM.compose(tmpP.set(x, (b + 0.5) * (RACK_H / bracesPerFrame), (z0 + z1) / 2), tmpQ, tmpS.set(1, 1, 1)));
      }
      if (c < nBays) for (let lv = 1; lv <= beamLevels; lv++) for (const z of [z0, z1]) beams.setMatrixAt(kb++, tmpM.makeTranslation(x + BAY / 2, lv * LEVEL_H, z));
    }
    for (const x of [L.x0 - 0.25, L.rackEndX + 0.25]) guards.setMatrixAt(kg++, tmpM.makeTranslation(x, 0.225, (z0 + z1) / 2));
  }
  for (const m of [uprights, braces, beams, guards]) { m.castShadow = true; m.receiveShadow = true; scene.add(m); }

  // ---------- Zonas de slotting (tinte de piso bajo los racks) ----------
  const nLocs = L.aisles * 2 * L.bays * L.levels;
  const zoneMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(L.bayW, L.rackD + 0.5).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false }), L.aisles * 2 * L.bays);
  zoneMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(zoneMesh.count * 3), 3);
  scene.add(zoneMesh);

  // ---------- Pallets ----------
  const EXTRA = 16;
  const palletGeoFull = palletGeometry(), palletGeoLite = palletGeometry(true);
  const palletMesh = new THREE.InstancedMesh(palletGeoFull, new THREE.MeshStandardMaterial({ map: woodTex(), roughness: 0.85 }), nLocs + EXTRA);
  const loadMat = new THREE.MeshStandardMaterial({ map: cartonTex(), roughness: 0.6, metalness: 0.0 });
  const loadMesh = new THREE.InstancedMesh(loadGeometry(), loadMat, nLocs + EXTRA);
  loadMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array((nLocs + EXTRA) * 3), 3);
  // etiqueta de color al frente del pallet (indicador en modo realista)
  const tagMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.34, 0.2), new THREE.MeshBasicMaterial({ toneMapped: false }), nLocs);
  tagMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nLocs * 3), 3);
  const ghostMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(PALLET_W, 1.3, PALLET_D).translate(0, 0.65, 0), new THREE.MeshStandardMaterial({ color: PALETTE.reservedSlot, transparent: true, opacity: 0.22, depthWrite: false }), nLocs);
  for (const m of [palletMesh, loadMesh]) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; scene.add(m); }
  tagMesh.frustumCulled = false; ghostMesh.frustumCulled = false; scene.add(tagMesh, ghostMesh);
  const pickMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(L.bayW - 0.1, LEVEL_H - 0.15, L.rackD).translate(0, (LEVEL_H - 0.15) / 2, 0), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }), nLocs);
  scene.add(pickMesh);
  let pickLevel = null;

  // Resaltados
  const boxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
  const mkOutline = (color, opacity = 1) => { const o = new THREE.LineSegments(boxEdges, new THREE.LineBasicMaterial({ color, transparent: true, opacity })); o.visible = false; scene.add(o); return o; };
  const hoverBox = mkOutline('#ffffff', 0.65), selBox = mkOutline('#ffffff', 1);
  function placeOutline(o, loc, pad = 0.08) {
    if (!loc) { o.visible = false; return; }
    const c = slotCenter(loc);
    o.position.set(c.x, slotBaseY(loc.level) - pad / 2, c.z);
    o.scale.set(L.bayW - 0.1 + pad, LEVEL_H - 0.25 + pad, L.rackD - 0.1 + pad);
    o.visible = true;
  }

  // ---------- Búsqueda: haz de luz, caja brillante, anillo en el piso y ruta ----------
  const search = { loc: null, t0: 0 };
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.9, 1, 32, 1, true).translate(0, 0.5, 0),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 1.1, 1.35), transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  const glow = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 0.75, 0.85), transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending }));
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.25, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 3, 3.4), transparent: true, depthWrite: false }));
  const routeMat = new LineMaterial({ color: 0x5eead4, linewidth: 6, worldUnits: false, transparent: true, opacity: 0.95, dashed: false });
  const route = new Line2(new LineGeometry(), routeMat);
  for (const o of [beam, glow, ring, route]) { o.visible = false; scene.add(o); }

  // ---------- Clarks ----------
  let clarkObjs = [];
  let builtFor = null;
  function buildClarks(st) {
    for (const o of clarkObjs) scene.remove(o.f.group, o.line, o.target, o.label);
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
      label.renderOrder = 10; scene.add(label);
      return { c, f, line, target, label, heading: c.heading };
    });
    builtFor = st;
  }

  // ---------- Cámara animada ----------
  let flight = null;
  function flyTo(pos, target, dur = 2, { lift = 0, now = null } = {}) {
    flight = { from: camera.position.clone(), fromT: controls.target.clone(), to: pos.clone(), toT: target.clone(), dur: dur * 1000, lift, start: now };
    controls.enabled = false;
  }
  function stepFlight(now) {
    if (!flight) return;
    if (flight.start == null) flight.start = now;
    const t = Math.min(1, (now - flight.start) / flight.dur), e = ease(t);
    camera.position.lerpVectors(flight.from, flight.to, e);
    camera.position.y += Math.sin(Math.PI * e) * flight.lift;
    controls.target.lerpVectors(flight.fromT, flight.toT, e);
    if (t >= 1) { flight = null; controls.enabled = true; }
  }

  // ---------- Actualización por cuadro ----------
  let lastZones = 0, lastW = 0, lastH = 0, viewSig = '';
  const slotSig = new Float64Array(nLocs).fill(NaN);
  const kraftOf = (sku) => (sku.cat === 'Perfumería' || sku.cat === 'Lácteos UAT' ? KRAFT[(sku.id % 2) ? 3 : 6] : KRAFT[sku.id % KRAFT.length]);
  function indicatorColor(st, p, loc = null) {
    if (view.mode === 'ocupacion') return PALETTE.occupied;
    if (view.mode === 'carga') return loc ? loadColor(beamUse(st, loc)) : loadColor(weightOf(st, p) / CAP.posKg); // en horquillas: peso del pallet
    return locColor(st, { palletId: p.id, reserved: false }, view.mode);
  }
  function setPallet(i, x, y, z, rotY, pallet, sku, st, loc = null) {
    tmpQ.setFromAxisAngle(UP, rotY);
    palletMesh.setMatrixAt(i, tmpM.compose(tmpP.set(x, y, z), tmpQ, tmpS.set(1, 1, 1)));
    tmpM.multiply(LOAD_UP).multiply(tmpS2.makeScale(1, loadHeight(pallet, sku), 1)).multiply(LOAD_DOWN);
    loadMesh.setMatrixAt(i, tmpM);
    loadMesh.setColorAt(i, col(view.look === 'real' ? kraftOf(sku) : indicatorColor(st, pallet, loc)));
  }

  function update(st, now) {
    if (builtFor !== st) buildClarks(st);
    stepFlight(now);
    const lf = view.level === 'all' ? null : Number(view.level);
    const vis = palletVisuals(st);
    const real = view.look === 'real';

    if (now - lastZones > 800 || now < lastZones || zoneMesh.userData.show !== view.showZones) {
      lastZones = now; zoneMesh.userData.show = view.showZones;
      let k = 0;
      for (const loc of st.locations) {
        if (loc.level !== 0) continue;
        const z = st.thrA != null ? zoneOf(st, loc) : 'C';
        const c = slotCenter(loc);
        zoneMesh.setMatrixAt(k, view.showZones && z !== 'C' ? tmpM.makeTranslation(c.x, 0.004, c.z) : HIDDEN);
        zoneMesh.setColorAt(k, z === 'A' ? col('#22c55e') : col('#f59e0b', 0.55));
        k++;
      }
      zoneMesh.instanceMatrix.needsUpdate = true; zoneMesh.instanceColor.needsUpdate = true;
    }

    const vsig = `${view.look}|${view.mode}|${view.level}`;
    const full = vsig !== viewSig; viewSig = vsig;
    let lo = Infinity, hi = -1;
    for (const loc of st.locations) {
      const i = loc.id;
      const shown = lf == null || loc.level === lf;
      const p = shown ? vis.slots.get(loc.id) : null;
      // firma de lo que se ve en la ubicación: si no cambió, no se toca
      let sig = p ? p.id * 8192 + p.qty * 4 + (p.status === 'CUARENTENA' ? 2 : 0) + p.exp * 1e-4 : shown ? (loc.reserved ? -2 : -3) : -4;
      if (p && view.mode === 'carga') sig += Math.round(beamUse(st, loc) * 40) * 1e-7; // en modo carga influye el resto de la viga
      if (!full && slotSig[i] === sig) continue;
      slotSig[i] = sig; if (i < lo) lo = i; if (i > hi) hi = i;
      const c = slotCenter(loc);
      const y = slotBaseY(loc.level);
      if (p) {
        const sku = st.skuMap.get(p.skuId);
        setPallet(i, c.x, y, c.z, 0, p, sku, st, loc);
        ghostMesh.setMatrixAt(i, HIDDEN);
        if (real) {
          const face = loc.side === 0 ? 1 : -1; // el frente del pallet mira al pasillo
          tmpQ.setFromAxisAngle(UP, loc.side === 0 ? 0 : Math.PI);
          tagMesh.setMatrixAt(i, tmpM.compose(tmpP.set(c.x - 0.3, y + PALLET_H + 0.42, c.z + face * (PALLET_D / 2 - 0.015)), tmpQ, tmpS.set(1, 1, 1)));
          tagMesh.setColorAt(i, col(indicatorColor(st, p, loc), 1.15));
        } else tagMesh.setMatrixAt(i, HIDDEN);
      } else {
        palletMesh.setMatrixAt(i, HIDDEN); loadMesh.setMatrixAt(i, HIDDEN); tagMesh.setMatrixAt(i, HIDDEN);
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
      const on = c.blocked ? 1 : c.task ? (Math.sin(now / 120 + k) > 0 ? 1 : 0.08) : 0.15;
      f.beaconMat.color.set(c.blocked ? '#ff2a2a' : '#ffa21a').multiplyScalar(on * 4);
      o.label.position.set(c.x, 3.1, c.y);
      o.label.scale.setScalar(view.selectedClark === c ? 0.95 : 0.65);
      o.label.visible = view.labels !== false;

      const p = vis.carried.get(c.id);
      const idx = nLocs + k;
      if (p) {
        f.group.updateMatrixWorld(true);
        const wp = tmpV.set(0.78, 0.03, 0).applyMatrix4(f.carriage.matrixWorld);
        setPallet(idx, wp.x, wp.y, wp.z, -o.heading + Math.PI / 2, p, st.skuMap.get(p.skuId), st);
      } else { palletMesh.setMatrixAt(idx, HIDDEN); loadMesh.setMatrixAt(idx, HIDDEN); }

      const pos = o.line.geometry.attributes.position;
      const pts = [{ x: c.x, y: c.y }, ...c.path].slice(0, 12);
      pts.forEach((pt, j) => pos.setXYZ(j, pt.x, 0.05, pt.y));
      pos.needsUpdate = true;
      o.line.geometry.setDrawRange(0, pts.length > 1 && view.paths !== false ? pts.length : 0);
      o.line.computeLineDistances();
      o.line.material.opacity = view.selectedClark === c ? 0.95 : 0.55;

      const ref = c.task ? (c.phase === 'toFrom' || c.phase === 'handle1' ? c.task.from : c.task.to) : null;
      if (ref && ref.kind === 'loc' && view.paths !== false) { placeOutline(o.target, st.locations[ref.id], 0.25 + pulse * 0.25); o.target.material.opacity = 0.45 + 0.55 * pulse; }
      else o.target.visible = false;
    });
    for (let k = clarkObjs.length; k < EXTRA; k++) { palletMesh.setMatrixAt(nLocs + k, HIDDEN); loadMesh.setMatrixAt(nLocs + k, HIDDEN); }
    // ubicaciones que cambiaron + los pallets que van en las horquillas (siempre se mueven)
    for (const m of [palletMesh, loadMesh, ghostMesh, tagMesh]) markRange(m.instanceMatrix, lo, hi);
    markRange(loadMesh.instanceColor, lo, hi); markRange(tagMesh.instanceColor, lo, hi);
    for (const m of [palletMesh, loadMesh]) markRange(m.instanceMatrix, nLocs, nLocs + EXTRA - 1);
    markRange(loadMesh.instanceColor, nLocs, nLocs + EXTRA - 1);

    placeOutline(hoverBox, view.hover && view.hover !== view.selected ? view.hover : null);
    placeOutline(selBox, view.selected && view.selected !== search.loc ? view.selected : null, 0.14);

    // búsqueda
    if (search.loc) {
      const loc = search.loc, c = slotCenter(loc), y0 = slotBaseY(loc.level);
      const k = Math.min(1, (now - (search.t0 ?? now)) / 700);
      const pl = 0.75 + 0.25 * Math.sin(now / 160);
      beam.position.set(c.x, y0 + LEVEL_H - 0.2, c.z);
      beam.scale.set(1, (WALL_H - 0.6 - (y0 + LEVEL_H - 0.2)) * k + 0.01, 1);
      beam.material.opacity = 0.32 * pl;
      glow.position.set(c.x, y0 - 0.05, c.z); glow.scale.set(L.bayW + 0.15, LEVEL_H - 0.1, L.rackD + 0.15);
      glow.material.opacity = 0.25 + 0.2 * pl;
      ring.position.set(loc.access.x, 0.03, loc.access.y); ring.scale.setScalar(1 + 0.25 * Math.sin(now / 200));
      ring.material.opacity = 0.6 + 0.3 * pl;
      for (const o of [beam, glow, ring]) o.visible = true;
    } else for (const o of [beam, glow, ring, route]) o.visible = false;
    routeMat.resolution.set(lastW, lastH);

    updateEnvironment(env, now);
    updateCutaway(env, camera, controls.target);
  }

  function setQuality(q) {
    if (pipeline) pipeline.dispose();
    qualityName = q;
    pipeline = createPipeline(renderer, scene, camera, env, q);
    palletMesh.geometry = q === 'baja' ? palletGeoLite : palletGeoFull;
    renderer.setSize(lastW || 1, lastH || 1, false);
    pipeline.setSize(lastW || 1, lastH || 1);
    scene.traverse((o) => { if (o.material && o.material.needsUpdate !== undefined && o.isMesh) o.material.needsUpdate = true; });
  }
  setQuality(quality);

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const api = {
    canvas, camera, controls,
    get quality() { return qualityName; },
    get stats() { return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }; },
    setQuality,
    resize(w, h) {
      if (w === lastW && h === lastH) return;
      lastW = w; lastH = h;
      renderer.setSize(w, h, false);
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      camera.aspect = w / Math.max(1, h);
      // en pantallas verticales se abre el campo visual para que entre el depósito
      camera.fov = camera.aspect < 0.8 ? 58 : 42;
      camera.updateProjectionMatrix();
      pipeline.setSize(w, h);
    },
    render(st, now) {
      update(st, now);
      if (!flight) controls.update();
      pipeline.render();
    },
    hitTest(st, sx, sy) {
      ndc.set((sx / lastW) * 2 - 1, -(sy / lastH) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects([pickMesh, ...clarkObjs.map((o) => o.f.group)], true)[0];
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
    home(dur = 1.6) { flyTo(HOME.pos, HOME.target, dur); },
    setCamera(pos, target) { flight = null; controls.enabled = true; camera.position.copy(pos); controls.target.copy(target); controls.update(); },
    flyTo(pos, target, dur, opts) { flyTo(new THREE.Vector3(...pos), new THREE.Vector3(...target), dur, opts); },
    get flying() { return !!flight; },
    aisleView(i = 0) { flyTo(new THREE.Vector3(L.rackEndX + 7, 1.7, aisleY(i)), new THREE.Vector3(L.x0 + 10, 2.2, aisleY(i)), 1.8, { lift: 3 }); },
    focus(x, z, dist = 7) { flyTo(new THREE.Vector3(x + dist, dist * 0.45, z + 0.4), new THREE.Vector3(x, 1.2, z), 1.4); },
    /** Muestra el resultado de una búsqueda. route: puntos {x,y} del clark hasta la ubicación. */
    setSearch(loc, routePts, now = null) {
      search.loc = loc; search.t0 = now;
      if (!loc || !routePts || routePts.length < 2) { route.visible = false; return; }
      const flat = []; for (const p of routePts) flat.push(p.x, 0.08, p.y);
      route.geometry.dispose(); route.geometry = new LineGeometry(); route.geometry.setPositions(flat);
      route.computeLineDistances(); route.visible = true;
    },
    /** Vuela hasta una ubicación encuadrándola desde el pasillo. */
    flyToLoc(loc, dur = 2.2) {
      const c = slotCenter(loc), face = loc.side === 0 ? 1 : -1;
      const ay = aisleY(loc.aisle);
      flyTo(new THREE.Vector3(c.x + 10, Math.max(3.2, slotBaseY(loc.level) + 1.6), ay + face * 1.4), new THREE.Vector3(c.x, slotBaseY(loc.level) + 0.7, c.z), dur, { lift: 6 });
    },
    setBrand: (b) => setBrand(env, b),
    dispose() { pipeline.dispose(); renderer.dispose(); canvas.remove(); },
  };
  api.setCamera(HOME.pos, HOME.target);
  return api;
}
