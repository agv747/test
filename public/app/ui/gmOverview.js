/**
 * GM Overview (GM review §E) — the first thirty seconds.
 *
 * The Control Tower opens with a nine-field filter form, eight KPI cards and a paragraph of
 * disclaimer, and the conclusions sit below all of it. That layout is right for the analyst who
 * lives in the screen and wrong for the person the demo is for: a GM has four questions — what
 * changed, where it matters, who has it, and how fresh the evidence is — and no reason to scroll
 * through a filter form to reach them.
 *
 * So this is a separate route, not a replacement. The Control Tower keeps every filter and every
 * metric. This page carries four metrics, three signals and the scope line, and everything else
 * is a click away. Four is a ceiling, not a target: a fifth card costs attention on the three
 * that decide something.
 *
 * The acceptance test is physical — at 1366×768 the message, the metrics and the priorities are
 * visible without scrolling — so the layout is measured in the browser smoke suite rather than
 * asserted here.
 */

import { esc, money, pct, priceIndex, signedMoney } from '../lib/format.js';
import { dateLabel, dateTimeLabel } from '../lib/format.js';
import { disclaimer, kpiCard, priorityPill, strategicPill } from './dom.js';
import { handleSnapshotAction } from './snapshotBar.js';
import { NO_SIGNAL_NOTE, SIGNAL_THRESHOLDS } from '../services/signalService.js';
import { SNAPSHOT_MODE } from '../services/snapshotService.js';

/** Which signal's outlets are open. Only one at a time: this is an overview. */
let expandedSignal = null;

export const title = () => 'GM Overview';
export const subtitle = () => 'What changed, where it matters, who has it, and how fresh the evidence is';

export function render(ctx) {
  const a = ctx.analytics;
  const { signals, suppressed } = a.signals;

  return `
    ${scopeBar(ctx, a)}
    ${metricRow(a)}
    ${signalsCard(ctx, signals, suppressed)}
    ${architectureLink()}
    ${disclaimer(
      'Synthetic demonstration data. Outlets set their own retail price: this tool observes and ' +
        'prioritises, it does not enforce. Nothing here attributes a price change to a field visit.',
    )}`;
}

/**
 * Market, as-of, window, scope and the demo marking — one line, before anything is counted.
 *
 * Every number below it is a share of something taken at a moment, and a reader who does not
 * know which moment cannot check any of them.
 */
function scopeBar(ctx, a) {
  const territory = ctx.data.territories.find((t) => t.id === ctx.filters.territory_id);
  const current = a.snapshot.mode === SNAPSHOT_MODE.CURRENT;

  return `<div class="gm-scope" data-gm-scope>
    <div class="gm-scope__main">
      <span class="gm-scope__market">Singapore · SGD / pack of 20</span>
      <span class="gm-scope__sep">·</span>
      <span>As of <strong>${esc(dateTimeLabel(a.snapshot.as_of))}</strong></span>
      <span class="gm-scope__sep">·</span>
      <span>${current ? `last ${a.snapshot.window_days} days` : 'full history'}</span>
      <span class="gm-scope__sep">·</span>
      <span><strong>${esc(territory?.name ?? 'All territories')}</strong></span>
      <span class="tag tag--demo">Demo data</span>
    </div>
    <div class="toolbar">
      ${territoryPicker(ctx)}
      <button class="btn btn--sm" data-nav="manager/tower">Full analysis →</button>
    </div>
  </div>`;
}

/** Two filters here; everything else stays on the Control Tower. */
function territoryPicker(ctx) {
  return `<select data-filter="territory_id" aria-label="Territory" style="width:auto">
    <option value="">All territories</option>
    ${ctx.data.territories
      .map(
        (t) =>
          `<option value="${esc(t.id)}"${t.id === ctx.filters.territory_id ? ' selected' : ''}>${esc(t.name)}</option>`,
      )
      .join('')}
  </select>
  <select data-action="set-snapshot-mode-select" aria-label="Snapshot mode" style="width:auto">
    <option value="current"${ctx.filters.snapshot_mode !== 'historical' ? ' selected' : ''}>Current picture</option>
    <option value="historical"${ctx.filters.snapshot_mode === 'historical' ? ' selected' : ''}>Full history</option>
  </select>`;
}

/**
 * Four metrics, each a count of something with a denominator that can be checked.
 *
 * Deliberately not the Control Tower's eight. Two of these are "have we looked" and two are
 * "what did we find", which is the smallest set that cannot be misread: a clean alignment
 * figure over an empty sample looks identical to a clean one over a full sample unless
 * coverage is beside it.
 */
