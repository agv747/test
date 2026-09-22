/**
 * Dispersion instead of a bar, and per-mapping effects instead of one blended index.
 *
 * Two screens told the reader something that was not there.
 *
 * Price Architecture drew each SKU as a filled bar as long as its median price, on an axis with
 * no numbers. A filled bar is read from zero, so prices clustered between SGD 12.60 and 16.00
 * looked several times apart; and a median alone hid the thing the page exists to show, which
 * is that one SKU is priced identically in twenty-four outlets while another ranges over a
 * dollar.
 *
 * Competitor Moves reported one Price Index — 101.6 — as the impact on Winston Red, Camel
 * Filters and LD Red together. They map to Pall Mall Red from three different price levels with
 * three different intended corridors, so a single index is the position of none of them. And
 * the movement itself compared a median of everything seen before against a median of
 * everything seen after: two different sets of shops, so a change in the visit schedule read as
 * a change in price.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPriceLadder,
  detectCompetitorMoves,
  enrichObservations,
} from '../public/app/services/analyticsService.js';
import {
  COMPETITIVE_BUCKET,
  COMPETITIVE_BUCKET_LABELS,
  RELATIVE_POSITION_NOTE,
} from '../public/app/services/pricePositionService.js';
import { intervalChart } from '../public/app/ui/charts.js';
import { DEFAULT_CONFIG } from '../public/app/config.js';
import { buildSeedData } from '../public/app/seed.js';

const NOW = '2026-09-14T10:00:00.000Z';
const data = buildSeedData(NOW);
const config = DEFAULT_CONFIG;
const all = enrichObservations(data, config, NOW);

/* ------------------------------------------------ the interval, not the bar */

test('a rung carries its whole distribution, not just a median', () => {
  const ladder = buildPriceLadder(all, config);
  const rung = ladder.rungs.find((r) => r.sku_id === 'sku-jti-winston-red');
  for (const key of ['p10', 'p25', 'median_price', 'p75', 'p90']) {
    assert.ok(Number.isFinite(rung[key]), `${key} is missing`);
  }
  assert.ok(rung.p10 <= rung.p25);
  assert.ok(rung.p25 <= rung.median_price);
  assert.ok(rung.median_price <= rung.p75);
  assert.ok(rung.p75 <= rung.p90);
});

test('percentiles are built from one price per outlet, not per visit', () => {
  const ladder = buildPriceLadder(all, config);
  const rung = ladder.rungs.find((r) => r.sku_id === 'sku-jti-winston-red');
  // An outlet visited ten times must count once: otherwise the percentile measures how often
  // somebody went to the shop, not what the shop charges.
  assert.equal(rung.values.length, rung.outlets);
  assert.ok(rung.observations > rung.outlets, 'the fixture should contain repeat visits');
});

test('two SKUs with the same median are distinguished by their spread', () => {
  const observations = [
    ...outletPrices('sku-a', [13.6, 13.6, 13.6, 13.6, 13.6, 13.6, 13.6, 13.6, 13.6, 13.6]),
    ...outletPrices('sku-b', [12.6, 12.9, 13.2, 13.5, 13.6, 13.6, 13.7, 14.0, 14.3, 14.6]),
  ];
  const ladder = buildPriceLadder(observations, config);
  const a = ladder.rungs.find((r) => r.sku_id === 'sku-a');
  const b = ladder.rungs.find((r) => r.sku_id === 'sku-b');

  assert.equal(a.median_price, b.median_price, 'the medians should be identical');
  assert.equal(a.p90 - a.p10, 0);
  assert.ok(b.p90 - b.p10 > 1, 'the dispersed SKU must be visibly dispersed');
});

test('a thin sample reports its points rather than implying a percentile distribution', () => {
  const ladder = buildPriceLadder(outletPrices('sku-a', [13.5, 14.0, 14.5]), config);
  const rung = ladder.rungs[0];
  assert.equal(rung.small_sample, true);
  assert.deepEqual(rung.values, [13.5, 14, 14.5]);
});

