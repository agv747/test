/**
 * MVP recognition provider — a deterministic simulator (§27 "MVP provider").
 *
 * It produces plausible shelf detections for ANY uploaded image (camera or gallery,
 * including real shelf photos) by seeding a PRNG from the image identity, so the same
 * photo always yields the same result and demos are reproducible.
 *
 * The generated mix always contains the situations the demo script needs (§30):
 * one Within Recommended Range, one Above Recommended Range, one Competitive Position
 * At Risk and one low-confidence Review Required detection.
 *
 * Replace this module with a real OCR / vision call by registering another provider —
 * nothing else in the app changes.
 */

import { rngFor } from '../../lib/rng.js';
import { round } from '../../lib/stats.js';
import { resolveEffectivePriceRule } from '../priceRuleService.js';

/**
 * How many packs of a product stand side by side, and on which shelf.
 *
 * A real shelf holds several facings of the same product; a real vision model is asked to
 * count them. The simulator does the same so the schematic is exercised with the shape it
 * gets in the field rather than one pack per product.
 */
function shelfPlan(rand, index) {
  return { shelf: Math.floor(index / 2) + 1, facings: 1 + Math.floor(rand() * 3) };
}

/** Detection "recipes" — engineered offsets from the recommended price. */
const RECIPES = [
  { key: 'within', offset: 0, confidence: [0.93, 0.99] },
  { key: 'above', offset: 0.6, confidence: [0.9, 0.98] },
  { key: 'slightly_above', offset: 0.25, confidence: [0.88, 0.97] },
  { key: 'below', offset: -0.45, confidence: [0.9, 0.97] },
  { key: 'low_confidence', offset: 0.1, confidence: [0.48, 0.72] },
];

function jitter(rand, amount) {
  return round((rand() - 0.5) * 2 * amount, 2);
}

/** Singapore shelf prices are set in 5-cent steps, so detections are snapped to that grid. */
function priceFor(rand, basePrice, offset) {
  const raw = basePrice + offset + jitter(rand, 0.08);
  return round(Math.round(raw * 20) / 20, 2);
}

export const mockRecognitionProvider = {
  id: 'mock-simulator',
  label: 'MVP Simulator',
  kind: 'simulated',
  /** This provider never looks at the image; the UI states that plainly. */
  reads_image: false,
  description:
    'Generates plausible detections from the SKU catalogue and price rules without looking at the image.',
  cost: 'Free',

  /**
   * @param {{id:string,name:string,size:number,image_source:string}} image
   * @param {{outlet:object, jtiSkus:object[], competitorSkus:object[], priceRules:object[],
   *          competitorMappings:object[], observedAt:string, market:string}} context
   */
  async analyzePriceImage(image, context) {
    const {
      outlet,
      jtiSkus = [],
      competitorSkus = [],
      priceRules = [],
      competitorMappings = [],
      observedAt,
      market = 'SG',
    } = context;

    const seedKey = `${image.id || image.name}|${image.size || 0}|${outlet?.id || 'no-outlet'}`;
    const rand = rngFor(seedKey);

    // Pick 3 JTI SKUs deterministically (rotated by image seed so different photos differ).
    const jtiPool = jtiSkus.filter((s) => s.active !== false);
    const startIdx = Math.floor(rand() * Math.max(1, jtiPool.length));
    const chosenJti = [];
    for (let i = 0; i < Math.min(3, jtiPool.length); i += 1) {
      chosenJti.push(jtiPool[(startIdx + i) % jtiPool.length]);
    }

    const detections = [];

    chosenJti.forEach((sku, idx) => {
      const recipe = RECIPES[idx === 0 ? 0 : idx === 1 ? 1 : 3];
      const rule = resolveEffectivePriceRule(
        priceRules,
        {
          sku_id: sku.id,
          market,
          territory_id: outlet?.territory_id,
          channel_id: outlet?.channel_id,
          outlet_id: outlet?.id,
        },
        observedAt,
      );
      const base = rule?.recommended_price ?? 14.0;
      const price = priceFor(rand, base, recipe.offset);
      const confidence = round(
        recipe.confidence[0] + rand() * (recipe.confidence[1] - recipe.confidence[0]),
        2,
      );
      detections.push({
        raw_text: `${sku.name.toUpperCase()}  $${price.toFixed(2)}`,
        brand_candidate: sku.brand_name,
        sku_candidate: sku.id,
        price_candidate: price,
        confidence,
        alternatives: alternativesFor(jtiPool, sku, rand),
        detected_is_jti: true,
        ...shelfPlan(rand, detections.length),
      });
    });

    // Mapped competitor SKUs so the visit can compute a real Price Index in-session.
    const mappedCompetitorIds = new Set(
      competitorMappings
        .filter((m) => chosenJti.some((s) => s.id === m.jti_sku_id) && m.active !== false)
        .map((m) => m.competitor_sku_id),
    );
    const competitorPool = competitorSkus.filter((s) => mappedCompetitorIds.has(s.id));
    const chosenCompetitors = competitorPool.slice(0, 2);

    chosenCompetitors.forEach((sku, idx) => {
      // Competitor priced just under the mapped JTI SKU → creates a realistic
      // "Competitive Position At Risk" case for at least one pair.
      const mapping = competitorMappings.find((m) => m.competitor_sku_id === sku.id);
      const jtiSku = chosenJti.find((s) => s.id === mapping?.jti_sku_id);
      const jtiDetection = detections.find((d) => d.sku_candidate === jtiSku?.id);
      const base = jtiDetection?.price_candidate ?? 14.0;
      const raw = base - (idx === 0 ? 0.7 : 0.15) + jitter(rand, 0.06);
      const price = round(Math.round(raw * 20) / 20, 2);
      detections.push({
        raw_text: `${sku.name.toUpperCase()}  $${price.toFixed(2)}`,
        brand_candidate: sku.brand_name,
        sku_candidate: sku.id,
        price_candidate: price,
        confidence: round(0.86 + rand() * 0.12, 2),
        alternatives: [],
        detected_is_jti: false,
        ...shelfPlan(rand, detections.length),
      });
    });

    // One deliberately low-confidence detection → Review Required + Image Review queue.
    if (jtiPool.length) {
      const sku = jtiPool[(startIdx + 3) % jtiPool.length];
      const rule = resolveEffectivePriceRule(
        priceRules,
        {
          sku_id: sku.id,
          market,
          territory_id: outlet?.territory_id,
          channel_id: outlet?.channel_id,
          outlet_id: outlet?.id,
        },
        observedAt,
      );
      const base = rule?.recommended_price ?? 14.0;
      detections.push({
        raw_text: `${sku.name.slice(0, 6).toUpperCase()}…  $${priceFor(rand, base, 0.1).toFixed(2)}?`,
        brand_candidate: sku.brand_name,
        sku_candidate: sku.id,
        price_candidate: priceFor(rand, base, 0.1),
        confidence: round(0.5 + rand() * 0.2, 2),
        alternatives: alternativesFor(jtiPool, sku, rand),
        detected_is_jti: true,
        ...shelfPlan(rand, detections.length),
      });
    }

    return detections;
  },
};

function alternativesFor(pool, sku, rand) {
  return pool
    .filter((s) => s.id !== sku.id)
    .slice(0, 2)
    .map((s) => ({
      sku_id: s.id,
      label: s.name,
      confidence: round(0.1 + rand() * 0.25, 2),
    }));
}
