/** §11 — SKU Intelligence: distribution first, never a single average. */

import { dateLabel, esc, money, num, pct, priceIndex } from '../lib/format.js';
import {
  dataTable,
  disclaimer,
  freshnessLabelHtml,
  gapCell,
  indexCell,
  kpiCard,
  statusPill,
  strategicPill,
  selectField,
} from './dom.js';
import { filterBar, handleFilterAction, handleFilterChange } from './filters.js';
import { boxPlot, distributionChart, lineChart, CHART_COLORS } from './charts.js';
import {
  buildTimeSeries,
  calculatePriceDistribution,
} from '../services/analyticsService.js';
import { listMappingsForSku } from '../services/competitorMappingService.js';
import { RANGE_BUCKET } from '../services/pricePositionService.js';
import { describe, median, round } from '../lib/stats.js';
import { autoGranularity } from '../lib/dates.js';
import { downloadCsv } from '../lib/csv.js';

let selectedSkuId = null;
let selectedCompetitorSkuId = '';
let granularity = 'auto';

export const title = () => 'SKU Intelligence';
export const subtitle = (ctx) => {
  const sku = ctx.data.skus.find((s) => s.id === currentSkuId(ctx));
  return sku ? `${sku.name} · ${sku.sku_code}` : 'Select a JTI SKU';
};

function currentSkuId(ctx) {
  const jti = ctx.data.skus.filter((s) => s.is_jti);
  if (ctx.params.sku && jti.some((s) => s.id === ctx.params.sku)) return ctx.params.sku;
  if (selectedSkuId && jti.some((s) => s.id === selectedSkuId)) return selectedSkuId;
  return ctx.filters.sku_id && jti.some((s) => s.id === ctx.filters.sku_id) ? ctx.filters.sku_id : jti[0]?.id;
}

