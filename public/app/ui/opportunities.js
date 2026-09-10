/** §10 — Pricing Opportunities. A business-opportunity view, never a "non-compliant outlet" list. */

import { dateLabel, esc, money } from '../lib/format.js';
import {
  dataTable,
  disclaimer,
  freshnessLabelHtml,
  gapCell,
  indexCell,
  priorityPill,
  sortRows,
  statusPill,
  strategicPill,
  selectField,
} from './dom.js';
import { filterBar, handleFilterAction, handleFilterChange } from './filters.js';
import { OPPORTUNITY_CATEGORIES, OPPORTUNITY_STATUSES } from '../config.js';
import { RANGE_BUCKET_LABELS } from '../services/pricePositionService.js';
import { downloadCsv } from '../lib/csv.js';

let sort = { key: 'priority_score', dir: 'desc' };
let categoryFilter = '';
let statusFilter = '';
let expandedId = null;

export const title = () => 'Pricing Opportunities';
export const subtitle = () => 'Commercial opportunities derived from observed retail price position';

function withState(ctx, opportunities) {
  return opportunities.map((o) => {
    const stored = ctx.store.getOpportunityState(o.id);
    return { ...o, status: stored?.status ?? o.status, assigned_user_id: stored?.assigned_user_id ?? o.assigned_user_id };
  });
}

const COLUMNS = [
  { key: 'priority_score', label: 'Priority', render: (o) => `${priorityPill(o.priority_label)}<br /><span class="xsmall muted mono">${o.priority_score}</span>` },
  { key: 'category', label: 'Category', render: (o) => esc(o.category) },
  { key: 'territory_name', label: 'Territory', render: (o) => esc(o.territory_name) },
  { key: 'channel_name', label: 'Channel', render: (o) => esc(o.channel_name) },
  { key: 'outlet_name', label: 'Outlet', render: (o) => `${esc(o.outlet_name)}<br /><span class="xsmall muted">${esc(o.outlet_code)}</span>` },
  { key: 'jti_sku_name', label: 'JTI SKU', render: (o) => `${esc(o.jti_sku_name)} ${strategicPill({ is_strategic: o.is_strategic, strategic_priority: o.strategic_priority })}` },
  { key: 'jti_price', label: 'JTI price', align: 'right', render: (o) => money(o.jti_price) },
  {
    key: 'range',
    label: 'Recommended range',
    align: 'right',
    render: (o) => (o.recommended_min !== null ? `${money(o.recommended_min)} – ${money(o.recommended_max)}` : '<span class="muted">—</span>'),
    sortValue: (o) => o.recommended_price ?? 0,
  },
  { key: 'competitor_sku_name', label: 'Competitor SKU', render: (o) => esc(o.competitor_sku_name ?? '—') },
  { key: 'competitor_price', label: 'Competitor price', align: 'right', render: (o) => money(o.competitor_price) },
  { key: 'price_gap', label: 'Price gap', align: 'right', render: (o) => gapCell(o.price_gap) },
  {
    key: 'price_index',
    label: 'Price Index',
    align: 'right',
    render: (o) => indexCell(o.price_index, o.desired_price_index_min, o.desired_price_index_max),
  },
  {
    key: 'desired_index',
    label: 'Desired Price Index',
    align: 'right',
    render: (o) => (o.desired_price_index_min !== null ? `${o.desired_price_index_min} – ${o.desired_price_index_max}` : '—'),
    sortValue: (o) => o.desired_price_index_min ?? 0,
  },
  { key: 'first_detected_at', label: 'First detected', render: (o) => esc(dateLabel(o.first_detected_at)), sortValue: (o) => new Date(o.first_detected_at).getTime() },
  { key: 'last_detected_at', label: 'Last detected', render: (o) => `${esc(dateLabel(o.last_detected_at))}<br />${freshnessLabelHtml(o.freshness)}`, sortValue: (o) => new Date(o.last_detected_at).getTime() },
  { key: 'days_open', label: 'Days open', align: 'right', render: (o) => o.days_open },
  { key: 'last_action', label: 'Last TME action', render: (o) => esc(o.last_action?.action_type ?? '—') },
  { key: 'status', label: 'Status', render: (o) => `<span class="pill pill--info">${esc(o.status)}</span>` },
  { key: 'assigned', label: 'Assigned TME', render: (o) => esc(o.assigned_tme_name ?? '—') },
];

