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

/** §9.1 — Market coverage: outlets observed recently vs. active outlets in scope. */
export function calculateMarketCoverage(observations, outlets, config, now) {
  const active = outlets.filter((o) => o.active !== false);
  const recent = new Set(
    observations
      .filter((o) => (daysBetween(o.observed_at, now) ?? Infinity) <= config.freshness.aging_max_days)
      .map((o) => o.outlet_id),
  );
  return {
    expected_outlets: active.length,
    observed_outlets: recent.size,
    coverage_pct: active.length ? round((recent.size / active.length) * 100, 1) : null,
    window_days: config.freshness.aging_max_days,
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
 */
export function deriveOpportunities(observations, context, config, now) {
  const { competitorMoves = [], dispersionFlags = new Set(), fieldActions = [] } = context;
  const movedSkus = new Set(competitorMoves.flatMap((m) => m.affected_jti_sku_ids));

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
    const latest = list[list.length - 1];
    if (!isOpportunity(latest.evaluation)) continue;

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

    const outletCount = countAffectedOutlets(observations, latest.sku_id);
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
      assigned_user_id: latest.outlet?.assigned_tme_id ?? null,
      last_action: lastAction ?? null,
      observations: list,
      status: 'New',
      recognition_confidence: latest.recognition_confidence,
      freshness: latest.freshness,
    };
    opp.reason = opportunityReason(opp);
    opp.suggested_action = suggestedAction(opp);
    opportunities.push(opp);
  }

  opportunities.sort((a, b) => b.priority_score - a.priority_score);
  return opportunities;
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

/** §13 — material competitor price movements within the lookback window. */
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

    const previous = round(median(before.map((o) => o.confirmed_price)), 2);
    const current = round(median(after.map((o) => o.confirmed_price)), 2);
    const change = round(current - previous, 2);
    const pctChange = previous ? round((change / previous) * 100, 2) : 0;
    if (Math.abs(change) < min_abs_change && Math.abs(pctChange) < min_pct_change) continue;

    const affectedMappings = mappings.filter((m) => m.competitor_sku_id === skuId);
    const affectedJtiSkuIds = [...new Set(affectedMappings.map((m) => m.jti_sku_id))];
    const affectedJtiObs = observations.filter(
      (o) => o.is_jti && affectedJtiSkuIds.includes(o.sku_id) && toDate(o.observed_at) >= cutoff,
    );
    const jtiMedian = round(median(affectedJtiObs.map((o) => o.confirmed_price)), 2);
    const newGap = jtiMedian !== null && current !== null ? round(jtiMedian - current, 2) : null;
    const newIndex =
      jtiMedian !== null && current ? round((jtiMedian / current) * 100, 1) : null;

    const strategicAffected = affectedJtiObs.some((o) => o.is_strategic);
    const magnitude = Math.abs(pctChange) * (strategicAffected ? config.competitor_move.strategic_mapping_weight : 1);

    moves.push({
      competitor_sku_id: skuId,
      competitor_sku_name: after[0].sku_name,
      competitor_brand: after[0].brand_name,
      competitor_company: after[0].company,
      previous_price: previous,
      current_price: current,
      change,
      pct_change: pctChange,
      affected_jti_sku_ids: affectedJtiSkuIds,
      affected_jti_sku_names: affectedJtiSkuIds.map(
        (id) => data.skus.find((s) => s.id === id)?.name ?? id,
      ),
      affected_outlets: new Set(affectedJtiObs.map((o) => o.outlet_id)).size,
      affected_observations: affectedJtiObs.length,
      new_gap: newGap,
      new_price_index: newIndex,
      strategic_affected: strategicAffected,
      magnitude: round(magnitude, 2),
      priority: magnitude >= 6 ? 'High' : magnitude >= 3 ? 'Medium' : 'Low',
      detected_at: after[after.length - 1].observed_at,
    });
  }

  moves.sort((a, b) => b.magnitude - a.magnitude);
  return moves;
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

