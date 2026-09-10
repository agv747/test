/** §18 — Outlet view: current position, price history and the field-action timeline. */

import { dateLabel, dateTimeLabel, esc, money, signedMoney } from '../lib/format.js';
import {
  dataTable,
  freshnessLabelHtml,
  gapCell,
  indexCell,
  priorityPill,
  statusPill,
  strategicPill,
  disclaimer,
} from './dom.js';
import { lineChart, CHART_COLORS } from './charts.js';
import { buildTimeSeries } from '../services/analyticsService.js';
import { round } from '../lib/stats.js';

export const title = (ctx) => {
  const outlet = ctx.data.outlets.find((o) => o.id === ctx.params.id);
  return outlet?.name ?? 'Outlet';
};
export const subtitle = (ctx) => {
  const outlet = ctx.data.outlets.find((o) => o.id === ctx.params.id);
  if (!outlet) return '';
  const territory = ctx.data.territories.find((t) => t.id === outlet.territory_id)?.name ?? '';
  const channel = ctx.data.channels.find((c) => c.id === outlet.channel_id)?.name ?? '';
  return `${outlet.outlet_code} · ${territory} · ${channel}`;
};

export function render(ctx) {
  const outletId = ctx.params.id;
  const outlet = ctx.data.outlets.find((o) => o.id === outletId);
  if (!outlet) return '<div class="empty">Outlet not found.</div>';

  const observations = ctx.analytics.all.filter((o) => o.outlet_id === outletId);
  const opportunities = ctx.analytics.opportunities.filter((o) => o.outlet_id === outletId);
  const actions = ctx.data.field_actions
    .filter((a) => a.outlet_id === outletId)
    .sort((a, b) => new Date(b.action_at) - new Date(a.action_at));
  const tme = ctx.data.users.find((u) => u.id === outlet.assigned_tme_id);
  const lastVisit = ctx.data.visits
    .filter((v) => v.outlet_id === outletId && v.submitted_at)
    .sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at))[0];
  const lastImage = ctx.data.images
    .filter((i) => i.visit_id === lastVisit?.id)
    .sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at))[0];

  return `
    ${ctx.params.submitted === '1' ? '<div class="disclaimer" style="background:var(--good-bg);border-color:var(--good-border);color:var(--good)"><strong>✓</strong><span>Visit submitted. It is now included in manager analytics.</span></div>' : ''}
    <div class="grid grid--kpi mb">
      ${headerCard('Assigned TME', esc(tme?.name ?? '—'))}
      ${headerCard('Last visit', esc(dateTimeLabel(lastVisit?.submitted_at)))}
      ${headerCard('Last image', lastImage ? `${esc(lastImage.file_name)}<div class="xsmall muted">${esc(lastImage.image_source)} · ${esc(lastImage.quality_status)}</div>` : '—')}
      ${headerCard('Open pricing opportunities', String(opportunities.length))}
    </div>

    ${opportunities.length ? opportunityPanel(opportunities) : ''}

    <div class="card">
      <div class="card__head"><h2>Observed price position</h2>
        <span class="card__sub">Latest observation per SKU, with the previous observation for comparison</span></div>
      ${priceTable(observations)}
    </div>

    <div class="card">
      <div class="card__head"><h2>Price history</h2>
        <span class="card__sub">Median observed price at this outlet, by week</span></div>
      ${historyChart(observations)}
    </div>

    <div class="card">
      <div class="card__head"><h2>Field action timeline</h2>
        <span class="card__sub">Observed sequence — not a causal attribution</span></div>
      ${timeline(observations, actions, opportunities)}
    </div>

    ${disclaimer('This outlet independently determines its final selling price. Statuses below describe observed market position only.')}
    <div class="toolbar">
      <button class="btn" data-nav="manager/outlets">‹ All outlets</button>
      <button class="btn btn--primary" data-nav="field/check">◉ Start Price Check here</button>
    </div>`;
}

function headerCard(label, value) {
  return `<div class="kpi"><div class="kpi__label">${esc(label)}</div>
    <div style="font-size:1rem;font-weight:650;margin-top:6px">${value}</div></div>`;
}

function opportunityPanel(opportunities) {
  return `<div class="card">
    <div class="card__head"><h2>Pricing opportunities at this outlet</h2></div>
    ${opportunities
      .map(
        (o) => `<div class="action-item action-item--${esc(o.priority_label)}">
          <div class="action-item__body">
            <div class="action-item__title">${esc(o.jti_sku_name)} ${strategicPill({ is_strategic: o.is_strategic, strategic_priority: o.strategic_priority })}</div>
            <div class="action-item__meta">${esc(o.category)} · open ${o.days_open} day${o.days_open === 1 ? '' : 's'}</div>
            <div class="action-item__reason">${esc(o.reason)}</div>
            <div class="action-item__cta">Suggested action: ${esc(o.suggested_action)}</div>
          </div>
          ${priorityPill(o.priority_label)}
        </div>`,
      )
      .join('')}
  </div>`;
}

