/**
 * The shelf schematic turns the detection list into the shape of the shelf.
 *
 * It replaces the photo overlay, which needed to know where on the image each price sat and
 * could not be made to: the vision models fabricated coordinates, and reading the rails out
 * of the pixels worked on a clean price list but not on a real cabinet. Everything the
 * schematic draws is already known for certain — what was read, at what price, in what
 * order — which is exactly why it can be asserted here rather than only looked at.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DRAWN_FACINGS,
  SCHEMATIC_NOTE,
  drawnFacings,
  groupIntoRails,
  shelfSchematic,
} from '../public/app/ui/shelfSchematic.js';
import { PRICE_POSITION_STATUS } from '../public/app/config.js';

function draft(overrides = {}) {
  return {
    draft_id: 'img-1:0',
    image_id: 'img-1',
    sku: { name: 'Winston Red', is_jti: true, is_strategic: false },
    is_jti: true,
    confirmed_price: 13.6,
    detected_price: 13.6,
    recognition_confidence: 0.96,
    evaluation: { status: PRICE_POSITION_STATUS.WITHIN },
    excluded: false,
    shelf: null,
    facings: 1,
    ...overrides,
  };
}

/* ------------------------------------------------------------------- rails */

test('the shelf numbers the model counted decide the shelves', () => {
  const { basis, rails } = groupIntoRails([
    draft({ draft_id: 'a', shelf: 1 }),
    draft({ draft_id: 'b', shelf: 2, confirmed_price: 16 }),
    draft({ draft_id: 'c', shelf: 1, confirmed_price: 14.6 }),
  ]);
  assert.equal(basis, 'shelf');
  assert.equal(rails.length, 2);
  assert.deepEqual(rails.map((r) => r.label), [1, 2]);
  assert.deepEqual(rails.map((r) => r.items.length), [2, 1], 'two products share shelf 1');
});

test('shelves come out top to bottom whatever order they were reported in', () => {
  const { rails } = groupIntoRails([draft({ shelf: 3 }), draft({ shelf: 1 }), draft({ shelf: 2 })]);
  assert.deepEqual(rails.map((r) => r.label), [1, 2, 3]);
});

test('a half-numbered response falls back rather than inventing a shelf for the rest', () => {
  const { basis } = groupIntoRails([draft({ shelf: 1 }), draft({ shelf: null })]);
  assert.equal(basis, 'price');
});

test('with no shelf numbers, products sharing a price make one shelf', () => {
  const { basis, rails } = groupIntoRails([
    draft({ draft_id: 'a', confirmed_price: 18.3 }),
    draft({ draft_id: 'b', confirmed_price: 18.3 }),
    draft({ draft_id: 'c', confirmed_price: 16 }),
  ]);
  assert.equal(basis, 'price');
  assert.equal(rails.length, 2);
  assert.deepEqual(rails.map((r) => r.items.length), [2, 1]);
  assert.deepEqual(rails.map((r) => r.price), [18.3, 16]);
});

test('a price that recurs after a different one starts a new shelf', () => {
  // Two shelves can carry the same price; a consecutive run, not an equal value, is a shelf.
  const { rails } = groupIntoRails([
    draft({ confirmed_price: 16 }),
    draft({ confirmed_price: 14.6 }),
    draft({ confirmed_price: 16 }),
  ]);
  assert.equal(rails.length, 3);
});

test('a corrected price regroups the shelf, since the confirmed price is what counts', () => {
  const { rails } = groupIntoRails([
    draft({ detected_price: 18.3, confirmed_price: 16 }),
    draft({ detected_price: 16, confirmed_price: 16 }),
  ]);
  assert.equal(rails.length, 1);
  assert.equal(rails[0].price, 16);
});

test('grouping nothing is not an error', () => {
  assert.deepEqual(groupIntoRails([]).rails, []);
  assert.deepEqual(groupIntoRails(null).rails, []);
});

/* --------------------------------------------------------------- facings */

