import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsv } from '../public/app/lib/csv.js';
import { defaultConfig } from '../public/app/config.js';
import { buildSeedData } from '../public/app/seed.js';
import { buildAnalytics } from '../public/app/services/analyticsService.js';

const NOW = '2026-09-09T12:00:00.000Z';

test('CSV serialisation quotes commas, quotes and newlines', () => {
  const csv = toCsv(['a', 'b'], [{ a: 'plain', b: 'has, comma' }, { a: 'say "hi"', b: 'line\nbreak' }]);
  assert.match(csv, /"has, comma"/);
  assert.match(csv, /"say ""hi"""/);
  assert.match(csv, /"line\nbreak"/);
});

test('CSV round-trips through the parser', () => {
  const rows = [
    { id: 'pr-1', sku_id: 'sku-a', notes: 'East, uplift', recommended_price: '13.70' },
    { id: 'pr-2', sku_id: 'sku-b', notes: 'says "review"', recommended_price: '14.30' },
  ];
  const columns = ['id', 'sku_id', 'notes', 'recommended_price'];
  assert.deepEqual(parseCsv(toCsv(columns, rows)), rows);
});

test('parser tolerates empty input and trailing newlines', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('a,b\n1,2\n\n'), [{ a: '1', b: '2' }]);
});

test('missing values export as empty cells, not "null"', () => {
  const csv = toCsv(['a', 'b'], [{ a: null, b: undefined }]);
  assert.equal(csv.split('\r\n')[1], ',');
});

test('price-rule export columns round-trip back into importable rows', () => {
  const data = buildSeedData(NOW);
  const columns = [
    'id', 'market', 'territory_id', 'channel_id', 'outlet_id', 'sku_id',
    'recommended_price', 'recommended_min', 'recommended_max',
    'effective_from', 'effective_to', 'priority', 'active', 'notes',
  ];
  const parsed = parseCsv(toCsv(columns, data.price_rules));
  assert.equal(parsed.length, data.price_rules.length);
  assert.equal(parsed[0].sku_id, data.price_rules[0].sku_id);
  assert.equal(Number(parsed[0].recommended_price), data.price_rules[0].recommended_price);
});

test('observation export carries the rule snapshot, not the live rule', () => {
  const config = defaultConfig();
  const data = buildSeedData(NOW);
  const analytics = buildAnalytics(data, {}, config, NOW);
  const strategic = analytics.observations.filter((o) => o.sku_id === 'sku-lm-rlxl');
  const old = strategic.filter((o) => new Date(o.observed_at) < new Date('2026-07-25T00:00:00Z'));

  const rows = old.map((o) => ({
    observed_at: o.observed_at,
    recommended_price_snapshot: o.recommended_price_snapshot,
  }));
  const parsed = parseCsv(toCsv(['observed_at', 'recommended_price_snapshot'], rows));
  assert.ok(parsed.length > 0);
  assert.ok(parsed.every((r) => r.recommended_price_snapshot === '13.5'));
});
