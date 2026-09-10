/**
 * PricePositionService — the price-intelligence evaluation engine (§8.8, §8.9, §8.10, §24).
 *
 * IMPORTANT BUSINESS CONTEXT (§2): Singapore retail outlets independently determine their
 * final selling price. Nothing in this module classifies an outlet as non-compliant or as
 * having committed an offence. Statuses describe *observed market position* only.
 *
 * All functions are pure and operate on snapshots, so historical observations always keep
 * the thresholds that were effective when they were recorded (§25).
 */

import { PRICE_POSITION_STATUS, FIELD_RECOMMENDATIONS } from '../config.js';
import { round } from '../lib/stats.js';

/** Vertical axis of the Price Position Matrix. */
export const RANGE_BUCKET = {
  ABOVE: 'above',
  WITHIN: 'within',
  BELOW: 'below',
  UNKNOWN: 'unknown',
};

/** Horizontal axis of the Price Position Matrix. */
export const COMPETITIVE_BUCKET = {
  /** Competitor is cheaper — JTI is relatively expensive versus the desired position. */
  JTI_EXPENSIVE: 'jti_expensive',
  DESIRED: 'desired',
  /** Competitor is more expensive — JTI is relatively cheaper than desired. */
  JTI_CHEAPER: 'jti_cheaper',
  UNKNOWN: 'unknown',
};

/**
 * Business interpretation of each matrix cell (§9.2). Data-driven so it can be tuned
 * without touching UI code.
 */
export const MATRIX_INTERPRETATION = {
  [RANGE_BUCKET.ABOVE]: {
    [COMPETITIVE_BUCKET.JTI_EXPENSIVE]: { label: 'High Risk', tone: 'risk' },
    [COMPETITIVE_BUCKET.DESIRED]: { label: 'Review', tone: 'watch' },
    [COMPETITIVE_BUCKET.JTI_CHEAPER]: { label: 'Review', tone: 'watch' },
  },
  [RANGE_BUCKET.WITHIN]: {
    [COMPETITIVE_BUCKET.JTI_EXPENSIVE]: { label: 'Competitive Risk', tone: 'watch' },
    [COMPETITIVE_BUCKET.DESIRED]: { label: 'Ideal', tone: 'good' },
    [COMPETITIVE_BUCKET.JTI_CHEAPER]: { label: 'Strong Position', tone: 'good' },
  },
  [RANGE_BUCKET.BELOW]: {
    [COMPETITIVE_BUCKET.JTI_EXPENSIVE]: { label: 'Review', tone: 'watch' },
    [COMPETITIVE_BUCKET.DESIRED]: { label: 'Margin / Positioning Opportunity', tone: 'watch' },
    [COMPETITIVE_BUCKET.JTI_CHEAPER]: { label: 'Margin / Positioning Opportunity', tone: 'watch' },
  },
};

export const RANGE_BUCKET_LABELS = {
  [RANGE_BUCKET.ABOVE]: 'Above Recommended Range',
  [RANGE_BUCKET.WITHIN]: 'Within Recommended Range',
  [RANGE_BUCKET.BELOW]: 'Below Recommended Range',
  [RANGE_BUCKET.UNKNOWN]: 'No Recommendation Available',
};

export const COMPETITIVE_BUCKET_LABELS = {
  [COMPETITIVE_BUCKET.JTI_EXPENSIVE]: 'Competitor cheaper',
  [COMPETITIVE_BUCKET.DESIRED]: 'Desired competitive position',
  [COMPETITIVE_BUCKET.JTI_CHEAPER]: 'Competitor more expensive',
  [COMPETITIVE_BUCKET.UNKNOWN]: 'No comparable competitor observation',
};

/**
 * §8.8 — position of the confirmed observed price against the recommended range snapshot.
 * @param {number|null} confirmedPrice
 * @param {{recommended_min_snapshot:number|null, recommended_max_snapshot:number|null}} snapshot
 * @param {{confidence?:number|null, confidenceThreshold?:number, ruleConflict?:boolean}} opts
 */
export function calculateRecommendedRangeStatus(confirmedPrice, snapshot, opts = {}) {
  const { confidence = null, confidenceThreshold = 0, ruleConflict = false } = opts;

  if (ruleConflict) {
    return { bucket: RANGE_BUCKET.UNKNOWN, status: PRICE_POSITION_STATUS.REVIEW };
  }
  if (confidence !== null && confidenceThreshold && confidence < confidenceThreshold) {
    return { bucket: RANGE_BUCKET.UNKNOWN, status: PRICE_POSITION_STATUS.REVIEW };
  }
  const min = snapshot?.recommended_min_snapshot;
  const max = snapshot?.recommended_max_snapshot;
  if (
    confirmedPrice === null ||
    confirmedPrice === undefined ||
    min === null ||
    min === undefined ||
    max === null ||
    max === undefined
  ) {
    return { bucket: RANGE_BUCKET.UNKNOWN, status: PRICE_POSITION_STATUS.NONE };
  }
  if (confirmedPrice < min) {
    return { bucket: RANGE_BUCKET.BELOW, status: PRICE_POSITION_STATUS.BELOW };
  }
  if (confirmedPrice > max) {
    return { bucket: RANGE_BUCKET.ABOVE, status: PRICE_POSITION_STATUS.ABOVE };
  }
  return { bucket: RANGE_BUCKET.WITHIN, status: PRICE_POSITION_STATUS.WITHIN };
}

