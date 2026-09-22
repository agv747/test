/**
 * Current snapshot versus historical observations (GM review §B).
 *
 * The manager screens were reading every observation ever recorded. An outlet visited ten
 * times counted ten times against one visited once, prices from June sat in a view labelled
 * as the current picture, and a low-confidence reading nobody had confirmed carried the same
 * weight as a verified one. None of that is visible in a percentage.
 *
 * So there are now two explicit modes, and every screen says which one it is showing:
 *
 *   current     one eligible observation per outlet, SKU and pack configuration, the latest
 *               at or before the as-of time, inside a freshness window
 *   historical  every observation, for trends and for the record
 *
 * "Eligible" is deliberately narrow. An observation earns a place in the trusted current
 * picture by being confirmable: not excluded, not dated in the future, inside the window,
 * and either read confidently or checked by a person. Everything kept out is counted and
 * shown — missing data is never quietly rendered as an aligned price.
 */

import { daysBetween, toDate } from '../lib/dates.js';

export const SNAPSHOT_MODE = {
  CURRENT: 'current',
  HISTORICAL: 'historical',
};

/** Why an observation is not in the trusted current picture. Each is counted and shown. */
export const INELIGIBLE = {
  PENDING: 'pending',
  FUTURE: 'future',
  STALE: 'stale',
  SUPERSEDED: 'superseded',
};

export const INELIGIBLE_LABEL = {
  [INELIGIBLE.PENDING]: 'awaiting confirmation',
  [INELIGIBLE.FUTURE]: 'dated after the as-of time',
  [INELIGIBLE.STALE]: 'older than the freshness window',
  [INELIGIBLE.SUPERSEDED]: 'superseded by a later observation of the same SKU in the outlet',
};

/**
 * Whether a reading can be trusted without a person looking at it again.
 *
 * A confident read counts. So does one a person confirmed — whether they corrected it or
 * confirmed it as read, which is why confirmation must not require changing a number. What
 * does not count is a low-confidence reading nobody has been back to.
 */
export function isConfirmed(observation, config) {
  const threshold = config?.confidence_review_threshold ?? 0;
  if (observation.review_resolved || observation.manual_correction) return true;
  const confidence = observation.recognition_confidence;
  return confidence === null || confidence === undefined || confidence >= threshold;
}

/** The configuration a snapshot is taken under, with the defaults the GM view opens on. */
export function snapshotSettings(config, overrides = {}) {
  const base = config?.snapshot ?? {};
  return {
    mode: overrides.mode ?? base.mode ?? SNAPSHOT_MODE.CURRENT,
    window_days: overrides.window_days ?? base.window_days ?? 14,
    as_of: overrides.as_of ?? base.as_of ?? null,
  };
}

/**
 * The key a current observation is unique on.
 *
 * Pack configuration is part of it because a price is only comparable within one: SGD 14.20
 * for a pack of 20 and for a carton are not two readings of the same thing.
 */
export function snapshotKey(observation) {
  const pack = observation.sku?.sticks_per_pack ?? observation.sticks_per_pack ?? 'unknown';
  return `${observation.outlet_id}|${observation.sku_id}|${pack}`;
}

/**
 * Reduces observations to the trusted current picture.
 *
 * @returns {{
 *   observations: object[],
 *   as_of: string,
 *   window_days: number,
 *   excluded: Record<string, number>,
 *   pending: object[],
 * }}
 */
export function currentSnapshot(observations, config, options = {}) {
  const { window_days: windowDays, as_of } = snapshotSettings(config, options);
  const asOf = as_of ?? options.now ?? new Date().toISOString();
  const asOfDate = toDate(asOf);

  const excluded = {
    [INELIGIBLE.PENDING]: 0,
    [INELIGIBLE.FUTURE]: 0,
    [INELIGIBLE.STALE]: 0,
    [INELIGIBLE.SUPERSEDED]: 0,
  };
  const pending = [];

  const eligible = [];
  for (const observation of observations) {
    const when = toDate(observation.observed_at);

    if (when > asOfDate) {
      excluded[INELIGIBLE.FUTURE] += 1;
      continue;
    }
    const age = daysBetween(observation.observed_at, asOf);
    if (age !== null && age > windowDays) {
      excluded[INELIGIBLE.STALE] += 1;
      continue;
    }
    if (!isConfirmed(observation, config)) {
      excluded[INELIGIBLE.PENDING] += 1;
      pending.push(observation);
      continue;
    }
    eligible.push(observation);
  }

  // Latest per outlet, SKU and pack configuration: repeat visits must not give one outlet
  // extra weight in a percentage that reads as a share of the network.
  const latest = new Map();
  for (const observation of eligible) {
    const key = snapshotKey(observation);
    const held = latest.get(key);
    if (!held || toDate(observation.observed_at) > toDate(held.observed_at)) {
      if (held) excluded[INELIGIBLE.SUPERSEDED] += 1;
      latest.set(key, observation);
    } else {
      excluded[INELIGIBLE.SUPERSEDED] += 1;
    }
  }

  return {
    observations: [...latest.values()],
    as_of: asOf,
    window_days: windowDays,
    excluded,
    pending,
  };
}

/**
 * A newer unconfirmed reading standing behind an older verified one.
 *
 * Showing the verified price alone would present it as the current state of the shelf when
 * somebody has already been back and read something else. The state is surfaced rather than
 * resolved: which of the two is right is exactly what nobody has established yet.
 */
export function supersededByPending(snapshot) {
  const shown = new Map(snapshot.observations.map((o) => [snapshotKey(o), o]));
  return snapshot.pending
    .filter((p) => {
      const held = shown.get(snapshotKey(p));
      return held && toDate(p.observed_at) > toDate(held.observed_at);
    })
    .map((p) => ({ pending: p, shown: shown.get(snapshotKey(p)) }));
}

/**
 * Applies a snapshot mode to a set of observations.
 *
 * Historical returns everything untouched, deliberately: trends and the record of what was
 * read need every reading, and those screens say so.
 */
export function applySnapshot(observations, config, options = {}) {
  const settings = snapshotSettings(config, options);
  if (settings.mode === SNAPSHOT_MODE.HISTORICAL) {
    return {
      mode: SNAPSHOT_MODE.HISTORICAL,
      observations,
      as_of: settings.as_of ?? options.now ?? new Date().toISOString(),
      window_days: null,
      excluded: null,
      pending: observations.filter((o) => !isConfirmed(o, config)),
    };
  }
  return { mode: SNAPSHOT_MODE.CURRENT, ...currentSnapshot(observations, config, options) };
}
