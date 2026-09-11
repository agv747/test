/**
 * Shelf schematic — the detections drawn as a shelf rather than listed as rows (§8.6).
 *
 * This replaces the photo overlay, which was tried twice and abandoned. Drawing on the photo
 * needs to know where on it each price sits, and nothing available can supply that: the
 * vision models fabricated coordinates (gpt-4o returned the same tidy grid of rectangles
 * above the packs twice over), and reading the shelf rails out of the pixels put labels on
 * the right rows of a clean price list but not of a real cabinet photographed at an angle,
 * behind glass, beside a door and a clock.
 *
 * A schematic needs none of that. Everything it draws is already known for certain: what was
 * read, what price it carried, and in what order. It shows the same shelf shape a TME is
 * standing in front of — facings side by side, a price ticket under each, one rail per price
 * — so a whole visit can be taken in at a glance instead of scrolled through.
 *
 * What it is honest about: this is the shelf AS READ, not a plan of the physical shelf.
 * Facings are grouped by shared price because one rail carries one price, and rails follow
 * the order the model reported. Nothing here claims to know that two packs are physically
 * adjacent.
 */

import {
  confidenceTone,
  confidenceWord,
  esc,
  money,
  statusPill,
  statusTone,
} from './dom.js';

export const SCHEMATIC_NOTE =
  'The shelf as read, not a plan of the real one: facings are grouped by shared price, and ' +
  'the rails follow the order the prices were read. Positions are not measured from the photo.';

/**
 * Groups consecutive detections that share a price into one rail.
 *
 * One shelf rail carries one price across several facings, and a model reading such a shelf
 * reports that price once per facing. Consecutive runs of equal price are therefore the
 * best available proxy for "these sit together" — and it needs no coordinates. A price that
 * recurs after a different one starts a new rail, because two shelves can carry the same
 * price.
 */
export function groupIntoRails(drafts) {
  const rails = [];
  for (const draft of drafts ?? []) {
    const price = draft.confirmed_price ?? draft.detected_price ?? null;
    const last = rails.at(-1);
    if (last && last.price === price) last.facings.push(draft);
    else rails.push({ price, facings: [draft] });
  }
  return rails;
}

/** The pack face. Standardised packaging carries no brand colours, so neither does this. */
function facing(draft, threshold) {
  const name = draft.sku?.name ?? draft.brand_candidate ?? 'Unrecognised item';
  const price = draft.confirmed_price ?? draft.detected_price;
  const isJti = Boolean(draft.sku?.is_jti);
  const tone = isJti ? statusTone(draft.evaluation?.status) : 'none';
  const confTone = confidenceTone(draft.recognition_confidence, threshold);
  const pct =
    draft.recognition_confidence === null || draft.recognition_confidence === undefined
      ? '—'
      : `${Math.round(draft.recognition_confidence * 100)}%`;

  const label = [
    name,
    money(price),
    isJti ? 'JTI' : 'competitor',
    draft.evaluation?.status ?? '',
    `recognition ${pct}, ${confidenceWord(draft.recognition_confidence, threshold)}`,
  ]
    .filter(Boolean)
    .join(', ');

  return `<button type="button" class="facing${draft.excluded ? ' facing--excluded' : ''}"
    data-action="focus-detection" data-draft="${esc(draft.draft_id)}"
    aria-label="${esc(`${label}. Open to correct.`)}">
    <span class="pack pack--${tone}${isJti ? ' pack--jti' : ''}">
      <span class="pack__owner">${isJti ? 'JTI' : 'Comp.'}</span>
      <span class="pack__name">${esc(name)}</span>
      ${draft.sku?.is_strategic ? '<span class="pack__strategic" title="Strategic SKU">★</span>' : ''}
    </span>
    <span class="ticket ticket--${tone}">
      <span class="ticket__price">${esc(Number.isFinite(price) ? price.toFixed(2) : '—')}</span>
      <span class="ticket__conf ticket__conf--${confTone}">${esc(pct)}</span>
    </span>
  </button>`;
}

function rail(entry, index, threshold) {
  const jti = entry.facings.filter((d) => d.sku?.is_jti);
  const statuses = [...new Set(jti.map((d) => d.evaluation?.status).filter(Boolean))];

  return `<div class="rail">
    <div class="rail__head">
      <span class="rail__name">Rail ${index}</span>
      <span class="rail__price">${money(entry.price)}</span>
      <span class="rail__count">${entry.facings.length} facing${entry.facings.length === 1 ? '' : 's'}</span>
      ${statuses.map((s) => statusPill(s)).join(' ')}
    </div>
    <div class="rail__facings">${entry.facings.map((d) => facing(d, threshold)).join('')}</div>
    <div class="rail__shelf" aria-hidden="true"></div>
  </div>`;
}

/**
 * @param {object[]} drafts detections in the order they were read
 * @param {{threshold?: number, imageName?: string, simulatedPrices?: boolean}} options
 */
export function shelfSchematic(drafts, options = {}) {
  const { threshold = 0.75, imageName = null, simulatedPrices = false } = options;
  const rails = groupIntoRails(drafts);

  if (!rails.length) {
    return '<div class="empty">Nothing was read from this image, so there is no shelf to draw.</div>';
  }

  return `<div class="schematic">
    ${imageName ? `<div class="schematic__source">From ${esc(imageName)}</div>` : ''}
    <div class="schematic__cabinet">
      ${rails.map((entry, i) => rail(entry, i + 1, threshold)).join('')}
    </div>
    <div class="schematic__legend">
      <span class="legend-key legend-key--good">■ within the recommended range</span>
      <span class="legend-key legend-key--risk">■ above the range, or competitive position at risk</span>
      <span class="legend-key legend-key--watch">■ below the range, or needs confirming</span>
      <span class="legend-key">■ competitor observation</span>
    </div>
    <p class="xsmall muted">${esc(SCHEMATIC_NOTE)}</p>
    ${simulatedPrices ? '<p class="xsmall muted">The MVP Simulator generated these prices from the catalogue without looking at the photo. Select a vision model in Admin to read the photo for real.</p>' : ''}
  </div>`;
}