export function render(ctx) {
  const skuId = currentSkuId(ctx);
  const sku = ctx.data.skus.find((s) => s.id === skuId);
  if (!sku) return '<div class="empty">No JTI SKUs available.</div>';

  const jtiSkus = ctx.data.skus.filter((s) => s.is_jti);
  const observations = ctx.analytics.observations.filter((o) => o.sku_id === skuId);
  const dist = calculatePriceDistribution(observations, skuId);
  const stats = dist?.stats ?? null;

  const mappings = listMappingsForSku(ctx.data.competitor_mappings, skuId, { market: 'SG' }, new Date().toISOString());
  const activeCompetitorId = selectedCompetitorSkuId || mappings[0]?.competitor_sku_id || '';
  const competitorObs = ctx.analytics.observations.filter((o) => o.sku_id === activeCompetitorId);
  const competitorMedian = competitorObs.length ? round(median(competitorObs.map((o) => o.confirmed_price)), 2) : null;
  const competitorSku = ctx.data.skus.find((s) => s.id === activeCompetitorId);

  const withRule = observations.filter((o) => o.evaluation?.rangeBucket !== RANGE_BUCKET.UNKNOWN);
  const bucketPct = (bucket) =>
    withRule.length ? (withRule.filter((o) => o.evaluation.rangeBucket === bucket).length / withRule.length) * 100 : null;

  const indexes = observations.map((o) => o.evaluation?.priceIndex).filter(Number.isFinite);
  const gaps = observations.map((o) => o.evaluation?.gap).filter(Number.isFinite);
  const latest = observations.slice().sort((a, b) => new Date(b.observed_at) - new Date(a.observed_at))[0];
  const mapping = mappings.find((m) => m.competitor_sku_id === activeCompetitorId) ?? mappings[0];

  return `
    ${filterBar(ctx, { show: ['date', 'territory', 'channel', 'user'] })}
    <div class="card">
      <div class="card__head">
        <div class="toolbar" style="flex:1">
          ${selectField({
            label: 'JTI SKU',
            name: 'sku-picker',
            value: skuId,
            includeAll: false,
            options: jtiSkus.map((s) => ({ value: s.id, label: s.name })),
          })}
          ${
            mappings.length
              ? selectField({
                  label: 'Compare with',
                  name: 'competitor-picker',
                  value: activeCompetitorId,
                  includeAll: false,
                  options: mappings.map((m) => {
                    const cs = ctx.data.skus.find((s) => s.id === m.competitor_sku_id);
                    return { value: m.competitor_sku_id, label: `${cs?.name ?? m.competitor_sku_id} (priority ${m.mapping_priority})` };
                  }),
                })
              : ''
          }
          <button class="btn btn--sm" data-action="export" style="margin-top:16px">⇩ Export SKU analysis</button>
        </div>
      </div>
      <div class="row">
        <h2 style="margin:0">${esc(sku.name)}</h2>
        ${strategicPill(sku)}
        <span class="tag">${esc(sku.sku_code)}</span>
        <span class="tag">${esc(ctx.data.brands.find((b) => b.id === sku.brand_id)?.name ?? '')}</span>
        ${latest ? freshnessLabelHtml(latest.freshness) : ''}
      </div>
    </div>

    <div class="grid grid--kpi mb">
      ${kpiCard({ label: 'Recommended price', value: money(latest?.recommended_price_snapshot ?? null), meta: latest?.recommended_min_snapshot !== null && latest ? `Range ${money(latest.recommended_min_snapshot)} – ${money(latest.recommended_max_snapshot)}` : 'No recommendation available' })}
      ${kpiCard({ label: 'Median observed price', value: money(stats?.median ?? null), meta: `${stats?.count ?? 0} observations across ${dist?.outlets ?? 0} outlets` })}
      ${kpiCard({ label: 'Median competitor price', value: money(competitorMedian), meta: esc(competitorSku?.name ?? 'No mapped competitor') })}
      ${kpiCard({ label: 'Median Price Index', value: priceIndex(median(indexes)), meta: mapping ? `Desired ${mapping.desired_price_index_min} – ${mapping.desired_price_index_max}` : 'No desired position configured' })}
      ${kpiCard({ label: 'Median price gap', value: money(median(gaps)), meta: mapping ? `Desired ${money(mapping.desired_gap_min)} – ${money(mapping.desired_gap_max)}` : '—' })}
      ${kpiCard({ label: 'Price dispersion (P90−P10)', value: money(stats?.p90_minus_p10 ?? null), meta: `IQR ${money(stats?.iqr ?? null)}` })}
    </div>

    <div class="card">
      <div class="card__head">
        <h2>Price distribution across outlets</h2>
        <span class="card__sub">Distribution, not just the average — retailers set their own price</span>
      </div>
      ${
        dist
          ? distributionChart({
              bins: dist.histogram,
              recommendedPrice: latest?.recommended_price_snapshot ?? null,
              recommendedMin: latest?.recommended_min_snapshot ?? null,
              recommendedMax: latest?.recommended_max_snapshot ?? null,
              competitorMedian,
            })
          : '<div class="empty">No observations for this SKU with the current filters.</div>'
      }
      ${stats ? boxPlot({ stats, recommendedMin: latest?.recommended_min_snapshot ?? null, recommendedMax: latest?.recommended_max_snapshot ?? null }) : ''}
      ${stats ? statsTable(stats, bucketPct) : ''}
    </div>

    <div class="card">
      <div class="card__head">
        <h2>Trend</h2>
        <div class="toolbar">
          ${selectField({
            label: 'Grouping',
            name: 'granularity',
            value: granularity,
            includeAll: false,
            options: [
              { value: 'auto', label: 'Automatic' },
              { value: 'day', label: 'Daily' },
              { value: 'week', label: 'Weekly' },
              { value: 'month', label: 'Monthly' },
            ],
          })}
        </div>
      </div>
      ${trendChart(ctx, observations, competitorObs, latest)}
    </div>

    <div class="card">
      <div class="card__head"><h2>Outlet detail</h2>
        <span class="card__sub">Latest observation per outlet</span></div>
      ${outletTable(ctx, observations)}
    </div>

    ${disclaimer('Different outlets legitimately sell the same SKU at different prices. Dispersion is a market characteristic, not a failure.')}`;
}