export function render(ctx) {
  const users = new Map(ctx.data.users.map((u) => [u.id, u]));
  let rows = withState(ctx, ctx.analytics.opportunities).map((o) => ({
    ...o,
    assigned_tme_name: users.get(o.assigned_user_id)?.name ?? null,
  }));

  if (categoryFilter) rows = rows.filter((o) => o.category === categoryFilter);
  if (statusFilter) rows = rows.filter((o) => o.status === statusFilter);
  rows = sortRows(rows, COLUMNS, sort.key, sort.dir);

  const byCategory = Object.values(OPPORTUNITY_CATEGORIES).map((c) => ({
    category: c,
    count: withState(ctx, ctx.analytics.opportunities).filter((o) => o.category === c).length,
  }));

  return `
    ${disclaimer('A price outside a JTI recommended range is a market signal, not a violation. Outlets in Singapore set their own final selling price.')}
    ${filterBar(ctx)}
    <div class="card">
      <div class="card__head"><h3>By category</h3></div>
      <div class="grid grid--3">
        ${byCategory
          .map(
            (c) => `<div class="kpi" style="cursor:pointer" data-action="filter-category" data-category="${esc(c.category)}">
              <div class="kpi__label">${esc(c.category)}</div>
              <div class="kpi__value">${c.count}</div>
              <div class="kpi__meta">${categoryFilter === c.category ? 'Filtering by this category — click to clear' : 'Click to filter'}</div>
            </div>`,
          )
          .join('')}
      </div>
    </div>
    <div class="card">
      <div class="card__head">
        <h2>${rows.length} opportunit${rows.length === 1 ? 'y' : 'ies'}</h2>
        <div class="toolbar">
          ${selectField({
            label: 'Lifecycle status',
            name: 'opp-status',
            value: statusFilter,
            includeAll: true,
            allLabel: 'All statuses',
            options: OPPORTUNITY_STATUSES.map((s) => ({ value: s, label: s })),
          })}
          <button class="btn btn--sm" data-action="export">⇩ Export CSV</button>
        </div>
      </div>
      ${dataTable(COLUMNS, rows.slice(0, 300), {
        sortKey: sort.key,
        sortDir: sort.dir,
        rowAttrs: (o) => `class="clickable" data-action="expand" data-opp="${esc(o.id)}"`,
        emptyMessage: 'No opportunities for the current filters — observed prices sit within the desired commercial position.',
      })}
    </div>
    ${expandedId ? detailCard(ctx, rows.find((o) => o.id === expandedId)) : ''}`;
}

function detailCard(ctx, opp) {
  if (!opp) return '';
  const columns = [
    { key: 'observed_at', label: 'Observed', render: (o) => esc(dateLabel(o.observed_at)) },
    { key: 'confirmed_price', label: 'JTI price', align: 'right', render: (o) => money(o.confirmed_price) },
    { key: 'competitor_price', label: 'Competitor price', align: 'right', render: (o) => money(o.competitor_price) },
    { key: 'gap', label: 'Gap', align: 'right', render: (o) => gapCell(o.evaluation?.gap) },
    { key: 'index', label: 'Price Index', align: 'right', render: (o) => indexCell(o.evaluation?.priceIndex, o.desired_price_index_min_snapshot, o.desired_price_index_max_snapshot) },
    { key: 'status', label: 'Status', render: (o) => statusPill(o.evaluation?.status) },
    { key: 'confidence', label: 'Confidence', align: 'right', render: (o) => `${Math.round((o.recognition_confidence ?? 0) * 100)}%` },
    { key: 'image', label: 'Source image', render: (o) => esc(ctx.data.images.find((i) => i.id === o.image_id)?.file_name ?? '—') },
  ];

  const components = Object.entries(opp.priority_components)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `<div class="detection__row"><dt>${esc(humanise(k))}</dt><dd>${v > 0 ? '+' : ''}${v}</dd></div>`)
    .join('');

  return `<div class="card">
    <div class="card__head">
      <h2>${esc(opp.jti_sku_name)} — ${esc(opp.outlet_name)}</h2>
      <div class="toolbar">
        ${selectField({
          label: 'Set status',
          name: 'set-status',
          value: opp.status,
          includeAll: false,
          options: OPPORTUNITY_STATUSES.map((s) => ({ value: s, label: s })),
        })}
        <button class="btn btn--sm" data-action="open-outlet" data-outlet="${esc(opp.outlet_id)}">Open outlet</button>
        <button class="btn btn--sm" data-action="collapse">Close</button>
      </div>
    </div>
    <div class="grid grid--2">
      <div>
        <h3>Why this is prioritised</h3>
        <p class="small">${esc(opp.reason)}</p>
        <p class="small"><strong>Suggested action:</strong> ${esc(opp.suggested_action)}</p>
        <p class="xsmall muted">Advisory only — the system never calculates or approves trade investment amounts.</p>
        <h4 class="mt">Priority score ${opp.priority_score} (${esc(opp.priority_label)})</h4>
        <dl style="margin:0">${components}</dl>
      </div>
      <div>
        <h3>Position</h3>
        <dl style="margin:0">
          <div class="detection__row"><dt>Range position</dt><dd>${esc(RANGE_BUCKET_LABELS[opp.range_bucket])}</dd></div>
          <div class="detection__row"><dt>Recommended range</dt><dd>${opp.recommended_min !== null ? `${money(opp.recommended_min)} – ${money(opp.recommended_max)}` : '—'}</dd></div>
          <div class="detection__row"><dt>JTI observed price</dt><dd>${money(opp.jti_price)}</dd></div>
          <div class="detection__row"><dt>Competitor observed price</dt><dd>${money(opp.competitor_price)}</dd></div>
          <div class="detection__row"><dt>Price gap</dt><dd>${gapCell(opp.price_gap)}</dd></div>
          <div class="detection__row"><dt>Price Index</dt><dd>${indexCell(opp.price_index, opp.desired_price_index_min, opp.desired_price_index_max)}</dd></div>
          <div class="detection__row"><dt>Outlets affected (same SKU)</dt><dd>${opp.outlet_count}</dd></div>
          <div class="detection__row"><dt>Days open</dt><dd>${opp.days_open}</dd></div>
        </dl>
      </div>
    </div>
    <h3 class="mt">Underlying observations</h3>
    ${dataTable(columns, opp.observations.slice().reverse())}
  </div>`;
}

