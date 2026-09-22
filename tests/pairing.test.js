/**
 * What counts as a comparable pair.
 *
 * A price comparison is a claim about one shelf at one moment. The bases available differ
 * enormously in how well they support that claim, and the code used to treat the weakest of
 * them as the strongest: where an outlet had no competitor reading, a median of other outlets
 * in the territory was substituted silently and fed straight into the verdict. That outlet then
 * produced a Price Index, a competitive position and a contribution to the alignment
 * percentage — every one of them describing shops somewhere else.
 *
 * A plausible number is worse than a missing one here, because a missing comparison is what
 * sends somebody to go and read it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichObservations, resolveCompetitorObservation } from '../public/app/services/analyticsService.js';
import { calculateCoverage } from '../public/app/services/coverageService.js';
import { DEFAULT_CONFIG } from '../public/app/config.js';

const NOW = '2026-09-14T10:00:00.000Z';
const config = DEFAULT_CONFIG;

const day = (offset) => new Date(new Date(NOW).getTime() + offset * 86400000).toISOString();

function observation(overrides = {}) {
  return {
    id: `obs-${Math.random()}`,
    visit_id: 'vis-1',
    outlet_id: 'out-e1',
    territory_id: 'ter-east',
    sku_id: 'sku-comp',
    confirmed_price: 13.2,
    observed_at: day(0),
    excluded: false,
    ...overrides,
  };
}

const jti = {
  id: 'obs-jti',
  visit_id: 'vis-1',
  outlet_id: 'out-e1',
  territory_id: 'ter-east',
  sku_id: 'sku-jti',
  confirmed_price: 14.2,
  observed_at: day(0),
};

/* ------------------------------------------------------- the bases */

test('two prices read in the same visit are the pair', () => {
  const pair = resolveCompetitorObservation(jti, 'sku-comp', [observation()], config);
  assert.equal(pair.basis, 'same_visit');
  assert.equal(pair.outlet_level, true);
  assert.equal(pair.skew_days, 0);
  assert.equal(pair.within_tolerance, true);
});

test('the same outlet a few days earlier is a pair, with the skew reported', () => {
  const pair = resolveCompetitorObservation(
    jti,
    'sku-comp',
    [observation({ visit_id: 'vis-0', observed_at: day(-3) })],
    config,
  );
  assert.equal(pair.basis, 'same_outlet_recent');
  assert.equal(pair.skew_days, 3);
  assert.equal(pair.within_tolerance, true);
  assert.match(pair.basis_label, /same outlet 3 days earlier/);
});

test('beyond the skew tolerance it is reported rather than quietly aged', () => {
  const pair = resolveCompetitorObservation(
    jti,
    'sku-comp',
    [observation({ visit_id: 'vis-0', observed_at: day(-40) })],
    config,
  );
  assert.equal(pair.outlet_level, true);
  assert.equal(pair.within_tolerance, false, 'a 40-day-old reading is not the same moment');
});

test('other outlets in the territory are context, not an outlet-level pair', () => {
  const pair = resolveCompetitorObservation(
    jti,
    'sku-comp',
    [observation({ outlet_id: 'out-e2', visit_id: 'vis-9', observed_at: day(-2) })],
    config,
  );
  assert.equal(pair.basis, 'territory_median');
  assert.equal(pair.outlet_level, false);
  assert.match(pair.basis_label, /other outlets in the territory/);
});

test('a competitor price read after the JTI price is rejected outright', () => {
  // It cannot have been on the shelf beside it.
  const pair = resolveCompetitorObservation(
    jti,
    'sku-comp',
    [observation({ visit_id: 'vis-2', observed_at: day(5) })],
    config,
  );
  assert.equal(pair, null);
});

test('a SKU with no mapping has nothing to resolve', () => {
  assert.equal(resolveCompetitorObservation(jti, null, [observation()], config), null);
});

/* ------------------------------------------ what reaches the verdict */

const data = {
  market: 'SG',
  brands: [
    { id: 'brd-jti', name: 'Winston', company: 'JTI', is_jti: true },
    { id: 'brd-comp', name: 'Pall Mall', company: 'BAT', is_jti: false },
  ],
  skus: [
    { id: 'sku-jti', brand_id: 'brd-jti', name: 'Winston Red', is_jti: true, is_strategic: true, sticks_per_pack: 20 },
    { id: 'sku-comp', brand_id: 'brd-comp', name: 'Pall Mall Red', is_jti: false, sticks_per_pack: 20 },
  ],
  outlets: [
    { id: 'out-e1', name: 'E1', outlet_code: 'E1', territory_id: 'ter-east', channel_id: 'ch-1', active: true },
    { id: 'out-e2', name: 'E2', outlet_code: 'E2', territory_id: 'ter-east', channel_id: 'ch-1', active: true },
  ],
  territories: [{ id: 'ter-east', name: 'East' }],
  channels: [{ id: 'ch-1', name: 'Independent' }],
  users: [],
  visits: [],
  price_observations: [],
  competitor_mappings: [],
  field_actions: [],
};

