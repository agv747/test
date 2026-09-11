/**
 * Shelf overlay — the captured photo with every price drawn where it was read (§8.6).
 *
 * What this is, and what it deliberately is not:
 *
 * It is an annotated still. The photo the TME just took is shown at full width, and above
 * each price on the shelf sits a label carrying that price, the SKU and how well it was
 * read, so "where did SGD 13.30 come from?" is answered by looking rather than by reading a
 * list. Tapping a label opens that detection for correction; dragging it moves it.
 *
 * It is not live camera passthrough. A vision model answers in seconds, not in frames, so a
 * continuously updating overlay would either lag far behind the camera or cost a model call
 * per frame. Freezing the frame is also what the task actually needs: prices are read once
 * per visit and then corrected, and a still image can be zoomed and re-read at leisure.
 *
 * Nothing here uses coordinates from the recognition model. Asked for them, gpt-4o twice
 * returned a tidy grid of identical rectangles sitting above the packs it had just read
 * correctly. It reads text well and localises badly, so it is no longer asked: the model
 * says WHAT was read and in what order, and the photograph itself says WHERE each price row
 * sits (see lib/shelfRows.js).
 */

import { CONFIDENCE_NOTE, confidenceTone, confidenceWord, esc, money } from './dom.js';
import { anchorOf } from '../lib/shelfRows.js';

/** How a label came to be where it is. Never omitted: a label on a photo reads as evidence. */
export const BOX_SOURCE_NOTE = {
  row:
    'Each price sits above the shelf row it was read from. The rows were found in the photo ' +
    'itself and the prices were matched to them in the order the model read them, so a label ' +
    'can be one row out where a row is hidden. Drag any label onto the right price.',
  band:
    'Approximate positions. No shelf rows could be made out in this photo, so the prices are ' +
    'spread evenly down it in the order they were read. Drag any label onto the price it ' +
    'belongs to.',
  model: 'Positions reported by the recognition provider and checked against the photo.',
  inferred:
    'Approximate positions, spread down the photo in the order the prices were read. Drag any ' +
    'label onto the price it belongs to.',
  simulated: 'Simulated positions, generated from the catalogue rather than read from the image.',
  manual: 'Positions you placed by hand. These are saved with the visit.',
  none: 'No positions are available for this image.',
};

/** The same distinction in three words, for a detail row. */
export const BOX_SOURCE_LABEL = {
  row: 'On the shelf row it was read from',
  band: 'Approximate — reading order',
  model: 'Reported by the provider',
  inferred: 'Approximate — reading order',
  simulated: 'Simulated',
  manual: 'Placed by you',
  none: 'Not placed',
};

/** Said alongside the above when the prices themselves were never read from the image. */
export const SIMULATED_PRICES_NOTE =
  'The MVP Simulator generated these prices from the catalogue without looking at the photo. ' +
  'Select a vision model in Admin to read this photo for real.';

/**
 * The provenance the picture as a whole can claim.
 *
 * The weakest one present wins, so one hand-placed marker never upgrades the rest and one
 * inferred band never gets to borrow the credibility of a measured box.
 */