/** §12 — price ladder built on median observed retail price. */
export function buildPriceLadder(observations, config, options = {}) {
  const { include = 'all' } = options;
  const groups = new Map();
  for (const o of observations) {
    if (include === 'jti' && !o.is_jti) continue;
    if (include === 'competitor' && o.is_jti) continue;
    if (!groups.has(o.sku_id)) groups.set(o.sku_id, []);
    groups.get(o.sku_id).push(o);
  }
  const rungs = [];
  for (const [skuId, list] of groups) {
    const first = list[0];
    const stats = describe(list.map((o) => o.confirmed_price));
    /**
     * The recommendation shown on the ladder is the MEDIAN of the snapshots in scope, not
     * the value from an arbitrary observation. A filtered range can span a rule change or
     * several territory overrides, and the median is the representative figure across
     * whatever mix the current filters produce.
     */
    const snapshotMedian = (key) => {
      const values = list.map((o) => o[key]).filter((v) => Number.isFinite(v));
      return values.length ? round(median(values), 2) : null;
    };
    rungs.push({
      sku_id: skuId,
      sku_name: first.sku_name,
      brand_name: first.brand_name,
      company: first.company,
      is_jti: first.is_jti,
      is_strategic: first.is_strategic,
      median_price: round(stats.median, 2),
      recommended_price: snapshotMedian('recommended_price_snapshot'),
      recommended_min: snapshotMedian('recommended_min_snapshot'),
      recommended_max: snapshotMedian('recommended_max_snapshot'),
      price_index: first.is_jti ? round(median(list.map((o) => o.evaluation?.priceIndex).filter(Number.isFinite)), 1) : null,
      observations: stats.count,
      outlets: new Set(list.map((o) => o.outlet_id)).size,
    });
  }
  rungs.sort((a, b) => b.median_price - a.median_price);
  return { rungs, insights: dedupe(ladderInsights(rungs, config)) };
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

  const topJti = jti[0];
  const topCompetitor = competitor[0];
  if (topJti && topCompetitor && topCompetitor.median_price > topJti.median_price) {
    insights.push({
      tone: 'watch',
      title: 'Premium position under pressure',
      detail: `${topCompetitor.sku_name} (SGD ${topCompetitor.median_price.toFixed(2)}) is priced above the highest observed JTI SKU ${topJti.sku_name}.`,
    });
  }

  const valueJti = jti[jti.length - 1];
  const competitorCore = competitor.find((c) => /core/i.test(c.sku_name));
  if (valueJti && competitorCore && valueJti.median_price > competitorCore.median_price) {
    insights.push({
      tone: 'risk',
      title: 'Value SKU priced above competitor core',
      detail: `${valueJti.sku_name} (SGD ${valueJti.median_price.toFixed(2)}) is above ${competitorCore.sku_name} (SGD ${competitorCore.median_price.toFixed(2)}).`,
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
  let engagedWithSubsequent = 0;
  let engagedWithPriceChange = 0;
  const detectionToActionDays = [];
  const actionToNextObsDays = [];
  const gapImprovements = [];

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

      if (!after) continue;
      engagedWithSubsequent += 1;
      const d2 = daysBetween(action.action_at, after.observed_at);
      if (d2 !== null) actionToNextObsDays.push(d2);

      const priceChanged = Math.abs(after.confirmed_price - before.confirmed_price) >= 0.05;
      if (priceChanged) engagedWithPriceChange += 1;

      const gapBefore = before.evaluation?.gap;
      const gapAfter = after.evaluation?.gap;
      if (Number.isFinite(gapBefore) && Number.isFinite(gapAfter)) {
        gapImprovements.push(round(Math.abs(gapBefore) - Math.abs(gapAfter), 2));
      }

      timeline.push({
        outlet_id: action.outlet_id,
        outlet_name: before.outlet_name,
        territory_name: before.territory_name,
        sku_id: skuId,
        sku_name: before.sku_name,
        is_strategic: before.is_strategic,
        action_type: action.action_type,
        action_at: action.action_at,
        user_id: action.user_id,
        before: {
          observed_at: before.observed_at,
          jti_price: before.confirmed_price,
          competitor_price: before.competitor_price,
          gap: gapBefore ?? null,
          price_index: before.evaluation?.priceIndex ?? null,
          status: before.evaluation?.status ?? null,
        },
        after: {
          observed_at: after.observed_at,
          jti_price: after.confirmed_price,
          competitor_price: after.competitor_price,
          gap: gapAfter ?? null,
          price_index: after.evaluation?.priceIndex ?? null,
          status: after.evaluation?.status ?? null,
        },
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

  return {
    label: 'Observed price change after engagement',
    disclaimer:
      'Sequence of observations only. This view does not attribute price movement to field action.',
    opportunities_identified: opportunities.length,
    opportunities_engaged: opportunitiesEngaged,
    outlet_agreed_to_review: agreedToReview,
    observed_price_changes: engagedWithPriceChange,
    engagements_with_subsequent_observation: engagedWithSubsequent,
    engagement_to_price_change_rate: engagedWithSubsequent
      ? round((engagedWithPriceChange / engagedWithSubsequent) * 100, 1)
      : null,
    opportunities_resolved: resolved,
    opportunity_resolution_rate: opportunitiesEngaged
      ? round((resolved / opportunitiesEngaged) * 100, 1)
      : null,
    median_detection_to_action_days: round(median(detectionToActionDays), 1),
    median_action_to_next_observation_days: round(median(actionToNextObsDays), 1),
    median_gap_improvement: round(median(gapImprovements), 2),
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
  const scoped = applyFilters(all, filters);

  const competitorMoves = detectCompetitorMoves(scoped, data, config, now);
  const dispersion = calculateDispersion(scoped, config);
  const dispersionFlags = new Set(dispersion.filter((d) => d.high_dispersion).map((d) => d.sku_id));
  const opportunities = deriveOpportunities(
    scoped,
    { competitorMoves, dispersionFlags, fieldActions: data.field_actions },
    config,
    now,
  );
  const previous = previousPeriodObservations(all, filters);
  const kpis = calculateKpis(scoped, config, previous);
  kpis.pricing_opportunities = opportunities.length;
  kpis.strategic_opportunities = opportunities.filter((o) => o.is_strategic).length;
  kpis.high_priority_opportunities = opportunities.filter((o) => o.priority_label === 'High').length;
  kpis.recent_competitor_moves = competitorMoves.length;
  kpis.coverage = calculateMarketCoverage(scoped, data.outlets, config, now);

  return {
    now,
    all,
    observations: scoped,
    kpis,
    matrix: buildPriceMatrix(scoped),
    opportunities,
    competitorMoves,
    dispersion,
    fieldEffectiveness: calculateFieldEffectiveness(scoped, data, opportunities, config, now),
    territories: buildTerritorySummary(scoped, data, opportunities, config, now),
    topActions: buildTopActions(opportunities, competitorMoves, dispersion),
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
