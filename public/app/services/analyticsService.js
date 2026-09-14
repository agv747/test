/**
 * AnalyticsService — joins raw entities into evaluated observation views and derives every
 * manager metric (§9, §11, §12, §13, §14, §15, §24).
 *
 * Historical integrity (§25): evaluation always uses the rule / mapping SNAPSHOTS stored on
 * the observation. Master data is used only for labels (names, strategic flags) and for the
 * explicit "restate using current rules" analysis.
 */

import { OPPORTUNITY_CATEGORIES } from '../config.js';
import { describe, histogram, median, round } from '../lib/stats.js';
import { daysBetween, freshnessLabel, periodKey, toDate } from '../lib/dates.js';
import {
  COMPETITIVE_BUCKET,
  RANGE_BUCKET,
  evaluateObservation,
} from './pricePositionService.js';
import {
  calculateOpportunityPriority,
  classifyOpportunity,
  isOpportunity,
  opportunityReason,
  suggestedAction,
} from './opportunityService.js';
import { rangeDeviation, priceIndexDeviation } from './pricePositionService.js';
import { applySnapshot, supersededByPending } from './snapshotService.js';
import { buildSignals } from './signalService.js';
import { OUTCOME, classifyOutcome, movementSource, summariseOutcomes } from './fieldOutcomeService.js';
import { calculateCoverage, outletsInScope } from './coverageService.js';

function indexBy(list, key = 'id') {
  const map = new Map();
  for (const item of list) map.set(item[key], item);
  return map;
}

/**
 * Finds the competitor observation to compare a JTI observation against.
 * Preference order: same visit → same outlet, most recent within lookback → territory
 * median within lookback (flagged as a fallback so the UI can warn about freshness §26).
 */
export function resolveCompetitorObservation(jtiObs, competitorSkuId, observations, config) {
  if (!competitorSkuId) return null;
  const lookback = config.competitor_move.lookback_days;
  const observedAt = toDate(jtiObs.observed_at);

  const relevant = observations.filter(
    (o) =>
      o.sku_id === competitorSkuId &&
      !o.excluded &&
      toDate(o.observed_at) <= observedAt &&
      (daysBetween(o.observed_at, observedAt) ?? Infinity) <= lookback,
  );
  if (!relevant.length) return null;

  const sameVisit = relevant.find((o) => o.visit_id === jtiObs.visit_id);
  if (sameVisit) {
    return { price: sameVisit.confirmed_price, observed_at: sameVisit.observed_at, basis: 'same_visit', observation: sameVisit };
  }

  const sameOutlet = relevant
    .filter((o) => o.outlet_id === jtiObs.outlet_id)
    .sort((a, b) => toDate(b.observed_at) - toDate(a.observed_at))[0];
  if (sameOutlet) {
    return {
      price: sameOutlet.confirmed_price,
      observed_at: sameOutlet.observed_at,
      basis: 'same_outlet_recent',
      observation: sameOutlet,
    };
  }

  const territoryObs = relevant.filter((o) => o.territory_id === jtiObs.territory_id);
  if (territoryObs.length) {
    const latest = territoryObs.sort((a, b) => toDate(b.observed_at) - toDate(a.observed_at))[0];
    return {
      price: round(median(territoryObs.map((o) => o.confirmed_price)), 2),
      observed_at: latest.observed_at,
      basis: 'territory_median',
      observation: null,
    };
  }
  return null;
}

/**
 * Builds evaluated observation views. This is the single join point every manager page
 * reads from.
 */
export function enrichObservations(data, config, now = new Date().toISOString()) {
  const skus = indexBy(data.skus);
  const brands = indexBy(data.brands);
  const outlets = indexBy(data.outlets);
  const territories = indexBy(data.territories);
  const channels = indexBy(data.channels);
  const users = indexBy(data.users);
  const visits = indexBy(data.visits);

  // Denormalise outlet scope onto observations first so competitor lookups can filter by it.
  const base = data.price_observations.map((o) => {
    const outlet = outlets.get(o.outlet_id);
    return {
      ...o,
      territory_id: outlet?.territory_id ?? null,
      channel_id: outlet?.channel_id ?? null,
    };
  });

  return base
    .map((o) => {
      const sku = skus.get(o.sku_id);
      const brand = sku ? brands.get(sku.brand_id) : null;
      const outlet = outlets.get(o.outlet_id);
      const visit = visits.get(o.visit_id);
      const view = {
        ...o,
        sku,
        sku_name: sku?.name ?? o.sku_id,
        sku_code: sku?.sku_code ?? '',
        brand,
        brand_name: brand?.name ?? '',
        company: brand?.company ?? '',
        is_jti: Boolean(sku?.is_jti),
        is_strategic: Boolean(sku?.is_strategic),
        strategic_priority: sku?.strategic_priority ?? null,
        outlet,
        outlet_name: outlet?.name ?? o.outlet_id,
        outlet_code: outlet?.outlet_code ?? '',
        territory: territories.get(o.territory_id),
        territory_name: territories.get(o.territory_id)?.name ?? '',
        channel: channels.get(o.channel_id),
        channel_name: channels.get(o.channel_id)?.name ?? '',
        user: users.get(visit?.user_id),
        user_name: users.get(visit?.user_id)?.name ?? '',
        visit,
        freshness: freshnessLabel(o.observed_at, now, config.freshness),
      };

      if (!view.is_jti) {
        view.evaluation = null;
        return view;
      }

      const competitor = resolveCompetitorObservation(
        o,
        o.competitor_sku_id_snapshot,
        base,
        config,
      );
      const competitorSku = competitor ? skus.get(o.competitor_sku_id_snapshot) : null;

      view.competitor_price = competitor?.price ?? null;
      view.competitor_observed_at = competitor?.observed_at ?? null;
      view.competitor_basis = competitor?.basis ?? null;
      view.competitor_sku = competitorSku;
      view.competitor_sku_name = competitorSku?.name ?? null;
      view.competitor_freshness = competitor
        ? freshnessLabel(competitor.observed_at, now, config.freshness)
        : null;
      /** §26 — do not present a confident competitive conclusion on stale comparison data. */
      view.competitor_stale =
        competitor && (daysBetween(competitor.observed_at, o.observed_at) ?? 0) >
          config.freshness.aging_max_days;

      view.evaluation = evaluateObservation({
        confirmedPrice: o.confirmed_price,
        competitorPrice: view.competitor_price,
        ruleSnapshot: o,
        mappingSnapshot: o,
        confidence: o.recognition_confidence,
        confidenceThreshold: config.confidence_review_threshold,
        isStrategic: view.is_strategic,
        comparisonMethod: config.comparison_method,
      });
      return view;
    })
    .filter((o) => !o.excluded);
}