/** §24 — `jti_price - competitor_price`. */
export function calculatePriceGap(jtiPrice, competitorPrice) {
  if (!Number.isFinite(jtiPrice) || !Number.isFinite(competitorPrice)) return null;
  return round(jtiPrice - competitorPrice, 2);
}

/** §24 — `jti_price / competitor_price * 100`. 100 = parity. */
export function calculatePriceIndex(jtiPrice, competitorPrice) {
  if (!Number.isFinite(jtiPrice) || !Number.isFinite(competitorPrice)) return null;
  if (competitorPrice === 0) return null;
  return round((jtiPrice / competitorPrice) * 100, 1);
}

/**
 * §24 — competitive alignment against the desired gap / Price Index snapshot.
 *
 * comparison_method:
 *   'gap'          — only the desired gap range is evaluated
 *   'price_index'  — only the desired Price Index range is evaluated
 *   'both'         — aligned when EITHER measure is inside its desired range (spec §24:
 *                    "True if either"); the evaluated measures are reported so the UI can
 *                    show which one drove the outcome.
 *
 * @returns {{aligned:boolean|null, bucket:string, method:string, evaluated:string[], reason:string}}
 */
export function calculateCompetitiveAlignment(gap, index, snapshot, method = 'both') {
  const gapMin = snapshot?.desired_gap_min_snapshot;
  const gapMax = snapshot?.desired_gap_max_snapshot;
  const idxMin = snapshot?.desired_price_index_min_snapshot;
  const idxMax = snapshot?.desired_price_index_max_snapshot;

  const hasGapRule = gapMin !== null && gapMin !== undefined && gapMax !== null && gapMax !== undefined;
  const hasIdxRule = idxMin !== null && idxMin !== undefined && idxMax !== null && idxMax !== undefined;
  const effectiveMethod = snapshot?.comparison_method_snapshot || method;

  const useGap = hasGapRule && Number.isFinite(gap) && effectiveMethod !== 'price_index';
  const useIdx = hasIdxRule && Number.isFinite(index) && effectiveMethod !== 'gap';

  if (!useGap && !useIdx) {
    return {
      aligned: null,
      bucket: COMPETITIVE_BUCKET.UNKNOWN,
      method: effectiveMethod,
      evaluated: [],
      reason: 'No comparable competitor observation or no desired position configured',
    };
  }

  const evaluated = [];
  let gapAligned = null;
  let idxAligned = null;
  let bucket = COMPETITIVE_BUCKET.DESIRED;

  if (useIdx) {
    evaluated.push('price_index');
    idxAligned = index >= idxMin && index <= idxMax;
    if (index > idxMax) bucket = COMPETITIVE_BUCKET.JTI_EXPENSIVE;
    else if (index < idxMin) bucket = COMPETITIVE_BUCKET.JTI_CHEAPER;
  }
  if (useGap) {
    evaluated.push('gap');
    gapAligned = gap >= gapMin && gap <= gapMax;
    if (!useIdx) {
      if (gap > gapMax) bucket = COMPETITIVE_BUCKET.JTI_EXPENSIVE;
      else if (gap < gapMin) bucket = COMPETITIVE_BUCKET.JTI_CHEAPER;
    }
  }

  let aligned;
  if (effectiveMethod === 'gap') aligned = gapAligned;
  else if (effectiveMethod === 'price_index') aligned = idxAligned;
  else aligned = Boolean(gapAligned) || Boolean(idxAligned);

  if (aligned) bucket = COMPETITIVE_BUCKET.DESIRED;

  return {
    aligned,
    bucket,
    method: effectiveMethod,
    evaluated,
    gapAligned,
    indexAligned: idxAligned,
    reason: aligned
      ? 'Within desired competitive position'
      : bucket === COMPETITIVE_BUCKET.JTI_EXPENSIVE
        ? 'JTI is relatively more expensive than the desired position'
        : 'JTI is relatively cheaper than the desired position',
  };
}

/**
 * Combines range status + competitive alignment into the headline commercial status
 * shown to the field user (§3 allowed statuses only).
 */
export function headlineStatus(rangeResult, competitive) {
  if (rangeResult.status === PRICE_POSITION_STATUS.REVIEW) return PRICE_POSITION_STATUS.REVIEW;
  if (competitive.aligned === false && competitive.bucket === COMPETITIVE_BUCKET.JTI_EXPENSIVE) {
    return PRICE_POSITION_STATUS.AT_RISK;
  }
  if (
    rangeResult.bucket === RANGE_BUCKET.WITHIN &&
    competitive.aligned === false &&
    competitive.bucket === COMPETITIVE_BUCKET.JTI_CHEAPER
  ) {
    return PRICE_POSITION_STATUS.STRONG;
  }
  return rangeResult.status;
}

