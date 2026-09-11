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

export const SCHEMATIC_NOTE = {
  shelf:
    'The shelf as read. Products sit on the shelf the model counted them on, and each is ' +
    'drawn as many times as it counted packs side by side. Which pack stands where along a ' +
    'shelf is not known — nothing here measures positions from the photo.',
  price:
    'The shelf as read. The model reported no shelf numbers for this photo, so products that ' +
    'share a price and were read one after another are drawn on one shelf. That is a guess ' +
    'about grouping, not a measurement.',
};

/** How many packs of one product to draw before the row becomes noise rather than a shelf. */
export const MAX_DRAWN_FACINGS = 8;

/**
 * Arranges detections into shelves.
 *
 * Preferred basis is the shelf number the model counted. It is asked for "which shelf from
 * the top, starting at 1", which is a counting question — unlike coordinates, which it
 * fabricated every time it was asked.
 *
 * Where no shelf numbers come back, consecutive runs of equal price stand in: one rail
 * carries one price, so a run of equal prices is very likely one shelf. A price that recurs
 * after a different one starts a new shelf, because two shelves can carry the same price.
 *
 * The basis is returned, not buried, because the two claim different things and the screen
 * says which one it is showing.
 *
 * @returns {{basis: 'shelf'|'price', rails: {label: number, items: object[]}[]}}
 */
export function groupIntoRails(drafts) {
  const rows = drafts ?? [];

  // Only when every detection carries one: a half-numbered response would otherwise put
  // the numbered products on real shelves and everything else on an invented one.
  const numbered = rows.length > 0 && rows.every((d) => Number.isFinite(d.shelf));

  if (numbered) {
    const byShelf = new Map();
    for (const draft of rows) {
      if (!byShelf.has(draft.shelf)) byShelf.set(draft.shelf, []);
      byShelf.get(draft.shelf).push(draft);
    }
    return {
      basis: 'shelf',
      rails: [...byShelf.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([label, items]) => ({ label, items })),
    };
  }

  const rails = [];
  for (const draft of rows) {
    const price = draft.confirmed_price ?? draft.detected_price ?? null;
    const last = rails.at(-1);
    if (last && last.price === price) last.items.push(draft);
    else rails.push({ label: rails.length + 1, price, items: [draft] });
  }
  return { basis: 'price', rails };
}

/** Facings actually drawn for one detection: what was counted, capped so a row stays legible. */
export function drawnFacings(draft) {
  const counted = Number.isFinite(draft?.facings) ? Math.max(1, Math.trunc(draft.facings)) : 1;
  return { counted, drawn: Math.min(counted, MAX_DRAWN_FACINGS) };
}

/**
 * One product on the shelf: every pack of it that was counted, with its ticket underneath.
 *
 * Drawing one pack per detection was the bug this fixes — a model reports a product once,
 * not once per facing, so three packs of Mevius side by side came out as a single pack. The
 * count now comes from the model, which is asked to count them.
 */
function block(draft, threshold) {
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

  const { counted, drawn } = drawnFacings(draft);
  const pack = `<span class="pack pack--${tone}${isJti ? ' pack--jti' : ''}">
      <span class="pack__owner">${isJti ? 'JTI' : 'Comp.'}</span>
      <span class="pack__name">${esc(name)}</span>
      ${draft.sku?.is_strategic ? '<span class="pack__strategic" title="Strategic SKU">★</span>' : ''}
    </span>`;

  return `<button type="button" class="block${draft.excluded ? ' block--excluded' : ''}"
    data-action="focus-detection" data-draft="${esc(draft.draft_id)}"
    data-facings="${counted}"
    aria-label="${esc(`${label}, ${counted} facing${counted === 1 ? '' : 's'}. Open to correct.`)}">
    <span class="block__packs">${pack.repeat(drawn)}</span>
    <span class="ticket ticket--${tone}">
      <span class="ticket__price">${esc(Number.isFinite(price) ? price.toFixed(2) : '—')}</span>
      ${counted > 1 ? `<span class="ticket__facings">×${counted}</span>` : ''}
      <span class="ticket__conf ticket__conf--${confTone}">${esc(pct)}</span>
    </span>
  </button>`;
}

function railPrice(items) {
  const prices = [...new Set(items.map((d) => d.confirmed_price ?? d.detected_price).filter(Number.isFinite))];
  if (!prices.length) return '—';
  if (prices.length === 1) return money(prices[0]);
  return `${money(Math.min(...prices))} – ${money(Math.max(...prices))}`;
}

function rail(entry, index, threshold) {
  const statuses = [
    ...new Set(entry.items.filter((d) => d.sku?.is_jti).map((d) => d.evaluation?.status).filter(Boolean)),
  ];
  const facings = entry.items.reduce((total, d) => total + drawnFacings(d).counted, 0);

  return `<div class="rail">
    <div class="rail__head">
      <span class="rail__name">Shelf ${index}</span>
      <span class="rail__price">${railPrice(entry.items)}</span>
      <span class="rail__count">${entry.items.length} product${entry.items.length === 1 ? '' : 's'}
        · ${facings} facing${facings === 1 ? '' : 's'}</span>
      ${statuses.map((s) => statusPill(s)).join(' ')}
    </div>
    <div class="rail__blocks">${entry.items.map((d) => block(d, threshold)).join('')}</div>
    <div class="rail__shelf" aria-hidden="true"></div>
  </div>`;
}

/**
 * @param {object[]} drafts detections in the order they were read
 * @param {{threshold?: number, imageName?: string, simulatedPrices?: boolean}} options
 */
export function shelfSchematic(drafts, options = {}) {
  const { threshold = 0.75, imageName = null, simulatedPrices = false } = options;
  const { basis, rails } = groupIntoRails(drafts);

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
    <p class="xsmall muted">${esc(SCHEMATIC_NOTE[basis])}</p>
    ${simulatedPrices ? '<p class="xsmall muted">The MVP Simulator generated these prices from the catalogue without looking at the photo. Select a vision model in Admin to read the photo for real.</p>' : ''}
  </div>`;
}
