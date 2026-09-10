/**
 * OpportunityService — turns evaluated observations into prioritised commercial
 * opportunities (§10, §17).
 *
 * Terminology note (§3): these are *Pricing Opportunities*, never "violations" or
 * "non-compliant outlets". A price outside the JTI recommended range is a market signal.
 */

import { OPPORTUNITY_CATEGORIES } from '../config.js';
import { clamp, round } from '../lib/stats.js';
import { daysBetween } from '../lib/dates.js';
import { COMPETITIVE_BUCKET, RANGE_BUCKET } from './pricePositionService.js';

/**
 * §17 — configurable priority score.
 *
 *   Priority Score = Strategic Weight
 *                  + Competitive Gap Severity
 *                  + Recommended Range Severity
 *                  + Persistence
 *                  + Outlet Scale
 *                  + Competitor Move Weight
 *                  + Unresolved Field Action
 *                  − Low Data Confidence Penalty
 *
 * All weights, per-unit rates, caps and High/Medium thresholds come from config so Admin
 * can tune them without a code change.
 *
 * @returns {{score:number, label:'High'|'Medium'|'Low', components:object}}
 */
export function calculateOpportunityPriority(inputs, config) {
  const w = config.priority_scoring;
  const {
    strategic_priority = null,
    is_strategic = false,
    range_deviation_pct = 0,
    price_index_deviation = 0,
    outlet_count = 1,
    days_open = 0,
    recent_competitor_move = false,
    confidence = null,
    unresolved_action = false,
  } = inputs;

  const strategicKey = is_strategic && strategic_priority ? strategic_priority : 'none';
  const strategic = w.strategic_weight[strategicKey] ?? 0;

  const rangeSeverity = clamp(
    Math.abs(range_deviation_pct) * w.recommended_range_severity_per_pct,
    0,
    w.recommended_range_severity_cap,
  );
  const competitiveSeverity = clamp(
    Math.abs(price_index_deviation) * w.competitive_gap_severity_per_index_point,
    0,
    w.competitive_gap_severity_cap,
  );
  const outletScale = clamp(
    Math.max(0, outlet_count - 1) * w.outlet_scale_per_outlet,
    0,
    w.outlet_scale_cap,
  );
  const persistence = clamp(Math.max(0, days_open) * w.persistence_per_day, 0, w.persistence_cap);
  const competitorMove = recent_competitor_move ? w.competitor_move_weight : 0;
  const unresolved = unresolved_action ? w.unresolved_action_weight : 0;
  const lowConfidence =
    confidence !== null && confidence < 0.75 ? -Math.abs(w.low_confidence_penalty) : 0;

  const components = {
    strategic,
    recommendedRangeSeverity: round(rangeSeverity, 1),
    competitiveGapSeverity: round(competitiveSeverity, 1),
    outletScale: round(outletScale, 1),
    persistence: round(persistence, 1),
    competitorMove,
    unresolvedAction: unresolved,
    lowConfidencePenalty: lowConfidence,
  };

  const score = round(
    Math.max(0, Object.values(components).reduce((a, b) => a + b, 0)),
    1,
  );

  const label = score >= w.thresholds.high ? 'High' : score >= w.thresholds.medium ? 'Medium' : 'Low';
  return { score, label, components };
}

/**
 * §10 — assigns the opportunity category. The first matching rule wins, most commercially
 * material first.
 */
export function classifyOpportunity(ctx) {
  const {
    evaluation,
    is_strategic = false,
    recent_competitor_move = false,
    persistent = false,
    high_dispersion = false,
  } = ctx;

  if (recent_competitor_move) return OPPORTUNITY_CATEGORIES.COMPETITOR_MOVE;
  if (persistent) return OPPORTUNITY_CATEGORIES.PERSISTENT;
  if (high_dispersion) return OPPORTUNITY_CATEGORIES.DISPERSION;
  if (evaluation.competitive.aligned === false) return OPPORTUNITY_CATEGORIES.COMPETITIVE_RISK;
  if (evaluation.rangeBucket === RANGE_BUCKET.ABOVE || evaluation.rangeBucket === RANGE_BUCKET.BELOW) {
    return is_strategic
      ? OPPORTUNITY_CATEGORIES.STRATEGIC_RISK
      : OPPORTUNITY_CATEGORIES.RECOMMENDED_DEVIATION;
  }
  return null;
}

