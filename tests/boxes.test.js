/**
 * Holding a model's coordinates against the photograph.
 *
 * The case these exist for: a vision model read a shelf photo correctly — right products,
 * right prices — and returned a tidy two-by-three lattice of identical rectangles sitting a
 * tenth of the image above the packs they claimed to mark. Every number was in range and
 * internally consistent, so no amount of geometry could tell they were invented. The pixels
 * could: the rectangles covered the flat dark inside of a cabinet.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLAT_REGION_DETAIL,
  inferBoxes,
  regionDetail,
  sampleLuminance,
  vetBoxesAgainstImage,
} from '../public/app/lib/boxes.js';

/** A luminance grid: `fill(x, y)` returns 0–255. */
function grid(width, height, fill) {
  const data = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data[y * width + x] = fill(x, y);
  }
  return { data, width, height };
}

/**
 * The upper half is the flat dark inside of a cabinet, carrying light sensor noise.
 * The lower half is a price list: a thin line of print every tenth row on white, which is
 * the shape that matters — text occupies a small share of the area it sits in.
 */
function shelfPhoto() {
  return grid(100, 100, (x, y) => {
    if (y < 50) return 16 + ((x * 7 + y * 13) % 5); // near-flat, with noise
    return y % 10 === 0 && x % 3 !== 0 ? 20 : 245; // sparse print on white
  });
}

// Stops short of the boundary: a box whose edge grazes the price list picks up that one
// row of contrast, which is real detail and should count.
const EMPTY_HALF = { x: 0, y: 0, w: 1, h: 0.45 };
const PRINTED_HALF = { x: 0, y: 0.5, w: 1, h: 0.5 };

test('a region of flat background reports no detail, and sensor noise does not rescue it', () => {
  assert.ok(regionDetail(shelfPhoto(), EMPTY_HALF) < 0.002);
});

test('a region carrying print reports detail even though print covers little of it', () => {
  // This is the case that ruled out averaging contrast: a loose box around one line of text
  // is mostly white, so its average contrast is as low as empty shelf. Edges are not.
  const photo = shelfPhoto();
  assert.ok(regionDetail(photo, PRINTED_HALF) > 0.1);
  assert.ok(regionDetail(photo, { x: 0, y: 0.5, w: 1, h: 0.3 }) > FLAT_REGION_DETAIL, 'a loose box too');
});

test('the flat threshold sits between the two, not on top of either', () => {
  const photo = shelfPhoto();
  assert.ok(regionDetail(photo, EMPTY_HALF) < FLAT_REGION_DETAIL);
  assert.ok(regionDetail(photo, PRINTED_HALF) > FLAT_REGION_DETAIL);
});

test('a region outside the image, or of no area, reports nothing rather than throwing', () => {
  const photo = shelfPhoto();
  assert.equal(regionDetail(photo, { x: 2, y: 2, w: 0.1, h: 0.1 }), 0);
  assert.equal(regionDetail(photo, { x: 0.5, y: 0.5, w: 0, h: 0 }), 0);
  assert.equal(regionDetail({ data: [], width: 0, height: 0 }, PRINTED_HALF), 0);
  assert.equal(regionDetail(null, PRINTED_HALF), 0);
});

/* ------------------------------------------------------------------- vetting */

const modelBox = (box) => ({ bounding_box: { ...box, source: 'model' } });

test('a box pointing at empty background is discarded', () => {
  const { detections, rejected } = vetBoxesAgainstImage(
    [modelBox({ x: 0.1, y: 0.05, w: 0.3, h: 0.3 }), modelBox({ x: 0.1, y: 0.6, w: 0.3, h: 0.3 })],
    shelfPhoto(),
  );
  assert.equal(rejected, 1);
  assert.equal(detections[1].bounding_box.source, 'model', 'the box over print survives');
});

test('a discarded box says why, so the screen can explain itself', () => {
  const { detections } = vetBoxesAgainstImage(
    [modelBox({ x: 0.1, y: 0.05, w: 0.3, h: 0.3 }), modelBox({ x: 0.1, y: 0.6, w: 0.3, h: 0.3 })],
    shelfPhoto(),
  );
  assert.equal(detections[0].box_rejected, 'featureless');
});

test('when every reported position is empty, the whole set falls back to reading order', () => {
  // This is the lattice-above-the-packs case: nothing the model said about position is usable.
  const { detections, rejected } = vetBoxesAgainstImage(
    [
      modelBox({ x: 0.1, y: 0.02, w: 0.3, h: 0.15 }),
      modelBox({ x: 0.5, y: 0.02, w: 0.3, h: 0.15 }),
      modelBox({ x: 0.1, y: 0.22, w: 0.3, h: 0.15 }),
    ],
    shelfPhoto(),
  );
  assert.equal(rejected, 3);
  assert.ok(detections.every((d) => d.bounding_box.source === 'inferred'));
  assert.ok(
    detections[0].bounding_box.y < detections[1].bounding_box.y,
    'the fallback keeps reading order',
  );
});

test('boxes the model got right are left exactly as they were', () => {
  const boxes = [modelBox({ x: 0.1, y: 0.55, w: 0.3, h: 0.3 }), modelBox({ x: 0.5, y: 0.6, w: 0.3, h: 0.3 })];
  const { detections, rejected } = vetBoxesAgainstImage(boxes, shelfPhoto());
  assert.equal(rejected, 0);
  assert.deepEqual(detections, boxes);
});

test('a low-contrast photo does not lose every box to the absolute floor', () => {
  // Threshold is the lesser of the floor and a quarter of the photo's own detail, so a flat,
  // dim photograph is judged against itself rather than against a studio shot.
  const dim = grid(100, 100, (x, y) => (y < 50 ? 10 : y % 25 === 0 ? 40 : 12));
  const { rejected } = vetBoxesAgainstImage([modelBox({ x: 0, y: 0.55, w: 1, h: 0.4 })], dim);
  assert.equal(rejected, 0);
});

test('an inferred layout is never second-guessed by the pixel check', () => {
  // It makes no claim about the image, so there is nothing to disprove.
  const rows = inferBoxes([{ bounding_box: null }, { bounding_box: null }]);
  const { detections, rejected } = vetBoxesAgainstImage(rows, shelfPhoto());
  assert.equal(rejected, 0);
  assert.ok(detections.every((d) => d.bounding_box.source === 'inferred'));
});

test('a position the TME placed by hand is never overruled', () => {
  const manual = [{ bounding_box: { x: 0.1, y: 0.05, w: 0.2, h: 0.1, source: 'manual' } }];
  const { detections, rejected } = vetBoxesAgainstImage(manual, shelfPhoto());
  assert.equal(rejected, 0);
  assert.equal(detections[0].bounding_box.source, 'manual');
});

test('no pixels means no judgement — the model keeps its boxes', () => {
  // A tainted canvas or a browser that blocks readback must not cost the model its positions.
  const boxes = [modelBox({ x: 0.1, y: 0.05, w: 0.3, h: 0.3 })];
  assert.deepEqual(vetBoxesAgainstImage(boxes, null), { detections: boxes, rejected: 0 });
  assert.equal(vetBoxesAgainstImage(boxes, { width: 0, height: 0 }).rejected, 0);
});

test('sampling luminance outside a browser yields nothing rather than throwing', () => {
  assert.equal(sampleLuminance({ width: 100, height: 100 }), null);
  assert.equal(sampleLuminance(null), null);
});
