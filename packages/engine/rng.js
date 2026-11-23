// Generador pseudoaleatorio con semilla (misma semilla = mismo depósito, ideal para demos repetibles)
export function makeRng(seed = 42) {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.int = (min, max) => min + Math.floor(r() * (max - min + 1));
  r.range = (min, max) => min + r() * (max - min);
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.weighted = (items, weightOf) => {
    let total = 0;
    for (const it of items) total += weightOf(it);
    let x = r() * total;
    for (const it of items) { x -= weightOf(it); if (x <= 0) return it; }
    return items[items.length - 1];
  };
  r.shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  };
  return r;
}
