/**
 * §12 — Price Architecture: where comparable SKUs actually sit, on one labelled SGD axis.
 *
 * The page used to show a ladder of filled bars, each as long as its SKU's median price, with
 * no numbers on the axis. That misleads twice over. A filled bar is read from zero, so prices
 * clustered between SGD 12.60 and 16.00 looked several times apart. And a median on its own
 * says nothing about spread: one SKU priced identically in twenty-four outlets and another
 * ranging over a dollar drew the same bar. Dispersion across outlets is the point of the
 * screen — a GM deciding where to look needs to see which SKU is consistent and which is not.
 */

import { esc, money, priceIndex } from '../lib/format.js';
import { dateLabel } from '../lib/format.js';
import { dataTable, disclaimer, selectField, strategicPill } from './dom.js';
import { filterBar, handleFilterAction, handleFilterChange } from './filters.js';
import { coveragePanel, handleSnapshotAction, snapshotBar } from './snapshotBar.js';
import { intervalChart } from './charts.js';
import { buildPriceLadder } from '../services/analyticsService.js';

let include = 'all';

export const title = () => 'Price Architecture';
export const subtitle = () =>
  'Observed retail price intervals across outlets — JTI portfolio versus competitor SKUs';

/**
 * What P10–P90 is, said where it is drawn.
 *
 * It is where the middle 80% of outlet prices fell. It is not a confidence interval — nothing
 * here is estimating a parameter — and it is not the full range, so prices outside it exist
 * and stay in the table rather than being quietly trimmed.
 */
const INTERVAL_NOTE =
  'The thin line is P10–P90 and the thicker body P25–P75: where the middle 80% and middle 50% ' +
  'of outlet prices fell. It is a dispersion interval, not a confidence interval, and not the ' +
  'full minimum–maximum range — prices outside it are kept in the table below, not trimmed.';

