import { makeRng } from './rng.js';
import { buildLayout } from './layout.js';
import { canPlace, palletKg } from './capacity.js';

// Catálogo ficticio de un centro de distribución de consumo masivo.
// [descripción, categoría, cajas por pallet, vida útil en días]
const CATALOG = [
  ['Gaseosa Cola 2,25 L x6', 'Bebidas', 70, 240], ['Agua mineral 2 L x6', 'Bebidas', 80, 365],
  ['Yerba mate 1 kg x10', 'Almacén', 60, 540], ['Aceite girasol 1,5 L x12', 'Almacén', 55, 450],
  ['Fideos tallarines 500 g x20', 'Almacén', 90, 600], ['Leche larga vida 1 L x12', 'Lácteos UAT', 64, 150],
  ['Cerveza lata 473 cc x24', 'Bebidas', 84, 270], ['Papel higiénico 4 rollos x12', 'Limpieza', 40, 1500],
  ['Arroz largo fino 1 kg x10', 'Almacén', 80, 540], ['Azúcar 1 kg x10', 'Almacén', 90, 900],
  ['Detergente 750 ml x12', 'Limpieza', 60, 900], ['Lavandina 2 L x8', 'Limpieza', 50, 365],
  ['Galletitas dulces 300 g x24', 'Almacén', 72, 300], ['Jugo en polvo x18 cajas', 'Bebidas', 100, 540],
  ['Harina 000 1 kg x10', 'Almacén', 90, 300], ['Tomate triturado 520 g x12', 'Almacén', 75, 720],
  ['Agua saborizada 1,5 L x6', 'Bebidas', 80, 240], ['Café molido 500 g x12', 'Almacén', 60, 450],
  ['Jabón en polvo 3 kg x4', 'Limpieza', 45, 1080], ['Suavizante 900 ml x12', 'Limpieza', 55, 720],
  ['Shampoo 400 ml x12', 'Perfumería', 70, 1080], ['Pañales talle G x4', 'Perfumería', 36, 1080],
  ['Mayonesa 475 g x12', 'Almacén', 80, 240], ['Dulce de leche 400 g x12', 'Almacén', 75, 270],
  ['Vino tinto 750 ml x6', 'Bebidas', 100, 900], ['Sal fina 500 g x20', 'Almacén', 100, 1500],
  ['Puré de tomate 520 g x12', 'Almacén', 75, 720], ['Atún en lata 170 g x24', 'Almacén', 90, 1080],
  ['Arvejas en lata 350 g x24', 'Almacén', 90, 1080], ['Mermelada 454 g x12', 'Almacén', 80, 540],
  ['Limpiador de pisos 900 ml x12', 'Limpieza', 60, 900], ['Esponjas x24', 'Limpieza', 50, 1800],
  ['Cacao en polvo 360 g x12', 'Almacén', 80, 540], ['Té x25 saquitos x24', 'Almacén', 90, 720],
  ['Pan rallado 1 kg x10', 'Almacén', 70, 180], ['Polenta 500 g x20', 'Almacén', 90, 450],
  ['Lentejas 400 g x20', 'Almacén', 90, 720], ['Bolsas de residuos x30', 'Limpieza', 60, 1800],
  ['Insecticida 360 cc x12', 'Limpieza', 55, 900], ['Desodorante 150 ml x12', 'Perfumería', 80, 1080],
  ['Crema dental 90 g x24', 'Perfumería', 90, 900], ['Alimento perro 15 kg', 'Mascotas', 40, 365],
  ['Alimento gato 3 kg x4', 'Mascotas', 45, 365], ['Edulcorante 200 ml x12', 'Almacén', 90, 720],
  ['Vinagre 1 L x12', 'Almacén', 70, 1080], ['Aceite oliva 500 ml x12', 'Almacén', 70, 540],
  ['Garbanzos 400 g x20', 'Almacén', 90, 720], ['Fernet 750 ml x6', 'Bebidas', 100, 1500],
  ['Sidra 720 ml x6', 'Bebidas', 100, 540], ['Servilletas x100 x24', 'Limpieza', 50, 1800],
  ['Velas x6 x20', 'Bazar', 60, 1800], ['Fósforos x10 x50', 'Bazar', 70, 1800],
  ['Pilas AA x4 x24', 'Bazar', 80, 1500], ['Rollo de cocina x3 x8', 'Limpieza', 40, 1500],
  ['Cloro gel 700 ml x12', 'Limpieza', 55, 540], ['Quitamanchas 450 ml x12', 'Limpieza', 60, 900],
  ['Toallitas húmedas x50 x24', 'Perfumería', 60, 720], ['Algodón 140 g x20', 'Perfumería', 80, 1800],
  ['Maní salado 200 g x24', 'Almacén', 80, 240], ['Papas fritas 145 g x20', 'Almacén', 60, 150],
];

// Peso aproximado de cada caja (kg), en el mismo orden que CATALOG.
const KG_CASE = [14, 12.5, 10.4, 17, 10.3, 12.6, 12.2, 3.8, 10.3, 10.2, 9.6, 16.8, 7.6, 1.2, 10.2, 6.9, 9.4, 6.4, 12.4, 11.4, 5.3, 5.6, 6.3, 5.4, 8.2, 10.2, 6.9, 4.6, 9.1, 6.2, 11.4, 0.9, 4.7, 1.4, 10.2, 10.2, 8.2, 3.1, 4.9, 2.1, 2.7, 15.2, 12.3, 2.8, 12.4, 6.9, 8.2, 7.4, 8.1, 3.4, 4.1, 2.9, 2.3, 2.6, 9.2, 6, 6.8, 3.1, 5.3, 3.3];

