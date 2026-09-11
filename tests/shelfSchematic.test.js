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
  SCHEMATIC_NOTE,
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
    ...overrides,
  };
}

/* ------------------------------------------------------------------- rails */

test('facings sharing a price make one rail, because one rail carries one price', () => {
  const rails = groupIntoRails([
    draft({ draft_id: 'a', confirmed_price: 18.3 }),
    draft({ draft_id: 'b', confirmed_price: 18.3 }),
    draft({ draft_id: 'c', confirmed_price: 16 }),
  ]);
  assert.equal(rails.length, 2);
  assert.deepEqual(rails.map((r) => r.facings.length), [2, 1]);
  assert.deepEqual(rails.map((r) => r.price), [18.3, 16]);
});

test('a price that recurs after a different one starts a new rail', () => {
  // Two shelves can carry the same price; a consecutive run, not an equal value, is a rail.
  const rails = groupIntoRails([
    draft({ confirmed_price: 16 }),
    draft({ confirmed_price: 14.6 }),
    draft({ confirmed_price: 16 }),
  ]);
  assert.equal(rails.length, 3);
});

test('a corrected price regroups the shelf, since the confirmed price is what counts', () => {
  const rails = groupIntoRails([
    draft({ detected_price: 18.3, confirmed_price: 16 }),
    draft({ detected_price: 16, confirmed_price: 16 }),
  ]);
  assert.equal(rails.length, 1);
  assert.equal(rails[0].price, 16);
});

test('grouping nothing is not an error', () => {
  assert.deepEqual(groupIntoRails([]), []);
  assert.deepEqual(groupIntoRails(null), []);
});

/* --------------------------------------------------------------- the shelf */

test('every facing carries its SKU, its price and how well it was read', () => {
  const html = shelfSchematic([draft()]);
  assert.match(html, /Winston Red/);
  assert.match(html, /13\.60/);
  assert.match(html, /96%/);
});

test('the rail is labelled with its price and how many facings sit on it', () => {
  const html = shelfSchematic([
    draft({ draft_id: 'a', confirmed_price: 18.3 }),
    draft({ draft_id: 'b', confirmed_price: 18.3 }),
  ]);
  assert.match(html, /Rail 1/);
  assert.match(html, /SGD 18\.30/);
  assert.match(html, /2 facings/);
});

test('one facing is not described as several', () => {
  assert.match(shelfSchematic([draft()]), /1 facing[^s]/);
});

test('a facing opens its own detection for correction', () => {
  const html = shelfSchematic([draft({ draft_id: 'img-1:3' })]);
  assert.match(html, /data-action="focus-detection"/);
  assert.match(html, /data-draft="img-1:3"/);
});

test('a facing is a button and describes itself to a screen reader', () => {
  const html = shelfSchematic([draft()]);
  assert.match(html, /<button type="button"/);
  assert.match(
    html,
    /aria-label="Winston Red, SGD 13\.60, JTI, Within Recommended Range, recognition 96%, read clearly\. Open to correct\."/,
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

test('a competitor facing is marked as one and carries no price-position judgement', () => {
  const html = shelfSchematic([
    draft({ sku: { name: 'Marlboro Red', is_jti: false }, is_jti: false, evaluation: null }),
  ]);
  assert.match(html, /Comp\./);
  assert.match(html, /pack--none/);
  assert.doesNotMatch(html, /pack--jti/);
});

test('a JTI facing is marked as JTI', () => {
  assert.match(shelfSchematic([draft()]), /pack--jti/);
  assert.match(shelfSchematic([draft()]), />JTI</);
});

test('a strategic SKU is marked on the pack', () => {
  const html = shelfSchematic([draft({ sku: { name: 'Winston Red', is_jti: true, is_strategic: true } })]);
  assert.match(html, /pack__strategic/);
});

test('an excluded facing is drawn as excluded rather than removed from the shelf', () => {
  assert.match(shelfSchematic([draft({ excluded: true })]), /facing--excluded/);
});

test('an unrecognised item still gets a facing, so its price can be corrected', () => {
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

test('the schematic says it is the shelf as read, not a plan of the real one', () => {
  const html = shelfSchematic([draft()]);
  assert.match(html, /shelf as read, not a plan of the real one/);
  assert.match(html, /Positions are not measured from the photo/);
});

test('the note never claims to know that two packs are physically adjacent', () => {
  assert.doesNotMatch(SCHEMATIC_NOTE, /next to|adjacent|position on the shelf/i);
  assert.match(SCHEMATIC_NOTE, /grouped by shared price/);
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
