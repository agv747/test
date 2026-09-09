/**
 * §9 — Price Control Tower.
 *
 * Answers one question first: where is current retail price position creating a business
 * risk or opportunity? Exceptions and opportunities lead; raw data is one click away.
 */

import { esc, money, pct } from '../lib/format.js';
import {
  MARKET_CONTEXT_NOTE,
  dataTable,
  disclaimer,
  freshnessLabelHtml,
  gapCell,
  indexCell,
  kpiCard,
  priorityPill,
  statusPill,
  strategicPill,
} from './dom.js';
import { filterBar, handleFilterAction, handleFilterChange } from './filters.js';
import {
  COMPETITIVE_BUCKET_LABELS,
  MATRIX_INTERPRETATION,
  RANGE_BUCKET,
  RANGE_BUCKET_LABELS,
  COMPETITIVE_BUCKET,
} from '../services/pricePositionService.js';
import { dateTimeLabel } from '../lib/format.js';

/** Drill-down selection for the matrix. */
let selectedCell = null;

/** Keeps the drill-down readable; the full set is available via export. */
const DRILLDOWN_LIMIT = 50;

export const title = () => 'Price Control Tower';
export const subtitle = () => 'Where is observed retail price position creating a business risk or opportunity?';

export function render(ctx) {
  const a = ctx.analytics;
  return `
    ${disclaimer(esc(MARKET_CONTEXT_NOTE))}
    ${filterBar(ctx)}
    ${kpiRow(a)}
    <div class="grid grid--2">
      <div>${matrixCard(a)}</div>
      <div>${topActionsCard(a)}</div>
    </div>
    ${selectedCell ? drilldownCard(a, ctx) : ''}
  `;
}

function kpiRow(a) {
  const k = a.kpis;
  return `<div class="grid grid--kpi mb">
    ${kpiCard({
      label: 'Recommended Price Alignment',
      value: pct(k.recommended_price_alignment),
      meta: `${k.recommended_price_alignment_n} JTI observations with a valid recommendation`,
      delta: k.delta?.recommended_price_alignment,
    })}
    ${kpiCard({
      label: 'Strategic SKU Alignment',
      value: pct(k.strategic_recommended_price_alignment),
      meta: `${k.strategic_recommended_price_alignment_n} Strategic SKU observations`,
      delta: k.delta?.strategic_recommended_price_alignment,
    })}
    ${kpiCard({
      label: 'Competitive Alignment',
      value: pct(k.competitive_alignment),
      meta: `${k.competitive_alignment_n} mapped JTI / competitor pairs`,
      delta: k.delta?.competitive_alignment,
    })}
    ${kpiCard({
      label: 'Pricing Opportunities',
      value: String(k.pricing_opportunities),
      meta: `${k.high_priority_opportunities} high priority`,
    })}
    ${kpiCard({
      label: 'Strategic SKU Opportunities',
      value: String(k.strategic_opportunities),
      meta: 'Opportunities involving a Strategic SKU',
    })}
    ${kpiCard({
      label: 'Recent Competitor Moves',
      value: String(k.recent_competitor_moves),
      meta: 'Material competitor price changes in the period',
    })}
    ${kpiCard({
      label: 'Market Coverage',
      value: pct(k.coverage.coverage_pct),
      meta: `${k.coverage.observed_outlets} of ${k.coverage.expected_outlets} outlets observed in ${k.coverage.window_days} days`,
    })}
    ${kpiCard({
      label: 'Data Confidence',
      value: pct(k.data_confidence),
      meta: 'Observations above the recognition-confidence threshold',
    })}
  </div>`;
}

function matrixCard(a) {
  const rows = [RANGE_BUCKET.ABOVE, RANGE_BUCKET.WITHIN, RANGE_BUCKET.BELOW];
  const cols = [COMPETITIVE_BUCKET.JTI_EXPENSIVE, COMPETITIVE_BUCKET.DESIRED, COMPETITIVE_BUCKET.JTI_CHEAPER];

  const head = `<tr><th class="row-head"></th>${cols
    .map((c) => `<th>${esc(COMPETITIVE_BUCKET_LABELS[c])}</th>`)
    .join('')}</tr>`;

  const body = a.matrix.matrix
    .map((row) => {
      const cells = row.cells
        .map((cell) => {
          const meaning = MATRIX_INTERPRETATION[cell.row][cell.col];
          const selected = selectedCell && selectedCell.row === cell.row && selectedCell.col === cell.col;
          return `<td><div class="matrix-cell matrix-cell--${meaning.tone}${selected ? ' matrix-cell--selected' : ''}"
              data-action="select-cell" data-row="${esc(cell.row)}" data-col="${esc(cell.col)}"
              role="button" tabindex="0" title="${esc(meaning.label)} — click to drill down">
              <div class="matrix-cell__count">${cell.count}</div>
              <div class="matrix-cell__label">${esc(meaning.label)}</div>
              <div class="matrix-cell__meta">${cell.outletCount} outlet${cell.outletCount === 1 ? '' : 's'} · ${pct(cell.pct, 0)}</div>
            </div></td>`;
        })
        .join('');
      return `<tr><th class="row-head">${esc(RANGE_BUCKET_LABELS[row.row])}</th>${cells}</tr>`;
    })
    .join('');

  return `<div class="card">
    <div class="card__head">
      <h2>Price Position Matrix</h2>
      <span class="card__sub">${a.matrix.total} JTI observations${a.matrix.unclassified ? ` · ${a.matrix.unclassified} without a comparable competitor or recommendation` : ''}</span>
    </div>
    <div class="table-wrap" style="border:0">
      <table class="matrix"><thead>${head}</thead><tbody>${body}</tbody></table>
    </div>
    <p class="xsmall muted mt">Cell meanings are configurable business interpretations, not fixed judgements. Click any cell to drill into the underlying observations.</p>
  </div>`;
}

