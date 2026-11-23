// Tests del motor compartido (packages/engine): recepción/putaway, picking FEFO, slotting e invariantes.
// No necesitan base de datos: corren sobre la simulación en memoria.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateMockData, classifyABC } from '../packages/engine/mockdata.js';
import { createSim, stepSim, setSmart } from '../packages/engine/simulation.js';
import { computeThresholds, zoneOf, choosePutawayLocation, computeSuggestions, travelIndex } from '../packages/engine/slotting.js';
import { buildLayout, routeDistance, L } from '../packages/engine/layout.js';

const newSim = (seed = 2026, opts = {}) => createSim(generateMockData({ seed, pallets: 300 }), { clarks: 5, seed: seed + 1, ...opts });

function checkInvariants(st) {
  const seen = new Map();
  for (const loc of st.locations) {
    if (loc.palletId == null) continue;
    assert.ok(!seen.has(loc.palletId), `pallet ${loc.palletId} en dos ubicaciones`);
    seen.set(loc.palletId, loc.id);
    const p = st.palletMap.get(loc.palletId);
    assert.ok(p, `ubicación ${loc.code} apunta a un pallet inexistente`);
    assert.equal(p.locId, loc.id, `pallet ${p.lpn} no coincide con su ubicación`);
  }
  for (const p of st.palletMap.values()) if (p.locId != null) assert.equal(st.locations[p.locId].palletId, p.id);
  // dos tareas abiertas nunca apuntan a la misma ubicación de destino
  const dest = st.tasks.filter((t) => t.to.kind === 'loc').map((t) => t.to.id);
  assert.equal(new Set(dest).size, dest.length, 'dos tareas abiertas hacia la misma ubicación');
  // un pallet nunca está en dos tareas a la vez
  const pals = st.tasks.map((t) => t.palletId);
  assert.equal(new Set(pals).size, pals.length, 'un pallet en dos tareas');
}

describe('datos y layout', () => {
  test('el generador es determinista con la misma semilla', () => {
    const a = generateMockData({ seed: 7, pallets: 300 }), b = generateMockData({ seed: 7, pallets: 300 });
    assert.deepEqual(a.pallets, b.pallets);
    assert.equal(a.pallets.length, 300);
    assert.equal(a.locations.length, L.aisles * 2 * L.bays * L.levels);
  });

  test('clasificación ABC por frecuencia de picks: A ≈ 80 %, B hasta 95 %', () => {
    const skus = [100, 60, 20, 10, 5, 3, 1, 1].map((picks90, i) => ({ id: i, picks90 }));
    classifyABC(skus);
    // acumulado: 50 %, 80 % → A · 90 %, 95 % → B · resto → C
    assert.deepEqual(skus.map((s) => s.abc), ['A', 'A', 'B', 'B', 'C', 'C', 'C', 'C']);
  });

  test('el score suma distancia por pasillos y penalización por altura', () => {
    const { locations } = buildLayout();
    for (const l of locations.slice(0, 50)) assert.equal(l.score, Math.round((l.dist + l.level * L.levelPenalty) * 10) / 10);
    const a = locations[0].access, b = locations[locations.length - 1].access;
    assert.ok(routeDistance(a, b) >= Math.hypot(a.x - b.x, a.y - b.y), 'la ruta no puede ser más corta que la línea recta');
  });
});

describe('recepción y putaway', () => {
  test('cada recepción crea el pallet en un muelle de ENTRADA y reserva una ubicación libre', () => {
    const st = newSim();
    stepSim(st, 0.5);
    const puts = st.tasks.filter((t) => t.type === 'PUTAWAY');
    assert.ok(puts.length > 0, 'se esperaban recepciones al iniciar el turno');
    for (const t of puts) {
      assert.equal(st.docks[t.from.id].kind, 'ENTRADA');
      const loc = st.locations[t.to.id];
      assert.equal(loc.reserved, true);
      assert.equal(loc.palletId, null);
      const p = st.palletMap.get(t.palletId);
      assert.equal(p.locId, null, 'el pallet recibido todavía está en el muelle');
      assert.equal(p.status, 'DISPONIBLE');
    }
  });

  test('putaway inteligente: un SKU A va a la ubicación libre más cercana al despacho', () => {
    const st = newSim();
    computeThresholds(st);
    const skuA = st.skus.find((s) => s.abc === 'A');
    const loc = choosePutawayLocation(st, skuA, true);
    const free = st.locations.filter((l) => l.palletId == null && !l.reserved);
    assert.equal(loc.score, Math.min(...free.map((l) => l.score)));
  });

  test('putaway inteligente: un SKU C no ocupa posiciones de zona A ni B si hay lugar lejos', () => {
    const st = newSim();
    computeThresholds(st);
    const skuC = st.skus.find((s) => s.abc === 'C');
    const loc = choosePutawayLocation(st, skuC, true);
    assert.equal(zoneOf(st, loc), 'C');
  });

  test('sin lugar libre no hay putaway', () => {
    const st = newSim();
    for (const l of st.locations) l.reserved = true;
    assert.equal(choosePutawayLocation(st, st.skus[0], true), null);
  });
});