export function render(ctx) {
  const a = ctx.analytics;
  const ladder = buildPriceLadder(a.observations, ctx.config, { include });

  if (!ladder.rungs.length) {
    return `${snapshotBar(a)}${filterBar(ctx, { show: ['date', 'territory', 'channel'] })}
      <div class="empty">No observations for the current filters.</div>`;
  }

  const columns = [
    { key: 'sku_name', label: 'SKU', render: (r) => `${esc(r.sku_name)} ${strategicPill({ is_strategic: r.is_strategic })}` },
    { key: 'company', label: 'Owner', render: (r) => esc(r.is_jti ? 'JTI' : r.company) },
    { key: 'pack', label: 'Pack', render: (r) => esc(r.pack_type ?? (r.sticks_per_pack ? `Pack of ${r.sticks_per_pack}` : '—')) },
    { key: 'p10', label: 'P10', align: 'right', render: (r) => money(r.p10) },
    { key: 'p25', label: 'P25', align: 'right', render: (r) => money(r.p25) },
    { key: 'median_price', label: 'Median', align: 'right', render: (r) => `<strong>${money(r.median_price)}</strong>`, sortValue: (r) => r.median_price },
    { key: 'p75', label: 'P75', align: 'right', render: (r) => money(r.p75) },
    { key: 'p90', label: 'P90', align: 'right', render: (r) => money(r.p90) },
    {
      key: 'spread',
      label: 'P90 − P10',
      align: 'right',
      render: (r) => money(r.p90 - r.p10),
      sortValue: (r) => r.p90 - r.p10,
    },
    {
      key: 'range',
      label: 'Recommended range',
      align: 'right',
      render: (r) =>
        r.recommendation_variants > 1
          ? `<span class="muted" title="Outlet-specific rules disagree; averaging them would draw a reference nobody set.">${r.recommendation_variants} applicable rules</span>`
          : r.recommended_min !== null
            ? `${money(r.recommended_min)} – ${money(r.recommended_max)}`
            : '<span class="muted">—</span>',
      sortValue: (r) => r.recommended_min ?? 0,
    },
    { key: 'price_index', label: 'Price Index', align: 'right', render: (r) => (r.price_index !== null ? priceIndex(r.price_index) : '<span class="muted">—</span>') },
    { key: 'outlets', label: 'Outlets', align: 'right', render: (r) => r.outlets },
    { key: 'observations', label: 'Observations', align: 'right', render: (r) => r.observations },
  ];

  const smallSamples = ladder.rungs.filter((r) => r.small_sample);
  const multiRule = ladder.rungs.filter((r) => r.recommendation_variants > 1);

  return `
    ${snapshotBar(a)}
    ${filterBar(ctx, { show: ['date', 'territory', 'channel'] })}
    ${coveragePanel(a.coverage, a.kpis.delta ?? {})}

    <div class="card" data-intervals>
      <div class="card__head">
        <h2>Observed price intervals</h2>
        <div class="toolbar">
          <span class="card__sub">${ladder.rungs.length} SKU${ladder.rungs.length === 1 ? '' : 's'} ·
            one price per outlet ·
            ${esc(scopeLabel(ladder))}</span>
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

      ${
        ladder.mixed_packs
          ? `<div class="disclaimer" style="background:var(--watch-bg);border-color:var(--watch-border)">
              <strong>!</strong><span>More than one pack configuration is in scope. Rows for different
              configurations are not comparable — narrow the filters to one pack before reading across them.</span>
            </div>`
          : ''
      }

      ${intervalChart({ rows: ladder.rungs, axis: ladder.axis })}

      <div class="legend">
        <span class="legend__item"><span class="legend__dot" style="background:var(--brand-2)"></span> JTI SKU</span>
        <span class="legend__item"><span class="legend__dot" style="background:#6b7280"></span> Competitor SKU</span>
        <span class="legend__item"><span class="legend__dot" style="background:transparent;border:1px dashed #b3261e"></span> Recommended range (JTI reference, shown separately)</span>
      </div>

      <p class="xsmall muted mt">${esc(INTERVAL_NOTE)}</p>
      ${
        smallSamples.length
          ? `<p class="xsmall muted">${esc(
              `${smallSamples.map((r) => r.sku_name).join(', ')} ${smallSamples.length === 1 ? 'has' : 'have'} too few outlets for a stable percentile, so the individual outlet prices are drawn as points instead.`,
            )}</p>`
          : ''
      }
      ${
        multiRule.length
          ? `<p class="xsmall muted">${esc(
              `${multiRule.map((r) => `${r.sku_name} (${r.recommendation_variants})`).join(', ')} — more than one recommendation applies in this scope, so no single reference corridor is drawn. Narrow the scope to see one.`,
            )}</p>`
          : ''
      }
    </div>

    <div class="card">
      <div class="card__head"><h2>Structural observations</h2>
        <span class="card__sub">Descriptive. Where the prices sit, not what that proves</span></div>
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
          : '<div class="empty">Nothing structural stands out in the current scope.</div>'
      }
    </div>

    <div class="card">
      <div class="card__head"><h2>Interval detail</h2>
        <span class="card__sub">Click a row to open that SKU with the same filters</span></div>
      ${dataTable(columns, ladder.rungs, {
        rowAttrs: (r) => `class="clickable" data-action="open-sku" data-sku="${esc(r.sku_id)}"`,
      })}
    </div>

    ${disclaimer(
      'Built from <strong>observed retail prices</strong>, one per outlet, not from recommended prices — ' +
        'so it reflects what shoppers actually see. The recommended range is drawn separately as a JTI reference.',
    )}`;
}

/** Pack, outlet count and how old the evidence is — the three things an interval needs stated. */
function scopeLabel(ladder) {
  const outlets = new Set();
  let oldest = null;
  let freshest = null;
  for (const rung of ladder.rungs) {
    outlets.add(rung.outlets);
    if (rung.oldest && (!oldest || rung.oldest < oldest)) oldest = rung.oldest;
    if (rung.freshest && (!freshest || rung.freshest > freshest)) freshest = rung.freshest;
  }
  const pack = ladder.rungs[0]?.pack_type ?? null;
  const parts = [];
  if (pack && !ladder.mixed_packs) parts.push(`SGD / ${pack.toLowerCase()}`);
  if (oldest && freshest) parts.push(`observed ${dateLabel(oldest)} – ${dateLabel(freshest)}`);
  return parts.join(' · ');
}

export function onAction(action, el, ctx) {
  if (handleFilterAction(action, el, ctx)) return;
  if (handleSnapshotAction(action, el, ctx)) return;
  // The SKU page reads `sku` from the route and keeps the global filters, so the same scope
  // carries across rather than resetting to the network.
  if (action === 'open-sku') ctx.navigate('manager/sku', { sku: el.dataset.sku });
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
