/**
 * §14 — Field Effectiveness.
 *
 * Because JTI does not set retailer price, every metric here is phrased as an OBSERVED
 * SEQUENCE. Nothing on this page claims that field engagement caused a price change.
 */

import { dateLabel, esc, money, num, pct, signedMoney } from '../lib/format.js';
import { dataTable, disclaimer, kpiCard, statusPill, strategicPill } from './dom.js';
import { filterBar, handleFilterAction, handleFilterChange } from './filters.js';
import { downloadCsv } from '../lib/csv.js';

export const title = () => 'Field Effectiveness';
export const subtitle = () => 'Observed price change after engagement — sequence, not causation';

export function render(ctx) {
  const fx = ctx.analytics.fieldEffectiveness;

  return `
    ${disclaimer(`<strong>${esc(fx.label)}.</strong> ${esc(fx.disclaimer)}`)}
    ${filterBar(ctx, { show: ['date', 'territory', 'channel', 'user'] })}

    <div class="grid grid--kpi mb">
      ${kpiCard({ label: 'Pricing Opportunities identified', value: String(fx.opportunities_identified) })}
      ${kpiCard({ label: 'Opportunities engaged by TME', value: String(fx.opportunities_engaged) })}
      ${kpiCard({ label: 'Outlet agreed to review price', value: String(fx.outlet_agreed_to_review) })}
      ${kpiCard({ label: 'Observed price changes after engagement', value: String(fx.observed_price_changes), meta: `${fx.engagements_with_subsequent_observation} engagements had a later observation` })}
      ${kpiCard({ label: 'Engagement-to-Price-Change Rate', value: pct(fx.engagement_to_price_change_rate), meta: 'Engagements with a later observed price change' })}
      ${kpiCard({ label: 'Opportunity Resolution Rate', value: pct(fx.opportunity_resolution_rate), meta: `${fx.opportunities_resolved} moved into the recommended range` })}
      ${kpiCard({ label: 'Median detection-to-action', value: fx.median_detection_to_action_days === null ? '—' : `${num(fx.median_detection_to_action_days, 1)} d` })}
      ${kpiCard({ label: 'Median action-to-next-observation', value: fx.median_action_to_next_observation_days === null ? '—' : `${num(fx.median_action_to_next_observation_days, 1)} d` })}
      ${kpiCard({ label: 'Median improvement in price gap', value: fx.median_gap_improvement === null ? '—' : money(fx.median_gap_improvement), meta: 'Absolute gap reduction after engagement' })}
    </div>

    <div class="card">
      <div class="card__head">
        <h2>Before / after engagement</h2>
        <div class="toolbar">
          <span class="card__sub">Observed sequence only</span>
          <button class="btn btn--sm" data-action="export">⇩ Export CSV</button>
        </div>
      </div>
      ${fx.timeline.length ? fx.timeline.slice(0, 12).map(beforeAfter).join('') : '<div class="empty">No engagements with a subsequent observation in this period.</div>'}
    </div>

    <div class="card">
      <div class="card__head"><h2>All engagements</h2></div>
      ${table(fx.timeline)}
    </div>`;
}

