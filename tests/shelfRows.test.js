/**
 * Finding the price rails in a photograph, so a label can sit above the price it was read
 * from rather than where a model guessed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorDetections,
  anchorOf,
  detectPriceRows,
  groupByPrice,
  prominence,
  rowStrokeProfile,
  smooth,
} from '../public/app/lib/shelfRows.js';

/**
 * A cabinet, in luminance: three shelves, each a band of packs with a thin rail of price
 * tickets under it, and flat background elsewhere.
 *
 * The packs matter as much as the rails. They carry warning imagery and are busy over a
 * broad band, which is exactly what drowns a rail in a raw projection — the reason the
 * profile is measured against its own local floor.
 */
function cabinet({ height = 200, width = 200, rails = [40, 90, 140] } = {}) {
  const data = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const onRail = rails.some((r) => Math.abs(y - r) <= 2);
      const onPack = rails.some((r) => y < r - 4 && y > r - 30);

      let value = 120; // flat background
      if (onRail) value = x % 3 === 0 ? 235 : 30; // dense print: strokes every 3px
      else if (onPack) value = x % 11 === 0 ? 200 : 60; // busy, but coarser
      data[y * width + x] = value;
    }
  }
  return { data, width, height };
}

test('a line of print shows up as a spike of vertical strokes', () => {
  const profile = rowStrokeProfile(cabinet());
  assert.ok(profile[40] > 0.5, 'the rail row is dense with strokes');
  assert.ok(profile[20] < profile[40] / 2, 'the packshot band is busy, but much less so');
  assert.equal(profile[55], 0, 'flat background between a rail and the next pack has none');
});

test('smoothing keeps the length and averages the neighbourhood', () => {
  assert.deepEqual(smooth([0, 0, 3, 0, 0], 0), [0, 0, 3, 0, 0]);
  assert.equal(smooth([0, 0, 3, 0, 0], 1).length, 5);
  assert.equal(smooth([0, 0, 3, 0, 0], 1)[2], 1);
});

test('the rails are found, one per shelf, in order down the image', () => {
  const rows = detectPriceRows(cabinet());
  assert.equal(rows.length, 3, `expected three rails, got ${JSON.stringify(rows)}`);
  for (const [i, expected] of [0.2, 0.45, 0.7].entries()) {
    assert.ok(
      Math.abs(rows[i].y - expected) < 0.03,
      `rail ${i} at ${rows[i].y} should be near ${expected}`,
    );
  }
});

test('a busy packshot does not masquerade as a price rail', () => {
  // Packs occupy far more of the image than the rails do; if the broad band won, every
  // label would sit on the wrong part of the shelf.
  const rows = detectPriceRows(cabinet());
  assert.ok(rows.every((r) => [0.2, 0.45, 0.7].some((e) => Math.abs(r.y - e) < 0.05)));
});

test('one rail yields one row, not a cluster', () => {
  const rows = detectPriceRows(cabinet({ height: 400, rails: [80, 180, 280] }));
  assert.equal(rows.length, 3);
});

test('a photo with nothing rail-like in it reports no rows rather than inventing them', () => {
  const flat = { data: new Uint8ClampedArray(200 * 200).fill(120), width: 200, height: 200 };
  assert.deepEqual(detectPriceRows(flat), []);
  assert.deepEqual(detectPriceRows({ width: 0, height: 0 }), []);
  assert.deepEqual(detectPriceRows(null), []);
});

/* -------------------------------------------------------------- anchoring */

const detection = (price, name) => ({
  draft_id: `d-${name}`,
  sku: { name },
  confirmed_price: price,
  detected_price: price,
});

test('facings sharing a price are treated as one shelf rail', () => {
  const groups = groupByPrice([
    detection(18.3, 'a'),
    detection(18.3, 'b'),
    detection(16, 'c'),
    detection(16, 'd'),
    detection(16, 'e'),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.items.length), [2, 3]);
  assert.deepEqual(groups.map((g) => g.price), [18.3, 16]);
});

