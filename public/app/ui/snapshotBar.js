/**
 * Saying which picture a manager screen is showing, and what it left out.
 *
 * Every headline number on these pages is now taken from the current snapshot: one eligible
 * observation per outlet, SKU and pack configuration, at or before an as-of time, inside a
 * freshness window. That is a far better number than the one it replaced — but only if the
 * screen says so. "68% aligned" reads identically whether it means today's shelves or every
 * reading ever taken, and the second is what it used to mean.
 *
 * So the bar states four things a percentage cannot: which mode, as of when, over what
 * window, and how many observations were held out and why. Exclusions are shown rather than
 * summed away, because "awaiting confirmation" and "older than the window" are different
 * problems with different owners, and a reader who cannot see them has no way to tell a clean
 * picture from an empty one.
 */

import { esc } from '../lib/format.js';
import { dateTimeLabel } from '../lib/format.js';
import { INELIGIBLE_LABEL, SNAPSHOT_MODE } from '../services/snapshotService.js';

export const SNAPSHOT_NOTE = {
  [SNAPSHOT_MODE.CURRENT]:
    'One eligible observation per outlet, SKU and pack configuration — the latest at or before ' +
    'the as-of time, inside the freshness window. Repeat visits do not give an outlet extra weight.',
  [SNAPSHOT_MODE.HISTORICAL]:
    'Every observation the filters select, including superseded and unconfirmed readings. ' +
    'Use it for trends and for the record — not as a picture of the shelves today.',
};

/** The mode switch plus the as-of line. Rendered at the top of every manager screen. */
export function snapshotBar(analytics) {
  const snapshot = analytics?.snapshot;
  if (!snapshot) return '';

  const current = snapshot.mode === SNAPSHOT_MODE.CURRENT;
  const button = (mode, label) =>
    `<button class="btn btn--sm${snapshot.mode === mode ? ' btn--primary' : ''}"
      data-action="set-snapshot-mode" data-mode="${esc(mode)}"
      aria-pressed="${snapshot.mode === mode}">${esc(label)}</button>`;

  return `<div class="snapshot" data-snapshot-mode="${esc(snapshot.mode)}">
    <div class="snapshot__head">
      <div>
        <div class="snapshot__label">Showing</div>
        <div class="snapshot__value">${current ? 'Current picture' : 'Full history'}</div>
      </div>
      <div class="toolbar">
        ${button(SNAPSHOT_MODE.CURRENT, 'Current')}
        ${button(SNAPSHOT_MODE.HISTORICAL, 'Historical')}
      </div>
    </div>
    <div class="snapshot__meta">
      As of ${esc(dateTimeLabel(snapshot.as_of))}${
        current ? ` · freshness window ${snapshot.window_days} days` : ''
      } · ${analytics.observations.length} observation${analytics.observations.length === 1 ? '' : 's'}
      of ${analytics.historical.length} selected
    </div>
    <p class="snapshot__note">${esc(SNAPSHOT_NOTE[snapshot.mode])}</p>
    ${excludedLine(snapshot)}
    ${pendingBehindLine(analytics)}
  </div>`;
}

/**
 * What was held out, itemised.
 *
 * A single "excluded: 412" tells a reader nothing they can act on. Readings nobody has been
 * back to confirm are a field problem; readings older than the window are a scheduling
 * problem; superseded ones are neither and simply mean the outlet was visited again.
 */
function excludedLine(snapshot) {
  if (!snapshot.excluded) return '';
  const parts = Object.entries(snapshot.excluded)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${INELIGIBLE_LABEL[reason]}`);
  if (!parts.length) return '<div class="snapshot__excluded">Nothing was held out of this picture.</div>';
  return `<div class="snapshot__excluded">Held out: ${esc(parts.join(' · '))}</div>`;
}

/**
 * A verified price still being shown when somebody has already been back and read something
 * else. Which of the two is right is exactly what nobody has established, so it is surfaced
 * rather than resolved — showing the confirmed one alone would present it as the shelf today.
 */
function pendingBehindLine(analytics) {
  const behind = analytics.snapshot?.superseded_by_pending ?? [];
  if (!behind.length) return '';
  return `<div class="snapshot__pending">⚠ ${behind.length} shown price${behind.length === 1 ? ' has' : 's have'}
    a newer unconfirmed reading behind ${behind.length === 1 ? 'it' : 'them'}. Confirm in Image Review
    before treating ${behind.length === 1 ? 'it' : 'them'} as the current shelf.</div>`;
}

/**
 * The four coverage questions, each with the numerator and denominator it is a share of.
 *
 * The screen used to report one figure called "Market Coverage": 25% for a territory whose
 * every outlet had been visited, because six was East's outlets and twenty-four was the
 * country's. A territory manager could never have reached 100%. Every denominator here is
 * computed inside the selected scope, and every one of them is printed, because a percentage
 * whose denominator is not shown cannot be checked.
 *
 * They are deliberately four numbers and not one. The first two answer "have we looked"; the
 * last two answer "what did we find". Blended together, a gap in either is invisible.
 */
export function coveragePanel(coverage, deltas = {}) {
  if (!coverage) return '';
  const metrics = [
    [coverage.outlet_visit_coverage, null],
    [coverage.fresh_sku_coverage, null],
    [coverage.comparable_pair_availability, null],
    [coverage.competitive_alignment, deltas.competitive_alignment],
  ];

  return `<div class="card" data-coverage>
    <div class="card__head">
      <h2>Coverage</h2>
      <span class="card__sub">${coverage.scope_outlets} outlet${coverage.scope_outlets === 1 ? '' : 's'} in the selected scope ·
        as of ${esc(dateTimeLabel(coverage.as_of))}</span>
    </div>
    <div class="grid grid--kpi">
      ${metrics.map(([metric, delta]) => coverageCard(metric, delta)).join('')}
    </div>
    <p class="xsmall muted mt">Every denominator is counted inside the selected scope, so filtering to a
      territory asks about that territory's own completeness. Expected assortment is
      ${esc(coverage.assortment_basis)} — a working definition until an approved assortment is supplied.</p>
  </div>`;
}

function coverageCard(metric, delta) {
  const cls = delta > 0.05 ? 'up' : delta < -0.05 ? 'down' : 'flat';
  const arrow = delta > 0.05 ? '▲' : delta < -0.05 ? '▼' : '▬';
  return `<div class="kpi" data-coverage-metric>
    <div class="kpi__label">${esc(metric.label)}</div>
    <div class="kpi__value">${metric.pct === null ? '—' : `${metric.pct}%`}</div>
    <div class="kpi__meta"><strong>${metric.numerator} of ${metric.denominator}</strong></div>
    <div class="kpi__meta xsmall">${esc(metric.description)}</div>
    ${
      Number.isFinite(delta)
        ? `<div class="kpi__delta kpi__delta--${cls}">${arrow} ${Math.abs(delta).toFixed(1)} pp vs previous period</div>`
        : ''
    }
  </div>`;
}

/** Shared handler — manager pages delegate the mode switch here. */
export function handleSnapshotAction(action, el, ctx) {
  if (action !== 'set-snapshot-mode') return false;
  ctx.setFilters({ snapshot_mode: el.dataset.mode });
  ctx.render();
  return true;
}