function beforeAfter(t) {
  const improved = t.observed_gap_improvement !== null && t.observed_gap_improvement > 0;
  return `<div class="card" style="box-shadow:none;margin-bottom:10px">
    <div class="row mb">
      <strong>${esc(t.sku_name)}</strong>
      ${strategicPill({ is_strategic: t.is_strategic })}
      <span class="muted small">${esc(t.outlet_name)} · ${esc(t.territory_name)}</span>
    </div>
    <div class="beforeafter">
      <div class="beforeafter__box">
        <div class="xsmall muted">Before — observed ${esc(dateLabel(t.before.observed_at))}</div>
        <div class="small">JTI price: <strong>${money(t.before.jti_price)}</strong></div>
        <div class="small">Competitor: <strong>${money(t.before.competitor_price)}</strong></div>
        <div class="small">Gap: <strong>${signedMoney(t.before.gap)}</strong></div>
        <div class="mt">${statusPill(t.before.status)}</div>
      </div>
      <div class="beforeafter__arrow" title="TME engagement">
        →
        <div class="xsmall muted nowrap">${esc(t.action_type)}<br />${esc(dateLabel(t.action_at))}</div>
      </div>
      <div class="beforeafter__box">
        <div class="xsmall muted">Next observed — ${esc(dateLabel(t.after.observed_at))}</div>
        <div class="small">JTI price: <strong>${money(t.after.jti_price)}</strong></div>
        <div class="small">Competitor: <strong>${money(t.after.competitor_price)}</strong></div>
        <div class="small">Gap: <strong>${signedMoney(t.after.gap)}</strong></div>
        <div class="mt">${statusPill(t.after.status)}</div>
      </div>
    </div>
    <p class="small mt" style="margin-bottom:0">
      <strong>Observed price-position change:</strong>
      ${t.observed_gap_improvement === null ? 'no comparable competitor observation' : `${improved ? 'gap narrowed by' : 'gap widened by'} ${money(Math.abs(t.observed_gap_improvement))}`}
      <span class="muted">— observed sequence, not attributed to the engagement.</span>
    </p>
  </div>`;
}

function table(timeline) {
  const columns = [
    { key: 'action_at', label: 'Engagement date', render: (t) => esc(dateLabel(t.action_at)), sortValue: (t) => new Date(t.action_at).getTime() },
    { key: 'outlet_name', label: 'Outlet', render: (t) => esc(t.outlet_name) },
    { key: 'territory_name', label: 'Territory', render: (t) => esc(t.territory_name) },
    { key: 'sku_name', label: 'SKU', render: (t) => `${esc(t.sku_name)} ${strategicPill({ is_strategic: t.is_strategic })}` },
    { key: 'action_type', label: 'Action', render: (t) => esc(t.action_type) },
    { key: 'before_price', label: 'Price before', align: 'right', render: (t) => money(t.before.jti_price), sortValue: (t) => t.before.jti_price },
    { key: 'after_price', label: 'Price after', align: 'right', render: (t) => money(t.after.jti_price), sortValue: (t) => t.after.jti_price },
    { key: 'observed_price_change', label: 'Observed change', align: 'right', render: (t) => signedMoney(t.observed_price_change) },
    { key: 'before_gap', label: 'Gap before', align: 'right', render: (t) => signedMoney(t.before.gap), sortValue: (t) => t.before.gap ?? 0 },
    { key: 'after_gap', label: 'Gap after', align: 'right', render: (t) => signedMoney(t.after.gap), sortValue: (t) => t.after.gap ?? 0 },
    { key: 'status_after', label: 'Status after', render: (t) => statusPill(t.after.status) },
  ];
  return dataTable(columns, timeline, { emptyMessage: 'No engagements recorded in this period.' });
}

export function onAction(action, el, ctx) {
  if (handleFilterAction(action, el, ctx)) return;
  if (action === 'export') {
    const rows = ctx.analytics.fieldEffectiveness.timeline.map((t) => ({
      engagement_date: t.action_at,
      action_type: t.action_type,
      outlet: t.outlet_name,
      territory: t.territory_name,
      sku: t.sku_name,
      strategic_sku: t.is_strategic ? 'Yes' : 'No',
      observed_before_at: t.before.observed_at,
      jti_price_before: t.before.jti_price,
      competitor_price_before: t.before.competitor_price ?? '',
      gap_before: t.before.gap ?? '',
      observed_after_at: t.after.observed_at,
      jti_price_after: t.after.jti_price,
      competitor_price_after: t.after.competitor_price ?? '',
      gap_after: t.after.gap ?? '',
      observed_price_change: t.observed_price_change,
      observed_gap_improvement: t.observed_gap_improvement ?? '',
      note: 'Observed sequence — not a causal attribution',
    }));
    downloadCsv('field-actions.csv', Object.keys(rows[0] ?? { outlet: '' }), rows);
  }
}

export function onChange(target, ctx) {
  return handleFilterChange(target, ctx);
}