/** Applies the global manager filters (§9). */
export function applyFilters(observations, filters = {}) {
  const from = filters.from ? toDate(filters.from) : null;
  const to = filters.to ? toDate(filters.to) : null;
  return observations.filter((o) => {
    const when = toDate(o.observed_at);
    if (from && when < from) return false;
    if (to && when > to) return false;
    if (filters.territory_id && o.territory_id !== filters.territory_id) return false;
    if (filters.channel_id && o.channel_id !== filters.channel_id) return false;
    if (filters.outlet_id && o.outlet_id !== filters.outlet_id) return false;
    if (filters.user_id && o.visit?.user_id !== filters.user_id) return false;
    if (filters.brand_id && o.sku?.brand_id !== filters.brand_id) return false;
    if (filters.sku_id && o.sku_id !== filters.sku_id) return false;
    if (filters.strategic_only && !o.is_strategic) return false;
    if (filters.ownership === 'jti' && !o.is_jti) return false;
    if (filters.ownership === 'competitor' && o.is_jti) return false;
    if (
      filters.min_confidence &&
      o.recognition_confidence !== null &&
      o.recognition_confidence < filters.min_confidence
    ) {
      return false;
    }
    return true;
  });
}

/** §9.1 — headline KPIs. */
export function calculateKpis(observations, config, comparisonObservations = null) {
  const jti = observations.filter((o) => o.is_jti && o.evaluation);

  const withRule = jti.filter((o) => o.evaluation.rangeBucket !== RANGE_BUCKET.UNKNOWN);
  const within = withRule.filter((o) => o.evaluation.rangeBucket === RANGE_BUCKET.WITHIN);
  const alignment = withRule.length ? (within.length / withRule.length) * 100 : null;

  const strategicWithRule = withRule.filter((o) => o.is_strategic);
  const strategicWithin = strategicWithRule.filter(
    (o) => o.evaluation.rangeBucket === RANGE_BUCKET.WITHIN,
  );
  const strategicAlignment = strategicWithRule.length
    ? (strategicWithin.length / strategicWithRule.length) * 100
    : null;

  const mapped = jti.filter((o) => o.evaluation.competitive.aligned !== null);
  const competitiveAligned = mapped.filter((o) => o.evaluation.competitive.aligned === true);
  const competitiveAlignment = mapped.length
    ? (competitiveAligned.length / mapped.length) * 100
    : null;

  const strategicMapped = mapped.filter((o) => o.is_strategic);
  const strategicCompetitiveAlignment = strategicMapped.length
    ? (strategicMapped.filter((o) => o.evaluation.competitive.aligned === true).length /
        strategicMapped.length) *
      100
    : null;

  const confident = jti.filter(
    (o) =>
      o.recognition_confidence === null ||
      o.recognition_confidence >= config.confidence_review_threshold,
  );
  const dataConfidence = jti.length ? (confident.length / jti.length) * 100 : null;

  const kpis = {
    recommended_price_alignment: round(alignment, 1),
    recommended_price_alignment_n: withRule.length,
    strategic_recommended_price_alignment: round(strategicAlignment, 1),
    strategic_recommended_price_alignment_n: strategicWithRule.length,
    competitive_alignment: round(competitiveAlignment, 1),
    competitive_alignment_n: mapped.length,
    strategic_competitive_alignment: round(strategicCompetitiveAlignment, 1),
    strategic_competitive_alignment_n: strategicMapped.length,
    data_confidence: round(dataConfidence, 1),
    jti_observations: jti.length,
    competitor_observations: observations.filter((o) => !o.is_jti).length,
    outlets_observed: new Set(observations.map((o) => o.outlet_id)).size,
  };

  if (comparisonObservations) {
    const prev = calculateKpis(comparisonObservations, config, null);
    kpis.delta = {
      recommended_price_alignment: deltaOf(
        kpis.recommended_price_alignment,
        prev.recommended_price_alignment,
      ),
      strategic_recommended_price_alignment: deltaOf(
        kpis.strategic_recommended_price_alignment,
        prev.strategic_recommended_price_alignment,
      ),
      competitive_alignment: deltaOf(kpis.competitive_alignment, prev.competitive_alignment),
      strategic_competitive_alignment: deltaOf(
        kpis.strategic_competitive_alignment,
        prev.strategic_competitive_alignment,
      ),
    };
    kpis.previous = prev;
  }
  return kpis;
}

function deltaOf(current, previous) {
  if (current === null || previous === null) return null;
  return round(current - previous, 1);
}

/**
 * §9.1 — Market coverage.
 *
 * Kept for the outlets-visited headline, now scoped: the denominator is the outlets the
 * current filters select, not every outlet in the country. Filtering to East and visiting
 * all six of East's outlets reads 6/6, not 6/24. The four separate coverage questions live
 * in coverageService.
 */
export function calculateMarketCoverage(observations, outlets, config, now, filters = {}) {
  const active = outletsInScope(outlets, filters);
  const inScope = new Set(active.map((o) => o.id));
  const recent = new Set(
    observations
      .filter((o) => inScope.has(o.outlet_id))
      .filter((o) => (daysBetween(o.observed_at, now) ?? Infinity) <= config.freshness.aging_max_days)
      .map((o) => o.outlet_id),
  );
  return {
    expected_outlets: active.length,
    observed_outlets: recent.size,
    coverage_pct: active.length ? round((recent.size / active.length) * 100, 1) : null,
    window_days: config.freshness.aging_max_days,
    scope: filters.territory_id || filters.channel_id || filters.outlet_id ? 'selected scope' : 'all outlets',
  };
}

/** §9.2 — the 3×3 Price Position Matrix. */
export function buildPriceMatrix(observations) {
  const rows = [RANGE_BUCKET.ABOVE, RANGE_BUCKET.WITHIN, RANGE_BUCKET.BELOW];
  const cols = [
    COMPETITIVE_BUCKET.JTI_EXPENSIVE,
    COMPETITIVE_BUCKET.DESIRED,
    COMPETITIVE_BUCKET.JTI_CHEAPER,
  ];
  const cells = {};
  for (const r of rows) {
    cells[r] = {};
    for (const c of cols) cells[r][c] = { observations: [], outlets: new Set() };
  }
  let unclassified = 0;
  let total = 0;

  for (const o of observations) {
    if (!o.is_jti || !o.evaluation) continue;
    total += 1;
    const r = o.evaluation.rangeBucket;
    const c = o.evaluation.competitive.bucket;
    if (!cells[r] || !cells[r][c]) {
      unclassified += 1;
      continue;
    }
    cells[r][c].observations.push(o);
    cells[r][c].outlets.add(o.outlet_id);
  }

  const matrix = rows.map((r) => ({
    row: r,
    cells: cols.map((c) => ({
      row: r,
      col: c,
      count: cells[r][c].observations.length,
      outletCount: cells[r][c].outlets.size,
      pct: total ? round((cells[r][c].observations.length / total) * 100, 1) : 0,
      observations: cells[r][c].observations,
    })),
  }));
  return { matrix, total, unclassified };
}

/**
 * §10 — derives Pricing Opportunities from evaluated observations.
 * One opportunity per outlet + JTI SKU, based on the most recent observation, enriched with
 * persistence, dispersion and competitor-move context.
 *
 * Two different sets of observations are needed and they are not interchangeable. Whether a
 * case is open now is decided by the current trusted picture: a low-confidence reading
 * nobody has confirmed must not put an outlet on a priority list. How long it has been open,
 * and whether it keeps recurring, can only come from the full history.
 */
