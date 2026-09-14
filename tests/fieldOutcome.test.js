/**
 * Classifying what happened after an engagement (GM review §D).
 *
 * The screen reported 80%: four price changes in five engagements that had a subsequent
 * observation. Among those four was a price that moved further from where it was meant to
 * be. Beside the word "effectiveness", 80% reads as four successes out of five.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTCOME,
  classifyComponent,
  classifyOutcome,
  distanceOutside,
  movementSource,
  summariseOutcomes,
} from '../public/app/services/fieldOutcomeService.js';

/* ------------------------------------------------------- distance to the corridor */

test('distance is zero anywhere inside the intended interval', () => {
  assert.equal(distanceOutside(-0.5, -0.7, -0.4), 0);
  assert.equal(distanceOutside(-0.7, -0.7, -0.4), 0, 'the edges are inside');
  assert.equal(distanceOutside(-0.4, -0.7, -0.4), 0);
});

test('distance grows with the shortfall on either side', () => {
  assert.equal(distanceOutside(-0.9, -0.7, -0.4), 0.2);
  assert.equal(distanceOutside(-0.2, -0.7, -0.4), 0.2);
});

test('an open-ended interval is honoured on the side that is set', () => {
  assert.equal(distanceOutside(5, 10, null), 5);
  assert.equal(distanceOutside(15, 10, null), 0);
});

test('with no interval at all there is nothing to be outside of', () => {
  assert.equal(distanceOutside(1, null, null), null);
  assert.equal(distanceOutside(null, 1, 2), null);
});

/* ------------------------------------------------------------ the whole point */

test('a gap moving toward zero can be a price leaving its intended position', () => {
  // −0.60 → −0.20 is closer to zero and looks like progress on a "did the gap narrow" test.
  // The intended gap is −0.70 to −0.40, so the price has left the corridor.
  const result = classifyComponent(-0.6, -0.2, -0.7, -0.4);
  assert.equal(result.outcome, OUTCOME.WORSENED);
  assert.equal(result.before, 0);
  assert.equal(result.after, 0.2);
});

test('moving into the corridor is an improvement even when the gap widens', () => {
  const result = classifyComponent(-0.2, -0.5, -0.7, -0.4);
  assert.equal(result.outcome, OUTCOME.IMPROVED);
});

test('a move smaller than the tolerance is unchanged, not a tiny improvement', () => {
  // Floating-point equality would classify noise as movement.
  assert.equal(classifyComponent(-0.9, -0.895, -0.7, -0.4, 0.01).outcome, OUTCOME.UNCHANGED);
  assert.equal(classifyComponent(-0.9, -0.9, -0.7, -0.4).outcome, OUTCOME.UNCHANGED);
});

test('a pair with no interval to judge against is unclassified, not passed', () => {
  assert.equal(classifyComponent(-0.6, -0.2, null, null).outcome, OUTCOME.UNKNOWN);
});

/* ------------------------------------------------------------------- policy */

test('with nothing observed since, the outcome is awaiting — not a failure', () => {
  const result = classifyOutcome({ gap: -0.6 }, null, {});
  assert.equal(result.outcome, OUTCOME.AWAITING);
});

test('under "both", the less favourable of two disagreeing components is reported', () => {
  // Otherwise a pair that worsened on one measure gets filed as an improvement on the other.
  const snapshot = {
    desired_gap_min_snapshot: -0.7,
    desired_gap_max_snapshot: -0.4,
    desired_price_index_min_snapshot: 100,
    desired_price_index_max_snapshot: 103,
  };
  const result = classifyOutcome(
    { gap: -0.2, price_index: 101 },
    { gap: -0.5, price_index: 108 },
    snapshot,
    { comparisonMethod: 'both' },
  );
  assert.equal(result.components.gap.outcome, OUTCOME.IMPROVED);
  assert.equal(result.components.price_index.outcome, OUTCOME.WORSENED);
  assert.equal(result.outcome, OUTCOME.WORSENED);
  assert.match(result.policy_note, /less favourable result is reported/);
});

test('both components stay visible, so the combination can be checked', () => {
  const result = classifyOutcome(
    { gap: -0.6, price_index: 104 },
    { gap: -0.5, price_index: 102 },
    {
      desired_gap_min_snapshot: -0.7,
      desired_gap_max_snapshot: -0.4,
      desired_price_index_min_snapshot: 100,
      desired_price_index_max_snapshot: 103,
    },
    { comparisonMethod: 'both' },
  );
  assert.ok(result.components.gap);
  assert.ok(result.components.price_index);
});

test('a single-basis policy evaluates only that basis', () => {
  const result = classifyOutcome({ gap: -0.6 }, { gap: -0.5 }, {
    desired_gap_min_snapshot: -0.7,
    desired_gap_max_snapshot: -0.4,
  }, { comparisonMethod: 'gap' });
  assert.deepEqual(Object.keys(result.components), ['gap']);
});

/* ------------------------------------------------------------- who moved */

test('a narrowing gap is not evidence that JTI acted', () => {
  const before = { jti_price: 13.6, competitor_price: 13.0 };
  assert.equal(movementSource(before, { jti_price: 13.6, competitor_price: 13.3 }), 'competitor price moved');
  assert.equal(movementSource(before, { jti_price: 13.3, competitor_price: 13.0 }), 'JTI price moved');
  assert.equal(movementSource(before, { jti_price: 13.4, competitor_price: 13.2 }), 'both prices moved');
  assert.equal(movementSource(before, { jti_price: 13.6, competitor_price: 13.0 }), 'neither price moved');
});

/* ------------------------------------------------------------------ totals */

test('each outcome is reported against the denominator it belongs to', () => {
  const summary = summariseOutcomes([
    { outcome: OUTCOME.IMPROVED, any_price_change: true },
    { outcome: OUTCOME.WORSENED, any_price_change: true },
    { outcome: OUTCOME.UNCHANGED, any_price_change: false },
    { outcome: OUTCOME.AWAITING },
  ]);

  assert.equal(summary.engagements, 4);
  assert.equal(summary.with_subsequent_observation, 3);
  assert.equal(summary.awaiting_observation, 1);
  assert.deepEqual(summary.improved, { numerator: 1, denominator: 3, pct: 33.3 });
  assert.deepEqual(summary.worsened, { numerator: 1, denominator: 3, pct: 33.3 });
  assert.deepEqual(summary.any_price_change, { numerator: 2, denominator: 3, pct: 66.7 });
});

test('"any price change" is not the same question as "did it improve"', () => {
  // Two prices changed; one of them moved the wrong way. A single 67% would say otherwise.
  const summary = summariseOutcomes([
    { outcome: OUTCOME.IMPROVED, any_price_change: true },
    { outcome: OUTCOME.WORSENED, any_price_change: true },
    { outcome: OUTCOME.UNCHANGED, any_price_change: false },
  ]);
  assert.notEqual(summary.any_price_change.pct, summary.improved.pct);
});

test('nothing engaged means no rates rather than a zero', () => {
  const summary = summariseOutcomes([]);
  assert.equal(summary.improved.pct, null);
  assert.equal(summary.any_price_change.pct, null);
});