function metricRow(a) {
  const coverage = a.coverage;
  const strategicAtRisk = a.opportunities.filter((o) => o.is_strategic);
  const strategicOutlets = new Set(strategicAtRisk.map((o) => o.outlet_id)).size;
  const overdue = a.opportunities.filter((o) => o.overdue);

  const outletsInScope = coverage.outlet_visit_coverage.denominator;
  const outletsWithIssue = new Set(a.opportunities.map((o) => o.outlet_id)).size;

  return `<div class="grid grid--kpi mb" data-gm-metrics>
    ${kpiCard({
      label: 'Outlets with an open deviation',
      value: String(outletsWithIssue),
      meta: `of ${outletsInScope} outlet${outletsInScope === 1 ? '' : 's'} in scope`,
    })}
    ${kpiCard({
      label: 'Strategic SKUs outside intended position',
      value: String(strategicAtRisk.length),
      meta: `across ${strategicOutlets} outlet${strategicOutlets === 1 ? '' : 's'}`,
    })}
    ${kpiCard({
      label: 'Checks overdue',
      value: String(overdue.length),
      meta: overdue.length
        ? 'Field actions whose promised follow-up date has passed'
        : 'No promised follow-up has slipped',
    })}
    ${kpiCard({
      label: 'Comparable evidence available',
      value: coverage.comparable_pair_availability.pct === null ? '—' : `${coverage.comparable_pair_availability.pct}%`,
      meta: `${coverage.comparable_pair_availability.numerator} of ${coverage.comparable_pair_availability.denominator} current JTI observations that need a competitor price have one`,
    })}
  </div>`;
}

/**
 * Three signals, each a group rather than a single outlet card claiming a group's count.
 *
 * A card headed "Winston Red — Tampines Hub Convenience · East · 19 outlets affected" is two
 * things at once, and the same subtitle appeared on a different outlet's card. Here the heading
 * is the group and the outlets are underneath it, where they can be counted.
 */
function signalsCard(ctx, signals, suppressed) {
  return `<div class="card" data-gm-signals>
    <div class="card__head">
      <h2>What needs attention</h2>
      <span class="card__sub">Grouped by issue, SKU and the selected scope · outlets listed inside each</span>
    </div>
    ${
      signals.length
        ? signals.map((s) => signalRow(ctx, s)).join('')
        : `<div class="empty" data-no-signal>
            <strong>No material signal.</strong>
            <p class="small muted" style="margin:6px 0 0">${esc(NO_SIGNAL_NOTE)}</p>
            ${
              suppressed.length
                ? `<p class="xsmall muted">${suppressed.length} group${suppressed.length === 1 ? '' : 's'}
                    did not clear it — nearest: ${esc(suppressed[0].jti_sku_name)}, ${esc(suppressed[0].suppressed_because)}.</p>`
                : ''
            }
          </div>`
    }
    ${
      signals.length
        ? `<p class="xsmall muted mt">A group is shown when it covers at least
            ${SIGNAL_THRESHOLDS.min_outlets} outlets — or one outlet on a Strategic SKU — and its freshest
            evidence is under ${SIGNAL_THRESHOLDS.max_evidence_age_days} days old. Groups below that bar are
            left out rather than padded in.</p>`
        : ''
    }
  </div>`;
}

function signalRow(ctx, signal) {
  const open = expandedSignal === signal.key;
  const stale = signal.evidence_age_days !== null && signal.evidence_age_days > 14;

  return `<div class="signal signal--${esc(signal.priority_label)}" data-signal="${esc(signal.key)}">
    <div class="signal__head" data-action="toggle-signal" data-signal="${esc(signal.key)}"
      role="button" tabindex="0" aria-expanded="${open}">
      <div class="signal__body">
        <div class="signal__title">${esc(signal.category)} — ${esc(signal.jti_sku_name)}
          ${strategicPill({ is_strategic: signal.is_strategic })}</div>
        <div class="signal__scope">${esc(signal.territory_name ?? 'All territories')} ·
          <strong>${signal.outlet_count} outlet${signal.outlet_count === 1 ? '' : 's'}</strong>
          ${signal.competitor_sku_name ? ` · vs ${esc(signal.competitor_sku_name)}` : ''}</div>

        <div class="signal__evidence">
          ${evidenceLine(signal)}
        </div>

        <div class="signal__meta">
          <span class="${stale ? 'signal__stale' : ''}">${esc(evidenceAge(signal))}</span>
          <span>Owner: ${esc(signal.owner_name ?? 'unassigned')}</span>
          <span>Next step: ${esc(signal.next_step ?? '—')}</span>
          ${signal.due_date ? `<span class="${signal.overdue_outlets ? 'signal__stale' : ''}">Due ${esc(dateLabel(signal.due_date))}</span>` : ''}
          ${signal.overdue_outlets ? `<span class="signal__stale">${signal.overdue_outlets} overdue</span>` : ''}
        </div>
      </div>
      <div class="signal__side">
        ${priorityPill(signal.priority_label)}
        <div class="xsmall muted">${open ? 'Hide' : 'Show'} outlets ▾</div>
      </div>
    </div>
    ${open ? outletList(ctx, signal) : ''}
  </div>`;
}