function priceTable(observations) {
  const bySku = new Map();
  for (const o of observations) {
    if (!bySku.has(o.sku_id)) bySku.set(o.sku_id, []);
    bySku.get(o.sku_id).push(o);
  }

  const rows = [...bySku.values()]
    .map((list) => {
      list.sort((a, b) => new Date(a.observed_at) - new Date(b.observed_at));
      const current = list[list.length - 1];
      const previous = list[list.length - 2] ?? null;
      return {
        current,
        previous,
        change: previous ? round(current.confirmed_price - previous.confirmed_price, 2) : null,
      };
    })
    .sort((a, b) => Number(b.current.is_jti) - Number(a.current.is_jti) || a.current.sku_name.localeCompare(b.current.sku_name));

  const columns = [
    {
      key: 'sku',
      label: 'SKU',
      render: (r) =>
        `${esc(r.current.sku_name)} ${strategicPill(r.current.sku)}<br /><span class="xsmall muted">${esc(r.current.is_jti ? 'JTI' : r.current.brand_name)}</span>`,
    },
    { key: 'current', label: 'Current observed price', align: 'right', render: (r) => money(r.current.confirmed_price) },
    { key: 'previous', label: 'Previous', align: 'right', render: (r) => (r.previous ? money(r.previous.confirmed_price) : '<span class="muted">—</span>') },
    {
      key: 'change',
      label: 'Change',
      align: 'right',
      render: (r) => (r.change === null ? '<span class="muted">—</span>' : signedMoney(r.change)),
    },
    {
      key: 'range',
      label: 'Recommended range',
      align: 'right',
      render: (r) =>
        r.current.recommended_min_snapshot !== null
          ? `${money(r.current.recommended_min_snapshot)} – ${money(r.current.recommended_max_snapshot)}`
          : '<span class="muted">—</span>',
    },
    {
      key: 'competitor',
      label: 'Competitor price',
      align: 'right',
      render: (r) =>
        r.current.competitor_price !== undefined && r.current.competitor_price !== null
          ? `${money(r.current.competitor_price)}<br /><span class="xsmall muted">${esc(r.current.competitor_sku_name ?? '')}</span>`
          : '<span class="muted">—</span>',
    },
    { key: 'gap', label: 'Price gap', align: 'right', render: (r) => gapCell(r.current.evaluation?.gap ?? null) },
    {
      key: 'index',
      label: 'Price Index',
      align: 'right',
      render: (r) =>
        indexCell(
          r.current.evaluation?.priceIndex ?? null,
          r.current.desired_price_index_min_snapshot,
          r.current.desired_price_index_max_snapshot,
        ),
    },
    { key: 'status', label: 'Status', render: (r) => (r.current.is_jti ? statusPill(r.current.evaluation?.status) : '<span class="pill pill--none">Competitor</span>') },
    { key: 'fresh', label: 'Data freshness', render: (r) => freshnessLabelHtml(r.current.freshness) },
  ];

  return dataTable(columns, rows, { emptyMessage: 'No observations at this outlet yet.' });
}

function historyChart(observations) {
  const jti = observations.filter((o) => o.is_jti);
  if (jti.length < 2) return '<div class="empty">Not enough observations for a history chart.</div>';
  const series = buildTimeSeries(observations, 'week');
  return lineChart({
    series: [
      {
        label: 'JTI median observed price',
        color: CHART_COLORS.jti,
        points: series.map((p) => ({ period: p.period, value: p.jti_median })),
      },
      {
        label: 'Competitor median observed price',
        color: CHART_COLORS.competitor,
        dash: '4 3',
        points: series.map((p) => ({ period: p.period, value: p.competitor_median })),
      },
    ],
    yLabel: 'SGD',
  });
}

function timeline(observations, actions, opportunities) {
  const events = [];

  for (const opp of opportunities) {
    events.push({
      at: opp.first_detected_at,
      kind: 'opportunity',
      label: `Opportunity created — ${opp.jti_sku_name}`,
      detail: `${opp.category} · ${opp.reason}`,
    });
  }
  for (const action of actions) {
    events.push({
      at: action.action_at,
      kind: 'action',
      label: `TME engagement — ${action.action_type}`,
      detail: `${action.notes || ''}${action.follow_up_date ? ` · follow-up ${dateLabel(action.follow_up_date)}` : ''}`,
    });
  }
  const latestByVisit = new Map();
  for (const o of observations) {
    if (!latestByVisit.has(o.visit_id)) latestByVisit.set(o.visit_id, o);
  }
  for (const o of [...latestByVisit.values()].slice(-8)) {
    events.push({
      at: o.observed_at,
      kind: 'observation',
      label: 'Observation recorded',
      detail: `${observations.filter((x) => x.visit_id === o.visit_id).length} price observations`,
    });
  }
  for (const opp of opportunities) {
    events.push({
      at: opp.last_detected_at,
      kind: 'status',
      label: `Opportunity still open — ${opp.jti_sku_name}`,
      detail: `Open ${opp.days_open} days · ${opp.priority_label} priority`,
    });
  }

  events.sort((a, b) => new Date(b.at) - new Date(a.at));
  if (!events.length) return '<div class="empty">No timeline events yet.</div>';

  return `<ul class="timeline">
    ${events
      .slice(0, 20)
      .map(
        (e) => `<li class="${e.kind === 'action' ? 'is-action' : ''}">
          <div class="timeline__when">${esc(dateTimeLabel(e.at))}</div>
          <strong>${esc(e.label)}</strong>
          ${e.detail ? `<div class="muted small">${esc(e.detail)}</div>` : ''}
        </li>`,
      )
      .join('')}
  </ul>`;
}