test('a product counted three times is drawn three times', () => {
  // The bug this fixes: a model reports a product once, not once per facing, so a row of
  // three identical packs came out as a single pack.
  const html = shelfSchematic([draft({ facings: 3 })]);
  assert.equal(html.match(/class="pack /g).length, 3);
  assert.match(html, /×3/);
});

test('a single facing is drawn once and not labelled with a count', () => {
  const html = shelfSchematic([draft({ facings: 1 })]);
  assert.equal(html.match(/class="pack /g).length, 1);
  assert.doesNotMatch(html, /×1/);
});

test('an uncounted product is drawn once rather than guessed at', () => {
  const html = shelfSchematic([draft({ facings: undefined })]);
  assert.equal(html.match(/class="pack /g).length, 1);
});

test('an implausible count is capped for drawing but reported in full', () => {
  const html = shelfSchematic([draft({ facings: 30 })]);
  assert.equal(html.match(/class="pack /g).length, MAX_DRAWN_FACINGS);
  assert.match(html, /×30/, 'the count the model gave is still stated');
});

test('the drawn and counted numbers are separable, and a bad count means one pack', () => {
  assert.deepEqual(drawnFacings({ facings: 3 }), { counted: 3, drawn: 3 });
  assert.deepEqual(drawnFacings({ facings: 30 }), { counted: 30, drawn: MAX_DRAWN_FACINGS });
  assert.deepEqual(drawnFacings({ facings: 0 }), { counted: 1, drawn: 1 });
  assert.deepEqual(drawnFacings({}), { counted: 1, drawn: 1 });
  assert.deepEqual(drawnFacings(null), { counted: 1, drawn: 1 });
});

test('the shelf head counts products and facings separately', () => {
  const html = shelfSchematic([
    draft({ draft_id: 'a', facings: 3 }),
    draft({ draft_id: 'b', facings: 2 }),
  ]);
  assert.match(html, /2 products/);
  assert.match(html, /5 facings/);
});

/* --------------------------------------------------------------- the shelf */

test('every facing carries its SKU, its price and how well it was read', () => {
  const html = shelfSchematic([draft()]);
  assert.match(html, /Winston Red/);
  assert.match(html, /13\.60/);
  assert.match(html, /96%/);
});

test('the shelf is labelled with its price and what stands on it', () => {
  const html = shelfSchematic([
    draft({ draft_id: 'a', confirmed_price: 18.3 }),
    draft({ draft_id: 'b', confirmed_price: 18.3 }),
  ]);
  assert.match(html, /Shelf 1/);
  assert.match(html, /SGD 18\.30/);
  assert.match(html, /2 products/);
});

test('one of something is not described as several', () => {
  const html = shelfSchematic([draft()]);
  assert.match(html, /1 product[^s]/);
  assert.match(html, /1 facing[^s]/);
});

test('a shelf carrying several prices shows the range rather than picking one', () => {
  const html = shelfSchematic([
    draft({ draft_id: 'a', shelf: 1, confirmed_price: 13.6 }),
    draft({ draft_id: 'b', shelf: 1, confirmed_price: 16 }),
  ]);
  assert.match(html, /SGD 13\.60 – SGD 16\.00/);
});

test('a product opens its own detection for correction', () => {
  const html = shelfSchematic([draft({ draft_id: 'img-1:3' })]);
  assert.match(html, /data-action="focus-detection"/);
  assert.match(html, /data-draft="img-1:3"/);
});

test('a product is a button and describes itself to a screen reader', () => {
  const html = shelfSchematic([draft({ facings: 3 })]);
  assert.match(html, /<button type="button"/);
  assert.match(
    html,
    /aria-label="Winston Red, SGD 13\.60, JTI, Within Recommended Range, recognition 96%, read clearly, 3 facings\. Open to correct\."/,
  );
});

test('price position colours the pack, and the status is spelled out on the rail', () => {
  const at = (status) => shelfSchematic([draft({ evaluation: { status } })]);
  assert.match(at(PRICE_POSITION_STATUS.WITHIN), /pack--good/);
  assert.match(at(PRICE_POSITION_STATUS.ABOVE), /pack--risk/);
  assert.match(at(PRICE_POSITION_STATUS.BELOW), /pack--watch/);
  // Never colour alone: the rail head names the status in words.
  assert.match(at(PRICE_POSITION_STATUS.ABOVE), /Above Recommended Range/);
});

test('a competitor product is marked as one and carries no price-position judgement', () => {
  const html = shelfSchematic([
    draft({ sku: { name: 'Marlboro Red', is_jti: false }, is_jti: false, evaluation: null }),
  ]);
  assert.match(html, /Comp\./);
  assert.match(html, /pack--none/);
  assert.doesNotMatch(html, /pack--jti/);
});

test('a JTI product is marked as JTI', () => {
  assert.match(shelfSchematic([draft()]), /pack--jti/);
  assert.match(shelfSchematic([draft()]), />JTI</);
});

test('a strategic SKU is marked on the pack', () => {
  const html = shelfSchematic([draft({ sku: { name: 'Winston Red', is_jti: true, is_strategic: true } })]);
  assert.match(html, /pack__strategic/);
});

test('an excluded product is drawn as excluded rather than removed from the shelf', () => {
  assert.match(shelfSchematic([draft({ excluded: true })]), /block--excluded/);
});

test('an unrecognised item still gets a pack, so its price can be corrected', () => {
  const html = shelfSchematic([
    draft({ sku: null, brand_candidate: null, is_jti: false, evaluation: null, recognition_confidence: 0.3 }),
  ]);
  assert.match(html, /Unrecognised item/);
  assert.match(html, /30%/);
});

test('a detection with no confidence shows that, not a zero', () => {
  const html = shelfSchematic([draft({ recognition_confidence: null })]);
  assert.match(html, /—/);
  assert.doesNotMatch(html, /0%/);
});

test('an unreadable price is a dash, not a fabricated number', () => {
  const html = shelfSchematic([draft({ confirmed_price: null, detected_price: null })]);
  assert.match(html, /ticket__price">—/);
});

/* ------------------------------------------------------------ what it claims */

test('the schematic says it is the shelf as read, and which basis it used', () => {
  const counted = shelfSchematic([draft({ shelf: 1 })]);
  assert.match(counted, /sit on the shelf the model counted them on/);
  assert.match(counted, /drawn as many times as it counted packs/);

  const guessed = shelfSchematic([draft()]);
  assert.match(guessed, /reported no shelf numbers/);
  assert.match(guessed, /a guess about grouping, not a measurement/);
});

test('neither note claims to know where along a shelf a pack stands', () => {
  assert.match(SCHEMATIC_NOTE.shelf, /Which pack stands where along a shelf is not known/);
  assert.match(SCHEMATIC_NOTE.shelf, /nothing here measures positions from the photo/);
  // The weaker basis must not borrow the language of the stronger one.
  assert.match(SCHEMATIC_NOTE.price, /a guess about grouping, not a measurement/);
  assert.doesNotMatch(SCHEMATIC_NOTE.price, /counted/);
});

test('invented prices are called out, because a tidy shelf drawing looks authoritative', () => {
  const html = shelfSchematic([draft()], { simulatedPrices: true });
  assert.match(html, /generated these prices from the catalogue without looking at the photo/);
  assert.doesNotMatch(shelfSchematic([draft()]), /generated these prices/);
});

test('the legend is readable without seeing colour', () => {
  const html = shelfSchematic([draft()]);
  assert.match(html, /within the recommended range/);
  assert.match(html, /above the range/);
  assert.match(html, /below the range/);
  assert.match(html, /competitor observation/);
});

test('the source image is named only when there is more than one shelf to tell apart', () => {
  assert.match(shelfSchematic([draft()], { imageName: 'shelf-2.jpg' }), /From shelf-2\.jpg/);
  assert.doesNotMatch(shelfSchematic([draft()]), /From /);
});

test('an image that yielded nothing says so instead of drawing an empty cabinet', () => {
  assert.match(shelfSchematic([]), /no shelf to draw/);
});