/**
 * Decides whether an evaluated observation warrants an opportunity at all.
 * Within-range + desired competitive position = no opportunity.
 */
export function isOpportunity(evaluation) {
  if (evaluation.rangeBucket === RANGE_BUCKET.ABOVE) return true;
  if (evaluation.rangeBucket === RANGE_BUCKET.BELOW) return true;
  if (evaluation.competitive.aligned === false) return true;
  return false;
}

/** §24 — persistent deviation test. */
export function isPersistent(history, config, now) {
  const { min_consecutive_visits, min_days_open } = config.persistence;
  const deviating = history.filter((h) => h.deviating);
  if (deviating.length >= min_consecutive_visits) {
    const consecutive = countTrailingConsecutive(history);
    if (consecutive >= min_consecutive_visits) return true;
  }
  const first = deviating[0];
  if (first) {
    const open = daysBetween(first.observed_at, now);
    if (open !== null && open >= min_days_open) return true;
  }
  return false;
}

function countTrailingConsecutive(history) {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].deviating) count += 1;
    else break;
  }
  return count;
}

/** Lifecycle transitions permitted from a given status (§10). */
export const OPPORTUNITY_TRANSITIONS = {
  New: ['Acknowledged', 'In Progress', 'Closed — No Action'],
  Acknowledged: ['In Progress', 'Monitoring', 'Closed — No Action'],
  'In Progress': ['Monitoring', 'Resolved', 'Closed — No Action'],
  Monitoring: ['In Progress', 'Resolved', 'Closed — No Action'],
  Resolved: ['Monitoring'],
  'Closed — No Action': ['New'],
};

export function canTransition(from, to) {
  return (OPPORTUNITY_TRANSITIONS[from] ?? []).includes(to);
}

/** Human-readable reason string for the Top Opportunities panel (§9.3). */
export function opportunityReason(opportunity) {
  const parts = [];
  if (opportunity.is_strategic) parts.push('Strategic SKU');
  if (opportunity.competitive_bucket === COMPETITIVE_BUCKET.JTI_EXPENSIVE) {
    parts.push('competitor cheaper');
  } else if (opportunity.competitive_bucket === COMPETITIVE_BUCKET.JTI_CHEAPER) {
    parts.push('competitor more expensive');
  }
  if (opportunity.range_bucket === RANGE_BUCKET.ABOVE) parts.push('above recommended range');
  if (opportunity.range_bucket === RANGE_BUCKET.BELOW) parts.push('below recommended range');
  if (opportunity.category === OPPORTUNITY_CATEGORIES.PERSISTENT) {
    parts.push(`open ${opportunity.days_open} days`);
  }
  if (opportunity.category === OPPORTUNITY_CATEGORIES.COMPETITOR_MOVE) {
    parts.push('recent competitor move');
  }
  if (opportunity.category === OPPORTUNITY_CATEGORIES.DISPERSION) parts.push('high price dispersion');
  return parts.length ? parts.join(' + ') : 'Price position review';
}

/** Suggested next step — advisory, never an incentive amount (§5.7, §33). */
export function suggestedAction(opportunity) {
  switch (opportunity.category) {
    case OPPORTUNITY_CATEGORIES.COMPETITOR_MOVE:
      return 'Review competitive position';
    case OPPORTUNITY_CATEGORIES.PERSISTENT:
      return 'Territory follow-up';
    case OPPORTUNITY_CATEGORIES.DISPERSION:
      return 'Review price dispersion across outlets';
    case OPPORTUNITY_CATEGORIES.STRATEGIC_RISK:
      return 'Prioritise outlet engagement';
    case OPPORTUNITY_CATEGORIES.COMPETITIVE_RISK:
      return 'Prioritise outlet engagement';
    default:
      return 'Discuss recommended price position with outlet';
  }
}