function topActionsCard(a) {
  if (!a.topActions.length) {
    return `<div class="card"><div class="card__head"><h2>Top Opportunities</h2></div>
      <div class="empty">No actionable opportunities for the current filters.</div></div>`;
  }
  return `<div class="card">
    <div class="card__head"><h2>Top Opportunities</h2>
      <span class="card__sub">Ranked by configurable priority score</span></div>
    ${a.topActions
      .map(
        (item) => `<div class="action-item action-item--${esc(item.priority)}"
            ${item.kind === 'opportunity' ? `data-action="open-opportunity" data-outlet="${esc(item.opportunity.outlet_id)}"` : ''}>
          <div class="action-item__body">
            <div class="action-item__title">${esc(item.title)}</div>
            <div class="action-item__meta">${esc(item.subtitle)}</div>
            <div class="action-item__reason">Reason: ${esc(item.reason)}</div>
            <div class="action-item__cta">Suggested action: ${esc(item.suggested_action)}</div>
          </div>
          ${priorityPill(item.priority)}
        </div>`,
      )
      .join('')}
    <button class="btn btn--sm mt" data-nav="manager/opportunities">View all pricing opportunities →</button>
  </div>`;
}

function drilldownCard(a, ctx) {
  const cell = a.matrix.matrix
    .find((r) => r.row === selectedCell.row)
    ?.cells.find((c) => c.col === selectedCell.col);
  if (!cell) return '';

  const meaning = MATRIX_INTERPRETATION[cell.row][cell.col];
  const recent = cell.observations
    .slice()
    .sort((a, b) => new Date(b.observed_at) - new Date(a.observed_at));
  const columns = [
    { key: 'territory_name', label: 'Territory', render: (o) => esc(o.territory_name) },
    { key: 'outlet_name', label: 'Outlet', render: (o) => `${esc(o.outlet_name)}<br /><span class="xsmall muted">${esc(o.outlet_code)}</span>` },
    { key: 'sku_name', label: 'JTI SKU', render: (o) => `${esc(o.sku_name)} ${strategicPill(o.sku)}` },
    { key: 'competitor_sku_name', label: 'Competitor SKU', render: (o) => esc(o.competitor_sku_name ?? '—') },
    { key: 'confirmed_price', label: 'JTI price', align: 'right', render: (o) => money(o.confirmed_price) },
    { key: 'competitor_price', label: 'Competitor price', align: 'right', render: (o) => money(o.competitor_price) },
    { key: 'gap', label: 'Price gap', align: 'right', render: (o) => gapCell(o.evaluation.gap), sortValue: (o) => o.evaluation.gap },
    {
      key: 'index',
      label: 'Price Index',
      align: 'right',
      render: (o) => indexCell(o.evaluation.priceIndex, o.desired_price_index_min_snapshot, o.desired_price_index_max_snapshot),
      sortValue: (o) => o.evaluation.priceIndex,
    },
    { key: 'status', label: 'Status', render: (o) => statusPill(o.evaluation.status) },
    { key: 'observed_at', label: 'Observed', render: (o) => `${esc(dateTimeLabel(o.observed_at))}<br />${freshnessLabelHtml(o.freshness)}` },
    {
      key: 'last_action',
      label: 'Last field action',
      render: (o) => {
        const action = ctx.data.field_actions
          .filter((x) => x.outlet_id === o.outlet_id)
          .sort((x, y) => new Date(y.action_at) - new Date(x.action_at))[0];
        return esc(action?.action_type ?? '—');
      },
    },
  ];

  return `<div class="card">
    <div class="card__head">
      <h2>${esc(meaning.label)} — ${esc(RANGE_BUCKET_LABELS[cell.row])} · ${esc(COMPETITIVE_BUCKET_LABELS[cell.col])}</h2>
      <div class="toolbar">
        <span class="card__sub">${cell.count} observations across ${cell.outletCount} outlets</span>
        <button class="btn btn--sm" data-action="close-drilldown">Close</button>
      </div>
    </div>
    <div style="max-height:60vh;overflow:auto">
      ${dataTable(columns, recent.slice(0, DRILLDOWN_LIMIT), {
        rowAttrs: (o) => `class="clickable" data-action="open-outlet" data-outlet="${esc(o.outlet_id)}"`,
      })}
    </div>
    ${cell.observations.length > DRILLDOWN_LIMIT ? `<p class="xsmall muted mt">Showing the ${DRILLDOWN_LIMIT} most recent of ${cell.observations.length} observations. Narrow the filters or export to see them all.</p>` : ''}
  </div>`;
}

export function onAction(action, el, ctx) {
  if (handleFilterAction(action, el, ctx)) return;
  switch (action) {
    case 'select-cell':
      selectedCell =
        selectedCell && selectedCell.row === el.dataset.row && selectedCell.col === el.dataset.col
          ? null
          : { row: el.dataset.row, col: el.dataset.col };
      ctx.render();
      break;
    case 'close-drilldown':
      selectedCell = null;
      ctx.render();
      break;
    case 'open-outlet':
    case 'open-opportunity':
      ctx.navigate('outlet', { id: el.dataset.outlet });
      break;
    default:
      break;
  }
}

export function onChange(target, ctx) {
  return handleFilterChange(target, ctx);
}
