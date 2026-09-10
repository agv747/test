import test from 'node:test';
import assert from 'node:assert/strict';
import { describe, histogram, median, percentile, round } from '../public/app/lib/stats.js';

test('percentile uses linear interpolation', () => {
  const values = [10, 20, 30, 40];
  assert.equal(percentile(values, 0), 10);
  assert.equal(percentile(values, 1), 40);
  assert.equal(percentile(values, 0.5), 25);
  assert.equal(round(percentile(values, 0.1), 4), 13);
});

test('median handles odd and even lengths', () => {
  assert.equal(median([13.5, 13.7, 14.1]), 13.7);
  assert.equal(median([13.5, 13.7]), 13.6);
  assert.equal(median([]), null);
});

test('describe reports the P90-P10 dispersion metric', () => {
  const prices = [13.2, 13.5, 13.5, 13.7, 13.7, 13.7, 13.9, 13.9, 14.1, 14.3];
  const stats = describe(prices);
  assert.equal(stats.count, 10);
  assert.equal(stats.min, 13.2);
  assert.equal(stats.max, 14.3);
  assert.equal(round(stats.median, 2), 13.7);
  assert.ok(stats.p90 > stats.p75);
  assert.ok(stats.p10 < stats.p25);
  assert.equal(round(stats.p90_minus_p10, 4), round(stats.p90 - stats.p10, 4));
  assert.equal(round(stats.iqr, 4), round(stats.p75 - stats.p25, 4));
});

test('describe returns null for empty input', () => {
  assert.equal(describe([]), null);
});

test('histogram buckets to a fixed bin width and stays ordered', () => {
  const bins = histogram([13.68, 13.72, 13.9, 14.31], 0.1);
  assert.deepEqual(bins.map((b) => b.label), ['13.70', '13.90', '14.30']);
  assert.equal(bins[0].count, 2);
  for (let i = 1; i < bins.length; i += 1) assert.ok(bins[i].bin > bins[i - 1].bin);
});
