/**
 * Inline-SVG chart primitives. No external chart library — the app must run offline and
 * inside a locked-down CSP.
 *
 * Every chart carries text labels in addition to colour (§31: never colour alone).
 */

import { esc } from '../lib/format.js';

const PALETTE = {
  jti: '#17614a',
  competitor: '#6b7280',
  recommended: '#b3261e',
  band: 'rgba(26,127,75,0.12)',
  grid: '#e2e5ea',
  axis: '#8a93a0',
  index: '#17559b',
};

function scale(domainMin, domainMax, rangeMin, rangeMax) {
  const span = domainMax - domainMin || 1;
  return (v) => rangeMin + ((v - domainMin) / span) * (rangeMax - rangeMin);
}

/**
 * Price distribution: histogram bars with recommended range band, recommended price and
 * competitor median overlays (§11.1).
 */
export function distributionChart({
  bins,
  recommendedPrice = null,
  recommendedMin = null,
  recommendedMax = null,
  competitorMedian = null,
  width = 720,
  height = 240,
}) {
  if (!bins.length) return '<div class="empty">No observations to plot.</div>';

  // Extra top padding so the recommended-price and competitor-median labels can be
  // stacked on separate lines — they often sit only a few cents apart.
  const pad = { top: 32, right: 16, bottom: 44, left: 40 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;

  const prices = bins.map((b) => b.bin);
  const extras = [recommendedPrice, recommendedMin, recommendedMax, competitorMedian].filter(
    (v) => v !== null && v !== undefined && Number.isFinite(v),
  );
  const minX = Math.min(...prices, ...extras) - 0.15;
  const maxX = Math.max(...prices, ...extras) + 0.15;
  const maxY = Math.max(...bins.map((b) => b.count));

  const x = scale(minX, maxX, 0, w);
  const y = scale(0, maxY, h, 0);
  const barW = Math.max(6, Math.min(34, (w / ((maxX - minX) / 0.1)) * 0.8));

  const band =
    recommendedMin !== null && recommendedMax !== null
      ? `<rect x="${x(recommendedMin)}" y="0" width="${Math.max(2, x(recommendedMax) - x(recommendedMin))}" height="${h}" fill="${PALETTE.band}"></rect>`
      : '';

  const bars = bins
    .map(
      (b) =>
        `<g><rect x="${x(b.bin) - barW / 2}" y="${y(b.count)}" width="${barW}" height="${h - y(b.count)}" fill="${PALETTE.jti}" rx="2"><title>SGD ${b.bin.toFixed(2)} — ${b.count} observation${b.count === 1 ? '' : 's'}</title></rect>
         <text x="${x(b.bin)}" y="${y(b.count) - 4}" text-anchor="middle" font-size="10" fill="${PALETTE.axis}">${b.count}</text></g>`,
    )
    .join('');

  const marker = (value, color, label, dash, labelY) =>
    value === null || value === undefined || !Number.isFinite(value)
      ? ''
      : `<g><line x1="${x(value)}" y1="0" x2="${x(value)}" y2="${h}" stroke="${color}" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ''}></line>
         <text x="${x(value)}" y="${labelY}" text-anchor="middle" font-size="10" font-weight="600" fill="${color}">${esc(label)}</text></g>`;

  const ticks = bins
    .filter((_, i) => bins.length <= 10 || i % Math.ceil(bins.length / 10) === 0)
    .map(
      (b) =>
        `<text x="${x(b.bin)}" y="${h + 15}" text-anchor="middle" font-size="10" fill="${PALETTE.axis}">${b.bin.toFixed(2)}</text>`,
    )
    .join('');

  return `<div class="chart"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Distribution of observed retail prices">
    <g transform="translate(${pad.left},${pad.top})">
      ${band}
      <line x1="0" y1="${h}" x2="${w}" y2="${h}" stroke="${PALETTE.grid}"></line>
      ${bars}
      ${marker(recommendedPrice, PALETTE.recommended, 'Recommended', '', -4)}
      ${marker(competitorMedian, PALETTE.competitor, 'Competitor median', '4 3', -17)}
      ${ticks}
      <text x="${w / 2}" y="${h + 34}" text-anchor="middle" font-size="10" fill="${PALETTE.axis}">Observed retail price (SGD)</text>
      <text transform="rotate(-90)" x="${-h / 2}" y="-26" text-anchor="middle" font-size="10" fill="${PALETTE.axis}">Observations</text>
    </g>
  </svg></div>
  <div class="legend">
    <span class="legend__item"><span class="legend__swatch" style="background:${PALETTE.jti};height:9px;width:9px;border-radius:2px"></span> Observed prices</span>
    <span class="legend__item"><span class="legend__swatch" style="background:${PALETTE.band};height:9px;width:14px"></span> Recommended range</span>
    <span class="legend__item"><span class="legend__swatch" style="background:${PALETTE.recommended}"></span> Recommended price</span>
    <span class="legend__item"><span class="legend__swatch" style="background:${PALETTE.competitor}"></span> Competitor median</span>
  </div>`;
}

/** Multi-series time-series line chart (§11.2, §13). */
export function lineChart({ series, width = 720, height = 250, yLabel = '', markers = [] }) {
  const points = series.flatMap((s) => s.points.filter((p) => p.value !== null && p.value !== undefined));
  if (!points.length) return '<div class="empty">Not enough observations for a trend.</div>';

  const pad = { top: 16, right: 16, bottom: 40, left: 46 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;

  const periods = [...new Set(series.flatMap((s) => s.points.map((p) => p.period)))].sort();
  const values = points.map((p) => p.value);
  const minY = Math.min(...values);
  const maxY = Math.max(...values);
  const padY = (maxY - minY) * 0.15 || 0.5;

  const x = (period) => (periods.indexOf(period) / Math.max(1, periods.length - 1)) * w;
  const y = scale(minY - padY, maxY + padY, h, 0);

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => {
      const value = minY - padY + t * (maxY + padY - (minY - padY));
      return `<g><line x1="0" y1="${y(value)}" x2="${w}" y2="${y(value)}" stroke="${PALETTE.grid}"></line>
        <text x="-6" y="${y(value) + 3}" text-anchor="end" font-size="10" fill="${PALETTE.axis}">${value.toFixed(2)}</text></g>`;
    })
    .join('');

  const paths = series
    .map((s) => {
      const pts = s.points.filter((p) => p.value !== null && p.value !== undefined);
      if (!pts.length) return '';
      const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.period)},${y(p.value)}`).join(' ');
      const dots = pts
        .map(
          (p) =>
            `<circle cx="${x(p.period)}" cy="${y(p.value)}" r="3" fill="${s.color}"><title>${esc(s.label)} · ${esc(p.period)} · ${p.value.toFixed(2)}</title></circle>`,
        )
        .join('');
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}></path>${dots}`;
    })
    .join('');

  const markerLines = markers
    .map(
      (m) =>
        `<g><line x1="${x(m.period)}" y1="0" x2="${x(m.period)}" y2="${h}" stroke="${PALETTE.recommended}" stroke-width="1.5" stroke-dasharray="3 3"></line>
      <text x="${x(m.period)}" y="-4" text-anchor="middle" font-size="9" fill="${PALETTE.recommended}">${esc(m.label)}</text></g>`,
    )
    .join('');

  const xLabels = periods
    .filter((_, i) => periods.length <= 8 || i % Math.ceil(periods.length / 8) === 0)
    .map(
      (p) =>
        `<text x="${x(p)}" y="${h + 16}" text-anchor="middle" font-size="10" fill="${PALETTE.axis}">${esc(p.slice(5))}</text>`,
    )
    .join('');

  const legend = series
    .map(
      (s) =>
        `<span class="legend__item"><span class="legend__swatch" style="background:${s.color}"></span> ${esc(s.label)}</span>`,
    )
    .join('');

  return `<div class="chart"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(yLabel || 'Trend')}">
    <g transform="translate(${pad.left},${pad.top})">
      ${gridLines}${markerLines}${paths}${xLabels}
      ${yLabel ? `<text transform="rotate(-90)" x="${-h / 2}" y="-32" text-anchor="middle" font-size="10" fill="${PALETTE.axis}">${esc(yLabel)}</text>` : ''}
    </g>
  </svg></div><div class="legend">${legend}</div>`;
}