function statsTable(stats, bucketPct) {
  const cells = [
    ['Observations', stats.count],
    ['Min', money(stats.min)],
    ['P10', money(stats.p10)],
    ['P25', money(stats.p25)],
    ['Median', money(stats.median)],
    ['Average', money(stats.mean)],
    ['P75', money(stats.p75)],
    ['P90', money(stats.p90)],
    ['Max', money(stats.max)],
    ['IQR', money(stats.iqr)],
    ['P90 − P10', money(stats.p90_minus_p10)],
    ['Std deviation', stats.stddev === null ? '—' : num(stats.stddev, 3)],
    ['% below recommended range', pct(bucketPct(RANGE_BUCKET.BELOW))],
    ['% within recommended range', pct(bucketPct(RANGE_BUCKET.WITHIN))],
    ['% above recommended range', pct(bucketPct(RANGE_BUCKET.ABOVE))],
  ];
  return `<div class="grid grid--3 mt">
    ${cells
      .map(
        ([label, value]) =>
          `<div style="display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">
            <span class="small muted">${esc(label)}</span><strong class="small mono">${value}</strong></div>`,
      )
      .join('')}
  </div>`;
}

function trendChart(ctx, observations, competitorObs, latest) {
  const g = granularity === 'auto' ? autoGranularity(ctx.filters.from ?? '2026-06-01', ctx.filters.to ?? new Date()) : granularity;
  const jtiSeries = buildTimeSeries(observations, g);
  const compSeries = buildTimeSeries(competitorObs, g);
  if (jtiSeries.length < 2) return '<div class="empty">Not enough observations for a trend.</div>';

  const periods = [...new Set([...jtiSeries.map((p) => p.period), ...compSeries.map((p) => p.period)])].sort();
  const pick = (series, key) => periods.map((p) => ({ period: p, value: series.find((s) => s.period === p)?.[key] ?? null }));

  const priceChart = lineChart({
    series: [
      { label: 'JTI median observed price', color: CHART_COLORS.jti, points: pick(jtiSeries, 'jti_median') },
      { label: 'Competitor median observed price', color: CHART_COLORS.competitor, dash: '4 3', points: pick(compSeries, 'competitor_median') },
      ...(latest?.recommended_price_snapshot
        ? [{
            label: 'Recommended price',
            color: CHART_COLORS.recommended,
            dash: '2 3',
            points: periods.map((p) => ({ period: p, value: latest.recommended_price_snapshot })),
          }]
        : []),
    ],
    yLabel: 'SGD',
  });

  const indexChart = lineChart({
    series: [{ label: 'Median Price Index', color: CHART_COLORS.index, points: pick(jtiSeries, 'price_index_median') }],
    yLabel: 'Price Index',
    height: 190,
  });

  return `${priceChart}<div class="mt">${indexChart}</div>`;
}