test('outlet-specific rules are counted, not averaged into a corridor nobody set', () => {
  const observations = [
    ...outletPrices('sku-a', [13.5, 13.6], { recommended_min_snapshot: 13.4, recommended_max_snapshot: 13.8 }),
    ...outletPrices('sku-a', [14.0, 14.1], { recommended_min_snapshot: 13.9, recommended_max_snapshot: 14.3, offset: 10 }),
  ];
  const rung = buildPriceLadder(observations, config).rungs[0];
  assert.equal(rung.recommendation_variants, 2);
  assert.equal(rung.recommended_min, null, 'no single band may be drawn');
  assert.equal(rung.recommended_max, null);
});

test('one applicable rule does produce a corridor', () => {
  const observations = outletPrices('sku-a', [13.5, 13.6, 13.7], {
    recommended_min_snapshot: 13.4,
    recommended_max_snapshot: 13.8,
  });
  const rung = buildPriceLadder(observations, config).rungs[0];
  assert.equal(rung.recommendation_variants, 1);
  assert.equal(rung.recommended_min, 13.4);
});

test('prices for different pack configurations are separate rows, never one distribution', () => {
  const observations = [
    ...outletPrices('sku-a', [13.5, 13.6], { sticks_per_pack_snapshot: 20 }),
    ...outletPrices('sku-a', [7.1, 7.2], { sticks_per_pack_snapshot: 10, offset: 10 }),
  ];
  const ladder = buildPriceLadder(observations, config);
  assert.equal(ladder.rungs.length, 2);
  assert.equal(ladder.mixed_packs, true);
  assert.deepEqual(ladder.rungs.map((r) => r.sticks_per_pack).sort(), [10, 20]);
});

test('the axis spans every interval and every corridor drawn on it', () => {
  const ladder = buildPriceLadder(all, config);
  for (const rung of ladder.rungs) {
    assert.ok(ladder.axis.min <= rung.p10, `${rung.sku_name} P10 falls off the axis`);
    assert.ok(ladder.axis.max >= rung.p90, `${rung.sku_name} P90 falls off the axis`);
    if (Number.isFinite(rung.recommended_min)) {
      assert.ok(ladder.axis.min <= rung.recommended_min);
      assert.ok(ladder.axis.max >= rung.recommended_max);
    }
  }
});

test('the chart prints its axis and never fills a bar from zero', () => {
  const ladder = buildPriceLadder(all, config);
  const svg = intervalChart({ rows: ladder.rungs, axis: ladder.axis });
  assert.match(svg, /SGD per pack/);
  // Axis tick labels, so a position can be read off rather than guessed from a length.
  assert.match(svg, new RegExp(ladder.axis.min.toFixed(2)));
  assert.ok(!svg.includes('x="0" y="0" width="100%"'), 'nothing is drawn from the origin');
});

test('the structural observations describe the prices rather than diagnosing pressure', () => {
  const ladder = buildPriceLadder(all, config);
  const titles = ladder.insights.map((i) => i.title).join(' | ');
  // "Premium position under pressure" was inferred from Marlboro simply being a premium brand.
  assert.ok(!/under pressure/i.test(titles), titles);
  const premium = ladder.insights.find((i) => /above the highest observed JTI SKU/.test(i.title));
  if (premium) assert.match(premium.detail, /Descriptive only/);
});

/* ------------------------------------------- per-mapping competitor effects */

test('a competitor event reports an effect per mapped JTI SKU, not one blended index', () => {
  const moves = detectCompetitorMoves(all, data, config, NOW);
  const move = moves.find((m) => m.competitor_sku_id === 'sku-bat-pallmall-red');
  assert.ok(move, 'the seeded Pall Mall Red movement should be detected');

  assert.ok(move.per_sku.length >= 3, 'Winston, Camel and LD all map to Pall Mall Red');
  const indices = move.per_sku.map((r) => r.price_index);
  assert.ok(new Set(indices).size > 1, 'three price levels cannot share one index');

  // Each row is judged against its own corridor, and the corridors genuinely differ.
  const corridors = move.per_sku.map((r) => `${r.desired_price_index_min}-${r.desired_price_index_max}`);
  assert.ok(new Set(corridors).size > 1, corridors.join(' / '));
});

