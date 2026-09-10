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
    bounding_box: { x: 0.05, y: 0.2, w: 0.9, h: 0.08, source: 'model' },
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

test('a marker is positioned from its box as percentages of the image', () => {
  const html = shelfOverlay(IMAGE, [draft()]);
  assert.match(html, /left:5%/);
  assert.match(html, /top:20%/);
  assert.match(html, /width:90%/);
  assert.match(html, /height:8%/);
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
  assert.match(html, /ar__box--risk/);
});

test('an excluded detection is drawn as excluded, not silently removed', () => {
  const html = shelfOverlay(IMAGE, [draft({ excluded: true })]);
  assert.match(html, /ar__box--excluded/);
});

test('confidence sets the marker colour against the review threshold', () => {
  const at = (confidence) => shelfOverlay(IMAGE, [draft({ recognition_confidence: confidence })], { threshold: 0.75 });
  assert.match(at(0.96), /ar__box--good/);
  assert.match(at(0.8), /ar__box--watch/);
  assert.match(at(0.6), /ar__box--risk/);
});

test('a detection with no position appears in the list instead, and the count says so', () => {
  const html = shelfOverlay(IMAGE, [draft(), draft({ draft_id: 'img-1:1', bounding_box: null })]);
  assert.match(html, /1 detection has no position and appear/);
});

/* ---------------------------------------------------- how the positions were arrived at */

test('the provenance of the rectangles is always stated', () => {
  const model = shelfOverlay(IMAGE, [draft()]);
  assert.match(model, /Positions reported by the recognition model/);

  const inferred = shelfOverlay(IMAGE, [
    draft({ bounding_box: { x: 0.03, y: 0.1, w: 0.94, h: 0.2, source: 'inferred' } }),
  ]);
  assert.match(inferred, /Approximate positions/);
  assert.match(inferred, /did not report where each one sits/);

  const simulated = shelfOverlay(IMAGE, [
    draft({ bounding_box: { x: 0.03, y: 0.1, w: 0.94, h: 0.2, source: 'simulated' } }),
  ]);
  assert.match(simulated, /Simulated positions/);
  assert.match(simulated, /does not look at the image/);
});

test('an inferred layout is never described as where the model looked', () => {
  assert.doesNotMatch(BOX_SOURCE_NOTE.inferred, /reported by/i);
  assert.doesNotMatch(BOX_SOURCE_NOTE.simulated, /reported by/i);
  assert.match(BOX_SOURCE_LABEL.inferred, /Approximate/);
  assert.match(BOX_SOURCE_LABEL.simulated, /Simulated/);
});

test('the weakest provenance present decides what the picture claims', () => {
  const box = (source) => ({ bounding_box: { x: 0, y: 0, w: 1, h: 0.1, source } });
  assert.equal(boxSource([box('model')]), 'model');
  assert.equal(boxSource([box('simulated'), box('inferred')]), 'simulated');
  assert.equal(boxSource([box('inferred')]), 'inferred');
  assert.equal(boxSource([{ bounding_box: null }]), 'none');
});

test('every provenance has a note and a short label — none can render as undefined', () => {
  for (const key of ['model', 'inferred', 'simulated', 'none']) {
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
