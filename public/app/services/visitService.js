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
    /** The ticket colour the model read, the only thing telling two plain packs apart. */
    ticket_colour: detection.ticket_colour ?? null,
    bounding_box: detection.bounding_box ?? null,
    // Shelf geometry the provider counted rather than measured. Held on the draft for the
    // schematic; `toRow` writes only declared columns, so neither reaches the database.
    shelf: detection.shelf ?? null,
    facings: detection.facings ?? 1,
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
 * Marks detections that look like two different variants reported as one product.
 *
 * Under plain packaging two variants of a brand sit side by side, look almost identical and
 * usually cost the same. A vision model reading such a shelf resolves both to whichever
 * variant it could read, and the two facings come back as one product at one price — the
 * failure a TME will not notice, because the answer looks entirely reasonable.
 *
 * The price ticket is what tells them apart, so the model is asked for its colour. Two
 * detections on the SAME shelf that resolve to the SAME SKU but carry DIFFERENT ticket
 * colours are the signature: the same product does not have two ticket colours on one shelf.
 *
 * This flags rather than corrects. Which variant the second one actually is cannot be known
 * from here — that is precisely what the model failed to read — so it is put in front of the
 * TME, who is standing at the shelf.
 *
 * A detection the TME has corrected by hand takes no further part: the flag exists to catch
 * what the model merged, and once a person looking at the pack has said what it is, the app
 * has nothing left to raise. Without that, correcting one facing to the variant the model
 * had already found on the same shelf simply re-raised the flag against itself.
 */
export function flagVariantConflicts(drafts) {
  const seen = new Map();
  for (const draft of drafts ?? []) {
    if (!draft.sku_id || !draft.ticket_colour || draft.manual_correction) continue;
    const key = `${draft.shelf ?? 'any'}|${draft.sku_id}`;
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(draft.ticket_colour.toLowerCase());
  }

  return (drafts ?? []).map((draft) => {
    if (draft.manual_correction) return { ...draft, variant_conflict: false };
    const key = `${draft.shelf ?? 'any'}|${draft.sku_id}`;
    const colours = seen.get(key);
    return { ...draft, variant_conflict: Boolean(colours && colours.size > 1) };
  });
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

  return flagVariantConflicts(drafts).map((d) => {
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
    variant_conflicts: drafts.filter((d) => d.variant_conflict && !d.excluded).length,
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
