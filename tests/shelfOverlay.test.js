/**
 * The shelf overlay draws recognition output over a photograph, which is the point in the
 * app where a wrong impression is cheapest to create and most expensive to catch: a
 * rectangle on a photo reads as evidence. These assert that what is drawn is labelled for
 * what it is, and that the percentage beside it says what it measures.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOX_SOURCE_LABEL,
  BOX_SOURCE_NOTE,
  boxSource,
  shelfOverlay,
} from '../public/app/ui/shelfOverlay.js';
import {
  CONFIDENCE_NOTE,
  confidenceMeter,
  confidenceTone,
  confidenceWord,
} from '../public/app/ui/dom.js';

const IMAGE = { id: 'img-1', name: 'shelf.jpg', previewUrl: 'blob:local/shelf' };

function draft(overrides = {}) {
  return {
    draft_id: 'img-1:0',
    image_id: 'img-1',
    sku: { name: 'Winston Red', is_jti: true },
    confirmed_price: 13.6,
    detected_price: 13.6,
    recognition_confidence: 0.96,
    bounding_box: { x: 0.5, y: 0.2, source: 'row' },
    excluded: false,
    ...overrides,
  };
}

/* ------------------------------------------------------------- what a marker says */

test('a marker carries the SKU, the price and the recognition percentage', () => {
  const html = shelfOverlay(IMAGE, [draft()]);
  assert.match(html, /Winston Red/);
  assert.match(html, /13\.60/);
  assert.match(html, /96%/);
});

test('a label is positioned at the price it points to, as percentages of the image', () => {
  const html = shelfOverlay(IMAGE, [draft()]);
  assert.match(html, /left:50\.00%/);
  assert.match(html, /top:20\.00%/);
  // The body sits above that point and a stem reaches down to it, so the price stays visible.
  assert.match(html, /ar__stem/);
});

test('a marker opens the correction form for its own detection', () => {
  const html = shelfOverlay(IMAGE, [draft()]);
  assert.match(html, /data-action="focus-detection"/);
  assert.match(html, /data-draft="img-1:0"/);
});