export function deriveOpportunities(observations, context, config, now) {
  const {
    competitorMoves = [],
    dispersionFlags = new Set(),
    fieldActions = [],
    current = null,
    states = {},
  } = context;
  const movedSkus = new Set(competitorMoves.flatMap((m) => m.affected_jti_sku_ids));
  // Null means "no snapshot supplied": every observation counts, as before.
  const eligible = current ? new Set(current.map((o) => o.id)) : null;

  const groups = new Map();
  for (const o of observations) {
    if (!o.is_jti || !o.evaluation) continue;
    const key = `${o.outlet_id}|${o.sku_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }

  const opportunities = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => toDate(a.observed_at) - toDate(b.observed_at));
    const trusted = eligible ? list.filter((o) => eligible.has(o.id)) : list;
    const latest = trusted[trusted.length - 1];
    if (!latest || !isOpportunity(latest.evaluation)) continue;

    const history = list.map((o) => ({
      observed_at: o.observed_at,
      deviating: isOpportunity(o.evaluation),
    }));
    const deviatingRun = history.filter((h) => h.deviating);
    const firstDetected = deviatingRun.length ? deviatingRun[0].observed_at : latest.observed_at;
    const daysOpen = daysBetween(firstDetected, now) ?? 0;

    const persistent =
      deviatingRun.length >= config.persistence.min_consecutive_visits ||
      daysOpen >= config.persistence.min_days_open;
    const recentMove = movedSkus.has(latest.sku_id);
    const highDispersion = dispersionFlags.has(latest.sku_id);

    // Outlets affected NOW, not outlets ever affected: the count drives priority.
    const outletCount = countAffectedOutlets(current ?? observations, latest.sku_id);
    const deviation = rangeDeviation(latest.confirmed_price, latest);
    const idxDeviation = priceIndexDeviation(latest.evaluation.priceIndex, latest);

    const lastAction = fieldActions
      .filter((a) => a.outlet_id === latest.outlet_id)
      .sort((a, b) => toDate(b.action_at) - toDate(a.action_at))[0];
    const unresolvedAction = Boolean(
      lastAction &&
        (lastAction.action_type === 'Follow-up required' ||
          (lastAction.follow_up_date && toDate(lastAction.follow_up_date) < toDate(now))),
    );

    const priority = calculateOpportunityPriority(
      {
        strategic_priority: latest.strategic_priority,
        is_strategic: latest.is_strategic,
        range_deviation_pct: deviation.pct,
        price_index_deviation: idxDeviation,
        outlet_count: outletCount,
        days_open: daysOpen,
        recent_competitor_move: recentMove,
        confidence: latest.recognition_confidence,
        unresolved_action: unresolvedAction,
      },
      config,
    );

    const category = classifyOpportunity({
      evaluation: latest.evaluation,
      is_strategic: latest.is_strategic,
      recent_competitor_move: recentMove,
      persistent,
      high_dispersion: highDispersion,
    });

    const opp = {
      id: `opp-${key}`,
      outlet_id: latest.outlet_id,
      outlet_name: latest.outlet_name,
      outlet_code: latest.outlet_code,
      territory_id: latest.territory_id,
      territory_name: latest.territory_name,
      channel_name: latest.channel_name,
      jti_sku_id: latest.sku_id,
      jti_sku_name: latest.sku_name,
      is_strategic: latest.is_strategic,
      strategic_priority: latest.strategic_priority,
      competitor_sku_id: latest.competitor_sku_id_snapshot,
      competitor_sku_name: latest.competitor_sku_name,
      category,
      range_bucket: latest.evaluation.rangeBucket,
      competitive_bucket: latest.evaluation.competitive.bucket,
      jti_price: latest.confirmed_price,
      competitor_price: latest.competitor_price,
      recommended_min: latest.recommended_min_snapshot,
      recommended_max: latest.recommended_max_snapshot,
      recommended_price: latest.recommended_price_snapshot,
      price_gap: latest.evaluation.gap,
      price_index: latest.evaluation.priceIndex,
      desired_price_index_min: latest.desired_price_index_min_snapshot,
      desired_price_index_max: latest.desired_price_index_max_snapshot,
      desired_gap_min: latest.desired_gap_min_snapshot,
      desired_gap_max: latest.desired_gap_max_snapshot,
      first_detected_at: firstDetected,
      last_detected_at: latest.observed_at,
      days_open: daysOpen,
      outlet_count: outletCount,
      priority_score: priority.score,
      priority_label: priority.label,
      priority_components: priority.components,
      last_action: lastAction ?? null,
      observations: list,
      recognition_confidence: latest.recognition_confidence,
      freshness: latest.freshness,
      ...lifecycle(`opp-${key}`, states, lastAction, latest, now),
    };
    opp.reason = opportunityReason(opp);
    opp.suggested_action = suggestedAction(opp);
    opportunities.push(opp);
  }

  opportunities.sort((a, b) => b.priority_score - a.priority_score);
  return opportunities;
}

/**
 * Who has this, what the next step is, and whether it is actually still open.
 *
 * Every opportunity used to be labelled "New", including one at Punggol with eighty-seven days
 * of history and a recorded "Follow-up required". A GM reading that screen cannot tell a case
 * nobody has touched from one somebody is already three visits into, which is exactly the
 * distinction that decides what to do next.
 *
 * Two sources settle it. A status somebody set by hand wins outright — a person looked at the
 * case and said where it stood. Otherwise the last field action at that outlet says whether
 * anybody has engaged, and an overdue follow-up date says the promised step has slipped.
 *
 * `days_open` deliberately stays the age of the current deviating run, not of the oldest
 * deviation ever seen. A case that was resolved and recurred is a new episode, and dating it
 * from the first historical deviation would claim months of neglect that did not happen.
 */
function lifecycle(id, states, lastAction, latest, now) {
  const stored = states?.[id] ?? null;
  const overdue = Boolean(
    lastAction?.follow_up_date && toDate(lastAction.follow_up_date) < toDate(now),
  );

  const status = stored?.status
    ? stored.status
    : overdue
      ? 'Follow-up overdue'
      : lastAction
        ? 'Engaged'
        : 'New';

  return {
    status,
    /** Set by a person, rather than inferred from the last action at the outlet. */
    status_set_by_hand: Boolean(stored?.status),
    assigned_user_id: stored?.assigned_user_id ?? latest.outlet?.assigned_tme_id ?? null,
    next_step: lastAction?.action_type ?? null,
    next_step_at: lastAction?.action_at ?? null,
    due_date: lastAction?.follow_up_date ?? null,
    overdue,
    state_updated_at: stored?.updated_at ?? null,
  };
}

function countAffectedOutlets(observations, skuId) {
  const outlets = new Set();
  for (const o of observations) {
    if (o.sku_id !== skuId || !o.evaluation) continue;
    if (isOpportunity(o.evaluation)) outlets.add(o.outlet_id);
  }
  return outlets.size || 1;
}

/** §11.1 / §15 — distribution of observed retail prices for one SKU. */
export function calculatePriceDistribution(observations, skuId, options = {}) {
  const relevant = observations.filter((o) => o.sku_id === skuId);
  if (!relevant.length) return null;
  const prices = relevant.map((o) => o.confirmed_price);
  const stats = describe(prices);
  return {
    sku_id: skuId,
    stats,
    histogram: histogram(prices, options.binWidth ?? 0.1),
    observations: relevant,
    outlets: new Set(relevant.map((o) => o.outlet_id)).size,
  };
}

/** §15 — dispersion per SKU with configurable high-dispersion flags. */
export function calculateDispersion(observations, config, groupBy = 'sku_id') {
  const groups = new Map();
  for (const o of observations) {
    if (!o.is_jti) continue;
    const key = o[groupBy];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  const rows = [];
  for (const [key, list] of groups) {
    const stats = describe(list.map((o) => o.confirmed_price));
    if (!stats || stats.count < config.dispersion.min_observations) continue;
    const spreadPct = stats.median ? (stats.p90_minus_p10 / stats.median) * 100 : 0;
    rows.push({
      key,
      label: list[0][groupBy === 'sku_id' ? 'sku_name' : 'territory_name'] ?? key,
      sku_id: list[0].sku_id,
      sku_name: list[0].sku_name,
      is_strategic: list[0].is_strategic,
      stats,
      spread_pct: round(spreadPct, 1),
      outlets: new Set(list.map((o) => o.outlet_id)).size,
      high_dispersion:
        stats.p90_minus_p10 >= config.dispersion.high_dispersion_abs ||
        spreadPct >= config.dispersion.high_dispersion_pct,
    });
  }
  rows.sort((a, b) => b.stats.p90_minus_p10 - a.stats.p90_minus_p10);
  return rows;
}

/**
 * §13 — observed retail price movement for a competitor SKU (GM review §G).
 *
 * Two things were wrong with the version this replaces.
 *
 * The headline impact was one blended Price Index — 101.6 — computed from the median of every
 * JTI price mapped to the moving competitor. Winston Red, Camel Filters and LD Red map to Pall
 * Mall Red, and they sit at three different price levels with three different intended
 * corridors. One number across all of them is the position of no SKU at all: an index that is
 * comfortable for a mainstream SKU is a problem for a value one. The event stays shared; the
 * effect is now reported per mapped SKU against that mapping's own corridor.
 *
 * And the movement itself was a median of everything seen before against a median of everything
 * seen after. Those are different sets of outlets, so a change in which shops were visited
 * reads as a change in price. The movement is now measured across outlets observed in BOTH
 * periods, with the paired count and its coverage of the whole reported beside it — if the
 * pairing is thin, that is the first thing to see.
 *
 * The event is named for what it is: retail prices observed to have moved. Retailers set their
 * own prices, so a set of shop-floor observations cannot establish a manufacturer's pricing
 * decision, however tempting the inference.
 */
export function detectCompetitorMoves(observations, data, config, now) {
  const { min_abs_change, min_pct_change, lookback_days } = config.competitor_move;
  const competitorObs = observations.filter((o) => !o.is_jti);
  const bySku = new Map();
  for (const o of competitorObs) {
    if (!bySku.has(o.sku_id)) bySku.set(o.sku_id, []);
    bySku.get(o.sku_id).push(o);
  }

  const mappings = data.competitor_mappings.filter((m) => m.active !== false);
  const moves = [];

  for (const [skuId, list] of bySku) {
    list.sort((a, b) => toDate(a.observed_at) - toDate(b.observed_at));
    const cutoff = new Date(toDate(now).getTime() - lookback_days * 86400000);
    const before = list.filter((o) => toDate(o.observed_at) < cutoff);
    const after = list.filter((o) => toDate(o.observed_at) >= cutoff);
    if (!before.length || !after.length) continue;

    const paired = pairedChange(before, after);
    // Unpaired medians are kept only to show what the naive comparison would have said, and
    // are never the reported movement.
    const previous = round(median(before.map((o) => o.confirmed_price)), 2);
    const current = round(median(after.map((o) => o.confirmed_price)), 2);

    const change = paired.outlets ? paired.change : round(current - previous, 2);
    const base = paired.outlets ? paired.previous : previous;
    const pctChange = base ? round((change / base) * 100, 2) : 0;
    if (Math.abs(change) < min_abs_change && Math.abs(pctChange) < min_pct_change) continue;

    const affectedMappings = mappings.filter((m) => m.competitor_sku_id === skuId);
    const affectedJtiSkuIds = [...new Set(affectedMappings.map((m) => m.jti_sku_id))];

    // One row per mapped JTI SKU, each against its own corridor. Deliberately not summed.
    const perSku = affectedMappings.map((mapping) => {
      const jtiObs = observations.filter(
        (o) => o.is_jti && o.sku_id === mapping.jti_sku_id && toDate(o.observed_at) >= cutoff,
      );
      const jtiMedian = round(median(jtiObs.map((o) => o.confirmed_price)), 2);
      const gap = jtiMedian !== null && current !== null ? round(jtiMedian - current, 2) : null;
      const index = jtiMedian !== null && current ? round((jtiMedian / current) * 100, 1) : null;

      const insideGap =
        gap === null || !Number.isFinite(mapping.desired_gap_min) || !Number.isFinite(mapping.desired_gap_max)
          ? null
          : gap >= mapping.desired_gap_min && gap <= mapping.desired_gap_max;
      const insideIndex =
        index === null ||
        !Number.isFinite(mapping.desired_price_index_min) ||
        !Number.isFinite(mapping.desired_price_index_max)
          ? null
          : index >= mapping.desired_price_index_min && index <= mapping.desired_price_index_max;

      const sku = data.skus.find((x) => x.id === mapping.jti_sku_id);
      return {
        jti_sku_id: mapping.jti_sku_id,
        jti_sku_name: sku?.name ?? mapping.jti_sku_id,
        is_strategic: Boolean(sku?.is_strategic),
        mapping_id: mapping.id,
        mapping_priority: mapping.mapping_priority,
        jti_median: jtiMedian,
        gap,
        price_index: index,
        desired_gap_min: mapping.desired_gap_min,
        desired_gap_max: mapping.desired_gap_max,
        desired_price_index_min: mapping.desired_price_index_min,
        desired_price_index_max: mapping.desired_price_index_max,
        inside_gap: insideGap,
        inside_index: insideIndex,
        outlets: new Set(jtiObs.map((o) => o.outlet_id)).size,
        observations: jtiObs.length,
      };
    });
    perSku.sort((a, b) => Number(b.is_strategic) - Number(a.is_strategic) || b.mapping_priority - a.mapping_priority);

    const affectedJtiObs = observations.filter(
      (o) => o.is_jti && affectedJtiSkuIds.includes(o.sku_id) && toDate(o.observed_at) >= cutoff,
    );
    const strategicAffected = affectedJtiObs.some((o) => o.is_strategic);
    const magnitude =
      Math.abs(pctChange) * (strategicAffected ? config.competitor_move.strategic_mapping_weight : 1);

    moves.push({
      competitor_sku_id: skuId,
      competitor_sku_name: after[0].sku_name,
      competitor_brand: after[0].brand_name,
      competitor_company: after[0].company,
      /** Named for what was observed, not for a decision that was not. */
      label: `Observed retail price movement for ${after[0].sku_name}`,
      previous_price: paired.outlets ? paired.previous : previous,
      current_price: paired.outlets ? paired.current : current,
      change,
      pct_change: pctChange,
      /** How the movement was measured, so a thin pairing is visible rather than implied. */
      paired_outlets: paired.outlets,
      comparable_outlets: paired.comparable,
      paired_coverage_pct: paired.comparable ? round((paired.outlets / paired.comparable) * 100, 1) : null,
      unpaired_previous: previous,
      unpaired_current: current,
      basis: paired.outlets ? 'outlets observed in both periods' : 'all observations in each period (no paired outlets)',

      affected_jti_sku_ids: affectedJtiSkuIds,
      affected_jti_sku_names: affectedJtiSkuIds.map(
        (id) => data.skus.find((x) => x.id === id)?.name ?? id,
      ),
      /** The effect on each mapped JTI SKU, against that mapping's own intended corridor. */
      per_sku: perSku,
      affected_outlets: new Set(affectedJtiObs.map((o) => o.outlet_id)).size,
      affected_observations: affectedJtiObs.length,
      strategic_affected: strategicAffected,
      magnitude: round(magnitude, 2),
      priority: magnitude >= 6 ? 'High' : magnitude >= 3 ? 'Medium' : 'Low',
      detected_at: after[after.length - 1].observed_at,
    });
  }

  moves.sort((a, b) => b.magnitude - a.magnitude);
  return moves;
}

/**
 * The price change across outlets seen in BOTH periods.
 *
 * Comparing all-of-before against all-of-after measures the visit schedule as much as the
 * shelf: drop two cheap outlets from the later round and the "price" rises without anything
 * moving. Pairing by outlet removes composition from the comparison, and the count of pairs is
 * reported so a change resting on three shops is not read as a market movement.
 */
function pairedChange(before, after) {
  const latest = (list) => {
    const byOutlet = new Map();
    for (const o of list) {
      const held = byOutlet.get(o.outlet_id);
      if (!held || toDate(o.observed_at) > toDate(held.observed_at)) byOutlet.set(o.outlet_id, o);
    }
    return byOutlet;
  };
  const first = latest(before);
  const second = latest(after);
  const shared = [...second.keys()].filter((id) => first.has(id));
  const comparable = new Set([...first.keys(), ...second.keys()]).size;

  if (!shared.length) return { outlets: 0, comparable, previous: null, current: null, change: null };

  const deltas = shared.map((id) => second.get(id).confirmed_price - first.get(id).confirmed_price);
  return {
    outlets: shared.length,
    comparable,
    previous: round(median(shared.map((id) => first.get(id).confirmed_price)), 2),
    current: round(median(shared.map((id) => second.get(id).confirmed_price)), 2),
    change: round(median(deltas), 2),
  };
}

/** §11.2, §13 — time series of medians for a SKU (and its mapped competitor). */
export function buildTimeSeries(observations, granularity = 'week') {
  const buckets = new Map();
  for (const o of observations) {
    const key = periodKey(o.observed_at, granularity);
    if (!buckets.has(key)) buckets.set(key, { period: key, jti: [], competitor: [], index: [] });
    const bucket = buckets.get(key);
    if (o.is_jti) {
      bucket.jti.push(o.confirmed_price);
      if (o.evaluation?.priceIndex !== null && o.evaluation?.priceIndex !== undefined) {
        bucket.index.push(o.evaluation.priceIndex);
      }
      if (o.competitor_price !== null && o.competitor_price !== undefined) {
        bucket.competitor.push(o.competitor_price);
      }
    } else {
      bucket.competitor.push(o.confirmed_price);
    }
  }
  return [...buckets.values()]
    .map((b) => ({
      period: b.period,
      jti_median: round(median(b.jti), 2),
      competitor_median: round(median(b.competitor), 2),
      price_index_median: round(median(b.index), 1),
      n: b.jti.length + b.competitor.length,
    }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

/**
 * §12 — the observed price distribution per comparable SKU (GM review §F).
 *
 * This used to be a ladder of filled bars, each as long as its SKU's median price, on an axis
 * with no numbers on it. Two things were wrong with that. A bar whose length encodes a value
 * starting near SGD 12 exaggerates every difference, because the eye reads length from zero
 * and the axis did not start there. And a median on its own says nothing about spread: one SKU
 * priced identically in twenty-four outlets and another ranging over a dollar looked the same.
 * Dispersion across outlets is the whole point of the screen.
 *
 * So each row now carries its actual distribution — P10–P90, P25–P75 and the median — to be
 * drawn on one shared, labelled SGD axis. Three things follow from doing it honestly:
 *
 *   One observation per outlet. Ten visits to one shop must not weight it ten times in a
 *   percentile, so the rung is built from the latest reading per outlet–SKU–pack.
 *
 *   Percentiles need a sample. Below `smallSample` the row reports its individual values and
 *   its count instead, because a P10 of five numbers is not a stable tenth percentile.
 *
 *   A recommended band is only a band if there is one. Outlet-specific rules mean the same SKU
 *   can carry several; merging them into one average corridor invents a reference nobody set,
 *   so the distinct rules are counted and the band is withheld when they disagree.
 */
export function buildPriceLadder(observations, config, options = {}) {
  const { include = 'all', smallSample = 8 } = options;

  // Pack configuration is part of the identity, not an attribute: SGD 14.20 for a pack of 20
  // and for any other configuration are not two readings of the same thing.
  const groups = new Map();
  for (const o of observations) {
    if (include === 'jti' && !o.is_jti) continue;
    if (include === 'competitor' && o.is_jti) continue;
    if (!Number.isFinite(o.confirmed_price)) continue;
    const pack = o.sticks_per_pack_snapshot ?? o.sku?.sticks_per_pack ?? null;
    const key = `${o.sku_id}|${pack ?? 'unknown'}`;
    if (!groups.has(key)) groups.set(key, { pack, list: [] });
    groups.get(key).list.push(o);
  }

  const rungs = [];
  for (const [key, { pack, list }] of groups) {
    // Latest per outlet: a percentile over repeat visits measures visit frequency, not price.
    const perOutlet = new Map();
    for (const o of list) {
      const held = perOutlet.get(o.outlet_id);
      if (!held || toDate(o.observed_at) > toDate(held.observed_at)) perOutlet.set(o.outlet_id, o);
    }
    const outletLevel = [...perOutlet.values()];
    const prices = outletLevel.map((o) => o.confirmed_price);
    const stats = describe(prices);
    if (!stats) continue;

    const first = list[0];

    /**
     * The recommended band, but only where the rules in scope agree on one.
     *
     * A filtered range can span a rule change or several outlet overrides. Averaging those
     * into a single corridor draws a reference line the business never set, which is worse
     * than drawing none: it is unfalsifiable on the screen.
     */
    const bands = new Map();
    for (const o of outletLevel) {
      if (!Number.isFinite(o.recommended_min_snapshot) || !Number.isFinite(o.recommended_max_snapshot)) continue;
      bands.set(`${o.recommended_min_snapshot}|${o.recommended_max_snapshot}`, {
        min: o.recommended_min_snapshot,
        max: o.recommended_max_snapshot,
        recommended: o.recommended_price_snapshot ?? null,
      });
    }
    const distinctBands = [...bands.values()];
    const band = distinctBands.length === 1 ? distinctBands[0] : null;

    rungs.push({
      key,
      sku_id: first.sku_id,
      sku_name: first.sku_name,
      brand_name: first.brand_name,
      company: first.company,
      is_jti: first.is_jti,
      is_strategic: first.is_strategic,
      sticks_per_pack: pack,
      pack_type: first.pack_type_snapshot ?? first.sku?.pack_type ?? null,

      stats,
      /** Every outlet-level price, so a small sample can be drawn as its own points. */
      values: prices.slice().sort((a, b) => a - b),
      small_sample: stats.count < smallSample,

      median_price: round(stats.median, 2),
      p10: round(stats.p10, 2),
      p25: round(stats.p25, 2),
      p75: round(stats.p75, 2),
      p90: round(stats.p90, 2),

      recommended_price: band?.recommended ?? null,
      recommended_min: band?.min ?? null,
      recommended_max: band?.max ?? null,
      /** More than one rule applies in this scope; no single corridor is shown. */
      recommendation_variants: distinctBands.length,

      price_index: first.is_jti
        ? round(median(outletLevel.map((o) => o.evaluation?.priceIndex).filter(Number.isFinite)), 1)
        : null,

      observations: list.length,
      outlets: outletLevel.length,
      freshest: outletLevel.reduce(
        (latest, o) => (!latest || toDate(o.observed_at) > toDate(latest) ? o.observed_at : latest),
        null,
      ),
      oldest: outletLevel.reduce(
        (first_, o) => (!first_ || toDate(o.observed_at) < toDate(first_) ? o.observed_at : first_),
        null,
      ),
    });
  }

  rungs.sort((a, b) => b.median_price - a.median_price);

  // One axis for every row, so two intervals can be compared by looking at them.
  const lows = rungs.flatMap((r) => [r.p10, r.recommended_min].filter(Number.isFinite));
  const highs = rungs.flatMap((r) => [r.p90, r.recommended_max].filter(Number.isFinite));
  const axis = rungs.length
    ? { min: Math.floor(Math.min(...lows) * 2) / 2, max: Math.ceil(Math.max(...highs) * 2) / 2 }
    : null;

  const packs = new Set(rungs.map((r) => r.sticks_per_pack ?? 'unknown'));

  return {
    rungs,
    axis,
    /** More than one pack configuration is on screen; rows are never compared across them. */
    mixed_packs: packs.size > 1,
    outlet_level: true,
    insights: dedupe(ladderInsights(rungs, config)),
  };
}

/** Several adjacent rung pairs can produce the same observation; report it once. */
function dedupe(insights) {
  const seen = new Set();
  return insights.filter((i) => {
    const key = `${i.title}|${i.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** §12 — structural observations about the ladder. */
function ladderInsights(rungs, config) {
  const insights = [];
  const jti = rungs.filter((r) => r.is_jti);
  const competitor = rungs.filter((r) => !r.is_jti);

  for (let i = 0; i < jti.length - 1; i += 1) {
    const upper = jti[i];
    const lower = jti[i + 1];
    const inserted = competitor.filter(
      (c) => c.median_price < upper.median_price && c.median_price > lower.median_price,
    );
    if (inserted.length) {
      insights.push({
        tone: 'watch',
        title: 'Competitor inserted between JTI price tiers',
        detail: `${inserted.map((c) => c.sku_name).join(', ')} sits between ${upper.sku_name} and ${lower.sku_name}.`,
      });
    }
    const gap = round(upper.median_price - lower.median_price, 2);
    // A zero gap means two SKUs share a price tier by design — that is architecture, not
    // an anomaly, so only a small-but-non-zero gap is worth flagging.
    if (gap > 0 && gap <= 0.15) {
      insights.push({
        tone: 'watch',
        title: 'Narrow gap between JTI SKUs',
        detail: `${upper.sku_name} and ${lower.sku_name} are only SGD ${gap.toFixed(2)} apart.`,
      });
    } else if (gap >= 1.5) {
      insights.push({
        tone: 'watch',
        title: 'Wide gap between JTI SKUs',
        detail: `${upper.sku_name} and ${lower.sku_name} are SGD ${gap.toFixed(2)} apart — a competitor could be positioned in between.`,
      });
    }
  }

  /**
   * Where the prices sit, stated as where the prices sit.
   *
   * This used to read "Premium position under pressure", derived from nothing more than
   * Marlboro's median sitting above the highest JTI SKU. Marlboro is a premium brand; JTI's
   * Singapore portfolio tops out at Core. That arrangement is the architecture working, not
   * evidence of pressure on it — and "under pressure" is a claim about a change, which a
   * single snapshot of two medians cannot support. Establishing it needs an approved intended
   * architecture, a mapping, comparable outlets and a movement against a base period.
   *
   * So the observation is kept and the conclusion is dropped.
   */
  const topJti = jti[0];
  const topCompetitor = competitor[0];
  if (topJti && topCompetitor && topCompetitor.median_price > topJti.median_price) {
    insights.push({
      tone: 'watch',
      title: 'Competitor median above the highest observed JTI SKU',
      detail:
        `${topCompetitor.sku_name} (SGD ${topCompetitor.median_price.toFixed(2)}) sits above ` +
        `${topJti.sku_name} (SGD ${topJti.median_price.toFixed(2)}). Descriptive only: whether this ` +
        'is a deviation depends on an approved intended architecture and a comparison against a base period.',
    });
  }

  const valueJti = jti[jti.length - 1];
  const competitorCore = competitor.find((c) => /core/i.test(c.sku_name));
  if (valueJti && competitorCore && valueJti.median_price > competitorCore.median_price) {
    insights.push({
      tone: 'watch',
      title: 'Lowest-priced JTI SKU above a competitor core SKU',
      detail:
        `${valueJti.sku_name} (SGD ${valueJti.median_price.toFixed(2)}) is above ` +
        `${competitorCore.sku_name} (SGD ${competitorCore.median_price.toFixed(2)}). ` +
        'A lower JTI price is not automatically a better position: different tiers carry different ' +
        'approved reference points, and only the configured mapping settles this one.',
    });
  }
  return insights;
}

/**
 * §14 — field effectiveness.
 *
 * Deliberately labelled as an OBSERVED SEQUENCE. This function does not and must not
 * assert that field engagement caused a price change (§5.8, §33).
 */
export function calculateFieldEffectiveness(observations, data, opportunities, config, now) {
  const engagementActions = new Set([
    'Discussed with outlet',
    'Outlet agreed to review price',
    'Outlet agreed to adjust price',
    'Outlet declined',
    'Follow-up required',
    'Trade investment review required',
    'Competitive position review required',
  ]);

  const actions = data.field_actions
    .filter((a) => engagementActions.has(a.action_type))
    .sort((a, b) => toDate(a.action_at) - toDate(b.action_at));

  const timeline = [];
  const awaiting = [];
  let engagedWithSubsequent = 0;
  let engagedWithPriceChange = 0;
  const detectionToActionDays = [];
  const actionToNextObsDays = [];

  for (const action of actions) {
    const relatedSkuIds = action.sku_ids?.length
      ? action.sku_ids
      : [...new Set(observations.filter((o) => o.outlet_id === action.outlet_id && o.is_jti).map((o) => o.sku_id))];

    for (const skuId of relatedSkuIds) {
      const series = observations
        .filter((o) => o.outlet_id === action.outlet_id && o.sku_id === skuId && o.is_jti)
        .sort((a, b) => toDate(a.observed_at) - toDate(b.observed_at));
      const before = series.filter((o) => toDate(o.observed_at) <= toDate(action.action_at)).pop();
      const after = series.find((o) => toDate(o.observed_at) > toDate(action.action_at));
      if (!before) continue;

      const opp = opportunities.find(
        (o) => o.outlet_id === action.outlet_id && o.jti_sku_id === skuId,
      );
      if (opp) {
        const d = daysBetween(opp.first_detected_at, action.action_at);
        if (d !== null && d >= 0) detectionToActionDays.push(d);
      }

      if (!after) {
        awaiting.push({
          outcome: OUTCOME.AWAITING,
          outlet_id: action.outlet_id,
          outlet_name: before.outlet_name,
          sku_id: skuId,
          sku_name: before.sku_name,
          action_type: action.action_type,
          action_at: action.action_at,
          before: {
            observed_at: before.observed_at,
            jti_price: before.confirmed_price,
            status: before.evaluation?.status ?? null,
          },
        });
        continue;
      }
      engagedWithSubsequent += 1;
      const d2 = daysBetween(action.action_at, after.observed_at);
      if (d2 !== null) actionToNextObsDays.push(d2);

      const priceChanged = Math.abs(after.confirmed_price - before.confirmed_price) >= 0.05;
      if (priceChanged) engagedWithPriceChange += 1;

      const gapBefore = before.evaluation?.gap;
      const gapAfter = after.evaluation?.gap;
      const beforeSide = {
        observed_at: before.observed_at,
        jti_price: before.confirmed_price,
        competitor_price: before.competitor_price,
        gap: gapBefore ?? null,
        price_index: before.evaluation?.priceIndex ?? null,
        status: before.evaluation?.status ?? null,
      };
      const afterSide = {
        observed_at: after.observed_at,
        jti_price: after.confirmed_price,
        competitor_price: after.competitor_price,
        gap: gapAfter ?? null,
        price_index: after.evaluation?.priceIndex ?? null,
        status: after.evaluation?.status ?? null,
      };

      // Not "did the gap narrow" — did the price move closer to the corridor it is meant to
      // sit in. A gap moving toward zero can be a price leaving its intended position.
      const classified = classifyOutcome(beforeSide, afterSide, before, {
        comparisonMethod: config.comparison_method,
        tolerance: config.field_outcomes?.gap_tolerance ?? 0.01,
        indexTolerance: config.field_outcomes?.index_tolerance ?? 0.1,
      });

      timeline.push({
        outcome: classified.outcome,
        outcome_components: classified.components,
        outcome_policy: classified.policy,
        outcome_policy_note: classified.policy_note,
        moved: movementSource(beforeSide, afterSide),
        any_price_change: priceChanged,
        outlet_id: action.outlet_id,
        outlet_name: before.outlet_name,
        territory_name: before.territory_name,
        sku_id: skuId,
        sku_name: before.sku_name,
        is_strategic: before.is_strategic,
        action_type: action.action_type,
        action_at: action.action_at,
        user_id: action.user_id,
        before: beforeSide,
        after: afterSide,
        observed_price_change: round(after.confirmed_price - before.confirmed_price, 2),
        observed_gap_improvement:
          Number.isFinite(gapBefore) && Number.isFinite(gapAfter)
            ? round(Math.abs(gapBefore) - Math.abs(gapAfter), 2)
            : null,
      });
    }
  }

  const engagedOutletSkus = new Set(
    actions.flatMap((a) => (a.sku_ids ?? []).map((s) => `${a.outlet_id}|${s}`)),
  );
  const opportunitiesEngaged = opportunities.filter((o) =>
    engagedOutletSkus.has(`${o.outlet_id}|${o.jti_sku_id}`),
  ).length;
  const agreedToReview = actions.filter(
    (a) =>
      a.action_type === 'Outlet agreed to review price' ||
      a.action_type === 'Outlet agreed to adjust price',
  ).length;
  const resolved = timeline.filter(
    (t) => t.after.status === 'Within Recommended Range' && t.before.status !== 'Within Recommended Range',
  ).length;

  const outcomes = summariseOutcomes([...timeline, ...awaiting]);

  return {
    label: 'Observed sequence after engagement',
    disclaimer:
      'Sequence of observations only. This view does not attribute price movement to field action.',
    /**
     * The four outcomes, each with the denominator it belongs to. "Any observed price
     * change" is kept as a plain description of what the shelf did; it is not a success
     * rate, and among the prices that changed are prices that moved the wrong way.
     */
    outcomes,
    awaiting: awaiting.sort((a, b) => toDate(b.action_at) - toDate(a.action_at)),
    opportunities_identified: opportunities.length,
    opportunities_engaged: opportunitiesEngaged,
    outlet_agreed_to_review: agreedToReview,
    observed_price_changes: engagedWithPriceChange,
    engagements_with_subsequent_observation: engagedWithSubsequent,
    /**
     * There is deliberately no "engagement-to-price-change rate" here any more.
     *
     * It was the page's headline: four price changes in five engagements that had a later
     * observation, shown as 80% beside the word "effectiveness". One of those four was a price
     * that moved further from where it was meant to be, and none of the five is attributed to
     * the visit. The same count survives inside `outcomes.any_price_change`, where it is
     * labelled as a description of the shelf rather than a rate of success.
     *
     * Nor is there a median gap improvement. It measured |gap| getting smaller, which is not
     * the same as the price moving toward its intended position: a gap narrowing toward zero
     * can be a price leaving the corridor it was meant to sit in. The distance-to-corridor
     * change is on each timeline entry, per comparison basis, in `outcome_components`.
     */
    opportunities_resolved: resolved,
    opportunity_resolution_rate: opportunitiesEngaged
      ? round((resolved / opportunitiesEngaged) * 100, 1)
      : null,
    median_detection_to_action_days: round(median(detectionToActionDays), 1),
    median_action_to_next_observation_days: round(median(actionToNextObsDays), 1),
    timeline: timeline.sort((a, b) => toDate(b.action_at) - toDate(a.action_at)),
  };
}

/** §19 — territory roll-up. */
export function buildTerritorySummary(observations, data, opportunities, config, now) {
  const byTerritory = new Map();
  for (const t of data.territories) byTerritory.set(t.id, { territory: t, observations: [] });
  for (const o of observations) {
    const entry = byTerritory.get(o.territory_id);
    if (entry) entry.observations.push(o);
  }
  return [...byTerritory.values()].map(({ territory, observations: obs }) => {
    const kpis = calculateKpis(obs, config);
    const territoryOpps = opportunities.filter((o) => o.territory_id === territory.id);
    const jtiPrices = obs.filter((o) => o.is_jti).map((o) => o.confirmed_price);
    const stats = describe(jtiPrices);
    const indexes = obs
      .filter((o) => o.is_jti && Number.isFinite(o.evaluation?.priceIndex))
      .map((o) => o.evaluation.priceIndex);
    return {
      territory,
      kpis,
      opportunities: territoryOpps.length,
      high_priority: territoryOpps.filter((o) => o.priority_label === 'High').length,
      median_price_index: round(median(indexes), 1),
      dispersion: stats ? round(stats.p90_minus_p10, 2) : null,
      coverage: calculateMarketCoverage(
        obs,
        data.outlets.filter((o) => o.territory_id === territory.id),
        config,
        now,
      ),
      tme_visits: new Set(obs.map((o) => o.visit_id)).size,
      outlets: new Set(obs.map((o) => o.outlet_id)).size,
    };
  });
}

/** §9.3 — Top Actions panel: highest-value opportunities plus material competitor moves. */
export function buildTopActions(opportunities, competitorMoves, dispersion, limit = 6) {
  const items = [];
  for (const opp of opportunities.slice(0, limit)) {
    items.push({
      kind: 'opportunity',
      priority: opp.priority_label,
      score: opp.priority_score,
      title: `${opp.jti_sku_name} — ${opp.outlet_name}`,
      subtitle: `${opp.territory_name} · ${opp.outlet_count} outlet${opp.outlet_count === 1 ? '' : 's'} affected`,
      reason: opp.reason,
      suggested_action: opp.suggested_action,
      opportunity: opp,
    });
  }
  for (const move of competitorMoves.slice(0, 3)) {
    items.push({
      kind: 'competitor_move',
      priority: move.priority,
      score: move.magnitude * 8,
      title: `${move.competitor_sku_name} ${move.change < 0 ? 'decreased' : 'increased'} by SGD ${Math.abs(move.change).toFixed(2)}`,
      subtitle: `${move.affected_observations} affected JTI observations across ${move.affected_outlets} outlets`,
      reason: `Mapped JTI SKU Price Index now ${move.new_price_index ?? '—'}`,
      suggested_action: 'Review competitive position',
      move,
    });
  }
  for (const row of dispersion.filter((d) => d.high_dispersion).slice(0, 2)) {
    items.push({
      kind: 'dispersion',
      priority: row.is_strategic ? 'High' : 'Medium',
      score: row.stats.p90_minus_p10 * 30,
      title: `High dispersion — ${row.sku_name}`,
      subtitle: `${row.outlets} outlets · P90−P10 SGD ${row.stats.p90_minus_p10.toFixed(2)}`,
      reason: `Median SGD ${row.stats.median.toFixed(2)} · P10 SGD ${row.stats.p10.toFixed(2)} · P90 SGD ${row.stats.p90.toFixed(2)}`,
      suggested_action: 'Review price dispersion across outlets',
      dispersion: row,
    });
  }
  const rank = { High: 0, Medium: 1, Low: 2 };
  items.sort((a, b) => (rank[a.priority] - rank[b.priority]) || b.score - a.score);
  return items.slice(0, limit + 4);
}

/**
 * Convenience: assembles the full analytics bundle every manager page needs.
 */
export function buildAnalytics(data, filters, config, now = new Date().toISOString()) {
  const all = enrichObservations(data, config, now);
  const everything = applyFilters(all, filters);

  // The trusted current picture drives the headline numbers; the full history drives trends
  // and the record. Which one a screen is showing is stated on the screen.
  const snapshot = applySnapshot(everything, config, { now, mode: filters.snapshot_mode });
  // A verified price still on screen while somebody has already been back and read something
  // else. Which of the two is right is exactly what nobody has established, so it is carried
  // through to be shown rather than resolved here.
  snapshot.superseded_by_pending = supersededByPending(snapshot);
  const scoped = snapshot.observations;

  const competitorMoves = detectCompetitorMoves(everything, data, config, now);
  const dispersion = calculateDispersion(scoped, config);
  const dispersionFlags = new Set(dispersion.filter((d) => d.high_dispersion).map((d) => d.sku_id));
  const opportunities = deriveOpportunities(
    everything,
    {
      competitorMoves,
      dispersionFlags,
      fieldActions: data.field_actions,
      current: scoped,
      states: data.opportunity_states ?? {},
    },
    config,
    now,
  );
  const previous = previousPeriodObservations(all, filters);
  const kpis = calculateKpis(scoped, config, previous);
  kpis.pricing_opportunities = opportunities.length;
  kpis.strategic_opportunities = opportunities.filter((o) => o.is_strategic).length;
  kpis.high_priority_opportunities = opportunities.filter((o) => o.priority_label === 'High').length;
  kpis.recent_competitor_moves = competitorMoves.length;
  kpis.coverage = calculateMarketCoverage(scoped, data.outlets, config, now, filters);

  const coverage = calculateCoverage(scoped, everything, data, {
    filters,
    now,
    windowDays: snapshot.window_days ?? config.freshness.aging_max_days,
    excluded: snapshot.excluded,
  });

  return {
    now,
    all,
    snapshot,
    coverage,
    /** Every observation the filters select, before the snapshot narrows it. */
    historical: everything,
    observations: scoped,
    kpis,
    matrix: buildPriceMatrix(scoped),
    opportunities,
    competitorMoves,
    dispersion,
    // Sequences need the full history: a before/after pair is two observations of the same
    // shelf, and the snapshot deliberately keeps only one of them.
    fieldEffectiveness: calculateFieldEffectiveness(everything, data, opportunities, config, now),
    territories: buildTerritorySummary(scoped, data, opportunities, config, now),
    topActions: buildTopActions(opportunities, competitorMoves, dispersion),
    /** Grouped by issue, SKU and scope, for the GM Overview. Outlets are the drill-down. */
    signals: buildSignals(opportunities, {
      now,
      users: data.users,
      // Selecting a territory already scopes the group; grouping by territory nationally just
      // repeats one story three times and crowds out the others.
      scopeBy: filters.territory_id ? 'territory' : 'selection',
    }),
    categories: OPPORTUNITY_CATEGORIES,
  };
}

/** Same-length window immediately before the selected range, for period-over-period deltas. */
function previousPeriodObservations(all, filters) {
  if (!filters.from || !filters.to) return null;
  const from = toDate(filters.from);
  const to = toDate(filters.to);
  const span = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - span);
  return applyFilters(all, { ...filters, from: prevFrom.toISOString(), to: from.toISOString() });
}
