/**
 * VisitService — the field workflow: recognition → confirmation → evaluation → submit
 * (§8.5 – §8.12).
 *
 * Draft observations carry BOTH the original detected value and the confirmed value, plus
 * a `manual_correction` flag, so corrections remain available as labelled examples for
 * future model improvement (§8.7).
 */

import { analyzePriceImage } from './recognition/provider.js';
import { resolveEffectivePriceRule, snapshotPriceRule } from './priceRuleService.js';
import {
  resolveCompetitorMapping,
  snapshotCompetitorMapping,
} from './competitorMappingService.js';
import { evaluateObservation, fieldRecommendation, RANGE_BUCKET } from './pricePositionService.js';
import { PRICE_POSITION_STATUS } from '../config.js';
import { calculatePriceGap, calculatePriceIndex } from './pricePositionService.js';

/**
 * Runs recognition over the visit's images and returns draft observations, each already
 * evaluated against the effective rule / mapping snapshots.
 */
export async function processVisitImages({ visit, outlet, images, data, config, observedAt }) {
  const when = observedAt ?? new Date().toISOString();
  const brands = new Map(data.brands.map((b) => [b.id, b]));
  const withBrand = data.skus.map((s) => ({ ...s, brand_name: brands.get(s.brand_id)?.name ?? '' }));

  const context = {
    outlet,
    market: data.market ?? 'SG',
    jtiSkus: withBrand.filter((s) => s.is_jti),
    competitorSkus: withBrand.filter((s) => !s.is_jti),
    priceRules: data.price_rules,
    competitorMappings: data.competitor_mappings,
    observedAt: when,
    currency: config.currency,
  };

  const drafts = [];
  for (const image of images) {
    const { provider, detections } = await analyzePriceImage(image, context);
    detections.forEach((detection, idx) => {
      drafts.push(
        buildDraftObservation({
          detection,
          detectionIndex: idx,
          image,
          provider,
          visit,
          outlet,
          data,
          config,
          observedAt: when,
        }),
      );
    });
  }
  return recomputeDrafts(drafts, config);
}

/** Creates one draft observation from a raw detection. */
export function buildDraftObservation({
  detection,
  detectionIndex = 0,
  image,
  provider,
  visit,
  outlet,
  data,
  config,
  observedAt,
}) {
  const sku = data.skus.find((s) => s.id === detection.sku_candidate) ?? null;
  const ctx = {
    market: data.market ?? 'SG',
    territory_id: outlet.territory_id,
    channel_id: outlet.channel_id,
    outlet_id: outlet.id,
    sku_id: sku?.id,
  };

  const isJti = Boolean(sku?.is_jti);
  const rule = isJti ? resolveEffectivePriceRule(data.price_rules, ctx, observedAt) : null;
  const mapping = isJti
    ? resolveCompetitorMapping(data.competitor_mappings, sku.id, ctx, observedAt)
    : null;

  return {
    draft_id: `${image.id}:${detectionIndex}`,
    visit_id: visit?.id ?? null,
    outlet_id: outlet.id,
    image_id: image.id,
    image_source: image.image_source,
    recognition_provider: provider,
    sku_id: sku?.id ?? null,
    sku,
    is_jti: isJti,
    raw_text: detection.raw_text,
    brand_candidate: detection.brand_candidate,
    alternatives: detection.alternatives ?? [],
    bounding_box: detection.bounding_box ?? null,
    detected_sku_id: detection.sku_candidate ?? null,
    detected_price: detection.price_candidate ?? null,
    confirmed_price: detection.price_candidate ?? null,
    currency: config.currency,
    recognition_confidence: detection.confidence ?? null,
    manual_correction: false,
    observed_at: observedAt,
    excluded: false,
    exclusion_reason: null,
    ...snapshotPriceRule(rule),
    ...snapshotCompetitorMapping(mapping),
  };
}