const CLIENTS = ['Distribuidora Del Plata', 'Mayorista Sur', 'Consumo Norte SA'];

// Clasificación ABC por frecuencia de picks (no por unidades): A ≈ 80 %, B ≈ 15 %, C ≈ 5 %.
export function classifyABC(skus) {
  const sorted = [...skus].sort((a, b) => b.picks90 - a.picks90);
  const total = sorted.reduce((s, k) => s + k.picks90, 0);
  let acc = 0;
  for (const s of sorted) {
    acc += s.picks90;
    const share = acc / total;
    s.abc = share <= 0.8 ? 'A' : share <= 0.95 ? 'B' : 'C';
  }
  return skus;
}

export function generateMockData({ seed = 2026, pallets: nPallets = 300, historyDays = 90 } = {}) {
  const rng = makeRng(seed);
  const layout = buildLayout();

  // --- SKUs con rotación tipo Pareto ---
  const order = rng.shuffle(CATALOG.map((_, i) => i));
  const skus = CATALOG.map(([desc, cat, cajas, vida], i) => ({
    id: i + 1,
    code: `SKU-${String(1001 + i)}`,
    ean: `779${String(1000000000 + i * 7919).slice(0, 10)}`,
    desc, cat, casesPerPallet: cajas, shelfLife: vida, kgCase: KG_CASE[i],
    client: CLIENTS[i % CLIENTS.length],
    rank: order.indexOf(i),
  }));
  // Historial de 90 días: picks diarios por SKU
  for (const s of skus) {
    const base = 280 / Math.pow(s.rank + 1, 1.18);
    s.history = [];
    for (let d = 0; d < historyDays; d++) {
      const dow = d % 7;
      const season = dow === 5 || dow === 6 ? 0.55 : 1.08;
      const noise = rng.range(0.6, 1.4);
      s.history.push(Math.max(0, Math.round(base * season * noise)));
    }
    s.picks90 = s.history.reduce((a, b) => a + b, 0);
    s.ppd = Math.round((s.picks90 / historyDays) * 100) / 100; // picks por día
  }
  classifyABC(skus);

  // --- Cantidad de pallets por SKU (proporcional a la rotación, mínimo 1) ---
  const weights = skus.map((s) => Math.pow(s.ppd + 0.15, 0.62));
  const wSum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => Math.max(1, (w / wSum) * nPallets));
  const counts = raw.map(Math.floor);
  let left = nPallets - counts.reduce((a, b) => a + b, 0);
  const byRem = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k = (k + 1) % byRem.length, left--) counts[byRem[k][1]]++;
  while (counts.reduce((a, b) => a + b, 0) > nPallets) {
    const i = counts.indexOf(Math.max(...counts)); counts[i]--;
  }

  // --- Pallets ubicados "como cayó" (situación típica sin WMS: sin slotting) ---
  const freeLocs = rng.shuffle([...layout.locations]);
  const pallets = [];
  const placed = { locations: layout.locations, palletMap: new Map(), skuMap: new Map(skus.map((s) => [s.id, s])) };
  let seq = 1;
  skus.forEach((s, i) => {
    for (let k = 0; k < counts[i]; k++) {
      const age = rng.int(3, Math.floor(s.shelfLife * 0.9));
      let exp = s.shelfLife - age;
      if (rng() < 0.07) exp = rng.int(4, 29);          // algunos por vencer → alertas FEFO
      const q = rng();
      const p = {
        id: seq,
        lpn: `LPN-${String(seq).padStart(6, '0')}`,
        skuId: s.id,
        lot: `L${String(26000 + rng.int(100, 999))}-${String.fromCharCode(65 + rng.int(0, 7))}`,
        exp,
        qty: s.casesPerPallet - (rng() < 0.25 ? rng.int(1, Math.floor(s.casesPerPallet * 0.6)) : 0),
        status: q < 0.85 ? 'DISPONIBLE' : q < 0.95 ? 'RESERVADO' : 'CUARENTENA',
        locId: null,
        receivedDaysAgo: age,
      };
      // primera ubicación libre (al azar) donde el rack aguanta el peso: posición, viga y módulo
      const kg = palletKg(s, p.qty), skipped = [];
      let loc = freeLocs.pop();
      while (loc && !canPlace(placed, loc, kg)) { skipped.push(loc); loc = freeLocs.pop(); }
      freeLocs.push(...skipped.reverse());
      if (!loc) throw new Error('No hay ubicaciones con capacidad para ' + nPallets + ' pallets');
      p.locId = loc.id;
      loc.palletId = p.id;
      placed.palletMap.set(p.id, p);
      pallets.push(p);
      seq++;
    }
  });

  return {
    generatedAt: new Date().toISOString(),
    seed,
    warehouse: { name: 'CD Ezeiza · Nave 2', aisles: layout.L.aisles, bays: layout.L.bays, levels: layout.L.levels },
    docks: layout.docks,
    locations: layout.locations,
    skus,
    pallets,
  };
}
