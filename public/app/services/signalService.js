/**
 * Material signals for the GM Overview (GM review §E).
 *
 * The opportunity list is one row per outlet and SKU, which is right for a territory manager
 * working through their week and wrong for a GM deciding where to look. Worse, it read as both
 * at once: a card headed "Winston Red — Tampines Hub Convenience" carried the subtitle
 * "East · 19 outlets affected", and the same subtitle appeared on the card for a different
 * outlet. Nineteen is the count of outlets with that SKU deviating; the card is about one of
 * them. A reader has no way to tell whether they are looking at one shop or nineteen, and the
 * honest answer is that the card was two things stapled together.
 *
 * So a signal here is the group — one issue, one SKU, one selected scope — and the outlets are
 * its evidence, listed in the drill-down where they can be counted. It carries what a decision
 * needs and nothing else: what was observed, how far off it is, over how many outlets, how old
 * the evidence is, who owns it and what the next step is.
 *
 * Where the criteria are not met the answer is "no material signal". Three slots do not have to
 * be filled; an overview that manufactures a third priority to look complete is worse than one
 * that says there are two.
 */

import { daysBetween } from '../lib/dates.js';
import { round } from '../lib/stats.js';

/** A signal must clear all of these, or it is not worth a GM's attention. */
export const SIGNAL_THRESHOLDS = {
  /** One outlet can be a data problem; a pattern needs more than one, unless it is strategic. */
  min_outlets: 2,
  /** Evidence older than this is a prompt to re-observe, not a basis for a decision. */
  max_evidence_age_days: 21,
};

export const NO_SIGNAL_NOTE =
  'No group of outlets currently meets the materiality criteria: at least two outlets (or one ' +
  'Strategic SKU), a current deviation, and evidence inside the freshness window. This is the ' +
  'honest answer — the space is not filled with the next-largest number.';

/**
 * The scope a signal is grouped at.
 *
 * "Issue, SKU and scope" means the scope the reader has selected, not always the territory.
 * Grouping nationally by territory produced three near-identical rows — the same competitor
 * move against the same SKU in East, North and Central — which fills all three slots with one
 * story and hides the others. At national scope the territories are a property of the group and
 * belong in the drill-down; once a territory is selected the group is inside it anyway.
 */
function groupKey(opportunity, scopeBy) {
  const scope = scopeBy === 'territory' ? (opportunity.territory_id ?? 'all') : 'all';
  return `${opportunity.category}|${opportunity.jti_sku_id}|${scope}`;
}

/**
 * Groups opportunities into signals.
 *
 * @param {object[]} opportunities derived opportunities, already scoped by the caller's filters
 * @param {object} options { now, limit, thresholds }
 * @returns {{signals: object[], considered: number, suppressed: object[]}}
 */
export function buildSignals(opportunities, options = {}) {
  const {
    now = new Date().toISOString(),
    limit = 3,
    thresholds = SIGNAL_THRESHOLDS,
    users = [],
    scopeBy = 'selection',
  } = options;

  const groups = new Map();
  for (const opportunity of opportunities) {
    const key = groupKey(opportunity, scopeBy);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(opportunity);
  }

  const all = [];
  for (const [key, members] of groups) {
    const first = members[0];
    const outlets = [...new Set(members.map((m) => m.outlet_id))];
    const territories = [...new Set(members.map((m) => m.territory_name).filter(Boolean))];

    // Age of the FRESHEST evidence in the group: the question is whether anything recent
    // supports it, not whether something old exists somewhere in it.
    const freshest = members.reduce(
      (latest, m) => (!latest || m.last_detected_at > latest ? m.last_detected_at : latest),
      null,
    );
    const evidenceAge = daysBetween(freshest, now);

    // The worst deviation in the group, because that is what a reader will be shown first and
    // what the priority score is already driven by.
    const worst = members.reduce((a, b) => (b.priority_score > a.priority_score ? b : a));

    const owners = [...new Set(members.map((m) => m.assigned_user_id).filter(Boolean))];
    const overdue = members.filter((m) => m.overdue);
    const engaged = members.filter((m) => m.status !== 'New');

    const signal = {
      key,
      category: first.category,
      jti_sku_id: first.jti_sku_id,
      jti_sku_name: first.jti_sku_name,
      is_strategic: first.is_strategic,
      territory_id: territories.length === 1 ? first.territory_id : null,
      territory_name:
        territories.length === 1
          ? first.territory_name
          : `${territories.length} territories (${territories.sort().join(', ')})`,
      territories,
      competitor_sku_name: first.competitor_sku_name,

      /** The evidence: every outlet in the group, for the drill-down. */
      opportunities: members.slice().sort((a, b) => b.priority_score - a.priority_score),
      outlet_count: outlets.length,

      observed_price: worst.jti_price,
      competitor_price: worst.competitor_price,
      price_gap: worst.price_gap,
      price_index: worst.price_index,
      desired_price_index_min: worst.desired_price_index_min,
      desired_price_index_max: worst.desired_price_index_max,
      recommended_min: worst.recommended_min,
      recommended_max: worst.recommended_max,
      worst_outlet_name: worst.outlet_name,

      evidence_age_days: evidenceAge === null ? null : round(evidenceAge, 1),
      last_observed_at: freshest,

      owner_id: owners.length === 1 ? owners[0] : null,
      owner_name:
        owners.length === 1
          ? (users.find((u) => u.id === owners[0])?.name ?? owners[0])
          : owners.length
            ? `${owners.length} TMEs`
            : null,
      engaged_outlets: engaged.length,
      overdue_outlets: overdue.length,
      next_step: worst.suggested_action,
      due_date: overdue[0]?.due_date ?? members.find((m) => m.due_date)?.due_date ?? null,

      priority_score: round(Math.max(...members.map((m) => m.priority_score)), 1),
      priority_label: worst.priority_label,
      reason: worst.reason,
    };

    // A single outlet can be a misread rather than a pattern — unless the SKU is strategic, in
    // which case one outlet is worth a GM's attention on its own.
    signal.material =
      (outlets.length >= thresholds.min_outlets || first.is_strategic) &&
      evidenceAge !== null &&
      evidenceAge <= thresholds.max_evidence_age_days;
    signal.suppressed_because = signal.material
      ? null
      : evidenceAge === null || evidenceAge > thresholds.max_evidence_age_days
        ? `evidence is ${evidenceAge === null ? 'undated' : `${Math.round(evidenceAge)} days old`}`
        : `only ${outlets.length} outlet${outlets.length === 1 ? '' : 's'}, and not a Strategic SKU`;

    all.push(signal);
  }

  all.sort((a, b) => b.priority_score - a.priority_score);
  const material = all.filter((s) => s.material);

  return {
    signals: material.slice(0, limit),
    considered: all.length,
    /** Groups that exist but did not clear the bar, so "no signal" can be explained. */
    suppressed: all.filter((s) => !s.material),
  };
}