/** Applies a TME correction, preserving the original detection (§8.7). */
export function correctDraft(draft, patch, data, config, observedAt) {
  const next = { ...draft, ...patch };
  const skuChanged = patch.sku_id !== undefined && patch.sku_id !== draft.sku_id;
  const priceChanged =
    patch.confirmed_price !== undefined && patch.confirmed_price !== draft.confirmed_price;

  if (skuChanged) {
    const sku = data.skus.find((s) => s.id === patch.sku_id) ?? null;
    next.sku = sku;
    next.is_jti = Boolean(sku?.is_jti);
    const outlet = data.outlets.find((o) => o.id === draft.outlet_id);
    const ctx = {
      market: data.market ?? 'SG',
      territory_id: outlet?.territory_id,
      channel_id: outlet?.channel_id,
      outlet_id: outlet?.id,
      sku_id: sku?.id,
    };
    const rule = next.is_jti ? resolveEffectivePriceRule(data.price_rules, ctx, observedAt) : null;
    const mapping = next.is_jti
      ? resolveCompetitorMapping(data.competitor_mappings, sku.id, ctx, observedAt)
      : null;
    Object.assign(next, snapshotPriceRule(rule), snapshotCompetitorMapping(mapping));
  }

  if (skuChanged || priceChanged) {
    next.manual_correction = true;
  }
  return next;
}

/**
 * Recomputes every draft's evaluation, wiring in competitor prices observed in the SAME
 * visit so the field user sees a live Price Index before submitting (§8.6).
 */
export function recomputeDrafts(drafts, config) {
  const competitorPrices = new Map();
  for (const d of drafts) {
    if (!d.is_jti && d.sku_id && Number.isFinite(d.confirmed_price)) {
      competitorPrices.set(d.sku_id, d.confirmed_price);
    }
  }

  return drafts.map((d) => {
    if (!d.is_jti) return { ...d, evaluation: null };
    const competitorPrice = d.competitor_sku_id_snapshot
      ? (competitorPrices.get(d.competitor_sku_id_snapshot) ?? null)
      : null;
    const evaluation = evaluateObservation({
      confirmedPrice: d.confirmed_price,
      competitorPrice,
      ruleSnapshot: d,
      mappingSnapshot: d,
      confidence: d.recognition_confidence,
      confidenceThreshold: config.confidence_review_threshold,
      isStrategic: Boolean(d.sku?.is_strategic),
      comparisonMethod: config.comparison_method,
    });
    return {
      ...d,
      competitor_price: competitorPrice,
      price_gap: calculatePriceGap(d.confirmed_price, competitorPrice),
      price_index: calculatePriceIndex(d.confirmed_price, competitorPrice),
      evaluation,
      recommendation: fieldRecommendation(
        { ...evaluation, isStrategic: Boolean(d.sku?.is_strategic) },
        {},
      ),
    };
  });
}

/** §8.12 — visit summary counters. */
export function summariseVisit(drafts, images) {
  const jti = drafts.filter((d) => d.is_jti && !d.excluded);
  const competitor = drafts.filter((d) => !d.is_jti && !d.excluded);
  const count = (status) => jti.filter((d) => d.evaluation?.status === status).length;

  return {
    images_processed: images.length,
    jti_observations: jti.length,
    competitor_observations: competitor.length,
    within_range: jti.filter((d) => d.evaluation?.rangeBucket === RANGE_BUCKET.WITHIN).length,
    above_range: jti.filter((d) => d.evaluation?.rangeBucket === RANGE_BUCKET.ABOVE).length,
    below_range: jti.filter((d) => d.evaluation?.rangeBucket === RANGE_BUCKET.BELOW).length,
    at_risk: count(PRICE_POSITION_STATUS.AT_RISK),
    strong: count(PRICE_POSITION_STATUS.STRONG),
    review_required: count(PRICE_POSITION_STATUS.REVIEW),
    no_recommendation: count(PRICE_POSITION_STATUS.NONE),
    manual_corrections: drafts.filter((d) => d.manual_correction).length,
  };
}

/** Strips UI-only fields before the draft is persisted as a price_observation. */
export function toPersistableObservation(draft) {
  const {
    draft_id,
    sku,
    evaluation,
    recommendation,
    alternatives,
    competitor_price,
    price_gap,
    price_index,
    is_jti,
    ...rest
  } = draft;
  return rest;
}