function humanise(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

export function onAction(action, el, ctx) {
  if (handleFilterAction(action, el, ctx)) return;
  switch (action) {
    case 'filter-category':
      categoryFilter = categoryFilter === el.dataset.category ? '' : el.dataset.category;
      ctx.render();
      break;
    case 'expand':
      expandedId = expandedId === el.dataset.opp ? null : el.dataset.opp;
      ctx.render();
      break;
    case 'collapse':
      expandedId = null;
      ctx.render();
      break;
    case 'open-outlet':
      ctx.navigate('outlet', { id: el.dataset.outlet });
      break;
    case 'export': {
      const rows = withState(ctx, ctx.analytics.opportunities).map((o) => ({
        priority: o.priority_label,
        priority_score: o.priority_score,
        category: o.category,
        territory: o.territory_name,
        channel: o.channel_name,
        outlet_code: o.outlet_code,
        outlet: o.outlet_name,
        jti_sku: o.jti_sku_name,
        strategic_sku: o.is_strategic ? 'Yes' : 'No',
        jti_observed_price: o.jti_price,
        recommended_min: o.recommended_min ?? '',
        recommended_max: o.recommended_max ?? '',
        competitor_sku: o.competitor_sku_name ?? '',
        competitor_observed_price: o.competitor_price ?? '',
        price_gap: o.price_gap ?? '',
        price_index: o.price_index ?? '',
        desired_price_index_min: o.desired_price_index_min ?? '',
        desired_price_index_max: o.desired_price_index_max ?? '',
        first_detected: o.first_detected_at,
        last_detected: o.last_detected_at,
        days_open: o.days_open,
        last_tme_action: o.last_action?.action_type ?? '',
        status: o.status,
      }));
      downloadCsv('pricing-opportunities.csv', Object.keys(rows[0] ?? { outlet: '' }), rows);
      break;
    }
    default:
      break;
  }
}

export function onChange(target, ctx) {
  if (handleFilterChange(target, ctx)) return true;
  if (target.dataset.filter === 'opp-status') {
    statusFilter = target.value;
    ctx.render();
    return true;
  }
  if (target.dataset.filter === 'set-status' && expandedId) {
    ctx.store.setOpportunityState(expandedId, { status: target.value });
    ctx.render();
    return true;
  }
  return false;
}

export function mount(ctx, root) {
  root.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      sort = { key, dir: sort.key === key && sort.dir === 'desc' ? 'asc' : 'desc' };
      ctx.render();
    });
  });
}
