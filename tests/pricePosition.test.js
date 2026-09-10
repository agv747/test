import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICE_POSITION_STATUS, FIELD_RECOMMENDATIONS } from '../public/app/config.js';
import {
  COMPETITIVE_BUCKET,
  MATRIX_INTERPRETATION,
  RANGE_BUCKET,
  calculateCompetitiveAlignment,
  calculatePriceGap,
  calculatePriceIndex,
  calculateRecommendedRangeStatus,
  evaluateObservation,
  fieldRecommendation,
  priceIndexDeviation,
  rangeDeviation,
} from '../public/app/services/pricePositionService.js';

const ruleSnapshot = {
  recommended_price_snapshot: 13.7,
  recommended_min_snapshot: 13.5,
  recommended_max_snapshot: 13.9,
};

const mappingSnapshot = {
  desired_gap_min_snapshot: 0.0,
  desired_gap_max_snapshot: 0.3,
  desired_price_index_min_snapshot: 100,
  desired_price_index_max_snapshot: 103,
};

test('recommended range status classifies below / within / above', () => {
  assert.equal(calculateRecommendedRangeStatus(13.4, ruleSnapshot).status, PRICE_POSITION_STATUS.BELOW);
  assert.equal(calculateRecommendedRangeStatus(13.7, ruleSnapshot).status, PRICE_POSITION_STATUS.WITHIN);
  assert.equal(calculateRecommendedRangeStatus(14.4, ruleSnapshot).status, PRICE_POSITION_STATUS.ABOVE);
});

test('range boundaries are inclusive', () => {
  assert.equal(calculateRecommendedRangeStatus(13.5, ruleSnapshot).bucket, RANGE_BUCKET.WITHIN);
  assert.equal(calculateRecommendedRangeStatus(13.9, ruleSnapshot).bucket, RANGE_BUCKET.WITHIN);
});

test('missing recommendation yields No Recommendation Available, not a deviation', () => {
  const result = calculateRecommendedRangeStatus(13.7, {
    recommended_min_snapshot: null,
    recommended_max_snapshot: null,
  });
  assert.equal(result.status, PRICE_POSITION_STATUS.NONE);
  assert.equal(result.bucket, RANGE_BUCKET.UNKNOWN);
});

test('low recognition confidence routes to Review Required', () => {
  const result = calculateRecommendedRangeStatus(14.4, ruleSnapshot, {
    confidence: 0.6,
    confidenceThreshold: 0.75,
  });
  assert.equal(result.status, PRICE_POSITION_STATUS.REVIEW);
});

test('price gap and price index formulas', () => {
  assert.equal(calculatePriceGap(13.7, 13.5), 0.2);
  assert.equal(calculatePriceGap(13.5, 13.7), -0.2);
  assert.equal(calculatePriceIndex(13.7, 13.5), 101.5);
  assert.equal(calculatePriceIndex(13.7, 13.7), 100);
  assert.equal(calculatePriceIndex(13.7, null), null);
  assert.equal(calculatePriceIndex(13.7, 0), null);
});

test('competitive alignment: inside desired band', () => {
  const gap = calculatePriceGap(13.7, 13.5);
  const idx = calculatePriceIndex(13.7, 13.5);
  const result = calculateCompetitiveAlignment(gap, idx, mappingSnapshot, 'both');
  assert.equal(result.aligned, true);
  assert.equal(result.bucket, COMPETITIVE_BUCKET.DESIRED);
});

test('competitive alignment: JTI too expensive relative to competitor', () => {
  const gap = calculatePriceGap(14.4, 13.5);
  const idx = calculatePriceIndex(14.4, 13.5);
  const result = calculateCompetitiveAlignment(gap, idx, mappingSnapshot, 'both');
  assert.equal(result.aligned, false);
  assert.equal(result.bucket, COMPETITIVE_BUCKET.JTI_EXPENSIVE);
});

test('competitive alignment: JTI cheaper than desired position', () => {
  const gap = calculatePriceGap(13.0, 13.5);
  const idx = calculatePriceIndex(13.0, 13.5);
  const result = calculateCompetitiveAlignment(gap, idx, mappingSnapshot, 'both');
  assert.equal(result.aligned, false);
  assert.equal(result.bucket, COMPETITIVE_BUCKET.JTI_CHEAPER);
});

test('comparison_method restricts which measure is evaluated', () => {
  // Gap inside 0..0.30 but index outside 100..103.
  const snapshot = { ...mappingSnapshot, desired_price_index_max_snapshot: 101 };
  const gapOnly = calculateCompetitiveAlignment(0.2, 101.5, snapshot, 'gap');
  assert.equal(gapOnly.aligned, true);
  assert.deepEqual(gapOnly.evaluated, ['gap']);

  const indexOnly = calculateCompetitiveAlignment(0.2, 101.5, snapshot, 'price_index');
  assert.equal(indexOnly.aligned, false);
  assert.deepEqual(indexOnly.evaluated, ['price_index']);

  // 'both' is an OR per §24.
  const both = calculateCompetitiveAlignment(0.2, 101.5, snapshot, 'both');
  assert.equal(both.aligned, true);
});

