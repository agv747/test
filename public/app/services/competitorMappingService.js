/**
 * CompetitorMappingService — resolves which competitor SKU a JTI SKU should be compared
 * against, and the desired competitive position for that pair (§8.9, §21).
 *
 * A JTI SKU may map to several competitor SKUs. For dashboard defaults the ACTIVE mapping
 * with the highest `mapping_priority` wins, unless the user explicitly chooses another
 * competitor SKU (pass `preferredCompetitorSkuId`).
 *
 * Scope specificity mirrors price rules: Territory + Channel > Territory > Channel > Market.
 */

import { isEffectiveAt, toDate } from '../lib/dates.js';

const TERRITORY_WEIGHT = 4;
const CHANNEL_WEIGHT = 2;

export function mappingSpecificity(mapping) {
  return (
    (mapping.territory_id ? TERRITORY_WEIGHT : 0) + (mapping.channel_id ? CHANNEL_WEIGHT : 0)
  );
}

function matches(mapping, jtiSkuId, ctx, observedAt) {
  if (mapping.active === false) return false;
  if (mapping.jti_sku_id !== jtiSkuId) return false;
  if (mapping.market && ctx.market && mapping.market !== ctx.market) return false;
  if (mapping.territory_id && mapping.territory_id !== ctx.territory_id) return false;
  if (mapping.channel_id && mapping.channel_id !== ctx.channel_id) return false;
  return isEffectiveAt(mapping, observedAt);
}

/**
 * @param {object[]} mappings
 * @param {string} jtiSkuId
 * @param {{market?:string, territory_id?:string, channel_id?:string}} ctx
 * @param {string|Date} observedAt
 * @param {string|null} preferredCompetitorSkuId manager override
 */
export function resolveCompetitorMapping(
  mappings,
  jtiSkuId,
  ctx,
  observedAt,
  preferredCompetitorSkuId = null,
) {
  let candidates = mappings.filter((m) => matches(m, jtiSkuId, ctx, observedAt));
  if (!candidates.length) return null;
  if (preferredCompetitorSkuId) {
    const preferred = candidates.filter((m) => m.competitor_sku_id === preferredCompetitorSkuId);
    if (preferred.length) candidates = preferred;
  }
  candidates.sort((a, b) => {
    const prio = (b.mapping_priority ?? 0) - (a.mapping_priority ?? 0);
    if (prio !== 0) return prio;
    const spec = mappingSpecificity(b) - mappingSpecificity(a);
    if (spec !== 0) return spec;
    const fromA = toDate(a.effective_from)?.getTime() ?? 0;
    const fromB = toDate(b.effective_from)?.getTime() ?? 0;
    if (fromB !== fromA) return fromB - fromA;
    return String(a.id).localeCompare(String(b.id));
  });
  return candidates[0];
}

/** All active mappings for a JTI SKU — used by the SKU page competitor selector. */
export function listMappingsForSku(mappings, jtiSkuId, ctx, observedAt) {
  return mappings
    .filter((m) => matches(m, jtiSkuId, ctx, observedAt))
    .sort((a, b) => (b.mapping_priority ?? 0) - (a.mapping_priority ?? 0));
}

/** Immutable snapshot persisted on an observation (§23, §25). */
export function snapshotCompetitorMapping(mapping) {
  if (!mapping) {
    return {
      competitor_mapping_id: null,
      competitor_sku_id_snapshot: null,
      desired_gap_min_snapshot: null,
      desired_gap_max_snapshot: null,
      desired_price_index_min_snapshot: null,
      desired_price_index_max_snapshot: null,
      comparison_method_snapshot: null,
    };
  }
  return {
    competitor_mapping_id: mapping.id,
    competitor_sku_id_snapshot: mapping.competitor_sku_id,
    desired_gap_min_snapshot: mapping.desired_gap_min,
    desired_gap_max_snapshot: mapping.desired_gap_max,
    desired_price_index_min_snapshot: mapping.desired_price_index_min,
    desired_price_index_max_snapshot: mapping.desired_price_index_max,
    comparison_method_snapshot: mapping.comparison_method ?? null,
  };
}