function outletTable(ctx, observations) {
  const byOutlet = new Map();
  for (const o of observations) {
    const existing = byOutlet.get(o.outlet_id);
    if (!existing || new Date(o.observed_at) > new Date(existing.observed_at)) byOutlet.set(o.outlet_id, o);
  }
  const rows = [...byOutlet.values()];

  const columns = [
    { key: 'outlet_name', label: 'Outlet', render: (o) => `${esc(o.outlet_name)}<br /><span class="xsmall muted">${esc(o.outlet_code)}</span>` },
    { key: 'territory_name', label: 'Territory', render: (o) => esc(o.territory_name) },
    { key: 'channel_name', label: 'Channel', render: (o) => esc(o.channel_name) },
    { key: 'confirmed_price', label: 'Current JTI price', align: 'right', render: (o) => money(o.confirmed_price) },
    {
      key: 'range',
      label: 'Recommended range',
      align: 'right',
      render: (o) => (o.recommended_min_snapshot !== null ? `${money(o.recommended_min_snapshot)} – ${money(o.recommended_max_snapshot)}` : '—'),
      sortValue: (o) => o.recommended_price_snapshot ?? 0,
    },
    { key: 'competitor_price', label: 'Competitor price', align: 'right', render: (o) => money(o.competitor_price) },
    { key: 'gap', label: 'Gap', align: 'right', render: (o) => gapCell(o.evaluation?.gap), sortValue: (o) => o.evaluation?.gap ?? 0 },
    {
      key: 'index',
      label: 'Price Index',
      align: 'right',
      render: (o) => indexCell(o.evaluation?.priceIndex, o.desired_price_index_min_snapshot, o.desired_price_index_max_snapshot),
      sortValue: (o) => o.evaluation?.priceIndex ?? 0,
    },
    { key: 'status', label: 'Status', render: (o) => statusPill(o.evaluation?.status) },
    { key: 'observed_at', label: 'Last visit', render: (o) => `${esc(dateLabel(o.observed_at))}<br />${freshnessLabelHtml(o.freshness)}`, sortValue: (o) => new Date(o.observed_at).getTime() },
    {
      key: 'last_action',
      label: 'Last field action',
      render: (o) => {
        const a = ctx.data.field_actions
          .filter((x) => x.outlet_id === o.outlet_id)
          .sort((x, y) => new Date(y.action_at) - new Date(x.action_at))[0];
        return esc(a?.action_type ?? '—');
      },
    },
  ];

  return dataTable(columns, rows, {
    rowAttrs: (o) => `class="clickable" data-action="open-outlet" data-outlet="${esc(o.outlet_id)}"`,
  });
}

export function onAction(action, el, ctx) {
  if (handleFilterAction(action, el, ctx)) return;
  if (action === 'open-outlet') {
    ctx.navigate('outlet', { id: el.dataset.outlet });
    return;
  }
  if (action === 'export') {
    const skuId = currentSkuId(ctx);
    const rows = ctx.analytics.observations
      .filter((o) => o.sku_id === skuId)
      .map((o) => ({
        observed_at: o.observed_at,
        outlet_code: o.outlet_code,
        outlet: o.outlet_name,
        territory: o.territory_name,
        channel: o.channel_name,
        sku: o.sku_name,
        confirmed_price: o.confirmed_price,
        detected_price: o.detected_price,
        manual_correction: o.manual_correction ? 'Yes' : 'No',
        recognition_confidence: o.recognition_confidence,
        recommended_price: o.recommended_price_snapshot ?? '',
        recommended_min: o.recommended_min_snapshot ?? '',
        recommended_max: o.recommended_max_snapshot ?? '',
        competitor_sku: o.competitor_sku_name ?? '',
        competitor_price: o.competitor_price ?? '',
        price_gap: o.evaluation?.gap ?? '',
        price_index: o.evaluation?.priceIndex ?? '',
        status: o.evaluation?.status ?? '',
        data_freshness: o.freshness?.label ?? '',
      }));
    downloadCsv(`sku-analysis-${skuId}.csv`, Object.keys(rows[0] ?? { sku: '' }), rows);
  }
}

export function onChange(target, ctx) {
  if (handleFilterChange(target, ctx)) return true;
  if (target.dataset.filter === 'sku-picker') {
    selectedSkuId = target.value;
    selectedCompetitorSkuId = '';
    ctx.setParams({ sku: target.value });
    return true;
  }
  if (target.dataset.filter === 'competitor-picker') {
    selectedCompetitorSkuId = target.value;
    ctx.render();
    return true;
  }
  if (target.dataset.filter === 'granularity') {
    granularity = target.value;
    ctx.render();
    return true;
  }
  return false;
}