test('a price that recurs after a different one starts a new group', () => {
  // Two shelves can carry the same price; consecutive runs, not equal values, mean a rail.
  const groups = groupByPrice([detection(16, 'a'), detection(14.6, 'b'), detection(16, 'c')]);
  assert.equal(groups.length, 3);
});

test('price groups land on the detected rails, top group on the top rail', () => {
  const rows = [{ y: 0.2 }, { y: 0.45 }, { y: 0.7 }];
  const placed = anchorDetections(
    [detection(18.3, 'a'), detection(18.3, 'b'), detection(16, 'c')],
    rows,
  );
  assert.equal(placed[0].bounding_box.y, 0.2);
  assert.equal(placed[1].bounding_box.y, 0.2);
  assert.equal(placed[2].bounding_box.y, 0.45);
  assert.ok(placed.every((p) => p.bounding_box.source === 'row'));
});

test('facings on one rail are spread across it in the order they were read', () => {
  const placed = anchorDetections([detection(18.3, 'a'), detection(18.3, 'b')], [{ y: 0.2 }]);
  assert.ok(placed[0].bounding_box.x < placed[1].bounding_box.x);
  assert.ok(placed.every((p) => p.bounding_box.x >= 0.1 && p.bounding_box.x <= 0.9));
});

test('too few rails for the groups means even spacing, honestly labelled', () => {
  const placed = anchorDetections([detection(18.3, 'a'), detection(16, 'b')], [{ y: 0.2 }]);
  assert.ok(placed.every((p) => p.bounding_box.source === 'band'));
  assert.ok(placed[0].bounding_box.y < placed[1].bounding_box.y, 'still in reading order');
});

test('no rails at all still produces a usable, clearly approximate layout', () => {
  const placed = anchorDetections([detection(18.3, 'a'), detection(16, 'b')], []);
  assert.deepEqual(placed.map((p) => p.bounding_box.source), ['band', 'band']);
});

test('a marker the TME placed by hand is never moved', () => {
  const manual = {
    ...detection(18.3, 'a'),
    bounding_box: { x: 0.4, y: 0.6, source: 'manual' },
  };
  const placed = anchorDetections([manual, detection(16, 'b')], [{ y: 0.2 }, { y: 0.45 }]);
  assert.deepEqual(placed[0].bounding_box, { x: 0.4, y: 0.6, source: 'manual' });
  assert.equal(placed[1].bounding_box.source, 'row');
});

test('a rail with one price alternates side to side, so stacked labels do not cover each other', () => {
  // Rails are closer together than a label is tall. Centring every one of them was what made
  // the top label unclickable, with its neighbour sitting on top of it.
  const rows = [{ y: 0.2 }, { y: 0.4 }, { y: 0.6 }, { y: 0.8 }];
  const placed = anchorDetections(
    [detection(18.3, 'a'), detection(16, 'b'), detection(14.6, 'c'), detection(12.9, 'd')],
    rows,
  );
  const xs = placed.map((p) => p.bounding_box.x);
  assert.deepEqual(xs, [0.3, 0.7, 0.3, 0.7]);
  for (let i = 1; i < xs.length; i += 1) {
    assert.notEqual(xs[i], xs[i - 1], 'neighbouring rows never share a column');
  }
});

test('anchoring an empty set of detections is not an error', () => {
  assert.deepEqual(anchorDetections([], [{ y: 0.2 }]), []);
  assert.deepEqual(anchorDetections(null, []), []);
});

/* ----------------------------------------------------------------- anchors */

test('a rectangle is aimed at from the middle of its top edge', () => {
  // That is where a label sitting above it would point.
  assert.deepEqual(anchorOf({ x: 0.2, y: 0.4, w: 0.4, h: 0.1, source: 'model' }), {
    x: 0.4,
    y: 0.4,
    source: 'model',
  });
});

test('a point is its own anchor', () => {
  assert.deepEqual(anchorOf({ x: 0.5, y: 0.3, source: 'row' }), { x: 0.5, y: 0.3, source: 'row' });
  assert.equal(anchorOf(null), null);
});
