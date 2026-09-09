/** Small DOM/rendering helpers. Pages return HTML strings; behaviour is bound by delegation. */

import { esc, money, num, pct, priceIndex, dateLabel, signedMoney } from '../lib/format.js';
import { PRICE_POSITION_STATUS } from '../config.js';

export { esc, money, num, pct, priceIndex, dateLabel, signedMoney };

/** Tone (colour + label) for a commercial status. Colour is never the only signal. */
export function statusTone(status) {
  switch (status) {
    case PRICE_POSITION_STATUS.WITHIN:
    case PRICE_POSITION_STATUS.STRONG:
      return 'good';
    case PRICE_POSITION_STATUS.ABOVE:
    case PRICE_POSITION_STATUS.AT_RISK:
      return 'risk';
    case PRICE_POSITION_STATUS.BELOW:
    case PRICE_POSITION_STATUS.REVIEW:
      return 'watch';
    default:
      return 'none';
  }
}

const STATUS_ICON = {
  good: '✓',
  watch: '!',
  risk: '▲',
  none: '–',
};

export function statusPill(status) {
  if (!status) return `<span class="pill pill--none">${STATUS_ICON.none} No data</span>`;
  const tone = statusTone(status);
  return `<span class="pill pill--${tone}">${STATUS_ICON[tone]} ${esc(status)}</span>`;
}

export function priorityPill(label) {
  const tone = label === 'High' ? 'risk' : label === 'Medium' ? 'watch' : 'none';
  return `<span class="pill pill--${tone}">${STATUS_ICON[tone]} ${esc(label)}</span>`;
}

export function strategicPill(sku) {
  if (!sku?.is_strategic) return '';
  return `<span class="pill pill--strategic">★ Strategic${sku.strategic_priority ? ` · ${esc(sku.strategic_priority)}` : ''}</span>`;
}

export function freshnessLabelHtml(freshness) {
  if (!freshness) return '<span class="muted">—</span>';
  const icon = freshness.level === 'fresh' ? '●' : freshness.level === 'aging' ? '◐' : '○';
  return `<span class="freshness--${freshness.level}">${icon} ${esc(freshness.label)}${
    freshness.ageDays !== null ? ` · ${freshness.ageDays}d` : ''
  }</span>`;
}

export function confidenceBar(confidence) {
  if (confidence === null || confidence === undefined) return '<span class="muted">—</span>';
  const pctValue = Math.round(confidence * 100);
  const color = confidence >= 0.9 ? 'var(--good)' : confidence >= 0.75 ? 'var(--watch)' : 'var(--risk)';
  return `<span class="row" style="gap:6px">
    <span class="confbar"><span class="confbar__fill" style="width:${pctValue}%;background:${color}"></span></span>
    <span class="xsmall mono">${pctValue}%</span>
  </span>`;
}

export function kpiCard({ label, value, meta, delta, deltaSuffix = ' pp vs previous period' }) {
  let deltaHtml = '';
  if (delta !== null && delta !== undefined && Number.isFinite(delta)) {
    const cls = delta > 0.05 ? 'up' : delta < -0.05 ? 'down' : 'flat';
    const arrow = delta > 0.05 ? '▲' : delta < -0.05 ? '▼' : '▬';
    deltaHtml = `<div class="kpi__delta kpi__delta--${cls}">${arrow} ${Math.abs(delta).toFixed(1)}${esc(deltaSuffix)}</div>`;
  }
  return `<div class="kpi">
    <div class="kpi__label">${esc(label)}</div>
    <div class="kpi__value">${value}</div>
    ${meta ? `<div class="kpi__meta">${meta}</div>` : ''}
    ${deltaHtml}
  </div>`;
}

/**
 * Sortable table. `columns` = [{key, label, align, render(row), sortValue(row), sortable}].
 */
export function dataTable(columns, rows, options = {}) {
  const { sortKey = null, sortDir = 'desc', rowAttrs = () => '', emptyMessage = 'No data for the current filters.' } = options;
  if (!rows.length) return `<div class="empty">${esc(emptyMessage)}</div>`;

  const head = columns
    .map((c) => {
      const sortable = c.sortable !== false;
      const aria = sortKey === c.key ? ` aria-sort="${sortDir === 'asc' ? 'ascending' : 'descending'}"` : '';
      return `<th class="${sortable ? '' : 'no-sort'}${c.align === 'right' ? ' right' : ''}"${
        sortable ? ` data-sort="${esc(c.key)}"` : ''
      }${aria}>${esc(c.label)}</th>`;
    })
    .join('');

  const body = rows
    .map(
      (row) =>
        `<tr ${rowAttrs(row)}>${columns
          .map((c) => `<td class="${c.align === 'right' ? 'num' : ''}">${c.render(row)}</td>`)
          .join('')}</tr>`,
    )
    .join('');

  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Generic client-side sorter used by every manager table. */
export function sortRows(rows, columns, sortKey, sortDir) {
  if (!sortKey) return rows;
  const column = columns.find((c) => c.key === sortKey);
  if (!column) return rows;
  const value = column.sortValue ?? ((r) => r[sortKey]);
  const dir = sortDir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
}

export function selectField({ label, name, options, value, includeAll = true, allLabel = 'All' }) {
  const opts = [
    includeAll ? `<option value="">${esc(allLabel)}</option>` : '',
    ...options.map(
      (o) => `<option value="${esc(o.value)}"${String(o.value) === String(value ?? '') ? ' selected' : ''}>${esc(o.label)}</option>`,
    ),
  ].join('');
  return `<div class="field"><label for="f-${esc(name)}">${esc(label)}</label>
    <select id="f-${esc(name)}" name="${esc(name)}" data-filter="${esc(name)}">${opts}</select></div>`;
}

export function inputField({ label, name, type = 'text', value = '', attrs = '' }) {
  return `<div class="field"><label for="f-${esc(name)}">${esc(label)}</label>
    <input id="f-${esc(name)}" name="${esc(name)}" type="${type}" value="${esc(value)}" ${attrs}></div>`;
}

export function disclaimer(text) {
  return `<div class="disclaimer"><strong>ℹ</strong><span>${text}</span></div>`;
}

/** The standing market-context note required by §2 / §36. */
export const MARKET_CONTEXT_NOTE =
  'Singapore retail outlets independently determine their final selling price. This application observes, benchmarks and prioritises commercial opportunities — it does not enforce retailer pricing, and a price outside a JTI recommended range is not a violation.';

export function money2(value, currency = 'SGD') {
  return money(value, currency);
}

export function gapCell(gap) {
  if (gap === null || gap === undefined) return '<span class="muted">—</span>';
  return `<span class="${gap > 0 ? '' : 'muted'}">${signedMoney(gap)}</span>`;
}

export function indexCell(index, min, max) {
  if (index === null || index === undefined) return '<span class="muted">—</span>';
  const inBand = min !== null && max !== null && min !== undefined && max !== undefined
    ? index >= min && index <= max
    : null;
  const tone = inBand === null ? 'none' : inBand ? 'good' : 'risk';
  const icon = inBand === null ? '–' : inBand ? '✓' : '▲';
  return `<span class="pill pill--${tone}">${icon} ${priceIndex(index)}</span>`;
}
