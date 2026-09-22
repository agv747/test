/**
 * §13 — observed retail price movement for a competitor SKU, and its effect per mapped JTI SKU.
 *
 * The headline impact used to be a single Price Index — 101.6 — covering Winston Red, Camel
 * Filters and LD Red at once, because all three map to Pall Mall Red. Those SKUs sit at three
 * price levels with three different intended corridors, so one index across them is the
 * position of none of them: comfortable for a mainstream SKU, a problem for a value one. The
 * event header stays shared; the effect is now a row per mapping, each judged against its own
 * corridor.
 */

import { dateLabel, esc, money, pct, priceIndex, signedMoney } from '../lib/format.js';
import { dataTable, disclaimer, inputField, priorityPill, sortRows, strategicPill } from './dom.js';
import { filterBar, handleFilterAction, handleFilterChange } from './filters.js';
import { lineChart, CHART_COLORS, SERIES_COLORS } from './charts.js';
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
  {
    // Not a blended index. A movement measured across three shops is not a market movement,
    // and a movement measured on different shops either side is not a movement at all.
    key: 'paired_outlets',
    label: 'Paired outlets',
    align: 'right',
    render: (m) =>
      m.paired_outlets
        ? `${m.paired_outlets} of ${m.comparable_outlets}<br /><span class="xsmall muted">${pct(m.paired_coverage_pct, 0)} observed in both periods</span>`
        : '<span class="muted">none — composition not controlled</span>',
    sortValue: (m) => m.paired_outlets,
  },
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
        <h2>${moves.length} observed retail price movement${moves.length === 1 ? '' : 's'}</h2>
        <div class="toolbar">
          <span class="card__sub">Measured across outlets observed in both periods</span>
          <button class="btn btn--sm" data-action="export">⇩ Export CSV</button>
        </div>
      </div>
      ${dataTable(COLUMNS, moves, {
        sortKey: sort.key,
        sortDir: sort.dir,
        rowAttrs: (m) => `class="clickable" data-action="select-move" data-sku="${esc(m.competitor_sku_id)}"`,
        emptyMessage: 'No competitor price movement exceeded the configured thresholds in this period.',
      })}
    </div>

    ${selected ? moveDetail(ctx, selected) : ''}

    ${disclaimer(
      'Competitor comparison uses <strong>mapped comparable SKUs</strong>. All-brand averages are ' +
        'deliberately not used as a default comparison. These are <strong>retail prices observed to ' +
        'have moved</strong> — retailers set their own prices, so shop-floor observations cannot ' +
        'establish a manufacturer pricing decision.',
    )}`;
}

function moveDetail(ctx, move) {
  const competitorObs = ctx.analytics.historical.filter((o) => o.sku_id === move.competitor_sku_id);
  const compSeries = buildTimeSeries(competitorObs, 'week');

  // One series per mapped JTI SKU, never their pooled median. Winston Red, Camel Filters and
  // LD Red sit at three price levels; a single line through all three is the trajectory of no
  // SKU on the chart, and it was the number this page led with.
  const perSku = move.per_sku.map((row, idx) => ({
    row,
    color: SERIES_COLORS[idx % SERIES_COLORS.length],
    series: buildTimeSeries(
      ctx.analytics.historical.filter((o) => o.sku_id === row.jti_sku_id),
      'week',
    ),
  }));

  const periods = [
    ...new Set([
      ...compSeries.map((p) => p.period),
      ...perSku.flatMap((s) => s.series.map((p) => p.period)),
    ]),
  ].sort();
  const pick = (series, key) =>
    periods.map((p) => ({ period: p, value: series.find((s) => s.period === p)?.[key] ?? null }));
  const markerPeriod =
    periods.find((p) => new Date(p) >= new Date(move.detected_at)) ?? periods[periods.length - 1];

  return `<div class="card">
    <div class="card__head">
      <h2>${esc(move.label)}</h2>
      <span class="card__sub">${esc(move.competitor_company)} ·
        ${signedMoney(move.change)} (${pct(move.pct_change)}) measured on ${esc(move.basis)}</span>
    </div>
    ${measurementNote(move)}
    ${perSkuTable(move)}
    ${lineChart({
      series: [
        {
          label: `${move.competitor_sku_name} median price`,
          color: CHART_COLORS.competitor,
          points: pick(compSeries, 'competitor_median'),
        },
        ...perSku.map((s) => ({
          label: `${s.row.jti_sku_name} median price`,
          color: s.color,
          points: pick(s.series, 'jti_median'),
        })),
      ],
      yLabel: 'SGD',
      markers: markerPeriod ? [{ period: markerPeriod, label: 'Move detected' }] : [],
    })}
    <div class="mt">
      ${lineChart({
        series: perSku.map((s) => ({
          label: `${s.row.jti_sku_name} Price Index`,
          color: s.color,
          points: pick(s.series, 'price_index_median'),
        })),
        yLabel: 'Price Index',
        height: 210,
      })}
      <p class="xsmall muted">One line per mapped SKU against its own corridor
        (${esc(
          move.per_sku
            .filter((r) => Number.isFinite(r.desired_price_index_min))
            .map((r) => `${r.jti_sku_name} ${r.desired_price_index_min}–${r.desired_price_index_max}`)
            .join(', ') || 'no corridor configured',
        )}).
        These indices are deliberately not pooled: a value SKU and a mainstream one do not share
        an intended position, so their median is nobody's.</p>
    </div>
    <p class="xsmall muted">Trends read the full history rather than the current snapshot, because a
      before-and-after needs both readings and the snapshot keeps only the later one.</p>
  </div>`;
}

/**
 * How the movement was measured, in front of the charts rather than behind them.
 *
 * A median of everything seen before against a median of everything seen after compares two
 * different sets of shops. Drop two cheap outlets from the later round and the "price" rises
 * with nothing having moved. The paired figure is the reported one; the naive figure is shown
 * beside it where they differ, because the difference is the composition effect.
 */
function measurementNote(move) {
  if (!move.paired_outlets) {
    return `<div class="disclaimer" style="background:var(--watch-bg);border-color:var(--watch-border)">
      <strong>!</strong><span>No outlet was observed in both periods, so this compares two different
      sets of shops. A change in which outlets were visited is indistinguishable from a change in
      price. Treat it as a prompt to re-observe, not as a measured movement.</span></div>`;
  }
  const naive = round2(move.unpaired_current - move.unpaired_previous);
  const differs = Math.abs(naive - move.change) >= 0.01;
  return `<p class="small muted" data-measurement>
    Measured across <strong>${move.paired_outlets} of ${move.comparable_outlets}</strong> outlets
    observed in both periods (${pct(move.paired_coverage_pct, 0)}):
    ${money(move.previous_price)} → ${money(move.current_price)}.
    ${
      differs
        ? `Comparing all observations in each period instead would have said ${signedMoney(naive)} —
           the difference is which outlets were visited, not what they charged.`
        : ''
    }
  </p>`;
}

/**
 * The effect on each mapped JTI SKU, against that mapping's own intended corridor.
 *
 * Three SKUs at three price levels do not share a position, so they do not share a number.
 */
function perSkuTable(move) {
  if (!move.per_sku?.length) {
    return '<div class="empty">No active JTI mapping for this competitor SKU.</div>';
  }
  const columns = [
    {
      key: 'jti_sku_name',
      label: 'Mapped JTI SKU',
      render: (r) => `${esc(r.jti_sku_name)} ${strategicPill({ is_strategic: r.is_strategic })}`,
    },
    { key: 'jti_median', label: 'JTI median', align: 'right', render: (r) => money(r.jti_median) },
    { key: 'gap', label: 'Gap', align: 'right', render: (r) => (r.gap === null ? '—' : signedMoney(r.gap)) },
    {
      key: 'desired_gap',
      label: 'Intended gap',
      align: 'right',
      render: (r) =>
        Number.isFinite(r.desired_gap_min)
          ? `${signedMoney(r.desired_gap_min)} – ${signedMoney(r.desired_gap_max)}`
          : '<span class="muted">—</span>',
      sortValue: (r) => r.desired_gap_min ?? 0,
    },
    { key: 'price_index', label: 'Price Index', align: 'right', render: (r) => priceIndex(r.price_index) },
    {
      key: 'desired_index',
      label: 'Intended index',
      align: 'right',
      render: (r) =>
        Number.isFinite(r.desired_price_index_min)
          ? `${r.desired_price_index_min} – ${r.desired_price_index_max}`
          : '<span class="muted">—</span>',
      sortValue: (r) => r.desired_price_index_min ?? 0,
    },
    {
      key: 'position',
      label: 'Relative position',
      render: (r) => relativePosition(r),
    },
    { key: 'outlets', label: 'Outlets', align: 'right', render: (r) => r.outlets },
  ];
  return `<div class="mb" data-per-sku>
    <h3 style="margin:0 0 4px">Effect by mapped JTI SKU</h3>
    <p class="xsmall muted" style="margin:0 0 8px">Each SKU is judged against its own configured corridor.
      These are not summed or averaged: SKUs at different price levels do not share a position.</p>
    ${dataTable(columns, move.per_sku)}
  </div>`;
}

/** Inside or outside the corridor, said in words rather than left to a colour. */
function relativePosition(row) {
  const verdicts = [row.inside_gap, row.inside_index].filter((v) => v !== null);
  if (!verdicts.length) return '<span class="muted">no corridor configured</span>';
  if (verdicts.every((v) => v === true)) {
    return '<span class="pill pill--good">Within intended relative position</span>';
  }
  const above = (row.gap !== null && Number.isFinite(row.desired_gap_max) && row.gap > row.desired_gap_max) ||
    (row.price_index !== null && Number.isFinite(row.desired_price_index_max) && row.price_index > row.desired_price_index_max);
  return above
    ? '<span class="pill pill--risk">Above intended relative position</span>'
    : '<span class="pill pill--watch">Below intended relative position</span>';
}

function round2(v) {
  return Math.round(v * 100) / 100;
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
      paired_outlets: m.paired_outlets,
      comparable_outlets: m.comparable_outlets,
      measurement_basis: m.basis,
      // One row per mapping, so the export cannot be read as a single blended position either.
      per_mapped_sku: m.per_sku
        .map((r) => `${r.jti_sku_name}: gap ${r.gap ?? '—'}, index ${r.price_index ?? '—'} (intended ${r.desired_price_index_min ?? '—'}–${r.desired_price_index_max ?? '—'})`)
        .join('; '),
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