test('mapping snapshot comparison_method overrides the global default', () => {
  const snapshot = {
    ...mappingSnapshot,
    desired_price_index_max_snapshot: 101,
    comparison_method_snapshot: 'price_index',
  };
  assert.equal(calculateCompetitiveAlignment(0.2, 101.5, snapshot, 'both').aligned, false);
});

test('no competitor observation yields unknown alignment, never a false negative', () => {
  const result = calculateCompetitiveAlignment(null, null, mappingSnapshot, 'both');
  assert.equal(result.aligned, null);
  assert.equal(result.bucket, COMPETITIVE_BUCKET.UNKNOWN);
});

test('evaluateObservation produces the full evaluation and matrix cell', () => {
  const evaluation = evaluateObservation({
    confirmedPrice: 13.7,
    competitorPrice: 13.5,
    ruleSnapshot,
    mappingSnapshot,
    confidence: 0.97,
    confidenceThreshold: 0.75,
  });
  assert.equal(evaluation.rangeBucket, RANGE_BUCKET.WITHIN);
  assert.equal(evaluation.priceIndex, 101.5);
  assert.equal(evaluation.gap, 0.2);
  assert.equal(evaluation.status, PRICE_POSITION_STATUS.WITHIN);
  assert.equal(evaluation.matrixCell.label, 'Ideal');
});

test('headline status flags Competitive Position At Risk when JTI is relatively expensive', () => {
  const evaluation = evaluateObservation({
    confirmedPrice: 13.8,
    competitorPrice: 13.0,
    ruleSnapshot,
    mappingSnapshot,
    confidence: 0.95,
    confidenceThreshold: 0.75,
  });
  assert.equal(evaluation.rangeBucket, RANGE_BUCKET.WITHIN);
  assert.equal(evaluation.status, PRICE_POSITION_STATUS.AT_RISK);
  assert.equal(evaluation.matrixCell.label, 'Competitive Risk');
});

test('matrix interpretation covers all nine cells', () => {
  const rows = [RANGE_BUCKET.ABOVE, RANGE_BUCKET.WITHIN, RANGE_BUCKET.BELOW];
  const cols = [
    COMPETITIVE_BUCKET.JTI_EXPENSIVE,
    COMPETITIVE_BUCKET.DESIRED,
    COMPETITIVE_BUCKET.JTI_CHEAPER,
  ];
  for (const r of rows) {
    for (const c of cols) {
      assert.ok(MATRIX_INTERPRETATION[r][c].label, `${r}/${c} must have a label`);
    }
  }
  assert.equal(MATRIX_INTERPRETATION[RANGE_BUCKET.ABOVE][COMPETITIVE_BUCKET.JTI_EXPENSIVE].label, 'High Risk');
  assert.equal(MATRIX_INTERPRETATION[RANGE_BUCKET.WITHIN][COMPETITIVE_BUCKET.DESIRED].label, 'Ideal');
});

test('field recommendation never prescribes an incentive amount', () => {
  const evaluation = evaluateObservation({
    confirmedPrice: 14.6,
    competitorPrice: 13.5,
    ruleSnapshot,
    mappingSnapshot,
    confidence: 0.95,
    confidenceThreshold: 0.75,
    isStrategic: true,
  });
  const rec = fieldRecommendation({ ...evaluation, isStrategic: true }, {});
  assert.equal(rec, FIELD_RECOMMENDATIONS.ENGAGE);
  assert.ok(!/\d/.test(rec), 'recommendation text must not contain an amount');
});

test('an open follow-up takes precedence in the field recommendation', () => {
  const evaluation = evaluateObservation({
    confirmedPrice: 13.7,
    competitorPrice: 13.5,
    ruleSnapshot,
    mappingSnapshot,
  });
  assert.equal(
    fieldRecommendation(evaluation, { hasOpenFollowUp: true }),
    FIELD_RECOMMENDATIONS.FOLLOW_UP,
  );
});

test('deviation helpers measure distance outside the range only', () => {
  assert.equal(rangeDeviation(13.7, ruleSnapshot).abs, 0);
  assert.equal(rangeDeviation(14.4, ruleSnapshot).abs, 0.5);
  assert.equal(rangeDeviation(13.2, ruleSnapshot).abs, -0.3);
  assert.equal(priceIndexDeviation(101.5, mappingSnapshot), 0);
  assert.equal(priceIndexDeviation(106, mappingSnapshot), 3);
  assert.equal(priceIndexDeviation(97, mappingSnapshot), -3);
});