export function boxSource(drafts) {
  const sources = new Set(drafts.map((d) => d.bounding_box?.source).filter(Boolean));
  for (const weakest of ['simulated', 'band', 'inferred', 'row', 'model', 'manual']) {
    if (sources.has(weakest)) return weakest;
  }
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

/**
 * One label, sitting above the price it belongs to and pointing down at it.
 *
 * Above rather than over: a rectangle drawn across a price ticket hides the very thing the
 * TME is being asked to confirm, and a rectangle that is even slightly wrong looks like a
 * claim about which ticket was read. A label with a pointer makes the same claim, leaves the
 * ticket visible underneath, and is small enough that several fit on one shelf.
 */
function marker(draft, index, threshold) {
  const anchor = anchorOf(draft.bounding_box);
  if (!anchor) return '';
  const tone = confidenceTone(draft.recognition_confidence, threshold);
  const { name, price, pct } = markerLabel(draft);
  const word = confidenceWord(draft.recognition_confidence, threshold);
  const source = anchor.source ?? 'none';

  return `<button type="button"
    class="ar__pin ar__pin--${tone}${draft.excluded ? ' ar__pin--excluded' : ''}${source === 'manual' ? ' ar__pin--manual' : ''}"
    style="left:${(anchor.x * 100).toFixed(2)}%;top:${(anchor.y * 100).toFixed(2)}%"
    data-action="focus-detection" data-draft="${esc(draft.draft_id)}" data-marker="${esc(draft.draft_id)}"
    aria-label="${esc(`${index}. ${name}, ${money(price)}, recognition ${pct}, ${word}. ${BOX_SOURCE_LABEL[source]}. Tap to correct, drag to place on the price.`)}">
    <span class="ar__tag">
      <span class="ar__price">${esc(Number.isFinite(price) ? price.toFixed(2) : '—')}</span>
      <span class="ar__name">${esc(name)}</span>
      <span class="ar__conf">${esc(pct)}</span>
    </span>
    <span class="ar__stem" aria-hidden="true"></span>
  </button>`;
}

/**
 * @param {{id:string, name:string, previewUrl:string|null}} image
 * @param {object[]} drafts drafts belonging to that image, in detection order
 * @param {{threshold?:number, fullscreen?:boolean, placing?:boolean}} options
 */
export function shelfOverlay(image, drafts, options = {}) {
  const { threshold = 0.75, fullscreen = false, placing = false, simulatedPrices = false } = options;
  const placed = drafts.filter((d) => d.bounding_box);
  const source = boxSource(drafts);

  if (!image?.previewUrl) {
    return `<div class="empty">This image is no longer held on the device, so it cannot be
      annotated. Retake the photo to use the shelf overlay.</div>`;
  }

  return `<div class="ar${fullscreen ? ' ar--full' : ''}${placing ? ' ar--placing' : ''}">
    <div class="ar__frame">
      <img class="ar__img" src="${esc(image.previewUrl)}" alt="${esc(`Shelf photo ${image.name}, with ${placed.length} recognised price${placed.length === 1 ? '' : 's'} marked`)}" />
      <div class="ar__layer">
        ${placed.map((d, i) => marker(d, i + 1, threshold)).join('')}
      </div>
    </div>
    <div class="ar__tools">
      <button type="button" class="ar__tool${placing ? ' ar__tool--on' : ''}"
        data-action="toggle-overlay-placing" aria-pressed="${placing}">
        ${placing ? '✓ Done moving' : '✥ Move labels'}
      </button>
      <button type="button" class="ar__tool" data-action="toggle-overlay-fullscreen">
        ${fullscreen ? '✕ Close' : '⤢ Full screen'}
      </button>
    </div>
  </div>
  ${placing ? '<p class="xsmall muted mt">Drag any label onto the price it belongs to. Positions you set are kept with the visit.</p>' : ''}
  ${fullscreen ? '' : overlayLegend(source, placed.length, drafts.length, simulatedPrices)}`;
}

/* --------------------------------------------------------------- laying out */

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function intersects(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Centre positions to try: where it wants to be, then further out to each side. */
function* columnCandidates(centre, width, half, step = 8) {
  const clamp = (value) => Math.min(width - half, Math.max(half, value));
  yield clamp(centre);
  for (let offset = step; offset <= width; offset += step) {
    yield clamp(centre + offset);
    yield clamp(centre - offset);
  }
}

/**
 * Slides labels sideways until none covers another.
 *
 * Placement can only know which row a price belongs to, not how wide its label will be once
 * the SKU name is in it — and shelf rows are closer together than a label is tall, so two
 * rows' labels collide whenever they happen to land in the same column. A covered label
 * hides a price and cannot be tapped.
 *
 * Only the horizontal position moves. Which row a label sits on is the claim it makes; where
 * along that row is not, since nothing here knows which facing a price came from.
 */
export function layoutMarkers(root) {
  const layer = root?.querySelector?.('.ar__layer');
  if (!layer) return;
  const bounds = layer.getBoundingClientRect();
  if (!bounds.width) return;

  const taken = [];
  for (const pin of layer.querySelectorAll('.ar__pin')) {
    const tag = pin.querySelector('.ar__tag');
    if (!tag) continue;

    const rect = tag.getBoundingClientRect();
    const half = rect.width / 2;
    const top = rect.top - bounds.top;
    const bottom = rect.bottom - bounds.top;

    let chosen = pin.offsetLeft;
    for (const candidate of columnCandidates(pin.offsetLeft, bounds.width, half)) {
      const box = { left: candidate - half, right: candidate + half, top, bottom };
      if (!taken.some((other) => intersects(other, box))) {
        chosen = candidate;
        break;
      }
    }

    pin.style.left = `${(chosen / bounds.width) * 100}%`;
    taken.push({ left: chosen - half, right: chosen + half, top, bottom });
  }
}

/* ------------------------------------------------------------- placing by hand */

/**
 * Lets the TME drag a label onto the price it belongs to.
 *
 * Only active while the overlay is in placing mode. Outside it, a label is a plain tap
 * target and a touch that starts on one scrolls the page — making every label swallow a
 * swipe would leave the page hard to scroll on a phone.
 *
 * @param {HTMLElement} root  the rendered page
 * @param {(draftId: string, anchor: {x, y, source:'manual'}) => void} onPlaced
 */
export function bindMarkerDrag(root, onPlaced) {
  const layer = root.querySelector('.ar--placing .ar__layer');
  if (!layer) return;

  let drag = null;

  layer.addEventListener('pointerdown', (event) => {
    const marker = event.target.closest('.ar__pin');
    if (!marker) return;
    const bounds = layer.getBoundingClientRect();
    drag = {
      marker,
      id: marker.dataset.marker,
      startX: event.clientX,
      startY: event.clientY,
      left: marker.offsetLeft,
      top: marker.offsetTop,
      bounds,
      moved: false,
    };
    marker.setPointerCapture?.(event.pointerId);
  });

  layer.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    // A few pixels of travel is a tap with a shaky thumb, not an attempt to move anything.
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;

    drag.moved = true;
    event.preventDefault();
    drag.marker.classList.add('ar__pin--dragging');
    drag.marker.style.left = `${clamp01((drag.left + dx) / drag.bounds.width) * 100}%`;
    drag.marker.style.top = `${clamp01((drag.top + dy) / drag.bounds.height) * 100}%`;
  });

  const finish = () => {
    if (!drag) return;
    const { marker, moved, id, bounds } = drag;
    drag = null;
    marker.classList.remove('ar__pin--dragging');
    if (!moved) return;

    // The pin is positioned by the point it aims at, so that point is what is stored.
    onPlaced(id, {
      x: clamp01(marker.offsetLeft / bounds.width),
      y: clamp01(marker.offsetTop / bounds.height),
      source: 'manual',
    });
  };

  layer.addEventListener('pointerup', finish);
  layer.addEventListener('pointercancel', finish);

  // A drag must not also count as a tap that opens the detection for correction.
  layer.addEventListener(
    'click',
    (event) => {
      if (!event.target.closest('.ar__pin')) return;
      event.stopPropagation();
      event.preventDefault();
    },
    true,
  );
}

function overlayLegend(source, placedCount, totalCount, simulatedPrices = false) {
  const missing = totalCount - placedCount;
  return `<div class="ar__legend">
    <div class="ar__keys">
      <span class="ar__key ar__key--good">■ 90%+ read clearly</span>
      <span class="ar__key ar__key--watch">■ 75–89% read with doubt</span>
      <span class="ar__key ar__key--risk">■ under 75% needs confirming</span>
    </div>
    <p class="xsmall muted">${esc(CONFIDENCE_NOTE)}</p>
    <p class="xsmall muted">${esc(BOX_SOURCE_NOTE[source])}</p>
    ${simulatedPrices ? `<p class="xsmall muted">${esc(SIMULATED_PRICES_NOTE)}</p>` : ''}
    ${missing > 0 ? `<p class="xsmall muted">${missing} detection${missing === 1 ? ' has' : 's have'} no position and appear only in the list below.</p>` : ''}
  </div>`;
}
