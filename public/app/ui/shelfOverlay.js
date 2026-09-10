/**
 * Shelf overlay — the captured photo with every detection drawn on it (§8.6, optional view).
 *
 * What this is, and what it deliberately is not:
 *
 * It is an annotated still. The photo the TME just took is shown at full width with one
 * marker per detection, each carrying the SKU, the price and the recognition percentage,
 * so "where did SGD 13.30 come from?" is answered by looking rather than by reading a list.
 * Tapping a marker opens that detection for correction.
 *
 * It is not live camera passthrough. A vision model answers in seconds, not in frames, so a
 * continuously updating overlay would either lag far behind the camera or cost a model call
 * per frame. Freezing the frame is also what the task actually needs: prices are read once
 * per visit and then corrected, and a still image can be zoomed and re-read at leisure.
 *
 * Positions come from three different places and the difference matters commercially, so it
 * is stated on screen rather than implied by drawing everything the same way:
 *
 *   model      the model reported coordinates — the rectangle is where it says it looked
 *   inferred   it reported none, so lines are laid out in reading order, top to bottom
 *   simulated  the MVP Simulator invented both the prices and the rectangles
 */

import { CONFIDENCE_NOTE, confidenceTone, confidenceWord, esc, money } from './dom.js';

/** How the rectangles were arrived at. Never omitted: an inferred box invites false trust. */
export const BOX_SOURCE_NOTE = {
  model:
    'Positions reported by the recognition model. Tap a marker to correct the SKU or the price.',
  inferred:
    'Approximate positions. The model read the lines but did not report where each one sits, ' +
    'so they are laid out in the order it read them, top to bottom. Use the markers to work ' +
    'through the list, not to prove which label a price came from.',
  simulated:
    'Simulated positions. The MVP Simulator does not look at the image — both the prices and ' +
    'the rectangles are generated from the catalogue. Select a vision model in Admin to read ' +
    'this photo for real.',
  none: 'The recognition provider reported no positions for this image.',
};

/** The same distinction in three words, for a detail row. */
export const BOX_SOURCE_LABEL = {
  model: 'Reported by the model',
  inferred: 'Approximate — reading order',
  simulated: 'Simulated',
  none: 'Not reported',
};

/** The dominant provenance across the drafts drawn on one image. */
export function boxSource(drafts) {
  const sources = new Set(drafts.map((d) => d.bounding_box?.source).filter(Boolean));
  if (sources.has('model')) return 'model';
  if (sources.has('simulated')) return 'simulated';
  if (sources.has('inferred')) return 'inferred';
  return 'none';
}

function markerLabel(draft) {
  const name = draft.sku?.name ?? draft.brand_candidate ?? 'Unrecognised item';
  const price = draft.confirmed_price ?? draft.detected_price;
  const pct =
    draft.recognition_confidence === null || draft.recognition_confidence === undefined
      ? '—'
      : `${Math.round(draft.recognition_confidence * 100)}%`;
  return { name, price, pct };
}

function marker(draft, index, threshold) {
  const box = draft.bounding_box;
  if (!box) return '';
  const tone = confidenceTone(draft.recognition_confidence, threshold);
  const { name, price, pct } = markerLabel(draft);
  const word = confidenceWord(draft.recognition_confidence, threshold);
  const style = `left:${box.x * 100}%;top:${box.y * 100}%;width:${box.w * 100}%;height:${box.h * 100}%`;

  return `<button type="button"
    class="ar__box ar__box--${tone}${draft.excluded ? ' ar__box--excluded' : ''}"
    style="${style}"
    data-action="focus-detection" data-draft="${esc(draft.draft_id)}"
    aria-label="${esc(`${index}. ${name}, ${money(price)}, recognition ${pct}, ${word}. Open to correct.`)}">
    <span class="ar__tag">
      <span class="ar__line">
        <span class="ar__price">${esc(Number.isFinite(price) ? price.toFixed(2) : '—')}</span>
        <span class="ar__conf">${esc(pct)}</span>
      </span>
      <span class="ar__name">${esc(name)}</span>
    </span>
  </button>`;
}

/**
 * @param {{id:string, name:string, previewUrl:string|null}} image
 * @param {object[]} drafts drafts belonging to that image, in detection order
 * @param {{threshold?:number, fullscreen?:boolean}} options
 */
export function shelfOverlay(image, drafts, options = {}) {
  const { threshold = 0.75, fullscreen = false } = options;
  const placed = drafts.filter((d) => d.bounding_box);
  const source = boxSource(drafts);

  if (!image?.previewUrl) {
    return `<div class="empty">This image is no longer held on the device, so it cannot be
      annotated. Retake the photo to use the shelf overlay.</div>`;
  }

  return `<div class="ar${fullscreen ? ' ar--full' : ''}">
    <div class="ar__frame">
      <img class="ar__img" src="${esc(image.previewUrl)}" alt="${esc(`Shelf photo ${image.name}, with ${placed.length} recognised price${placed.length === 1 ? '' : 's'} marked`)}" />
      <div class="ar__layer">
        ${placed.map((d, i) => marker(d, i + 1, threshold)).join('')}
      </div>
    </div>
    <button type="button" class="ar__expand" data-action="toggle-overlay-fullscreen">
      ${fullscreen ? '✕ Close' : '⤢ Full screen'}
    </button>
  </div>
  ${fullscreen ? '' : overlayLegend(source, placed.length, drafts.length)}`;
}

function overlayLegend(source, placedCount, totalCount) {
  const missing = totalCount - placedCount;
  return `<div class="ar__legend">
    <div class="ar__keys">
      <span class="ar__key ar__key--good">■ 90%+ read clearly</span>
      <span class="ar__key ar__key--watch">■ 75–89% read with doubt</span>
      <span class="ar__key ar__key--risk">■ under 75% needs confirming</span>
    </div>
    <p class="xsmall muted">${esc(CONFIDENCE_NOTE)}</p>
    <p class="xsmall muted">${esc(BOX_SOURCE_NOTE[source])}</p>
    ${missing > 0 ? `<p class="xsmall muted">${missing} detection${missing === 1 ? ' has' : 's have'} no position and appear only in the list below.</p>` : ''}
  </div>`;
}