/** How old the freshest evidence is, in words a reader does not have to convert. */
function evidenceAge(signal) {
  if (signal.evidence_age_days === null) return 'Evidence undated';
  const days = Math.round(signal.evidence_age_days);
  if (days <= 0) return 'Observed today';
  return `Evidence ${days} day${days === 1 ? '' : 's'} old`;
}

/** The observed numbers behind the signal, so the priority is checkable rather than asserted. */
function evidenceLine(signal) {
  const parts = [];
  if (Number.isFinite(signal.observed_price)) {
    parts.push(`Observed ${money(signal.observed_price)} at ${esc(signal.worst_outlet_name)}`);
  }
  if (Number.isFinite(signal.recommended_min)) {
    parts.push(`recommended ${money(signal.recommended_min)}–${money(signal.recommended_max)}`);
  }
  if (Number.isFinite(signal.competitor_price)) {
    parts.push(`competitor ${money(signal.competitor_price)}`);
  }
  if (Number.isFinite(signal.price_gap)) parts.push(`gap ${signedMoney(signal.price_gap)}`);
  if (Number.isFinite(signal.price_index)) {
    const corridor = Number.isFinite(signal.desired_price_index_min)
      ? ` (intended ${signal.desired_price_index_min}–${signal.desired_price_index_max})`
      : '';
    parts.push(`index ${priceIndex(signal.price_index)}${corridor}`);
  }
  return parts.join(' · ');
}

function outletList(ctx, signal) {
  return `<div class="signal__outlets">
    <table class="table table--compact">
      <thead><tr>
        <th>Outlet</th><th>Territory</th><th class="right">Observed</th>
        <th class="right">Gap</th><th class="right">Index</th><th>Status</th><th>Last observed</th>
      </tr></thead>
      <tbody>
        ${signal.opportunities
          .map(
            (o) => `<tr class="clickable" data-action="open-outlet" data-outlet="${esc(o.outlet_id)}">
              <td>${esc(o.outlet_name)}<br /><span class="xsmall muted">${esc(o.outlet_code)}</span></td>
              <td>${esc(o.territory_name)}</td>
              <td class="right">${money(o.jti_price)}</td>
              <td class="right">${o.price_gap === null ? '—' : signedMoney(o.price_gap)}</td>
              <td class="right">${priceIndex(o.price_index)}</td>
              <td>${esc(o.status)}${o.overdue ? ' <span class="pill pill--risk">overdue</span>' : ''}</td>
              <td>${esc(dateLabel(o.last_detected_at))}</td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>
    <div class="toolbar">
      <button class="btn btn--sm" data-nav="manager/opportunities">Open in Pricing Opportunities →</button>
      <button class="btn btn--sm" data-action="open-sku" data-sku="${esc(signal.jti_sku_id)}">Open ${esc(signal.jti_sku_name)} →</button>
    </div>
  </div>`;
}

/** One line to the interval chart, since "where do our prices sit" is the next question. */
function architectureLink() {
  return `<div class="card">
    <div class="card__head">
      <h2>Price architecture</h2>
      <span class="card__sub">Observed intervals across outlets, on one SGD axis</span>
    </div>
    <p class="small muted" style="margin:0 0 10px">A median hides how differently outlets price the same
      pack. The interval view shows the spread per SKU, with the JTI reference corridor drawn separately.</p>
    <button class="btn btn--sm" data-nav="manager/architecture">Open price architecture →</button>
  </div>`;
}

export function onAction(action, el, ctx) {
  if (handleSnapshotAction(action, el, ctx)) return;
  switch (action) {
    case 'toggle-signal':
      expandedSignal = expandedSignal === el.dataset.signal ? null : el.dataset.signal;
      ctx.render();
      break;
    case 'open-outlet':
      ctx.navigate('outlet', { id: el.dataset.outlet });
      break;
    case 'open-sku':
      ctx.navigate('manager/sku', { sku: el.dataset.sku });
      break;
    default:
      break;
  }
}

export function onChange(target, ctx) {
  if (target.dataset.filter === 'territory_id') {
    ctx.setFilters({ territory_id: target.value });
    ctx.render();
    return true;
  }
  if (target.dataset.action === 'set-snapshot-mode-select') {
    ctx.setFilters({ snapshot_mode: target.value });
    ctx.render();
    return true;
  }
  return false;
}
