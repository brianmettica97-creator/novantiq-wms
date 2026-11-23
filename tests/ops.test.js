// Tests de la capa de gestión: historia de pallets, inventario cíclico, recepción contra remito,
// facturación por cliente, tablet del clark y resumen del turno.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateMockData } from '../packages/engine/mockdata.js';
import { createSim, stepSim } from '../packages/engine/simulation.js';
import {
  createOps, stepOps, stockAccuracy, clientReport, occupancyProjection, palletHistory, simulateScan,
  submitChecklist, unblock, reportProblem, shiftSummary, checkPin, countLocation, TARIFAS, DIFF_RATE, PIN_DEMO,
} from '../packages/engine/ops.js';

function setup(seed = 2026) {
  const st = createSim(generateMockData({ seed, pallets: 300 }), { clarks: 5, seed: seed + 1 });
  const ops = createOps(st, { seed });
  const run = (seconds, step = 60) => { for (let s = 0; s < seconds; s += step) { stepSim(st, step); stepOps(ops, st); } };
  return { st, ops, run };
}

describe('capa de gestión', () => {
  test('sin diferencias de stock ni de recepción, no altera el movimiento de los clarks', () => {
    const a = createSim(generateMockData({ seed: 9, pallets: 300 }), { clarks: 5, seed: 10 });
    const b = createSim(generateMockData({ seed: 9, pallets: 300 }), { clarks: 5, seed: 10 });
    const ops = createOps(b, { seed: 9, diferencias: false });
    for (let k = 0; k < 60; k++) { stepSim(a, 60); stepSim(b, 60); stepOps(ops, b); }
    assert.deepEqual(a.clarks.map((c) => [c.x, c.y, c.tasksDone]), b.clarks.map((c) => [c.x, c.y, c.tasksDone]));
  });

  test('cada pallet movido en el turno tiene su historia con quién lo hizo', () => {
    const { st, ops, run } = setup();
    run(2 * 3600);
    assert.ok(ops.received > 0 && ops.dispatched > 0);
    const moved = [...ops.ledger.entries()].filter(([, h]) => h.some((m) => m.t != null && m.tipo === 'PICK'));
    assert.ok(moved.length > 0);
    for (const [id] of moved.slice(0, 10)) {
      const h = palletHistory(ops, id);
      assert.equal(h[0].tipo, 'PICK', 'lo último que le pasó fue el despacho');
      assert.match(h[0].quien, /CLK-\d\d/);
    }
  });
});

describe('inventario cíclico', () => {
  test('encuentra las diferencias ocultas, ajusta el stock y mide la exactitud', () => {
    const { st, ops, run } = setup();
    const hidden = ops.physical.size;
    assert.equal(hidden, Math.round(300 * DIFF_RATE));
    run(8 * 3600);
    assert.ok(ops.counted >= 8 * 30 - 1, `contó ${ops.counted} ubicaciones en 8 h`);
    assert.ok(ops.countedWithDiff > 0, 'tiene que haber encontrado alguna diferencia');
    const acc = stockAccuracy(ops);
    assert.ok(acc > 0.9 && acc < 1, `exactitud ${acc}`);
    for (const loc of st.locations) if (loc.palletId != null) assert.ok(st.palletMap.has(loc.palletId), 'ajustes consistentes');
  });

  test('un pallet faltante se da de baja y queda en su historia', () => {
    const { st, ops } = setup();
    const [pid] = [...ops.physical.entries()].find(([, d]) => d.tipo === 'FALTANTE');
    const loc = st.locations[st.palletMap.get(pid).locId];
    const r = countLocation(ops, st, loc);
    assert.equal(r.ok, false);
    assert.equal(loc.palletId, null);
    assert.equal(st.palletMap.has(pid), false);
    assert.equal(palletHistory(ops, pid)[0].tipo, 'AJUSTE');
  });

  test('las cajas se ajustan a lo contado', () => {
    const { st, ops } = setup();
    const [pid, d] = [...ops.physical.entries()].find(([, x]) => x.tipo === 'CAJAS');
    countLocation(ops, st, st.locations[st.palletMap.get(pid).locId]);
    assert.equal(st.palletMap.get(pid).qty, d.cajasReales);
  });

  test('cuenta primero las ubicaciones con productos A', () => {
    const { st, ops, run } = setup();
    run(3600);
    const firstCodes = new Set(ops.countLog.slice(-10).map((e) => e.code));
    const classes = st.locations.filter((l) => firstCodes.has(l.code) && l.palletId != null)
      .map((l) => st.skuMap.get(st.palletMap.get(l.palletId).skuId).abc);
    assert.ok(classes.every((c) => c === 'A'), `primeras clases contadas: ${classes}`);
  });
});

