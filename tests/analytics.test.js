import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, OPPORTUNITY_CATEGORIES } from '../public/app/config.js';
import { buildSeedData } from '../public/app/seed.js';
import {
  applyFilters,
  buildAnalytics,
  buildPriceLadder,
  buildPriceMatrix,
  buildTimeSeries,
  calculateDispersion,
  calculateKpis,
  calculatePriceDistribution,
  detectCompetitorMoves,
  enrichObservations,
} from '../public/app/services/analyticsService.js';
import { RANGE_BUCKET } from '../public/app/services/pricePositionService.js';

/** Fixed clock so every assertion below is deterministic. */
const NOW = '2026-09-09T12:00:00.000Z';
const config = defaultConfig();
const data = buildSeedData(NOW);
const analytics = buildAnalytics(data, {}, config, NOW);

test('seed data covers every entity the spec requires', () => {
  assert.equal(data.territories.length, 4);
  assert.equal(data.channels.length, 4);
  assert.equal(data.outlets.length, 24);
  assert.ok(data.skus.filter((s) => s.is_jti).length >= 6);
  assert.ok(data.skus.filter((s) => !s.is_jti).length >= 5);
  assert.ok(data.price_observations.length > 500, 'enough observations to show a distribution');
  assert.ok(data.field_actions.length >= 3);
  assert.ok(data.skus.some((s) => s.is_strategic && s.strategic_priority === 'High'));
});

test('observations enrich into evaluated views with joined master data', () => {
  const enriched = enrichObservations(data, config, NOW);
  assert.ok(enriched.length > 0);
  const jti = enriched.find((o) => o.is_jti);
  assert.ok(jti.sku_name);
  assert.ok(jti.outlet_name);
  assert.ok(jti.territory_name);
  assert.ok(jti.channel_name);
  assert.ok(jti.evaluation);
  assert.ok(['fresh', 'aging', 'stale'].includes(jti.freshness.level));
  assert.equal(enrichObservations(data, config, NOW).some((o) => o.excluded), false);
});

test('historical integrity: a superseded rule still governs its own observations (§25)', () => {
  // The Strategic SKU recommendation moved from 13.40 to 13.60 forty-five days ago.
  const strategic = data.price_observations.filter((o) => o.sku_id === 'sku-jti-winston-red');
  const old = strategic.filter((o) => new Date(o.observed_at) < new Date('2026-07-25T00:00:00Z'));
  const recent = strategic.filter((o) => new Date(o.observed_at) > new Date('2026-08-01T00:00:00Z'));

  assert.ok(old.length && recent.length, 'seed spans the rule change');
  assert.ok(old.every((o) => o.recommended_price_snapshot === 13.4));
  assert.ok(recent.every((o) => o.recommended_price_snapshot === 13.6));
  assert.ok(old.every((o) => o.price_rule_id === 'pr-WIN-RED-mkt-prev'));
});

test('territory-specific rule overrides the market rule in the East', () => {
  const east = data.outlets.filter((o) => o.territory_id === 'ter-east').map((o) => o.id);
  const eastDf = data.price_observations.filter(
    (o) => o.sku_id === 'sku-jti-mevius-original' && east.includes(o.outlet_id),
  );
  const westDf = data.price_observations.filter(
    (o) => o.sku_id === 'sku-jti-mevius-original' && !east.includes(o.outlet_id),
  );
  assert.ok(eastDf.length && westDf.length);
  assert.ok(eastDf.every((o) => o.recommended_price_snapshot === 14.5));
  assert.ok(westDf.every((o) => o.recommended_price_snapshot === 14.4));
});

test('KPIs are computed over observations with a valid recommendation only', () => {
  const kpis = analytics.kpis;
  assert.ok(kpis.recommended_price_alignment >= 0 && kpis.recommended_price_alignment <= 100);
  assert.ok(kpis.competitive_alignment >= 0 && kpis.competitive_alignment <= 100);
  assert.ok(kpis.recommended_price_alignment_n > 0);
  assert.ok(kpis.strategic_recommended_price_alignment !== null);
  assert.ok(kpis.strategic_competitive_alignment !== null);
  assert.ok(kpis.jti_observations > 0);
  assert.ok(kpis.competitor_observations > 0);
  assert.equal(kpis.coverage.expected_outlets, 24);
});

test('alignment percentage matches a hand-computed count', () => {
  const jti = analytics.observations.filter(
    (o) => o.is_jti && o.evaluation.rangeBucket !== RANGE_BUCKET.UNKNOWN,
  );
  const within = jti.filter((o) => o.evaluation.rangeBucket === RANGE_BUCKET.WITHIN);
  const expected = Math.round((within.length / jti.length) * 1000) / 10;
  assert.equal(analytics.kpis.recommended_price_alignment, expected);
});