test('a marker is a button and describes itself to a screen reader', () => {
  const html = shelfOverlay(IMAGE, [draft()]);
  assert.match(html, /<button type="button"/);
  assert.match(html, /aria-label="1\. Winston Red, SGD 13\.60, recognition 96%, read clearly/);
});

test('an unrecognised detection is still drawn rather than left off the photo', () => {
  const html = shelfOverlay(IMAGE, [draft({ sku: null, brand_candidate: null, recognition_confidence: 0.3 })]);
  assert.match(html, /Unrecognised item/);
  assert.match(html, /30%/);
  assert.match(html, /ar__pin--risk/);
});

test('an excluded detection is drawn as excluded, not silently removed', () => {
  const html = shelfOverlay(IMAGE, [draft({ excluded: true })]);
  assert.match(html, /ar__pin--excluded/);
});

test('confidence sets the marker colour against the review threshold', () => {
  const at = (confidence) => shelfOverlay(IMAGE, [draft({ recognition_confidence: confidence })], { threshold: 0.75 });
  assert.match(at(0.96), /ar__pin--good/);
  assert.match(at(0.8), /ar__pin--watch/);
  assert.match(at(0.6), /ar__pin--risk/);
});

test('a detection with no position appears in the list instead, and the count says so', () => {
  const html = shelfOverlay(IMAGE, [draft(), draft({ draft_id: 'img-1:1', bounding_box: null })]);
  assert.match(html, /1 detection has no position and appear/);
});

/* ---------------------------------------------------- how the positions were arrived at */

test('the provenance of every label is always stated', () => {
  const onRow = shelfOverlay(IMAGE, [draft()]);
  assert.match(onRow, /sits above the shelf row it was read from/);
  assert.match(onRow, /can be one row out where a row is hidden/);

  const band = shelfOverlay(IMAGE, [draft({ bounding_box: { x: 0.5, y: 0.1, source: 'band' } })]);
  assert.match(band, /Approximate positions/);
  assert.match(band, /No shelf rows could be made out/);
});

test('invented prices are called out separately from where the labels sit', () => {
  // The simulator can be placed on real rows read off a real photo — which makes it more,
  // not less, important to say that the prices themselves were never read.
  const html = shelfOverlay(IMAGE, [draft()], { simulatedPrices: true });
  assert.match(html, /sits above the shelf row it was read from/);
  assert.match(html, /generated these prices from the catalogue without looking at the photo/);
  assert.doesNotMatch(shelfOverlay(IMAGE, [draft()]), /generated these prices/);
});

test('an approximate layout is never described as where anything was measured', () => {
  assert.doesNotMatch(BOX_SOURCE_NOTE.band, /reported by/i);
  assert.doesNotMatch(BOX_SOURCE_NOTE.simulated, /reported by/i);
  assert.match(BOX_SOURCE_LABEL.band, /Approximate/);
  assert.match(BOX_SOURCE_LABEL.row, /shelf row it was read from/);
});

test('the weakest provenance present decides what the picture claims', () => {
  const box = (source) => ({ bounding_box: { x: 0.5, y: 0.2, source } });
  assert.equal(boxSource([box('row')]), 'row');
  assert.equal(boxSource([box('simulated'), box('band')]), 'simulated');
  assert.equal(boxSource([box('band')]), 'band');
  assert.equal(boxSource([{ bounding_box: null }]), 'none');

  // One hand-placed label must not let the rest borrow its credibility, and one label on a
  // real shelf row must not lend its credibility to a picture that is mostly guesswork.
  assert.equal(boxSource([box('manual'), box('band')]), 'band');
  assert.equal(boxSource([box('row'), box('band')]), 'band');
  assert.equal(boxSource([box('manual'), box('row')]), 'row');
  assert.equal(boxSource([box('manual')]), 'manual');
});

/* ------------------------------------------------------ placing markers by hand */

test('a marker can be identified for dragging and says so to a screen reader', () => {
  const html = shelfOverlay(IMAGE, [draft()]);
  assert.match(html, /data-marker="img-1:0"/);
  assert.match(html, /Tap to correct, drag to place on the price/);
});

test('the label names where its own position came from, not just the picture as a whole', () => {
  const band = shelfOverlay(IMAGE, [draft({ bounding_box: { x: 0.5, y: 0.1, source: 'band' } })]);
  assert.match(band, /Approximate — reading order/);
});

test('placing mode is off until asked for, and says what to do when on', () => {
  const off = shelfOverlay(IMAGE, [draft()]);
  assert.match(off, /Move labels/);
  assert.doesNotMatch(off, /ar--placing/);

  const on = shelfOverlay(IMAGE, [draft()], { placing: true });
  assert.match(on, /ar--placing/);
  assert.match(on, /Done moving/);
  assert.match(on, /Drag any label onto the price it belongs to/);
  assert.match(on, /kept with the visit/);
});

test('a hand-placed label is drawn as such', () => {
  const html = shelfOverlay(IMAGE, [draft({ bounding_box: { x: 0.2, y: 0.3, source: 'manual' } })]);
  assert.match(html, /ar__pin--manual/);
  assert.match(html, /Placed by you/);
});

test('the legend tells the TME they can move a label that sits wrong', () => {
  assert.match(BOX_SOURCE_NOTE.row, /Drag any label/);
  assert.match(BOX_SOURCE_NOTE.band, /Drag any label/);
  assert.match(BOX_SOURCE_NOTE.manual, /saved with the visit/);
});

test('a row placement admits the one way it goes wrong', () => {
  // Prices are matched to rows by reading order, so a row hidden behind a door shifts every
  // label below it. Saying so is the difference between a guide and a false claim.
  assert.match(BOX_SOURCE_NOTE.row, /matched to them in the order the model read them/);
  assert.match(BOX_SOURCE_NOTE.row, /one row out/);
});

test('every provenance has a note and a short label — none can render as undefined', () => {
  for (const key of ['row', 'band', 'model', 'inferred', 'simulated', 'manual', 'none']) {
    assert.ok(BOX_SOURCE_NOTE[key], `${key} has a note`);
    assert.ok(BOX_SOURCE_LABEL[key], `${key} has a label`);
  }
});

/* ------------------------------------------------------------------- the legend */

test('the legend explains the percentage rather than leaving it bare', () => {
  const html = shelfOverlay(IMAGE, [draft()]);
  assert.match(html, /read both the product name and the price/);
  assert.match(html, /says nothing about whether the price itself is good or bad/);
});

test('the colour key is readable without seeing colour', () => {
  const html = shelfOverlay(IMAGE, [draft()]);
  assert.match(html, /90%\+ read clearly/);
  assert.match(html, /75–89% read with doubt/);
  assert.match(html, /under 75% needs confirming/);
});

test('an image no longer on the device says so instead of rendering an empty frame', () => {
  const html = shelfOverlay({ id: 'img-1', name: 'shelf.jpg', previewUrl: null }, [draft()]);
  assert.match(html, /cannot be\s+annotated/);
  assert.doesNotMatch(html, /<img/);
});

test('full screen drops the legend but keeps the way out', () => {
  const html = shelfOverlay(IMAGE, [draft()], { fullscreen: true });
  assert.match(html, /ar--full/);
  assert.match(html, /Close/);
  assert.doesNotMatch(html, /ar__legend/);
});

/* -------------------------------------------------------- the confidence readout */

test('the confidence readout names what it measures', () => {
  // Shown bare beside a status pill, "96%" reads as a share of something commercial.
  const html = confidenceMeter(0.96, 0.75);
  assert.match(html, /Recognition/);
  assert.match(html, /96%/);
  assert.match(html, /read clearly/);
});

test('the reading never depends on colour alone', () => {
  assert.equal(confidenceWord(0.96, 0.75), 'read clearly');
  assert.equal(confidenceWord(0.8, 0.75), 'read with doubt');
  assert.equal(confidenceWord(0.6, 0.75), 'needs confirming');
  assert.equal(confidenceWord(null), 'not recognised');
});

test('the word turns at the same threshold that triggers Review Required', async () => {
  const { DEFAULT_CONFIG } = await import('../public/app/config.js');
  const threshold = DEFAULT_CONFIG.confidence_review_threshold;
  assert.equal(confidenceTone(threshold, threshold), 'watch');
  assert.equal(confidenceTone(threshold - 0.01, threshold), 'risk');
  assert.equal(confidenceWord(threshold - 0.01, threshold), 'needs confirming');
});

test('a missing confidence is stated, not shown as zero', () => {
  const html = confidenceMeter(null);
  assert.match(html, /not recognised/);
  assert.doesNotMatch(html, /0%/);
});

test('the explanation of the percentage is one sentence any TME can act on', () => {
  assert.match(CONFIDENCE_NOTE, /product name and the price/);
  assert.ok(CONFIDENCE_NOTE.length < 260);
});
