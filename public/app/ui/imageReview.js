/** §22 — Image Review queue for low-confidence recognition. */

import { dateTimeLabel, esc, money } from '../lib/format.js';
import {
  CONFIDENCE_NOTE,
  confidenceBar,
  confidenceMeter,
  dataTable,
  disclaimer,
  selectField,
  statusPill,
} from './dom.js';
import { BOX_SOURCE_LABEL } from './shelfOverlay.js';

let selectedId = null;
let showResolved = false;

export const title = () => 'Image Review';
export const subtitle = (ctx) =>
  `Detections below ${Math.round(ctx.config.confidence_review_threshold * 100)}% recognition confidence`;

function queue(ctx) {
  const threshold = ctx.config.confidence_review_threshold;
  return ctx.analytics.all.filter(
    (o) =>
      o.recognition_confidence !== null &&
      (showResolved
        ? o.recognition_confidence < threshold
        : o.recognition_confidence < threshold && !o.manual_correction && !o.review_resolved),
  );
}

export function render(ctx) {
  const rows = queue(ctx);
  const selected = rows.find((o) => o.id === selectedId) ?? rows[0] ?? null;

  const columns = [
    { key: 'observed_at', label: 'Observed', render: (o) => esc(dateTimeLabel(o.observed_at)), sortValue: (o) => new Date(o.observed_at).getTime() },
    { key: 'outlet_name', label: 'Outlet', render: (o) => `${esc(o.outlet_name)}<br /><span class="xsmall muted">${esc(o.outlet_code)}</span>` },
    { key: 'sku_name', label: 'Detected SKU', render: (o) => esc(o.sku_name) },
    { key: 'confirmed_price', label: 'Detected price', align: 'right', render: (o) => money(o.detected_price) },
    { key: 'confidence', label: 'Confidence', render: (o) => confidenceBar(o.recognition_confidence), sortValue: (o) => o.recognition_confidence },
    { key: 'status', label: 'Current status', render: (o) => (o.is_jti ? statusPill(o.evaluation?.status) : '<span class="pill pill--none">Competitor</span>') },
    { key: 'state', label: 'Review state', render: (o) => (o.review_resolved ? '<span class="pill pill--good">✓ Reviewed</span>' : o.manual_correction ? '<span class="pill pill--info">Corrected in field</span>' : '<span class="pill pill--watch">! Pending</span>') },
  ];

  return `
    ${disclaimer(`${esc(CONFIDENCE_NOTE)} Low recognition confidence produces a <strong>Review Required</strong> status rather than a price-position judgement, so uncertain data never drives a commercial conclusion.`)}
    <div class="card">
      <div class="card__head">
        <h2>${rows.length} item${rows.length === 1 ? '' : 's'} in the queue</h2>
        <label class="checkbox"><input type="checkbox" data-action="toggle-resolved" ${showResolved ? 'checked' : ''} /> Include reviewed and field-corrected items</label>
      </div>
      ${dataTable(columns, rows.slice(0, 200), {
        rowAttrs: (o) => `class="clickable" data-action="select-observation" data-id="${esc(o.id)}"`,
        emptyMessage: 'Nothing awaiting review — all detections are above the confidence threshold.',
      })}
    </div>
    ${selected ? reviewPanel(ctx, selected) : ''}`;
}

