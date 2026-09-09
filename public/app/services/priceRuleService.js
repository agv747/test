/**
 * PriceRuleService — resolves the JTI recommended price rule that was effective for a
 * given observation context at a given point in time (§8.8, §20, §25).
 *
 * RULE RESOLUTION LOGIC (documented per spec §20):
 *
 *   A candidate rule matches when
 *     - it is active, and
 *     - its market equals the observation market, and
 *     - its sku_id equals the observed SKU, and
 *     - observed_at falls inside [effective_from, effective_to] (effective_to may be null), and
 *     - each of territory_id / channel_id / outlet_id is either null (wildcard) or equal
 *       to the observation context value.
 *
 *   Among matching rules the MOST SPECIFIC wins, using this precedence:
 *
 *     Outlet-specific            (outlet set)                      weight 8
 *     Channel + Territory        (territory + channel set)          weight 4 + 2 = 6
 *     Territory-specific         (territory set)                    weight 4
 *     Channel-specific           (channel set)                      weight 2
 *     Market-level               (all wildcards)                    weight 0
 *
 *   Ties are broken by explicit `priority` (higher wins), then by the most recent
 *   `effective_from`, then by rule id — so resolution is fully deterministic.
 *
 * HISTORICAL INTEGRITY (§25): callers resolve at observation time and persist a snapshot
 * of the resolved thresholds onto the observation. Analytics read the snapshot, never the
 * live master rule, unless an explicit restatement is requested.
 */

import { isEffectiveAt, toDate } from '../lib/dates.js';

const OUTLET_WEIGHT = 8;
const TERRITORY_WEIGHT = 4;
const CHANNEL_WEIGHT = 2;

export function ruleSpecificity(rule) {
  return (
    (rule.outlet_id ? OUTLET_WEIGHT : 0) +
    (rule.territory_id ? TERRITORY_WEIGHT : 0) +
    (rule.channel_id ? CHANNEL_WEIGHT : 0)
  );
}

export function ruleScopeLabel(rule) {
  if (rule.outlet_id) return 'Outlet';
  if (rule.territory_id && rule.channel_id) return 'Territory + Channel';
  if (rule.territory_id) return 'Territory';
  if (rule.channel_id) return 'Channel';
  return 'Market';
}

function matches(rule, ctx, observedAt) {
  if (rule.active === false) return false;
  if (rule.sku_id !== ctx.sku_id) return false;
  if (rule.market && ctx.market && rule.market !== ctx.market) return false;
  if (rule.territory_id && rule.territory_id !== ctx.territory_id) return false;
  if (rule.channel_id && rule.channel_id !== ctx.channel_id) return false;
  if (rule.outlet_id && rule.outlet_id !== ctx.outlet_id) return false;
  return isEffectiveAt(rule, observedAt);
}

/**
 * @param {object[]} rules all price rules (master data)
 * @param {{sku_id:string, market?:string, territory_id?:string, channel_id?:string, outlet_id?:string}} ctx
 * @param {string|Date} observedAt
 * @returns {object|null} the winning rule, or null when no recommendation exists
 */
export function resolveEffectivePriceRule(rules, ctx, observedAt) {
  const candidates = rules.filter((r) => matches(r, ctx, observedAt));
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const spec = ruleSpecificity(b) - ruleSpecificity(a);
    if (spec !== 0) return spec;
    const prio = (b.priority ?? 0) - (a.priority ?? 0);
    if (prio !== 0) return prio;
    const fromA = toDate(a.effective_from)?.getTime() ?? 0;
    const fromB = toDate(b.effective_from)?.getTime() ?? 0;
    if (fromB !== fromA) return fromB - fromA;
    return String(a.id).localeCompare(String(b.id));
  });
  return candidates[0];
}

/** Builds the immutable snapshot stored on an observation (§23 observation_rule_context). */
export function snapshotPriceRule(rule) {
  if (!rule) {
    return {
      price_rule_id: null,
      recommended_price_snapshot: null,
      recommended_min_snapshot: null,
      recommended_max_snapshot: null,
    };
  }
  return {
    price_rule_id: rule.id,
    recommended_price_snapshot: rule.recommended_price,
    recommended_min_snapshot: rule.recommended_min,
    recommended_max_snapshot: rule.recommended_max,
  };
}

/**
 * Overlap validation for the Price Rules admin screen (§20).
 * Two rules conflict when they target the same SKU + identical scope (same territory /
 * channel / outlet triple), share the same priority and their effective windows overlap —
 * i.e. resolution would be ambiguous but for the id tie-break.
 *
 * @returns {{rule_a:string, rule_b:string, reason:string}[]}
 */
export function findOverlappingRules(rules) {
  const conflicts = [];
  const active = rules.filter((r) => r.active !== false);
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      if (a.sku_id !== b.sku_id) continue;
      if ((a.market ?? null) !== (b.market ?? null)) continue;
      if ((a.territory_id ?? null) !== (b.territory_id ?? null)) continue;
      if ((a.channel_id ?? null) !== (b.channel_id ?? null)) continue;
      if ((a.outlet_id ?? null) !== (b.outlet_id ?? null)) continue;
      if (!windowsOverlap(a, b)) continue;
      if ((a.priority ?? 0) !== (b.priority ?? 0)) continue;
      conflicts.push({
        rule_a: a.id,
        rule_b: b.id,
        reason: 'Identical scope, overlapping effective dates and equal priority',
      });
    }
  }
  return conflicts;
}

export function windowsOverlap(a, b) {
  const aFrom = toDate(a.effective_from)?.getTime() ?? -Infinity;
  const aTo = toDate(a.effective_to)?.getTime() ?? Infinity;
  const bFrom = toDate(b.effective_from)?.getTime() ?? -Infinity;
  const bTo = toDate(b.effective_to)?.getTime() ?? Infinity;
  return aFrom <= bTo && bFrom <= aTo;
}
