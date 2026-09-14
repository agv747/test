/**
 * Coverage, with denominators that belong to the scope being looked at (GM review §C).
 *
 * The Control Tower filtered to East reported 25% market coverage — six outlets of
 * twenty-four. Six was East's; twenty-four was the whole network's. A territory manager
 * reading their own screen was shown the territory's share of the country as if it were
 * their own completeness. Visiting every outlet they have would never have reached 100%.
 *
 * So each metric here carries its own numerator, denominator and exclusions, and every one
 * of them is computed inside the selected scope. Four separate questions, deliberately not
 * blended into one number:
 *
 *   outlet visit coverage      have we been to the outlets we are supposed to cover?
 *   fresh SKU coverage         of what those outlets carry, how much do we have a price for?
 *   comparable-pair availability  where a comparison is required, do we have one?
 *   competitive alignment      of the comparisons we do have, how many sit where intended?
 *
 * The first two answer "have we looked", the last two "what did we find". Reporting them as
 * one figure hides which is missing.
 */

import { daysBetween } from '../lib/dates.js';
import { round } from '../lib/stats.js';

/** Outlets the current filters actually select. */
export function outletsInScope(outlets, filters = {}) {
  return outlets.filter((outlet) => {
    if (outlet.active === false) return false;
    if (filters.territory_id && outlet.territory_id !== filters.territory_id) return false;
    if (filters.channel_id && outlet.channel_id !== filters.channel_id) return false;
    if (filters.outlet_id && outlet.id !== filters.outlet_id) return false;
    if (filters.user_id && outlet.assigned_tme_id !== filters.user_id) return false;
    return true;
  });
}

/**
 * The outlet–SKU combinations an outlet is expected to have a price for.
 *
 * Not every outlet sells every SKU, so "all outlets × all SKUs" would invent a denominator
 * that no amount of fieldwork could ever fill. The assortment is taken from what has
 * actually been observed there at least once across the whole history: an outlet that has
 * never stocked LD is not marked as missing an LD price. This is a working definition until
 * the business supplies an approved assortment, and the screens say so.
 */
export function expectedAssortment(allObservations, outletIds, options = {}) {
  const { jtiOnly = true } = options;
  const scope = new Set(outletIds);
  const pairs = new Set();
  for (const observation of allObservations) {
    if (!scope.has(observation.outlet_id)) continue;
    if (jtiOnly && !observation.is_jti) continue;
    if (!observation.sku_id) continue;
    pairs.add(`${observation.outlet_id}|${observation.sku_id}`);
  }
  return pairs;
}

function metric(numerator, denominator, extra = {}) {
  return {
    numerator,
    denominator,
    pct: denominator ? round((numerator / denominator) * 100, 1) : null,
    ...extra,
  };
}

/**
 * @param {object[]} snapshotObservations the trusted current picture, already scoped
 * @param {object[]} allObservations every observation, for the expected assortment
 * @param {object} data master data (outlets)
 * @param {object} options { filters, now, windowDays, excluded }
 */
export function calculateCoverage(snapshotObservations, allObservations, data, options = {}) {
  const { filters = {}, now = new Date().toISOString(), windowDays = 14, excluded = null } = options;

  const outlets = outletsInScope(data.outlets, filters);
  const outletIds = outlets.map((o) => o.id);
  const inScope = new Set(outletIds);

  const recentlyVisited = new Set(
    snapshotObservations
      .filter((o) => inScope.has(o.outlet_id))
      .filter((o) => (daysBetween(o.observed_at, now) ?? Infinity) <= windowDays)
      .map((o) => o.outlet_id),
  );

  const expected = expectedAssortment(allObservations, outletIds);
  const covered = new Set(
    snapshotObservations
      .filter((o) => o.is_jti && inScope.has(o.outlet_id))
      .map((o) => `${o.outlet_id}|${o.sku_id}`),
  );
  const coveredExpected = [...covered].filter((key) => expected.has(key));

  // A comparison is "required" where the SKU carries a competitor mapping at all; without
  // one there is nothing to compare against and nothing missing.
  const jti = snapshotObservations.filter((o) => o.is_jti && inScope.has(o.outlet_id));
  const requiringPair = jti.filter((o) => o.competitor_sku_id_snapshot);
  // `comparable_pair` is the single definition of a usable pair — two readings of the same
  // shelf, close enough in time. A median of other outlets in the territory does not count,
  // which is why this number is lower than it used to be and truer than it was.
  const withPair = requiringPair.filter((o) => o.comparable_pair);

  const matched = jti.filter((o) => o.evaluation?.competitive?.aligned !== null && o.evaluation?.competitive?.aligned !== undefined);
  const aligned = matched.filter((o) => o.evaluation.competitive.aligned === true);

  return {
    as_of: now,
    window_days: windowDays,
    scope_outlets: outlets.length,
    excluded,
    assortment_basis: 'outlet–SKU combinations observed at least once in the full history',

    outlet_visit_coverage: metric(recentlyVisited.size, outlets.length, {
      label: 'Outlet visit coverage',
      description: `Outlets in scope with an eligible observation in the last ${windowDays} days, out of active outlets in scope.`,
    }),

    fresh_sku_coverage: metric(coveredExpected.length, expected.size, {
      label: 'Fresh SKU coverage',
      description:
        'Expected outlet–SKU combinations with a current eligible observation, out of the expected assortment in scope.',
    }),

    comparable_pair_availability: metric(withPair.length, requiringPair.length, {
      label: 'Comparable-pair availability',
      description:
        'Current JTI observations with a usable competitor price observed close enough in time, out of those that carry a competitor mapping.',
    }),

    competitive_alignment: metric(aligned.length, matched.length, {
      label: 'Competitive alignment',
      description:
        'Matched pairs sitting inside the configured intended position, out of eligible matched pairs.',
    }),
  };
}
