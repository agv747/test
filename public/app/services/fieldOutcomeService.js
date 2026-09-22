/**
 * What happened after a field engagement, classified rather than counted (GM review §D).
 *
 * The screen reported 80%. It meant four price changes in five engagements that had a
 * subsequent observation — and among those four was a price that moved further from where
 * it was meant to be. Presented beside the word "effectiveness", 80% reads as four successes
 * out of five. It is not a success rate, and it is not a rate of anything caused by the
 * visit.
 *
 * So a sequence is now classified into one of four outcomes, each reported with its own
 * numerator and denominator:
 *
 *   improved    the price moved closer to the intended position
 *   worsened    it moved away from it
 *   unchanged   it moved by less than the tolerance, or not at all
 *   awaiting    nothing has been observed since the engagement
 *
 * "Any observed price change" survives as a plain descriptive count, because it is a fact
 * about the shelf. It is simply not the same question.
 */

import { round } from '../lib/stats.js';

export const OUTCOME = {
  IMPROVED: 'improved',
  WORSENED: 'worsened',
  UNCHANGED: 'unchanged',
  AWAITING: 'awaiting',
  UNKNOWN: 'unknown',
};

export const OUTCOME_LABEL = {
  [OUTCOME.IMPROVED]: 'Position improved',
  [OUTCOME.WORSENED]: 'Position worsened',
  [OUTCOME.UNCHANGED]: 'Position unchanged',
  [OUTCOME.AWAITING]: 'Awaiting a subsequent observation',
  [OUTCOME.UNKNOWN]: 'Cannot be classified',
};

/**
 * How far a value sits outside its intended interval.
 *
 * For a value x and an interval [L, U], distance = max(L − x, 0, x − U): zero anywhere
 * inside, and growing with the shortfall on either side.
 *
 * This is the whole point of the rewrite. A gap that moves from −0.60 to −0.20 is closer to
 * zero, and on a "did the gap narrow" test that looks like progress — but if the intended
 * gap is −0.70 to −0.40, the price has left the corridor it was supposed to be in. Improvement
 * means this distance fell, not that the absolute number got smaller.
 */
export function distanceOutside(value, min, max) {
  if (!Number.isFinite(value)) return null;
  const lower = Number.isFinite(min) ? min : null;
  const upper = Number.isFinite(max) ? max : null;
  if (lower === null && upper === null) return null;

  const below = lower === null ? 0 : Math.max(lower - value, 0);
  const above = upper === null ? 0 : Math.max(value - upper, 0);
  return round(Math.max(below, above), 4);
}

/**
 * Classifies one before/after pair on one comparison basis.
 *
 * @returns {{outcome: string, before: number|null, after: number|null, change: number|null}}
 */
export function classifyComponent(beforeValue, afterValue, min, max, tolerance = 0.01) {
  const before = distanceOutside(beforeValue, min, max);
  const after = distanceOutside(afterValue, min, max);
  if (before === null || after === null) {
    return { outcome: OUTCOME.UNKNOWN, before, after, change: null };
  }

  const change = round(after - before, 4);
  if (Math.abs(change) <= tolerance) {
    return { outcome: OUTCOME.UNCHANGED, before, after, change };
  }
  return { outcome: change < 0 ? OUTCOME.IMPROVED : OUTCOME.WORSENED, before, after, change };
}

/**
 * Classifies a sequence on the configured comparison basis.
 *
 * Under `both`, the two components are reported side by side and combined by an explicit,
 * stated policy — the stricter reading wins, so a pair that improved on one measure and
 * worsened on the other is not quietly filed as an improvement. The components stay visible
 * so the combination can be checked rather than trusted.
 */
export function classifyOutcome(before, after, snapshot, options = {}) {
  const { comparisonMethod = 'both', tolerance = 0.01, indexTolerance = 0.1 } = options;

  if (!after) return { outcome: OUTCOME.AWAITING, components: {}, policy: comparisonMethod };

  const components = {};
  if (comparisonMethod === 'gap' || comparisonMethod === 'both') {
    components.gap = classifyComponent(
      before.gap,
      after.gap,
      snapshot?.desired_gap_min_snapshot,
      snapshot?.desired_gap_max_snapshot,
      tolerance,
    );
  }
  if (comparisonMethod === 'price_index' || comparisonMethod === 'both') {
    components.price_index = classifyComponent(
      before.price_index,
      after.price_index,
      snapshot?.desired_price_index_min_snapshot,
      snapshot?.desired_price_index_max_snapshot,
      indexTolerance,
    );
  }

  const outcomes = Object.values(components)
    .map((c) => c.outcome)
    .filter((o) => o !== OUTCOME.UNKNOWN);

  if (!outcomes.length) return { outcome: OUTCOME.UNKNOWN, components, policy: comparisonMethod };

  // Stated policy: worsened beats unchanged beats improved. The more favourable of two
  // disagreeing components is never the one reported.
  const outcome = outcomes.includes(OUTCOME.WORSENED)
    ? OUTCOME.WORSENED
    : outcomes.includes(OUTCOME.UNCHANGED)
      ? OUTCOME.UNCHANGED
      : OUTCOME.IMPROVED;

  return {
    outcome,
    components,
    policy: comparisonMethod,
    policy_note:
      comparisonMethod === 'both'
        ? 'Gap and Price Index are both evaluated; where they disagree the less favourable result is reported.'
        : null,
  };
}

/** Which side of the pair moved. A narrowing gap is not evidence that JTI acted. */
export function movementSource(before, after, tolerance = 0.01) {
  const jtiMoved =
    Number.isFinite(before?.jti_price) &&
    Number.isFinite(after?.jti_price) &&
    Math.abs(after.jti_price - before.jti_price) > tolerance;
  const competitorMoved =
    Number.isFinite(before?.competitor_price) &&
    Number.isFinite(after?.competitor_price) &&
    Math.abs(after.competitor_price - before.competitor_price) > tolerance;

  if (jtiMoved && competitorMoved) return 'both prices moved';
  if (jtiMoved) return 'JTI price moved';
  if (competitorMoved) return 'competitor price moved';
  return 'neither price moved';
}

/** Counts of each outcome, each carrying the denominator it belongs to. */
export function summariseOutcomes(entries) {
  const total = entries.length;
  const observed = entries.filter((e) => e.outcome !== OUTCOME.AWAITING);
  const count = (outcome) => entries.filter((e) => e.outcome === outcome).length;

  const share = (n, d) => ({ numerator: n, denominator: d, pct: d ? round((n / d) * 100, 1) : null });

  return {
    engagements: total,
    awaiting_observation: count(OUTCOME.AWAITING),
    with_subsequent_observation: observed.length,
    improved: share(count(OUTCOME.IMPROVED), observed.length),
    unchanged: share(count(OUTCOME.UNCHANGED), observed.length),
    worsened: share(count(OUTCOME.WORSENED), observed.length),
    unclassified: share(count(OUTCOME.UNKNOWN), observed.length),
    any_price_change: share(
      observed.filter((e) => e.any_price_change).length,
      observed.length,
    ),
  };
}
