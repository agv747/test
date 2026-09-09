/** §19 — Territory view with rankings by SKU, outlet, channel and competitor. */

import { esc, money, pct, priceIndex } from '../lib/format.js';
import { dataTable, kpiCard, selectField, strategicPill } from './dom.js';
import { filterBar, handleFilterAction, handleFilterChange } from './filters.js';
import { calculateDispersion, calculateKpis } from '../services/analyticsService.js';
import { describe, median, round } from '../lib/stats.js';
import { RANGE_BUCKET } from '../services/pricePositionService.js';

let rankBy = 'sku';

export const title = () => 'Territories';
export const subtitle = () => 'Price position, coverage and field activity by territory';

export function render(ctx) {
  const summaries = ctx.analytics.territories;

  const columns = [
    { key: 'name', label: 'Territory', render: (t) => `<strong>${esc(t.territory.name)}</strong>` },
    { key: 'alignment', label: 'Recommended Price Alignment', align: 'right', render: (t) => pct(t.kpis.recommended_price_alignment), sortValue: (t) => t.kpis.recommended_price_alignment ?? -1 },
    { key: 'competitive', label: 'Competitive Alignment', align: 'right', render: (t) => pct(t.kpis.competitive_alignment), sortValue: (t) => t.kpis.competitive_alignment ?? -1 },
    { key: 'strategic', label: 'Strategic SKU Alignment', align: 'right', render: (t) => pct(t.kpis.strategic_recommended_price_alignment), sortValue: (t) => t.kpis.strategic_recommended_price_alignment ?? -1 },
    { key: 'opportunities', label: 'Pricing Opportunities', align: 'right', render: (t) => t.opportunities },
    { key: 'high_priority', label: 'High priority', align: 'right', render: (t) => (t.high_priority ? `<span class="pill pill--risk">▲ ${t.high_priority}</span>` : '0') },
    { key: 'median_price_index', label: 'Median Price Index', align: 'right', render: (t) => priceIndex(t.median_price_index) },
    { key: 'dispersion', label: 'Dispersion (P90−P10)', align: 'right', render: (t) => money(t.dispersion) },
    { key: 'coverage', label: 'Market coverage', align: 'right', render: (t) => pct(t.coverage.coverage_pct), sortValue: (t) => t.coverage.coverage_pct ?? -1 },
    { key: 'tme_visits', label: 'Visits', align: 'right', render: (t) => t.tme_visits },
    { key: 'outlets', label: 'Outlets observed', align: 'right', render: (t) => t.outlets },
  ];

  const selectedTerritory = ctx.filters.territory_id
    ? summaries.find((t) => t.territory.id === ctx.filters.territory_id)
    : null;

  return `
    ${filterBar(ctx, { show: ['date', 'territory', 'channel', 'user'] })}
    ${selectedTerritory ? territoryKpis(ctx, selectedTerritory) : ''}
    <div class="card">
      <div class="card__head"><h2>Territory comparison</h2></div>
      ${dataTable(columns, summaries, {
        rowAttrs: (t) => `class="clickable" data-action="select-territory" data-territory="${esc(t.territory.id)}"`,
      })}
    </div>
    <div class="card">
      <div class="card__head">
        <h2>Rankings</h2>
        <div class="toolbar">
          ${selectField({
            label: 'Rank by',
            name: 'rank-by',
            value: rankBy,
            includeAll: false,
            options: [
              { value: 'sku', label: 'JTI SKU' },
              { value: 'outlet', label: 'Outlet' },
              { value: 'channel', label: 'Channel' },
              { value: 'competitor', label: 'Competitor SKU' },
            ],
          })}
        </div>
      </div>
      ${rankingTable(ctx)}
    </div>`;
}

function territoryKpis(ctx, t) {
  return `<div class="grid grid--kpi mb">
    ${kpiCard({ label: `${t.territory.name} — Recommended Price Alignment`, value: pct(t.kpis.recommended_price_alignment), meta: `${t.kpis.recommended_price_alignment_n} observations` })}
    ${kpiCard({ label: 'Competitive Alignment', value: pct(t.kpis.competitive_alignment), meta: `${t.kpis.competitive_alignment_n} mapped pairs` })}
    ${kpiCard({ label: 'Strategic SKU Alignment', value: pct(t.kpis.strategic_recommended_price_alignment) })}
    ${kpiCard({ label: 'Pricing Opportunities', value: String(t.opportunities), meta: `${t.high_priority} high priority` })}
    ${kpiCard({ label: 'Median Price Index', value: priceIndex(t.median_price_index) })}
    ${kpiCard({ label: 'Price dispersion (P90−P10)', value: money(t.dispersion) })}
    ${kpiCard({ label: 'Market coverage', value: pct(t.coverage.coverage_pct), meta: `${t.coverage.observed_outlets}/${t.coverage.expected_outlets} outlets` })}
    ${kpiCard({ label: 'TME visits', value: String(t.tme_visits) })}
  </div>`;
}