/**
 * §8.10 — immediate field recommendation. Advisory only: the tool never calculates or
 * approves trade-investment amounts (§5.7).
 */
export function fieldRecommendation(evaluation, context = {}) {
  const { hasOpenFollowUp = false, recentCompetitorMove = false } = context;
  if (hasOpenFollowUp) return FIELD_RECOMMENDATIONS.FOLLOW_UP;
  if (evaluation.status === PRICE_POSITION_STATUS.REVIEW) return FIELD_RECOMMENDATIONS.MONITOR;

  if (recentCompetitorMove && evaluation.competitive.aligned === false) {
    return FIELD_RECOMMENDATIONS.REVIEW_COMPETITIVE;
  }
  if (evaluation.competitive.bucket === COMPETITIVE_BUCKET.JTI_EXPENSIVE) {
    return evaluation.isStrategic ? FIELD_RECOMMENDATIONS.ENGAGE : FIELD_RECOMMENDATIONS.MONITOR;
  }
  if (evaluation.rangeBucket === RANGE_BUCKET.ABOVE) {
    return FIELD_RECOMMENDATIONS.ENGAGE;
  }
  if (evaluation.rangeBucket === RANGE_BUCKET.BELOW) {
    return evaluation.isStrategic
      ? FIELD_RECOMMENDATIONS.REVIEW_INVESTMENT
      : FIELD_RECOMMENDATIONS.MONITOR;
  }
  if (evaluation.competitive.aligned === false) return FIELD_RECOMMENDATIONS.REVIEW_COMPETITIVE;
  return FIELD_RECOMMENDATIONS.NONE;
}

/**
 * Full evaluation of one JTI observation against its snapshots.
 *
 * @param {object} params
 * @param {number} params.confirmedPrice
 * @param {number|null} params.competitorPrice
 * @param {object} params.ruleSnapshot
 * @param {object} params.mappingSnapshot
 * @param {number|null} params.confidence
 * @param {number} params.confidenceThreshold
 * @param {boolean} params.isStrategic
 * @param {string} params.comparisonMethod
 */
export function evaluateObservation({
  confirmedPrice,
  competitorPrice = null,
  ruleSnapshot = {},
  mappingSnapshot = {},
  confidence = null,
  confidenceThreshold = 0,
  isStrategic = false,
  comparisonMethod = 'both',
  ruleConflict = false,
}) {
  const rangeResult = calculateRecommendedRangeStatus(confirmedPrice, ruleSnapshot, {
    confidence,
    confidenceThreshold,
    ruleConflict,
  });
  const gap = calculatePriceGap(confirmedPrice, competitorPrice);
  const index = calculatePriceIndex(confirmedPrice, competitorPrice);
  const competitive = calculateCompetitiveAlignment(gap, index, mappingSnapshot, comparisonMethod);

  const evaluation = {
    rangeBucket: rangeResult.bucket,
    rangeStatus: rangeResult.status,
    gap,
    priceIndex: index,
    competitive,
    isStrategic,
    recommendedPrice: ruleSnapshot?.recommended_price_snapshot ?? null,
    recommendedMin: ruleSnapshot?.recommended_min_snapshot ?? null,
    recommendedMax: ruleSnapshot?.recommended_max_snapshot ?? null,
  };
  evaluation.status = headlineStatus(rangeResult, competitive);
  evaluation.matrixCell =
    evaluation.rangeBucket === RANGE_BUCKET.UNKNOWN ||
    competitive.bucket === COMPETITIVE_BUCKET.UNKNOWN
      ? null
      : MATRIX_INTERPRETATION[evaluation.rangeBucket][competitive.bucket];
  return evaluation;
}

/** Deviation from the recommended range, as an absolute amount and a percentage. */
export function rangeDeviation(confirmedPrice, ruleSnapshot) {
  const min = ruleSnapshot?.recommended_min_snapshot;
  const max = ruleSnapshot?.recommended_max_snapshot;
  const ref = ruleSnapshot?.recommended_price_snapshot;
  if (!Number.isFinite(confirmedPrice) || min == null || max == null) return { abs: 0, pct: 0 };
  let abs = 0;
  if (confirmedPrice < min) abs = confirmedPrice - min;
  else if (confirmedPrice > max) abs = confirmedPrice - max;
  const base = Number.isFinite(ref) && ref > 0 ? ref : (min + max) / 2;
  return { abs: round(abs, 2), pct: base ? round((abs / base) * 100, 2) : 0 };
}

/** Distance (in index points) from the desired Price Index band; 0 when inside. */
export function priceIndexDeviation(index, mappingSnapshot) {
  const min = mappingSnapshot?.desired_price_index_min_snapshot;
  const max = mappingSnapshot?.desired_price_index_max_snapshot;
  if (!Number.isFinite(index) || min == null || max == null) return 0;
  if (index < min) return round(index - min, 1);
  if (index > max) return round(index - max, 1);
  return 0;
}