describe('recepción contra remito', () => {
  test('agrupa por camión, cierra al completar y registra diferencias', () => {
    const { ops, run } = setup();
    run(8 * 3600);
    const closed = ops.trucks.filter((t) => t.cierre != null);
    assert.ok(closed.length > 0);
    for (const t of closed) {
      assert.equal(t.recibidos, t.esperado);
      assert.equal(t.estado, t.diferencias.length ? 'CON DIFERENCIAS' : 'OK');
    }
    assert.ok(ops.receivingIssues.length > 0, 'en un turno aparece alguna diferencia');
  });
});

describe('clientes y facturación', () => {
  test('la facturación del día suma almacenaje + entradas + salidas con las tarifas', () => {
    const { st, ops, run } = setup();
    run(4 * 3600);
    const rows = clientReport(ops, st);
    assert.equal(rows.length, 3);
    for (const r of rows) {
      const c = ops.clients.get(r.name);
      const esperado = c.palletDias * TARIFAS.almacenajePalletDia + c.entradas * TARIFAS.entradaPallet + c.salidas * TARIFAS.salidaPallet;
      assert.ok(Math.abs(r.hoy - esperado) < 1e-6);
      assert.ok(r.mes > r.hoy);
    }
    const stock = [...st.palletMap.values()].filter((p) => p.locId != null).length;
    assert.equal(rows.reduce((s, r) => s + r.pallets, 0), stock);
    assert.ok(rows.some((r) => r.riesgo > 0), 'hay pallets por vencer con valor');
  });

  test('la proyección de ocupación necesita al menos media hora de datos', () => {
    const { st, ops, run } = setup();
    assert.equal(occupancyProjection(ops, st).estado, 'MIDIENDO');
    run(2 * 3600);
    assert.notEqual(occupancyProjection(ops, st).estado, 'MIDIENDO');
  });
});

describe('tablet del clark', () => {
  test('PIN de la demo', () => {
    assert.equal(checkPin(PIN_DEMO), true);
    assert.equal(checkPin('0000'), false);
  });

  test('checklist con falla bloquea el equipo y el clark se detiene hasta que lo habilitan', () => {
    const { st, ops, run } = setup();
    run(600);
    const c = st.clarks[0];
    assert.equal(submitChecklist(ops, st, c, ['Frenos y freno de mano']).ok, false);
    const pos = [c.x, c.y, c.tasksDone];
    run(1800);
    assert.deepEqual([c.x, c.y, c.tasksDone], pos);
    unblock(ops, st, c);
    run(1800);
    assert.notDeepEqual([c.x, c.y, c.tasksDone], pos);
  });

  test('escanear el pallet que vence después de lo indicado dispara el bloqueo FEFO', () => {
    const { st, ops } = setup();
    for (let k = 0; k < 4000; k++) {
      stepSim(st, 1); stepOps(ops, st);
      for (const c of st.clarks) {
        if (c.task?.type !== 'PICK' || c.phase !== 'toFrom') continue;
        const r = simulateScan(ops, st, c, false);
        if (!r.fefo) continue;
        const expected = st.palletMap.get(c.task.palletId);
        const wrong = [...st.palletMap.values()].find((q) => q.lpn === r.wrong);
        assert.equal(wrong.skuId, expected.skuId);
        assert.ok(wrong.exp > expected.exp);
        assert.equal(simulateScan(ops, st, c, true).ok, true);
        return;
      }
    }
    assert.fail('no apareció un picking con alternativa que venza después');
  });

  test('los problemas reportados llegan al resumen del turno', () => {
    const { st, ops, run } = setup();
    run(3600);
    reportProblem(ops, st, st.clarks[1], 'DANADO');
    const s = shiftSummary(ops, st, 'CD Test');
    assert.match(s.text, /Problemas: 1 reportados/);
    assert.match(s.text, /Exactitud de stock: \d+[.,]\d %/);
    assert.match(s.text, /Entraron \d+ pallets/);
  });
});
