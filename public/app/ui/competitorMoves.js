/** §13 — Competitor Moves: what changed, not a competitor price list. */

import { dateLabel, esc, money, pct, priceIndex, signedMoney } from '../lib/format.js';
import { dataTable, disclaimer, inputField, priorityPill, sortRows, strategicPill } from './dom.js';
import { filterBar, handleFilterAction, handleFilterChange } from './filters.js';
import { lineChart, CHART_COLORS } from './charts.js';
import { buildTimeSeries } from '../services/analyticsService.js';
import { downloadCsv } from '../lib/csv.js';

let sort = { key: 'magnitude', dir: 'desc' };
let selectedMoveSkuId = null;

export const title = () => 'Competitor Moves';
export const subtitle = (ctx) =>
  `Material changes over the last ${ctx.config.competitor_move.lookback_days} days`;

const COLUMNS = [
  { key: 'competitor_company', label: 'Competitor', render: (m) => esc(m.competitor_company) },
  { key: 'competitor_sku_name', label: 'SKU', render: (m) => esc(m.competitor_sku_name) },
  { key: 'previous_price', label: 'Previous price', align: 'right', render: (m) => money(m.previous_price) },
  { key: 'current_price', label: 'Current price', align: 'right', render: (m) => money(m.current_price) },
  {
    key: 'change',
    label: 'Change',
    align: 'right',
    render: (m) => `<span class="pill pill--${m.change < 0 ? 'risk' : 'watch'}">${m.change < 0 ? '▼' : '▲'} ${signedMoney(m.change)}</span>`,
  },
  { key: 'pct_change', label: '% change', align: 'right', render: (m) => pct(m.pct_change) },
  {
    key: 'affected_jti',
    label: 'Affected JTI SKU',
    render: (m) =>
      m.affected_jti_sku_names.length
        ? `${esc(m.affected_jti_sku_names.join(', '))}${m.strategic_affected ? ' ' + strategicPill({ is_strategic: true }) : ''}`
        : '<span class="muted">no active mapping</span>',
    sortValue: (m) => m.affected_jti_sku_names.join(','),
  },
  { key: 'affected_outlets', label: 'Affected outlets', align: 'right', render: (m) => m.affected_outlets },
  { key: 'new_gap', label: 'New gap', align: 'right', render: (m) => (m.new_gap === null ? '—' : signedMoney(m.new_gap)) },
  { key: 'new_price_index', label: 'New Price Index', align: 'right', render: (m) => priceIndex(m.new_price_index) },
  { key: 'priority', label: 'Priority', render: (m) => priorityPill(m.priority) },
  { key: 'detected_at', label: 'Detected', render: (m) => esc(dateLabel(m.detected_at)), sortValue: (m) => new Date(m.detected_at).getTime() },
];

export function render(ctx) {
  const moves = sortRows(ctx.analytics.competitorMoves, COLUMNS, sort.key, sort.dir);
  const cfg = ctx.config.competitor_move;
  const selected = moves.find((m) => m.competitor_sku_id === selectedMoveSkuId) ?? moves[0] ?? null;

  return `
    ${filterBar(ctx, { show: ['date', 'territory', 'channel', 'sku'] })}
    <div class="card">
      <div class="card__head">
        <h3>Material-move thresholds</h3>
        <span class="card__sub">Configurable — a change must exceed either threshold to be reported</span>
      </div>
      <div class="filters">
        ${inputField({ label: 'Absolute change (SGD)', name: 'min_abs_change', type: 'number', value: cfg.min_abs_change, attrs: 'step="0.05" min="0" data-config="min_abs_change"' })}
        ${inputField({ label: 'Percentage change (%)', name: 'min_pct_change', type: 'number', value: cfg.min_pct_change, attrs: 'step="0.1" min="0" data-config="min_pct_change"' })}
        ${inputField({ label: 'Lookback (days)', name: 'lookback_days', type: 'number', value: cfg.lookback_days, attrs: 'step="1" min="1" data-config="lookback_days"' })}
        ${inputField({ label: 'Strategic mapping weight', name: 'strategic_mapping_weight', type: 'number', value: cfg.strategic_mapping_weight, attrs: 'step="0.1" min="0" data-config="strategic_mapping_weight"' })}
      </div>
    </div>

    <div class="card">
      <div class="card__head">
        <h2>${moves.length} material competitor move${moves.length === 1 ? '' : 's'}</h2>
        <button class="btn btn--sm" data-action="export">⇩ Export CSV</button>
      </div>
      ${dataTable(COLUMNS, moves, {
        sortKey: sort.key,
        sortDir: sort.dir,
        rowAttrs: (m) => `class="clickable" data-action="select-move" data-sku="${esc(m.competitor_sku_id)}"`,
        emptyMessage: 'No competitor price movement exceeded the configured thresholds in this period.',
      })}
    </div>

    ${selected ? moveDetail(ctx, selected) : ''}

    ${disclaimer('Competitor comparison uses <strong>mapped comparable SKUs</strong>. All-brand averages are deliberately not used as a default comparison.')}`;
}