function rankingTable(ctx) {
  const observations = ctx.analytics.observations;
  const groups = new Map();

  const keyOf = (o) => {
    if (rankBy === 'sku') return o.is_jti ? o.sku_id : null;
    if (rankBy === 'competitor') return o.is_jti ? null : o.sku_id;
    if (rankBy === 'outlet') return o.outlet_id;
    return o.channel_id;
  };
  const labelOf = (o) => {
    if (rankBy === 'sku' || rankBy === 'competitor') return o.sku_name;
    if (rankBy === 'outlet') return o.outlet_name;
    return o.channel_name;
  };

  for (const o of observations) {
    const key = keyOf(o);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { key, label: labelOf(o), sample: o, items: [] });
    groups.get(key).items.push(o);
  }

  const rows = [...groups.values()].map((g) => {
    const jti = g.items.filter((o) => o.is_jti && o.evaluation?.rangeBucket !== RANGE_BUCKET.UNKNOWN);
    const within = jti.filter((o) => o.evaluation.rangeBucket === RANGE_BUCKET.WITHIN).length;
    const stats = describe(g.items.map((o) => o.confirmed_price));
    const indexes = g.items.map((o) => o.evaluation?.priceIndex).filter(Number.isFinite);
    const opportunities = ctx.analytics.opportunities.filter((o) =>
      rankBy === 'sku' ? o.jti_sku_id === g.key : rankBy === 'outlet' ? o.outlet_id === g.key : false,
    ).length;
    return {
      ...g,
      median: stats ? round(stats.median, 2) : null,
      dispersion: stats ? round(stats.p90_minus_p10, 2) : null,
      alignment: jti.length ? (within / jti.length) * 100 : null,
      price_index: indexes.length ? round(median(indexes), 1) : null,
      observations: g.items.length,
      outlets: new Set(g.items.map((o) => o.outlet_id)).size,
      opportunities,
    };
  });

  const columns = [
    {
      key: 'label',
      label: rankBy === 'sku' ? 'JTI SKU' : rankBy === 'competitor' ? 'Competitor SKU' : rankBy === 'outlet' ? 'Outlet' : 'Channel',
      render: (r) => `${esc(r.label)} ${rankBy === 'sku' ? strategicPill(r.sample.sku) : ''}`,
    },
    { key: 'median', label: 'Median observed price', align: 'right', render: (r) => money(r.median) },
    { key: 'dispersion', label: 'Dispersion (P90−P10)', align: 'right', render: (r) => money(r.dispersion) },
    { key: 'alignment', label: 'Recommended Price Alignment', align: 'right', render: (r) => pct(r.alignment), sortValue: (r) => r.alignment ?? -1 },
    { key: 'price_index', label: 'Median Price Index', align: 'right', render: (r) => priceIndex(r.price_index) },
    { key: 'observations', label: 'Observations', align: 'right', render: (r) => r.observations },
    { key: 'outlets', label: 'Outlets', align: 'right', render: (r) => r.outlets },
    { key: 'opportunities', label: 'Opportunities', align: 'right', render: (r) => (rankBy === 'channel' || rankBy === 'competitor' ? '—' : r.opportunities) },
  ];

  return dataTable(columns, rows.sort((a, b) => (b.dispersion ?? 0) - (a.dispersion ?? 0)));
}

export function onAction(action, el, ctx) {
  if (handleFilterAction(action, el, ctx)) return;
  if (action === 'select-territory') {
    const id = el.dataset.territory;
    ctx.setFilters({ territory_id: ctx.filters.territory_id === id ? '' : id });
    ctx.render();
  }
}

export function onChange(target, ctx) {
  if (handleFilterChange(target, ctx)) return true;
  if (target.dataset.filter === 'rank-by') {
    rankBy = target.value;
    ctx.render();
    return true;
  }
  return false;
}