test('the blended headline index is gone from the event', () => {
  const move = detectCompetitorMoves(all, data, config, NOW)[0];
  assert.equal(move.new_price_index, undefined);
  assert.equal(move.new_gap, undefined);
});

test('the event is named as an observed movement, not a pricing decision', () => {
  const move = detectCompetitorMoves(all, data, config, NOW)[0];
  assert.match(move.label, /^Observed retail price movement for /);
});

test('the movement is measured on outlets observed in both periods', () => {
  const move = detectCompetitorMoves(all, data, config, NOW).find(
    (m) => m.competitor_sku_id === 'sku-bat-pallmall-red',
  );
  assert.ok(move.paired_outlets > 0);
  assert.ok(move.comparable_outlets >= move.paired_outlets);
  assert.equal(move.basis, 'outlets observed in both periods');
  assert.ok(Number.isFinite(move.paired_coverage_pct));
});

test('a change in which outlets were visited is not reported as a price movement', () => {
  // Every outlet holds its price exactly. The later period simply drops the two cheap shops,
  // which is what the old before-median vs after-median comparison read as a price rise.
  const observations = [
    competitorObs('out-1', 12.0, -40),
    competitorObs('out-2', 12.0, -40),
    competitorObs('out-3', 14.0, -40),
    competitorObs('out-4', 14.0, -40),
    competitorObs('out-3', 14.0, -1),
    competitorObs('out-4', 14.0, -1),
  ];
  const moves = detectCompetitorMoves(observations, { ...data, competitor_mappings: [] }, config, NOW);
  const move = moves.find((m) => m.competitor_sku_id === 'sku-bat-pallmall-red');

  // Naively this looks like +2.00; paired, nothing moved, so nothing is reported.
  assert.equal(move, undefined, 'a composition change must not surface as a movement');
});

/* --------------------------------------------------- the renamed axis */

test('the competitive axis is named for the intended position, not the raw comparison', () => {
  assert.equal(
    COMPETITIVE_BUCKET_LABELS[COMPETITIVE_BUCKET.JTI_EXPENSIVE],
    'Above intended relative position',
  );
  assert.equal(
    COMPETITIVE_BUCKET_LABELS[COMPETITIVE_BUCKET.JTI_CHEAPER],
    'Below intended relative position',
  );
  const labels = Object.values(COMPETITIVE_BUCKET_LABELS).join(' ');
  assert.ok(!/cheaper$|more expensive/.test(labels), labels);
});

test('the note explains why a cheaper JTI price can be above its intended position', () => {
  assert.match(RELATIVE_POSITION_NOTE, /below its competitor can[\s\S]*still be above/);
});

/* ------------------------------------------------------------- helpers */

function outletPrices(skuId, prices, overrides = {}) {
  const { offset = 0, ...rest } = overrides;
  return prices.map((price, i) => ({
    sku_id: skuId,
    sku_name: skuId,
    brand_name: 'Brand',
    company: 'JTI',
    is_jti: true,
    is_strategic: false,
    outlet_id: `out-${i + 1 + offset}`,
    confirmed_price: price,
    observed_at: NOW,
    recommended_min_snapshot: null,
    recommended_max_snapshot: null,
    recommended_price_snapshot: null,
    sticks_per_pack_snapshot: 20,
    pack_type_snapshot: 'Pack of 20',
    evaluation: null,
    ...rest,
  }));
}

function competitorObs(outletId, price, dayOffset) {
  return {
    sku_id: 'sku-bat-pallmall-red',
    sku_name: 'Pall Mall Red',
    brand_name: 'Pall Mall',
    company: 'British American Tobacco',
    is_jti: false,
    outlet_id: outletId,
    confirmed_price: price,
    observed_at: new Date(new Date(NOW).getTime() + dayOffset * 86400000).toISOString(),
  };
}
