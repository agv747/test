import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, OPPORTUNITY_CATEGORIES } from '../public/app/config.js';
import {
  calculateOpportunityPriority,
  canTransition,
  classifyOpportunity,
  isOpportunity,
  opportunityReason,
  suggestedAction,
} from '../public/app/services/opportunityService.js';
import { COMPETITIVE_BUCKET, RANGE_BUCKET } from '../public/app/services/pricePositionService.js';
import {
  resolveCompetitorMapping,
  listMappingsForSku,
} from '../public/app/services/competitorMappingService.js';

const config = defaultConfig();

test('a within-range, desired-position observation is not an opportunity', () => {
  assert.equal(
    isOpportunity({ rangeBucket: RANGE_BUCKET.WITHIN, competitive: { aligned: true } }),
    false,
  );
});

test('range deviation or competitive misalignment each create an opportunity', () => {
  assert.equal(isOpportunity({ rangeBucket: RANGE_BUCKET.ABOVE, competitive: { aligned: true } }), true);
  assert.equal(isOpportunity({ rangeBucket: RANGE_BUCKET.BELOW, competitive: { aligned: true } }), true);
  assert.equal(isOpportunity({ rangeBucket: RANGE_BUCKET.WITHIN, competitive: { aligned: false } }), true);
});

test('unknown competitive alignment alone does not create an opportunity', () => {
  assert.equal(
    isOpportunity({ rangeBucket: RANGE_BUCKET.WITHIN, competitive: { aligned: null } }),
    false,
  );
});

test('priority score rises with strategic weight, deviation, scale and persistence', () => {
  const light = calculateOpportunityPriority(
    { range_deviation_pct: 1, outlet_count: 1, days_open: 0 },
    config,
  );
  const heavy = calculateOpportunityPriority(
    {
      is_strategic: true,
      strategic_priority: 'High',
      range_deviation_pct: 6,
      price_index_deviation: 5,
      outlet_count: 20,
      days_open: 30,
      recent_competitor_move: true,
      unresolved_action: true,
      confidence: 0.95,
    },
    config,
  );
  assert.ok(heavy.score > light.score);
  assert.equal(heavy.label, 'High');
  assert.equal(light.label, 'Low');
});

test('severity components respect their configured caps', () => {
  const extreme = calculateOpportunityPriority(
    { range_deviation_pct: 999, price_index_deviation: 999, outlet_count: 9999, days_open: 9999 },
    config,
  );
  const w = config.priority_scoring;
  assert.equal(extreme.components.recommendedRangeSeverity, w.recommended_range_severity_cap);
  assert.equal(extreme.components.competitiveGapSeverity, w.competitive_gap_severity_cap);
  assert.equal(extreme.components.outletScale, w.outlet_scale_cap);
  assert.equal(extreme.components.persistence, w.persistence_cap);
});

test('low recognition confidence reduces the priority score', () => {
  const inputs = { is_strategic: true, strategic_priority: 'High', range_deviation_pct: 4 };
  const confident = calculateOpportunityPriority({ ...inputs, confidence: 0.95 }, config);
  const shaky = calculateOpportunityPriority({ ...inputs, confidence: 0.6 }, config);
  assert.ok(shaky.score < confident.score);
});

test('scoring thresholds are configuration-driven, not hard-coded', () => {
  const tuned = defaultConfig();
  tuned.priority_scoring.thresholds = { high: 5, medium: 1 };
  const result = calculateOpportunityPriority({ range_deviation_pct: 3 }, tuned);
  assert.equal(result.label, 'High');
});

test('classification prefers the most material category', () => {
  const evaluation = { rangeBucket: RANGE_BUCKET.ABOVE, competitive: { aligned: false } };
  assert.equal(
    classifyOpportunity({ evaluation, recent_competitor_move: true }),
    OPPORTUNITY_CATEGORIES.COMPETITOR_MOVE,
  );
  assert.equal(classifyOpportunity({ evaluation, persistent: true }), OPPORTUNITY_CATEGORIES.PERSISTENT);
  assert.equal(
    classifyOpportunity({ evaluation, high_dispersion: true }),
    OPPORTUNITY_CATEGORIES.DISPERSION,
  );
  assert.equal(classifyOpportunity({ evaluation }), OPPORTUNITY_CATEGORIES.COMPETITIVE_RISK);
  assert.equal(
    classifyOpportunity({
      evaluation: { rangeBucket: RANGE_BUCKET.ABOVE, competitive: { aligned: true } },
      is_strategic: true,
    }),
    OPPORTUNITY_CATEGORIES.STRATEGIC_RISK,
  );
});

test('opportunity language stays commercial, never compliance framing', () => {
  const reason = opportunityReason({
    is_strategic: true,
    competitive_bucket: COMPETITIVE_BUCKET.JTI_EXPENSIVE,
    range_bucket: RANGE_BUCKET.ABOVE,
    category: OPPORTUNITY_CATEGORIES.STRATEGIC_RISK,
  });
  assert.match(reason, /Strategic SKU/);
  assert.doesNotMatch(reason, /violation|non-compliant|illegal/i);
  assert.doesNotMatch(suggestedAction({ category: OPPORTUNITY_CATEGORIES.PERSISTENT }), /SGD|\$/);
});

test('opportunity lifecycle transitions are constrained', () => {
  assert.equal(canTransition('New', 'Acknowledged'), true);
  assert.equal(canTransition('In Progress', 'Resolved'), true);
  assert.equal(canTransition('New', 'Resolved'), false);
});

test('competitor mapping resolves the highest-priority active mapping', () => {
  const mappings = [
    {
      id: 'm-low',
      jti_sku_id: 'sku-1',
      competitor_sku_id: 'c-low',
      market: 'SG',
      mapping_priority: 10,
      effective_from: '2026-01-01',
      effective_to: null,
      active: true,
    },
    {
      id: 'm-high',
      jti_sku_id: 'sku-1',
      competitor_sku_id: 'c-high',
      market: 'SG',
      mapping_priority: 100,
      effective_from: '2026-01-01',
      effective_to: null,
      active: true,
    },
  ];
  const ctx = { market: 'SG' };
  const at = '2026-06-01';
  assert.equal(resolveCompetitorMapping(mappings, 'sku-1', ctx, at).id, 'm-high');
  assert.equal(listMappingsForSku(mappings, 'sku-1', ctx, at).length, 2);

  // A manager override picks a specific competitor SKU.
  assert.equal(resolveCompetitorMapping(mappings, 'sku-1', ctx, at, 'c-low').id, 'm-low');

  // Inactive mappings are ignored.
  const inactive = mappings.map((m) => (m.id === 'm-high' ? { ...m, active: false } : m));
  assert.equal(resolveCompetitorMapping(inactive, 'sku-1', ctx, at).id, 'm-low');
});