export const CHART_COLORS = PALETTE;

/** Box-plot style dispersion summary for one series of prices. */
export function boxPlot({ stats, width = 720, height = 92, recommendedMin = null, recommendedMax = null }) {
  if (!stats) return '';
  const pad = { left: 20, right: 20 };
  const w = width - pad.left - pad.right;
  const lo = Math.min(stats.min, recommendedMin ?? stats.min) - 0.1;
  const hi = Math.max(stats.max, recommendedMax ?? stats.max) + 0.1;
  const x = scale(lo, hi, 0, w);
  const cy = 40;

  const band =
    recommendedMin !== null && recommendedMax !== null
      ? `<rect x="${x(recommendedMin)}" y="14" width="${Math.max(2, x(recommendedMax) - x(recommendedMin))}" height="52" fill="${PALETTE.band}"></rect>`
      : '';

  return `<div class="chart"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Price dispersion">
    <g transform="translate(${pad.left},0)">
      ${band}
      <line x1="${x(stats.p10)}" y1="${cy}" x2="${x(stats.p90)}" y2="${cy}" stroke="${PALETTE.axis}" stroke-width="2"></line>
      <line x1="${x(stats.p10)}" y1="${cy - 8}" x2="${x(stats.p10)}" y2="${cy + 8}" stroke="${PALETTE.axis}" stroke-width="2"></line>
      <line x1="${x(stats.p90)}" y1="${cy - 8}" x2="${x(stats.p90)}" y2="${cy + 8}" stroke="${PALETTE.axis}" stroke-width="2"></line>
      <rect x="${x(stats.p25)}" y="${cy - 13}" width="${Math.max(2, x(stats.p75) - x(stats.p25))}" height="26" fill="${PALETTE.jti}" opacity="0.75" rx="3"></rect>
      <line x1="${x(stats.median)}" y1="${cy - 15}" x2="${x(stats.median)}" y2="${cy + 15}" stroke="#fff" stroke-width="2.5"></line>
      <text x="${x(stats.p10)}" y="${cy + 26}" text-anchor="middle" font-size="10" fill="${PALETTE.axis}">P10 ${stats.p10.toFixed(2)}</text>
      <text x="${x(stats.median)}" y="${cy - 20}" text-anchor="middle" font-size="10" font-weight="600" fill="${PALETTE.jti}">Median ${stats.median.toFixed(2)}</text>
      <text x="${x(stats.p90)}" y="${cy + 26}" text-anchor="middle" font-size="10" fill="${PALETTE.axis}">P90 ${stats.p90.toFixed(2)}</text>
    </g>
  </svg></div>`;
}