test('the dataset shows below, within and above range positions', () => {
  const buckets = new Set(
    analytics.observations.filter((o) => o.is_jti).map((o) => o.evaluation.rangeBucket),
  );
  assert.ok(buckets.has(RANGE_BUCKET.WITHIN));
  assert.ok(buckets.has(RANGE_BUCKET.ABOVE));
  assert.ok(buckets.has(RANGE_BUCKET.BELOW));
});

test('price position matrix accounts for every classifiable JTI observation', () => {
  const { matrix, total, unclassified } = buildPriceMatrix(analytics.observations);
  assert.equal(matrix.length, 3);
  assert.equal(matrix[0].cells.length, 3);
  const summed = matrix.flatMap((r) => r.cells).reduce((a, c) => a + c.count, 0);
  const classifiable = analytics.observations.filter(
    (o) => o.is_jti && o.evaluation.rangeBucket !== RANGE_BUCKET.UNKNOWN && o.evaluation.competitive.bucket !== 'unknown',
  ).length;
  assert.equal(summed, classifiable);
  assert.equal(summed + unclassified, total);
  assert.ok(matrix.flatMap((r) => r.cells).some((c) => c.count > 0));
});

test('opportunities are derived, prioritised and never use compliance language', () => {
  const opps = analytics.opportunities;
  assert.ok(opps.length > 0);
  for (let i = 1; i < opps.length; i += 1) {
    assert.ok(opps[i - 1].priority_score >= opps[i].priority_score, 'sorted by priority');
  }
  assert.ok(opps.some((o) => o.priority_label === 'High'));
  assert.ok(opps.some((o) => o.is_strategic));
  for (const o of opps.slice(0, 20)) {
    assert.ok(Object.values(OPPORTUNITY_CATEGORIES).includes(o.category));
    assert.doesNotMatch(o.reason, /violation|non-compliant|illegal/i);
    assert.ok(o.days_open >= 0);
  }
});

test('the scripted persistent strategic opportunity is detected in the East', () => {
  const opp = analytics.opportunities.find(
    (o) => o.outlet_id === 'out-e1' && o.jti_sku_id === 'sku-jti-winston-red',
  );
  assert.ok(opp, 'Punggol Central Minimart strategic opportunity exists');
  assert.equal(opp.is_strategic, true);
  assert.equal(opp.range_bucket, RANGE_BUCKET.ABOVE);
  assert.ok(opp.days_open >= config.persistence.min_days_open);
  assert.equal(opp.priority_label, 'High');
});

test('the scripted competitor price drop is detected as a material move', () => {
  const moves = detectCompetitorMoves(analytics.observations, data, config, NOW);
  const move = moves.find((m) => m.competitor_sku_id === 'sku-bat-pallmall-red');
  assert.ok(move, 'Pall Mall Red move detected');
  assert.ok(move.change < 0, 'price decreased');
  assert.ok(Math.abs(move.change) >= config.competitor_move.min_abs_change);
  assert.ok(move.affected_jti_sku_ids.length > 0);
  assert.ok(move.affected_outlets > 0);
  assert.ok(['High', 'Medium', 'Low'].includes(move.priority));
});

test('immaterial competitor noise is filtered out by the configured thresholds', () => {
  const strict = defaultConfig();
  strict.competitor_move.min_abs_change = 5;
  strict.competitor_move.min_pct_change = 50;
  assert.equal(detectCompetitorMoves(analytics.observations, data, strict, NOW).length, 0);
});

test('price distribution reports percentiles, not just an average', () => {
  const dist = calculatePriceDistribution(
    analytics.observations.filter((o) => o.is_jti),
    'sku-jti-winston-red',
  );
  assert.ok(dist);
  assert.ok(dist.stats.count > 10);
  assert.ok(dist.stats.p10 <= dist.stats.median);
  assert.ok(dist.stats.median <= dist.stats.p90);
  assert.ok(dist.histogram.length > 1, 'prices vary across outlets');
  assert.ok(dist.outlets > 1);
});

test('dispersion flags high-spread SKUs using P90-P10', () => {
  const rows = calculateDispersion(analytics.observations, config);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(
      row.high_dispersion,
      row.stats.p90_minus_p10 >= config.dispersion.high_dispersion_abs ||
        row.spread_pct >= config.dispersion.high_dispersion_pct,
    );
  }
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i - 1].stats.p90_minus_p10 >= rows[i].stats.p90_minus_p10);
  }
});

test('price ladder is ordered by median observed price and mixes JTI with competitors', () => {
  const { rungs, insights } = buildPriceLadder(analytics.observations, config);
  assert.ok(rungs.length >= 10);
  for (let i = 1; i < rungs.length; i += 1) {
    assert.ok(rungs[i - 1].median_price >= rungs[i].median_price);
  }
  assert.ok(rungs.some((r) => r.is_jti));
  assert.ok(rungs.some((r) => !r.is_jti));
  assert.ok(Array.isArray(insights));
});

