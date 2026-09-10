/** Date helpers. All timestamps in the store are ISO-8601 strings (UTC). */

export const DAY_MS = 24 * 60 * 60 * 1000;

export function toDate(value) {
  if (value instanceof Date) return value;
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isoDate(value) {
  const d = toDate(value);
  return d ? d.toISOString().slice(0, 10) : null;
}

export function daysBetween(from, to) {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return null;
  return Math.floor((b.getTime() - a.getTime()) / DAY_MS);
}

export function addDays(value, days) {
  const d = toDate(value);
  if (!d) return null;
  return new Date(d.getTime() + days * DAY_MS);
}

/**
 * Inclusive-from / exclusive-to effective-date window check.
 * `effective_to` may be null meaning "open ended".
 */
export function isEffectiveAt(record, at) {
  const when = toDate(at);
  if (!when) return false;
  const from = toDate(record.effective_from);
  const to = toDate(record.effective_to);
  if (from && when < from) return false;
  if (to && when > to) return false;
  return true;
}

/** §26 — data freshness bucket for an observation age. */
export function freshnessLabel(observedAt, now, freshnessConfig) {
  const age = daysBetween(observedAt, now);
  if (age === null) return { label: 'Unknown', level: 'unknown', ageDays: null };
  if (age <= freshnessConfig.fresh_max_days) return { label: 'Fresh', level: 'fresh', ageDays: age };
  if (age <= freshnessConfig.aging_max_days) return { label: 'Aging', level: 'aging', ageDays: age };
  return { label: 'Stale', level: 'stale', ageDays: age };
}

/** Bucket key for time-series grouping. */
export function periodKey(value, granularity) {
  const d = toDate(value);
  if (!d) return null;
  if (granularity === 'month') return d.toISOString().slice(0, 7);
  if (granularity === 'week') {
    const monday = new Date(d);
    const dow = (monday.getUTCDay() + 6) % 7;
    monday.setUTCDate(monday.getUTCDate() - dow);
    return monday.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

/** Pick a sensible granularity for a date range. */
export function autoGranularity(fromDate, toDateValue) {
  const span = daysBetween(fromDate, toDateValue) ?? 30;
  if (span > 180) return 'month';
  if (span > 45) return 'week';
  return 'day';
}
