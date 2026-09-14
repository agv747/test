/**
 * Coverage denominators belong to the scope on screen (GM review §C).
 *
 * Filtered to East, the Control Tower reported 25% market coverage: six outlets of
 * twenty-four. Six was East's, twenty-four was the country's. Visiting every outlet East
 * has could never have reached 100%.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCoverage,
  expectedAssortment,
  outletsInScope,
} from '../public/app/services/coverageService.js';
import { buildAnalytics } from '../public/app/services/analyticsService.js';
import { buildSeedData } from '../public/app/seed.js';
import { defaultConfig } from '../public/app/config.js';

const NOW = '2026-09-09T12:00:00.000Z';
const config = defaultConfig();
const data = buildSeedData(NOW);

const OUTLETS = [
  { id: 'a', territory_id: 'east', channel_id: 'indep', assigned_tme_id: 'u1', active: true },
  { id: 'b', territory_id: 'east', channel_id: 'chain', assigned_tme_id: 'u1', active: true },
  { id: 'c', territory_id: 'west', channel_id: 'indep', assigned_tme_id: 'u2', active: true },
  { id: 'd', territory_id: 'east', channel_id: 'indep', assigned_tme_id: 'u1', active: false },
];

/* -------------------------------------------------------------------- scope */

test('scope means the outlets the filters actually select', () => {
  assert.deepEqual(outletsInScope(OUTLETS, { territory_id: 'east' }).map((o) => o.id), ['a', 'b']);
  assert.deepEqual(outletsInScope(OUTLETS, { channel_id: 'chain' }).map((o) => o.id), ['b']);
  assert.deepEqual(outletsInScope(OUTLETS, { outlet_id: 'c' }).map((o) => o.id), ['c']);
  assert.deepEqual(outletsInScope(OUTLETS, { user_id: 'u2' }).map((o) => o.id), ['c']);
});

test('a closed outlet is nobody\'s missing visit', () => {
  assert.equal(outletsInScope(OUTLETS, {}).some((o) => o.id === 'd'), false);
});

/* -------------------------------------------------------------- assortment */

test('an outlet is not marked short of a SKU it has never stocked', () => {
  // "All outlets × all SKUs" would invent a denominator no amount of fieldwork could fill.
  const history = [
    { outlet_id: 'a', sku_id: 'winston', is_jti: true },
    { outlet_id: 'a', sku_id: 'camel', is_jti: true },
    { outlet_id: 'b', sku_id: 'winston', is_jti: true },
    { outlet_id: 'b', sku_id: 'marlboro', is_jti: false },
  ];
  const expected = expectedAssortment(history, ['a', 'b']);
  assert.equal(expected.size, 3, 'three JTI outlet-SKU pairs, and the competitor is not one');
  assert.ok(expected.has('a|camel'));
  assert.ok(!expected.has('b|camel'));
});

/* ---------------------------------------------------------------- the bug */

test('visiting every outlet in a territory reads as complete, not as a quarter', () => {
  const east = data.outlets.filter((o) => o.territory_id === 'ter-east' && o.active !== false);
  const observations = east.map((outlet, i) => ({
    id: `o${i}`,
    outlet_id: outlet.id,
    sku_id: 'sku-jti-winston-red',
    is_jti: true,
    observed_at: NOW,
    competitor_sku_id_snapshot: null,
    evaluation: null,
  }));

  const coverage = calculateCoverage(observations, observations, data, {
    filters: { territory_id: 'ter-east' },
    now: NOW,
  });

  assert.equal(coverage.scope_outlets, east.length);
  assert.equal(coverage.outlet_visit_coverage.numerator, east.length);
  assert.equal(coverage.outlet_visit_coverage.denominator, east.length);
  assert.equal(coverage.outlet_visit_coverage.pct, 100);
});

test('the national view is unchanged by that, and still counts every outlet', () => {
  const analytics = buildAnalytics(data, {}, config, NOW);
  assert.equal(analytics.coverage.scope_outlets, 24);
  assert.ok(analytics.coverage.outlet_visit_coverage.denominator === 24);
});

test('a territory filter narrows the denominator with the numerator', () => {
  const national = buildAnalytics(data, {}, config, NOW).coverage;
  const east = buildAnalytics(data, { territory_id: 'ter-east' }, config, NOW).coverage;
  assert.ok(east.outlet_visit_coverage.denominator < national.outlet_visit_coverage.denominator);
  assert.equal(east.outlet_visit_coverage.denominator, 6);
});

/* --------------------------------------------------------- the four questions */

test('coverage answers four separate questions, each with its own denominator', () => {
  const coverage = buildAnalytics(data, {}, config, NOW).coverage;
  for (const key of [
    'outlet_visit_coverage',
    'fresh_sku_coverage',
    'comparable_pair_availability',
    'competitive_alignment',
  ]) {
    const metric = coverage[key];
    assert.ok(metric.label, `${key} is named`);
    assert.ok(metric.description, `${key} says how it is computed`);
    assert.equal(typeof metric.numerator, 'number');
    assert.equal(typeof metric.denominator, 'number');
    assert.ok(metric.numerator <= metric.denominator, `${key} cannot exceed its own denominator`);
  }
});

test('"have we looked" is never blended into "what did we find"', () => {
  // Visit coverage and competitive alignment answer different questions; one number for
  // both would hide which of the two is missing.
  const coverage = buildAnalytics(data, {}, config, NOW).coverage;
  assert.notEqual(
    coverage.outlet_visit_coverage.denominator,
    coverage.competitive_alignment.denominator,
  );
});

test('no comparable observations means unknown, not 0% or 100% alignment', () => {
  const coverage = calculateCoverage([], [], data, { filters: {}, now: NOW });
  assert.equal(coverage.competitive_alignment.pct, null);
  assert.equal(coverage.comparable_pair_availability.pct, null);
});

test('the exclusions from the snapshot travel with the coverage figures', () => {
  const analytics = buildAnalytics(data, {}, config, NOW);
  assert.ok(analytics.coverage.excluded, 'what was left out is reported beside what was counted');
  assert.equal(typeof analytics.coverage.excluded.stale, 'number');
});

test('the assortment basis is stated rather than assumed', () => {
  assert.match(buildAnalytics(data, {}, config, NOW).coverage.assortment_basis, /observed at least once/);
});
