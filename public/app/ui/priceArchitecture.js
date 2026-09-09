/** §12 — Price Architecture: how JTI tiers sit against each other and against competitors. */

import { esc, money, priceIndex } from '../lib/format.js';
import { dataTable, disclaimer, selectField, strategicPill } from './dom.js';
import { filterBar, handleFilterAction, handleFilterChange } from './filters.js';
import { buildPriceLadder } from '../services/analyticsService.js';

let include = 'all';

export const title = () => 'Price Architecture';
export const subtitle = () => 'Median observed retail price ladder — JTI portfolio versus competitor SKUs';

export function render(ctx) {
  const ladder = buildPriceLadder(ctx.analytics.observations, ctx.config, { include });
  if (!ladder.rungs.length) {
    return `${filterBar(ctx, { show: ['date', 'territory', 'channel'] })}<div class="empty">No observations for the current filters.</div>`;
  }

  const max = Math.max(...ladder.rungs.map((r) => r.median_price));
  const min = Math.min(...ladder.rungs.map((r) => r.median_price));
  const span = max - min || 1;

  const rows = ladder.rungs
    .map((r) => {
      const width = 22 + ((r.median_price - min) / span) * 78;
      return `<div class="ladder-row">
        <div class="right mono small">${money(r.median_price)}</div>
        <div>
          <div class="ladder-bar ladder-bar--${r.is_jti ? 'jti' : 'competitor'}" style="width:${width}%">
            ${esc(r.sku_name)}
          </div>
          <div class="xsmall muted">${esc(r.is_jti ? 'JTI' : r.company)} ·
            ${r.observations} observation${r.observations === 1 ? '' : 's'} · ${r.outlets} outlets
            ${r.recommended_price !== null ? ` · recommended ${money(r.recommended_price)}` : ''}
            ${r.price_index !== null ? ` · Price Index ${priceIndex(r.price_index)}` : ''}
          </div>
        </div>
      </div>`;
    })
    .join('');

  const columns = [
    { key: 'sku_name', label: 'SKU', render: (r) => `${esc(r.sku_name)} ${strategicPill({ is_strategic: r.is_strategic })}` },
    { key: 'company', label: 'Owner', render: (r) => esc(r.is_jti ? 'JTI' : r.company) },
    { key: 'median_price', label: 'Median observed price', align: 'right', render: (r) => money(r.median_price) },
    {
      key: 'recommended_price',
      label: 'Recommended price',
      align: 'right',
      render: (r) => (r.recommended_price !== null ? money(r.recommended_price) : '<span class="muted">—</span>'),
    },
    {
      key: 'range',
      label: 'Recommended range',
      align: 'right',
      render: (r) => (r.recommended_min !== null ? `${money(r.recommended_min)} – ${money(r.recommended_max)}` : '<span class="muted">—</span>'),
      sortValue: (r) => r.recommended_min ?? 0,
    },
    { key: 'price_index', label: 'Price Index', align: 'right', render: (r) => (r.price_index !== null ? priceIndex(r.price_index) : '<span class="muted">—</span>') },
    { key: 'observations', label: 'Observations', align: 'right', render: (r) => r.observations },
    { key: 'outlets', label: 'Outlets', align: 'right', render: (r) => r.outlets },
  ];

  return `
    ${filterBar(ctx, { show: ['date', 'territory', 'channel'] })}
    <div class="card">
      <div class="card__head">
        <h2>Price ladder</h2>
        <div class="toolbar">
          ${selectField({
            label: 'View',
            name: 'ladder-include',
            value: include,
            includeAll: false,
            options: [
              { value: 'all', label: 'JTI and competitors' },
              { value: 'jti', label: 'Own brand only' },
              { value: 'competitor', label: 'Competitors only' },
            ],
          })}
        </div>
      </div>
      ${rows}
      <div class="legend">
        <span class="legend__item"><span class="legend__dot" style="background:var(--brand-2)"></span> JTI SKU</span>
        <span class="legend__item"><span class="legend__dot" style="background:#6b7280"></span> Competitor SKU</span>
      </div>
    </div>

    <div class="card">
      <div class="card__head"><h2>Structural observations</h2>
        <span class="card__sub">Where the portfolio architecture may need review</span></div>
      ${
        ladder.insights.length
          ? ladder.insights
              .map(
                (i) => `<div class="action-item action-item--${i.tone === 'risk' ? 'High' : 'Medium'}">
                  <div class="action-item__body">
                    <div class="action-item__title">${esc(i.title)}</div>
                    <div class="action-item__reason">${esc(i.detail)}</div>
                  </div>
                </div>`,
              )
              .join('')
          : '<div class="empty">No structural issues detected in the current ladder.</div>'
      }
    </div>

    <div class="card">
      <div class="card__head"><h2>Ladder detail</h2></div>
      ${dataTable(columns, ladder.rungs)}
    </div>

    ${disclaimer('The ladder uses <strong>median observed retail price</strong>, not recommended price, so it reflects what shoppers actually see on shelf.')}`;
}

export function onAction(action, el, ctx) {
  handleFilterAction(action, el, ctx);
}

export function onChange(target, ctx) {
  if (handleFilterChange(target, ctx)) return true;
  if (target.dataset.filter === 'ladder-include') {
    include = target.value;
    ctx.render();
    return true;
  }
  return false;
}