function reviewPanel(ctx, o) {
  const image = ctx.data.images.find((i) => i.id === o.image_id);
  const box = o.bounding_box;

  return `<div class="card">
    <div class="card__head">
      <h2>Review — ${esc(o.sku_name)}</h2>
      <span class="card__sub">${esc(o.outlet_name)} · ${esc(dateTimeLabel(o.observed_at))}</span>
    </div>
    <div class="grid grid--2">
      <div>
        <h3>Source image</h3>
        <div style="position:relative;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:14px;text-align:center">
          <div class="mono small">${esc(image?.file_name ?? 'image unavailable')}</div>
          <div class="xsmall muted mt">Source: ${esc(image?.image_source ?? '—')} · Quality: ${esc(image?.quality_status ?? '—')}</div>
          ${
            box
              ? `<svg viewBox="0 0 100 100" width="100%" height="130" style="margin-top:10px" role="img" aria-label="Detected region">
                  <rect x="0" y="0" width="100" height="100" fill="#e9edf1"></rect>
                  <rect x="${box.x * 100}" y="${box.y * 100}" width="${box.w * 100}" height="${box.h * 100}"
                    fill="none" stroke="var(--accent)" stroke-width="1.5"></rect>
                  <text x="${box.x * 100 + 1}" y="${box.y * 100 - 1}" font-size="4" fill="var(--accent)">detected region</text>
                </svg>
                <div class="xsmall muted">Position: ${esc(BOX_SOURCE_LABEL[box.source ?? 'none'])}</div>`
              : '<p class="xsmall muted mt">No position supplied by the recognition provider.</p>'
          }
          <p class="xsmall muted">Images are not uploaded, so the region is shown as geometry
            without the photograph. The TME sees the same detections drawn on the real photo
            during the visit, in the shelf overlay.</p>
        </div>
      </div>
      <div>
        <h3>Detection</h3>
        <dl style="margin:0">
          <div class="detection__row"><dt>Detected text</dt><dd class="mono">${esc(o.raw_text ?? '—')}</dd></div>
          <div class="detection__row"><dt>Detected SKU</dt><dd>${esc(o.sku_name)}</dd></div>
          <div class="detection__row"><dt>Detected price</dt><dd>${money(o.detected_price)}</dd></div>
          <div class="detection__row"><dt>Confirmed price</dt><dd>${money(o.confirmed_price)}</dd></div>
          <div class="detection__row"><dt>Recognition</dt><dd>${confidenceMeter(o.recognition_confidence, ctx.config.confidence_review_threshold)}</dd></div>
          <div class="detection__row"><dt>Manual correction in field</dt><dd>${o.manual_correction ? 'Yes' : 'No'}</dd></div>
          <div class="detection__row"><dt>Visit</dt><dd class="mono xsmall">${esc(o.visit_id)}</dd></div>
        </dl>

        <div class="form-grid mt">
          ${selectField({
            label: 'Change SKU',
            name: 'review-sku',
            value: o.sku_id,
            includeAll: false,
            options: ctx.data.skus.map((s) => ({ value: s.id, label: s.name })),
          })}
          <div class="field">
            <label for="review-price">Change price (SGD)</label>
            <input id="review-price" type="number" step="0.05" min="0" value="${o.confirmed_price}" data-filter="review-price" />
          </div>
        </div>

        <div class="toolbar mt">
          <button class="btn btn--primary btn--sm" data-action="confirm" data-id="${esc(o.id)}">✓ Confirm</button>
          <button class="btn btn--sm" data-action="mark-unreadable" data-id="${esc(o.id)}">Mark Unreadable</button>
          <button class="btn btn--sm btn--danger" data-action="exclude" data-id="${esc(o.id)}">Exclude Observation</button>
        </div>
        <p class="xsmall muted mt">The TME can also recover in the field by retaking the photo or choosing another image from the gallery.</p>
      </div>
    </div>
  </div>`;
}

export function onAction(action, el, ctx) {
  switch (action) {
    case 'select-observation':
      selectedId = el.dataset.id;
      ctx.render();
      break;
    case 'toggle-resolved':
      showResolved = el.checked;
      ctx.render();
      break;
    case 'confirm':
      ctx.store.updateObservation(el.dataset.id, { review_resolved: true, reviewed_at: new Date().toISOString() });
      ctx.render();
      break;
    case 'mark-unreadable':
      ctx.store.updateObservation(el.dataset.id, {
        review_resolved: true,
        excluded: true,
        exclusion_reason: 'Marked unreadable in Image Review',
      });
      selectedId = null;
      ctx.render();
      break;
    case 'exclude':
      ctx.store.updateObservation(el.dataset.id, {
        review_resolved: true,
        excluded: true,
        exclusion_reason: 'Excluded by reviewer',
      });
      selectedId = null;
      ctx.render();
      break;
    default:
      break;
  }
}

export function onChange(target, ctx) {
  if (!selectedId) return false;
  if (target.dataset.filter === 'review-sku') {
    ctx.store.updateObservation(selectedId, { sku_id: target.value, manual_correction: true });
    ctx.render();
    return true;
  }
  if (target.dataset.filter === 'review-price') {
    const value = Number.parseFloat(target.value);
    if (Number.isFinite(value)) {
      ctx.store.updateObservation(selectedId, { confirmed_price: value, manual_correction: true });
      ctx.render();
    }
    return true;
  }
  return false;
}
