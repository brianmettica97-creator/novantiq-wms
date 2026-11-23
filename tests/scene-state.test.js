// Tests de la lógica de animación de la vista 3D (sin WebGL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMockData } from '../packages/engine/mockdata.js';
import { createSim, stepSim, HANDLE_BASE, HANDLE_LEVEL } from '../packages/engine/simulation.js';
import {
  forkHeight, reachAmount, palletVisuals, handleState, slotBaseY, TRAVEL_FORK_H, TRANSFER_AT, lerpAngle, facingHeading,
} from '../apps/demo/scene-state.js';

const sim = () => createSim(generateMockData({ seed: 2026, pallets: 300 }), { clarks: 5, seed: 2027 });

test('las horquillas arrancan y terminan a altura de circulación y llegan al nivel en el medio', () => {
  for (const level of [0, 1, 2, 3]) {
    assert.ok(Math.abs(forkHeight(level, 0) - TRAVEL_FORK_H) < 1e-9);
    assert.ok(Math.abs(forkHeight(level, 1) - TRAVEL_FORK_H) < 1e-9);
    assert.ok(Math.abs(forkHeight(level, TRANSFER_AT) - (slotBaseY(level) + 0.1)) < 1e-9);
  }
  assert.equal(reachAmount(0), 0); assert.equal(reachAmount(1), 0);
  assert.equal(reachAmount(TRANSFER_AT), 1, 'el mástil está extendido al momento del traspaso');
});

test('la vista muestra cada pallet en un solo lugar (rack u horquillas) durante todo el turno', () => {
  const st = sim();
  let handled = 0;
  for (let k = 0; k < 4000; k++) {
    stepSim(st, 2);
    const { slots, carried } = palletVisuals(st);
    const ids = [...slots.values(), ...carried.values()].map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'pallet dibujado dos veces');
    for (const c of st.clarks) {
      const h = handleState(st, c);
      if (!h) continue;
      handled++;
      assert.ok(h.p >= 0 && h.p <= 1);
      const total = HANDLE_BASE + h.level * HANDLE_LEVEL;
      assert.ok(Math.abs(h.p - (1 - c.wait / total)) < 1e-9);
    }
  }
  assert.ok(handled > 0);
});

test('al tomar un pallet, pasa del rack a las horquillas en TRANSFER_AT', () => {
  const st = sim();
  for (let k = 0; k < 20000; k++) {
    stepSim(st, 0.5);
    const c = st.clarks.find((x) => x.phase === 'handle1' && x.task.from.kind === 'loc');
    if (!c) continue;
    const h = handleState(st, c);
    const { slots, carried } = palletVisuals(st);
    if (h.p < TRANSFER_AT) {
      assert.equal(slots.get(c.task.from.id)?.id, c.task.palletId);
      assert.equal(carried.has(c.id), false);
    } else {
      assert.equal(slots.has(c.task.from.id), false);
      assert.equal(carried.get(c.id).id, c.task.palletId);
      return;
    }
  }
  assert.fail('no se encontró una maniobra de toma en rack');
});

test('el clark mira hacia el rack correcto y gira por el camino corto', () => {
  const st = sim();
  const side0 = st.locations.find((l) => l.side === 0), side1 = st.locations.find((l) => l.side === 1);
  assert.equal(facingHeading(st, { kind: 'loc', id: side0.id }), -Math.PI / 2);
  assert.equal(facingHeading(st, { kind: 'loc', id: side1.id }), Math.PI / 2);
  assert.equal(facingHeading(st, { kind: 'dock', id: 0 }), 0);
  assert.ok(Math.abs(lerpAngle(3.0, -3.0, 0.5) - Math.PI) < 0.01, 'de 3,0 a -3,0 rad cruza por π, no por 0');
});