function moveDetail(ctx, move) {
  const competitorObs = ctx.analytics.observations.filter((o) => o.sku_id === move.competitor_sku_id);
  const jtiObs = ctx.analytics.observations.filter((o) => move.affected_jti_sku_ids.includes(o.sku_id));
  const compSeries = buildTimeSeries(competitorObs, 'week');
  const jtiSeries = buildTimeSeries(jtiObs, 'week');
  const periods = [...new Set([...compSeries.map((p) => p.period), ...jtiSeries.map((p) => p.period)])].sort();
  const pick = (series, key) => periods.map((p) => ({ period: p, value: series.find((s) => s.period === p)?.[key] ?? null }));
  const markerPeriod = periods.find((p) => new Date(p) >= new Date(move.detected_at)) ?? periods[periods.length - 1];

  return `<div class="card">
    <div class="card__head">
      <h2>${esc(move.competitor_sku_name)} — price movement</h2>
      <span class="card__sub">${esc(move.competitor_company)} · ${move.affected_observations} affected JTI observations</span>
    </div>
    ${lineChart({
      series: [
        { label: 'Competitor median price', color: CHART_COLORS.competitor, points: pick(compSeries, 'competitor_median') },
        { label: 'Mapped JTI median price', color: CHART_COLORS.jti, points: pick(jtiSeries, 'jti_median') },
      ],
      yLabel: 'SGD',
      markers: markerPeriod ? [{ period: markerPeriod, label: 'Move detected' }] : [],
    })}
    <div class="mt">
      ${lineChart({
        series: [{ label: 'Median Price Index (mapped JTI SKUs)', color: CHART_COLORS.index, points: pick(jtiSeries, 'price_index_median') }],
        yLabel: 'Price Index',
        height: 190,
      })}
    </div>
  </div>`;
}

export function onAction(action, el, ctx) {
  if (handleFilterAction(action, el, ctx)) return;
  if (action === 'select-move') {
    selectedMoveSkuId = el.dataset.sku;
    ctx.render();
    return;
  }
  if (action === 'export') {
    const rows = ctx.analytics.competitorMoves.map((m) => ({
      competitor: m.competitor_company,
      competitor_sku: m.competitor_sku_name,
      previous_price: m.previous_price,
      current_price: m.current_price,
      change: m.change,
      pct_change: m.pct_change,
      affected_jti_skus: m.affected_jti_sku_names.join('; '),
      affected_outlets: m.affected_outlets,
      new_gap: m.new_gap ?? '',
      new_price_index: m.new_price_index ?? '',
      priority: m.priority,
      detected_at: m.detected_at,
    }));
    downloadCsv('competitor-moves.csv', Object.keys(rows[0] ?? { competitor: '' }), rows);
  }
}

export function onChange(target, ctx) {
  if (handleFilterChange(target, ctx)) return true;
  if (target.dataset.config) {
    const value = Number.parseFloat(target.value);
    if (Number.isFinite(value)) {
      ctx.store.updateConfig({
        competitor_move: { ...ctx.config.competitor_move, [target.dataset.config]: value },
      });
      ctx.render();
    }
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
