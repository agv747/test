/**
 * Markets, and keeping them apart (spec v3 §2).
 *
 * Singapore asks whether a retail price sits where it was recommended to. Taiwan asks whether
 * a cigarette cabinet matches the planogram approved for it. Different currencies, different
 * law, different units of observation, and — this is the part a shared codebase gets wrong —
 * numbers that look like each other. A price alignment percentage and a planogram adherence
 * percentage are both "a percentage of things that are as intended", and nothing but an
 * explicit market boundary stops them being averaged into one figure that means nothing.
 *
 * So the market is a stored selection, never inferred from a currency or a browser locale, and
 * it scopes the dataset before any screen sees it. Every module below reads `ctx.data` and
 * `ctx.analytics`; if the market filter lives at that boundary, a Taiwan observation cannot
 * reach a Singapore KPI even by mistake, because it is not in the array.
 *
 * What this is NOT: authorization. This application has no authentication — anyone with the URL
 * can use it, and the role switcher is a demo control. Scoping the data a browser is shown is
 * not the same as a server refusing a request, and acceptance A23 asks for the second. That gap
 * is real, it is named in `docs/REPO-INSPECTION.md`, and it is not closed by this file.
 */

export const MODULE = {
  PRICE_INTELLIGENCE: 'price_intelligence',
  PLANOGRAM: 'planogram',
};

export const MODULE_LABEL = {
  [MODULE.PRICE_INTELLIGENCE]: 'Price Intelligence',
  [MODULE.PLANOGRAM]: 'Planogram Verification',
};

/**
 * The market definitions the application ships with.
 *
 * Seeded into the `markets` table, and used directly when the app runs on bundled data. A
 * market that is not in the database yet still resolves here, so adding one is a seed change
 * rather than a migration.
 */
export const MARKETS = [
  {
    id: 'mkt-sg',
    code: 'SG',
    name: 'Singapore',
    currency: 'SGD',
    timezone: 'Asia/Singapore',
    supported_locales: ['en-SG'],
    enabled_modules: [MODULE.PRICE_INTELLIGENCE],
    policy_version: 'sg-2026-09',
    active: true,
  },
  {
    id: 'mkt-tw',
    code: 'TW',
    name: 'Taiwan',
    currency: 'TWD',
    timezone: 'Asia/Taipei',
    /** zh-Hant first: the pack and the price card on a Taiwan shelf are read in it. */
    supported_locales: ['zh-Hant-TW', 'en'],
    enabled_modules: [MODULE.PLANOGRAM],
    policy_version: 'tw-pilot-v1',
    active: true,
  },
];

export const DEFAULT_MARKET_ID = 'mkt-sg';

export function listMarkets(data) {
  const stored = data?.markets?.length ? data.markets : MARKETS;
  return stored.filter((m) => m.active !== false);
}

export function findMarket(data, marketId) {
  return listMarkets(data).find((m) => m.id === marketId) ?? listMarkets(data)[0] ?? MARKETS[0];
}

export function hasModule(market, module) {
  return Boolean(market?.enabled_modules?.includes(module));
}

/**
 * Which market an entity belongs to.
 *
 * Rows written before the market column existed carry no `market_id`. They are Singapore's:
 * that is the only market the application had, and treating them as belonging to none would
 * make 1,322 real observations vanish from the market that recorded them. The fallback is
 * stated here once rather than repeated as a `?? 'mkt-sg'` at every call site.
 */
export function marketIdOf(entity, fallback = DEFAULT_MARKET_ID) {
  return entity?.market_id ?? fallback;
}

/** The entities that carry a market directly, and therefore filter directly. */
const MARKET_SCOPED = [
  'territories',
  'users',
  'brands',
  'skus',
  'outlets',
  'visits',
  'fixture_types',
  'fixtures',
  'planograms',
  'planogram_versions',
  'planogram_assignments',
  'planogram_exceptions',
  'capture_sets',
  'planogram_assessments',
  'execution_issues',
  'audit_events',
];

/**
 * The entities that inherit their market through a parent, and the column that points at it.
 *
 * A price observation has no market of its own — it belongs to the outlet it was read in, and
 * storing the market on it as well would create two answers to one question and no rule for
 * which wins when a migration touches only one of them.
 */
const INHERITED = {
  price_observations: { via: 'outlets', key: 'outlet_id' },
  field_actions: { via: 'outlets', key: 'outlet_id' },
  images: { via: 'visits', key: 'visit_id' },
  planogram_rules: { via: 'planogram_versions', key: 'version_id' },
  capture_images: { via: 'capture_sets', key: 'capture_set_id' },
  recognition_runs: { via: 'capture_sets', key: 'capture_set_id' },
  observed_facings: { via: 'capture_sets', key: 'capture_set_id' },
  evidence_regions: { via: 'capture_sets', key: 'capture_set_id' },
  rule_results: { via: 'planogram_assessments', key: 'assessment_id' },
  issue_events: { via: 'execution_issues', key: 'issue_id' },
  facing_evidence: { via: 'observed_facings', key: 'facing_id' },
};

/**
 * The dataset as one market sees it.
 *
 * Applied once, at the store boundary, so every screen and service downstream is already
 * scoped. Collections that belong to no market — channels, the market list itself, derived
 * opportunity state — pass through whole.
 *
 * @param {object} data the full dataset
 * @param {string} marketId
 * @returns {object} the same shape, with every market-scoped collection filtered
 */
export function scopeToMarket(data, marketId) {
  if (!data || !marketId) return data;

  const scoped = { ...data, market_id: marketId };
  const kept = new Map();

  for (const name of MARKET_SCOPED) {
    if (!Array.isArray(data[name])) continue;
    const rows = data[name].filter((row) => marketIdOf(row) === marketId);
    scoped[name] = rows;
    kept.set(name, new Set(rows.map((r) => r.id)));
  }

  // Two passes, because a rule inherits through a version that itself inherits through a
  // market: the parents must be scoped before the children can be filtered against them.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const [name, { via, key }] of Object.entries(INHERITED)) {
      if (!Array.isArray(data[name])) continue;
      const parents = kept.get(via);
      if (!parents) continue;
      const rows = data[name].filter((row) => parents.has(row[key]));
      scoped[name] = rows;
      kept.set(name, new Set(rows.map((r) => r.id)));
    }
  }

  return scoped;
}

/**
 * Whether a set of entities all belong to one market.
 *
 * T-2 asks for consistent market ownership across every referenced entity. A fixture in Taipei
 * carrying a Singapore planogram is not a data-entry slip to tidy up later: it is a comparison
 * against the wrong plan, and it would produce confident, completely wrong deviations.
 */
export function sameMarket(entities, marketId) {
  return entities.filter(Boolean).every((entity) => marketIdOf(entity) === marketId);
}