describe('picking FEFO', () => {
  test('cada picking toma el pallet que vence primero entre los disponibles de ese SKU', () => {
    for (const seed of [2026, 11, 99]) {
      const st = newSim(seed);
      stepSim(st, 0.5); // crea las primeras tareas sin completar ninguna
      const picks = st.tasks.filter((t) => t.type === 'PICK');
      assert.ok(picks.length > 0, 'se esperaban pickings');
      const targeted = new Set(st.tasks.map((t) => t.palletId));
      for (const t of picks) {
        const p = st.palletMap.get(t.palletId);
        assert.equal(st.docks[t.to.id].kind, 'SALIDA');
        assert.notEqual(p.status, 'CUARENTENA');
        const candidates = [...st.palletMap.values()].filter((q) =>
          q.skuId === p.skuId && q.locId != null && q.status !== 'CUARENTENA' && !targeted.has(q.id));
        for (const q of candidates) assert.ok(q.exp >= p.exp, `${q.lpn} vence antes (${q.exp}d) que ${p.lpn} (${p.exp}d)`);
      }
    }
  });

  test('un pallet en cuarentena nunca se pickea', () => {
    const st = newSim(5);
    const quarantined = new Set([...st.palletMap.values()].filter((p) => p.status === 'CUARENTENA').map((p) => p.id));
    assert.ok(quarantined.size > 0);
    for (let k = 0; k < 120; k++) {
      stepSim(st, 30);
      for (const t of st.tasks) if (t.type === 'PICK') assert.ok(!quarantined.has(t.palletId));
    }
  });
});

describe('slotting', () => {
  test('las sugerencias acercan pallets A a ubicaciones libres de menor score', () => {
    const st = newSim();
    const sug = computeSuggestions(st);
    assert.ok(sug.length > 0, 'el depósito inicial está desordenado: debería haber sugerencias');
    const dest = new Set();
    for (const s of sug) {
      assert.ok(!dest.has(s.toId), 'dos sugerencias al mismo destino'); dest.add(s.toId);
      const from = st.locations[s.fromId], to = st.locations[s.toId];
      assert.equal(to.palletId, null); assert.equal(to.reserved, false);
      assert.equal(st.palletMap.get(s.palletId).locId, from.id);
      if (s.kind === 'A_CERCA') {
        assert.ok(to.score < from.score);
        assert.ok(s.savings >= 0);
        assert.equal(zoneOf(st, to), 'A');
      }
    }
    for (let i = 1; i < sug.length; i++) assert.ok(sug[i - 1].savings >= sug[i].savings, 'ordenadas por ahorro');
  });

  test('con slotting activo el índice de recorrido baja respecto del inicial', () => {
    const st = newSim();
    const base = travelIndex(st);
    setSmart(st, true);
    stepSim(st, 4 * 3600);
    assert.ok(travelIndex(st) < base * 0.95, `índice ${travelIndex(st).toFixed(1)} vs base ${base.toFixed(1)}`);
  });

  test('desactivar el slotting cancela las reubicaciones pendientes y libera reservas', () => {
    const st = newSim();
    setSmart(st, true);
    stepSim(st, 60);
    setSmart(st, false);
    assert.equal(st.tasks.filter((t) => t.type === 'REPOSICION' && t.state === 'PENDIENTE').length, 0);
    checkInvariants(st);
  });
});

describe('simulación', () => {
  test('invariantes de stock durante un turno completo (con y sin slotting)', () => {
    for (const smart of [false, true]) {
      const st = newSim(42);
      setSmart(st, smart);
      for (let k = 0; k < 8 * 60; k++) { stepSim(st, 60); if (k % 20 === 0) checkInvariants(st); }
      checkInvariants(st);
      assert.ok(st.done > 100, 'los clarks completaron tareas');
      assert.ok(st.palletMap.size > 200 && st.palletMap.size < 420, `stock estable (${st.palletMap.size})`);
    }
  });

  test('misma semilla, mismo resultado', () => {
    const a = newSim(3), b = newSim(3);
    stepSim(a, 1800); stepSim(b, 1800);
    assert.equal(a.done, b.done);
    assert.deepEqual(a.clarks.map((c) => [c.x, c.y]), b.clarks.map((c) => [c.x, c.y]));
  });
});

describe('depósito real (2 posiciones por bahía, ~78 % de ocupación)', () => {
  test('1.920 posiciones: 2 pallets por viga de 2,7 m', () => {
    const { locations } = buildLayout();
    assert.equal(locations.length, 1920);
    assert.equal(L.bayW * L.posPerBay, 2.7);
    assert.equal(new Set(locations.map((l) => l.code)).size, 1920, 'códigos únicos');
  });

  test('con 1.500 pallets la operación mantiene el stock cerca del objetivo y las invariantes', () => {
    const st = createSim(generateMockData({ seed: 2026, pallets: 1500 }), { clarks: 6, seed: 2027 });
    setSmart(st, true);
    for (let k = 0; k < 4 * 60; k++) { stepSim(st, 60); if (k % 30 === 0) checkInvariants(st); }
    checkInvariants(st);
    assert.ok(Math.abs(st.palletMap.size - 1500) < 60, `stock ${st.palletMap.size}`);
    assert.ok(st.done > 200);
  });
});
