// Peso de pallets y capacidad de carga de los racks.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateMockData } from '../packages/engine/mockdata.js';
import { createSim, stepSim, setSmart } from '../packages/engine/simulation.js';
import { choosePutawayLocation, computeThresholds, computeSuggestions } from '../packages/engine/slotting.js';
import { CAP, canPlace, rackLoad, weightOf, palletKg, capacityReport } from '../packages/engine/capacity.js';

const sim = (pallets = 1500, seed = 2026) => createSim(generateMockData({ seed, pallets }), { clarks: 6, seed: seed + 1 });

function assertNoOverload(st, msg = '') {
  for (const loc of st.locations) {
    const p = loc.palletId != null ? st.palletMap.get(loc.palletId) : null;
    if (p) assert.ok(weightOf(st, p) <= (loc.level === 0 ? CAP.floorKg : CAP.posKg), `${msg} pallet de ${weightOf(st, p)} kg en ${loc.code}`);
    if (loc.level === 0) continue;
    const r = rackLoad(st, loc);
    assert.ok(r.beam <= CAP.beamKg + 1e-6, `${msg} viga de ${loc.code} con ${r.beam.toFixed(0)} kg`);
    assert.ok(r.module <= CAP.bayKg + 1e-6, `${msg} módulo de ${loc.code} con ${r.module.toFixed(0)} kg`);
  }
}

describe('peso de los pallets', () => {
  test('tara + cajas × kg por caja', () => {
    assert.equal(palletKg({ kgCase: 14 }, 70), 25 + 70 * 14);
    const d = generateMockData({ seed: 1, pallets: 10 });
    assert.ok(d.skus.every((s) => s.kgCase > 0), 'todos los productos tienen peso por caja');
  });

  test('un pallet incompleto pesa menos', () => {
    const st = sim(300);
    const p = [...st.palletMap.values()][0];
    const full = weightOf(st, p);
    p.qty = Math.floor(p.qty / 2);
    assert.ok(weightOf(st, p) < full);
  });
});

describe('capacidad del rack', () => {
  test('límites de posición, viga y módulo', () => {
    const st = sim(0);
    const at = (code) => st.locations.find((l) => l.code === code);
    assert.equal(canPlace(st, at('A-01-01-1'), CAP.posKg + 1), false, 'más que la posición');
    assert.equal(canPlace(st, at('A-01-01-0'), 1400), true, 'en el piso entra hasta el límite del pallet');
    // ocupar una posición de la viga con 1.100 kg: la de al lado solo admite hasta 900
    const sku = { kgCase: 10 }; st.skuMap.set(999, sku);
    const p = { id: 1, skuId: 999, qty: 107.5, locId: null };
    st.palletMap.set(1, p); at('A-01-01-1').palletId = 1;
    assert.equal(canPlace(st, at('A-01-02-1'), 950), false, 'el par de vigas supera 2.000 kg');
    assert.equal(canPlace(st, at('A-01-02-1'), 850), true);
    assert.equal(canPlace(st, at('A-01-03-1'), 1100), true, 'otra bahía, otra viga');
  });

  test('la carga inicial respeta todos los límites', () => {
    assertNoOverload(sim(1500), 'inicial:');
  });

  test('ningún rack se excede durante un turno completo (con y sin slotting)', () => {
    for (const smart of [false, true]) {
      const st = sim(1500, 42);
      setSmart(st, smart);
      for (let k = 0; k < 8 * 60; k++) { stepSim(st, 60); if (k % 20 === 0) assertNoOverload(st, `${smart ? 'smart' : 'normal'} min ${k}:`); }
      assertNoOverload(st, 'final:');
      assert.equal(capacityReport(st).beamsOver, 0);
      assert.equal(capacityReport(st).modulesOver, 0);
    }
  });

  test('putaway inteligente: un pallet pesado va a los niveles bajos', () => {
    const st = sim(1500);
    computeThresholds(st);
    const heavy = st.skus.find((s) => palletKg(s, s.casesPerPallet) > CAP.heavyKg);
    const loc = choosePutawayLocation(st, heavy, true, palletKg(heavy, heavy.casesPerPallet));
    assert.ok(loc.level < 2, `quedó en el nivel ${loc.level}`);
  });

  test('las sugerencias de slotting solo proponen destinos con capacidad', () => {
    const st = sim(1500);
    for (const s of computeSuggestions(st)) {
      const p = st.palletMap.get(s.palletId);
      assert.ok(canPlace(st, st.locations[s.toId], weightOf(st, p)), `sugerencia a ${st.locations[s.toId].code} sin capacidad`);
    }
  });
});