test('ladder views can be restricted to own brand or competitors', () => {
  const jtiOnly = buildPriceLadder(analytics.observations, config, { include: 'jti' });
  assert.ok(jtiOnly.rungs.every((r) => r.is_jti));
  const compOnly = buildPriceLadder(analytics.observations, config, { include: 'competitor' });
  assert.ok(compOnly.rungs.every((r) => !r.is_jti));
});

test('time series groups medians by period in chronological order', () => {
  const series = buildTimeSeries(
    analytics.observations.filter((o) => o.sku_id === 'sku-jti-winston-red' || o.sku_id === 'sku-pmi-lm-red'),
    'week',
  );
  assert.ok(series.length > 3);
  for (let i = 1; i < series.length; i += 1) {
    assert.ok(series[i - 1].period < series[i].period);
  }
  assert.ok(series.some((p) => p.jti_median !== null));
});

test('field effectiveness reports observed sequence without claiming causality', () => {
  const fx = analytics.fieldEffectiveness;
  assert.equal(fx.label, 'Observed price change after engagement');
  assert.match(fx.disclaimer, /does not attribute/i);
  assert.ok(fx.timeline.length > 0);
  assert.ok(fx.opportunities_identified > 0);
  assert.ok(fx.engagement_to_price_change_rate !== null);
});

test('the scripted engagement shows a later observed price improvement', () => {
  const entry = analytics.fieldEffectiveness.timeline.find(
    (t) => t.outlet_id === 'out-n1' && t.sku_id === 'sku-jti-winston-red',
  );
  assert.ok(entry, 'Yishun Mini Mart engagement is in the timeline');
  assert.equal(entry.before.jti_price, 14.5);
  assert.equal(entry.after.jti_price, 14.0);
  assert.equal(entry.observed_price_change, -0.5);
  assert.equal(entry.before.gap, 0.8);
  assert.equal(entry.after.gap, 0.3);
  assert.equal(entry.observed_gap_improvement, 0.5);
});

test('territory summary covers every territory with its own KPIs', () => {
  assert.equal(analytics.territories.length, 4);
  for (const t of analytics.territories) {
    assert.ok(t.territory.name);
    assert.ok(t.kpis.jti_observations > 0);
    assert.ok(t.outlets > 0);
    assert.ok(t.coverage.coverage_pct !== null);
  }
});

test('top actions blend opportunities, competitor moves and dispersion, ranked by priority', () => {
  const items = analytics.topActions;
  assert.ok(items.length > 0);
  const kinds = new Set(items.map((i) => i.kind));
  assert.ok(kinds.has('opportunity'));
  const rank = { High: 0, Medium: 1, Low: 2 };
  for (let i = 1; i < items.length; i += 1) {
    assert.ok(rank[items[i - 1].priority] <= rank[items[i].priority]);
  }
  for (const item of items) {
    assert.ok(item.suggested_action);
    assert.doesNotMatch(item.suggested_action, /SGD \d|approve|incentive amount/i);
  }
});

test('filters narrow the analysed observation set', () => {
  const enriched = enrichObservations(data, config, NOW);
  const east = applyFilters(enriched, { territory_id: 'ter-east' });
  assert.ok(east.length > 0 && east.length < enriched.length);
  assert.ok(east.every((o) => o.territory_id === 'ter-east'));

  const strategic = applyFilters(enriched, { strategic_only: true });
  assert.ok(strategic.every((o) => o.is_strategic));

  const jtiOnly = applyFilters(enriched, { ownership: 'jti' });
  assert.ok(jtiOnly.every((o) => o.is_jti));

  const confident = applyFilters(enriched, { min_confidence: 0.9 });
  assert.ok(confident.every((o) => o.recognition_confidence >= 0.9));

  const windowed = applyFilters(enriched, { from: '2026-08-01', to: '2026-09-09T23:59:59Z' });
  assert.ok(windowed.length > 0 && windowed.length < enriched.length);
});

test('period-over-period deltas are reported when a date range is selected', () => {
  const scoped = buildAnalytics(
    data,
    { from: '2026-08-10T00:00:00Z', to: '2026-09-09T23:59:59Z' },
    config,
    NOW,
  );
  assert.ok(scoped.kpis.delta, 'delta block present');
  assert.ok(scoped.kpis.previous.jti_observations > 0);
});

test('data freshness is available on every observation (§26)', () => {
  const stale = analytics.observations.filter((o) => o.freshness.level === 'stale');
  const fresh = analytics.observations.filter((o) => o.freshness.level === 'fresh');
  assert.ok(stale.length > 0 && fresh.length > 0, 'dataset spans freshness buckets');
});
