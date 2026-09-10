/** Pure statistics helpers used by dispersion / distribution analytics (§11, §15). */

export function sortedNumbers(values) {
  return values
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
}

/**
 * Linear-interpolation percentile (same definition as Excel PERCENTILE.INC / numpy default).
 * @param {number[]} values unsorted
 * @param {number} p 0..1
 */
export function percentile(values, p) {
  const s = sortedNumbers(values);
  if (s.length === 0) return null;
  if (s.length === 1) return s[0];
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export function median(values) {
  return percentile(values, 0.5);
}

export function mean(values) {
  const s = sortedNumbers(values);
  if (!s.length) return null;
  return s.reduce((a, b) => a + b, 0) / s.length;
}

export function stddev(values) {
  const s = sortedNumbers(values);
  if (s.length < 2) return null;
  const m = mean(s);
  const variance = s.reduce((acc, v) => acc + (v - m) ** 2, 0) / (s.length - 1);
  return Math.sqrt(variance);
}

/**
 * Full distribution summary. Primary dispersion metric is P90 - P10 (§15).
 * @returns {{count:number, min:number, max:number, mean:number, median:number,
 *            p10:number, p25:number, p75:number, p90:number, iqr:number,
 *            p90_minus_p10:number, stddev:number|null}|null}
 */
export function describe(values) {
  const s = sortedNumbers(values);
  if (!s.length) return null;
  const p10 = percentile(s, 0.1);
  const p25 = percentile(s, 0.25);
  const p75 = percentile(s, 0.75);
  const p90 = percentile(s, 0.9);
  return {
    count: s.length,
    min: s[0],
    max: s[s.length - 1],
    mean: mean(s),
    median: percentile(s, 0.5),
    p10,
    p25,
    p75,
    p90,
    iqr: p75 - p25,
    p90_minus_p10: p90 - p10,
    stddev: stddev(s),
  };
}

/**
 * Bucket values into a histogram with a fixed bin width (price ladders use 0.10 SGD).
 * @returns {{bin:number, label:string, count:number, values:number[]}[]}
 */
export function histogram(values, binWidth = 0.1) {
  const s = sortedNumbers(values);
  if (!s.length) return [];
  const bins = new Map();
  for (const v of s) {
    const bin = Math.round(v / binWidth) * binWidth;
    const key = bin.toFixed(2);
    if (!bins.has(key)) bins.set(key, { bin: Number(key), label: key, count: 0, values: [] });
    const entry = bins.get(key);
    entry.count += 1;
    entry.values.push(v);
  }
  return [...bins.values()].sort((a, b) => a.bin - b.bin);
}

/** Clamp helper used by scoring caps. */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function round(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * f) / f;
}