function enrich(observations) {
  return enrichObservations({ ...data, price_observations: observations }, config, NOW);
}

const jtiRow = (overrides = {}) => ({
  id: 'obs-jti',
  visit_id: 'vis-1',
  outlet_id: 'out-e1',
  sku_id: 'sku-jti',
  confirmed_price: 14.2,
  observed_at: day(0),
  excluded: false,
  recognition_confidence: 0.97,
  competitor_sku_id_snapshot: 'sku-comp',
  desired_gap_min_snapshot: 0,
  desired_gap_max_snapshot: 0.35,
  desired_price_index_min_snapshot: 100,
  desired_price_index_max_snapshot: 103,
  recommended_min_snapshot: 13.4,
  recommended_max_snapshot: 13.8,
  recommended_price_snapshot: 13.6,
  ...overrides,
});

test('a same-visit pair produces a competitive verdict', () => {
  const [row] = enrich([jtiRow(), observation({ id: 'obs-c', confirmed_price: 13.5 })]).filter((o) => o.is_jti);
  assert.equal(row.comparable_pair, true);
  assert.equal(row.competitor_price, 13.5);
  assert.equal(row.evaluation.priceIndex, 105.2);
  assert.equal(row.pair_unavailable_reason, null);
});

test('a territory median does not produce one, and says why', () => {
  const [row] = enrich([
    jtiRow(),
    observation({ id: 'obs-c', outlet_id: 'out-e2', visit_id: 'vis-9', observed_at: day(-2), confirmed_price: 13.5 }),
  ]).filter((o) => o.is_jti);

  assert.equal(row.comparable_pair, false);
  // The number is still shown as context — it is simply not the basis of a judgement.
  assert.equal(row.competitor_price, 13.5);
  assert.equal(row.evaluation.priceIndex, null);
  assert.equal(row.evaluation.competitive.aligned, null);
  assert.match(row.pair_unavailable_reason, /median of other outlets/);
});

test('a stale competitor price does not produce one either', () => {
  const [row] = enrich([
    jtiRow(),
    observation({ id: 'obs-c', visit_id: 'vis-0', observed_at: day(-40), confirmed_price: 13.5 }),
  ]).filter((o) => o.is_jti);

  assert.equal(row.comparable_pair, false);
  assert.equal(row.evaluation.priceIndex, null);
  assert.match(row.pair_unavailable_reason, /beyond the 14-day tolerance/);
});

test('an unavailable comparison is never rendered as agreement', () => {
  const [row] = enrich([jtiRow()]).filter((o) => o.is_jti);
  // Not aligned, not a zero gap, not an index of 100 — three ways missing data used to arrive
  // on screen wearing the clothes of a good result.
  assert.equal(row.comparable_pair, false);
  assert.equal(row.evaluation.competitive.aligned, null);
  assert.equal(row.evaluation.gap, null);
  assert.equal(row.evaluation.priceIndex, null);
  assert.match(row.pair_unavailable_reason, /no competitor price has been observed/);
});

test('both timestamps are available wherever a pair is shown', () => {
  const rows = enrich([jtiRow(), observation({ id: 'obs-c', confirmed_price: 13.5 })]).filter((o) => o.is_jti);
  assert.ok(rows[0].observed_at);
  assert.ok(rows[0].competitor_observed_at);
  assert.equal(rows[0].competitor_skew_days, 0);
});

/* ------------------------------------------------------ coverage */

test('comparable-pair availability counts only real pairs', () => {
  const observations = enrich([
    jtiRow(),
    jtiRow({ id: 'obs-jti-2', outlet_id: 'out-e2', visit_id: 'vis-2' }),
    observation({ id: 'obs-c', confirmed_price: 13.5 }),
  ]);
  const coverage = calculateCoverage(observations, observations, data, { now: NOW, windowDays: 14 });

  assert.equal(coverage.comparable_pair_availability.denominator, 2, 'both JTI rows carry a mapping');
  assert.equal(coverage.comparable_pair_availability.numerator, 1, 'only one has a real pair');
});

test('with no pairs at all, alignment is unknown rather than 0% or 100%', () => {
  const observations = enrich([jtiRow()]);
  const coverage = calculateCoverage(observations, observations, data, { now: NOW, windowDays: 14 });
  assert.equal(coverage.competitive_alignment.denominator, 0);
  assert.equal(coverage.competitive_alignment.pct, null);
});
