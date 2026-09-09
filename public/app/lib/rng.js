/**
 * Deterministic pseudo-random generator (mulberry32).
 *
 * Used by the seed-data generator and by the mock recognition provider so that
 * demos are reproducible: the same outlet / image always produces the same result.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit string hash (FNV-1a) — turns any key into an RNG seed. */
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function rngFor(key) {
  return mulberry32(hashString(key));
}

export function pick(rand, array) {
  return array[Math.floor(rand() * array.length) % array.length];
}
