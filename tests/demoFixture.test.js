/**
 * The built-in demo samples, and saying out loud what read them.
 *
 * Two separate defects, with one cause between them: a demonstration whose content was
 * invented per image seed, and no statement anywhere of whether a model had looked at the
 * photo at all.
 *
 * The Punggol sample used to come back with Winston Red but not Pall Mall Red — Winston Red's
 * own primary mapping — so the screen built to compare the two had nothing to compare, and
 * the price gap and Price Index were blank on the one slide the demo exists for. Generated
 * content is plausible; it is not coherent, and a comparison needs both halves.
 *
 * The second is worse. Simulated detections and model-read detections are indistinguishable
 * once they reach the results screen: same prices, same confidence bars, same shelf. An
 * audience watching a demo has no way to tell which they are being shown, so the mode has to
 * be stated before anybody presses Process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_FIXTURES, DEMO_IMAGES, demoFixtureFor } from '../public/app/demoImages.js';
import { fixtureDetections, mockRecognitionProvider } from '../public/app/services/recognition/mockProvider.js';
import {
  describeRecognitionMode,
  registerProvider,
  setActiveProvider,
} from '../public/app/services/recognition/provider.js';
import { buildSeedData } from '../public/app/seed.js';

const data = buildSeedData('2026-09-14T10:00:00.000Z');
const brands = new Map(data.brands.map((b) => [b.id, b]));
const skus = data.skus.map((s) => ({ ...s, brand_name: brands.get(s.brand_id)?.name ?? '' }));
const punggol = { id: 'img-1', name: 'shelf-punggol-central.jpg', size: 1024 };

/* -------------------------------------------------- the fixtures themselves */

test('every built-in sample image has an agreed fixture', () => {
  for (const sample of DEMO_IMAGES) {
    assert.ok(DEMO_FIXTURES[sample.file], `no fixture for ${sample.file}`);
  }
});

test('every SKU a fixture names exists in the catalogue', () => {
  const known = new Set(data.skus.map((s) => s.id));
  for (const [file, fixture] of Object.entries(DEMO_FIXTURES)) {
    for (const detection of fixture.detections) {
      assert.ok(known.has(detection.sku_id), `${file} names unknown SKU ${detection.sku_id}`);
      for (const alt of detection.alternatives ?? []) {
        assert.ok(known.has(alt.sku_id), `${file} names unknown alternative ${alt.sku_id}`);
      }
    }
  }
});

test('a photo the TME supplied has no fixture and falls through to the simulator', () => {
  assert.equal(demoFixtureFor({ name: 'IMG_4821.HEIC' }), null);
  assert.equal(fixtureDetections({ name: 'IMG_4821.HEIC' }, skus), null);
});

/* ------------------------------------------------ the defect this was for */

test('the Punggol sample contains the mapped competitor for its strategic SKU', async () => {
  const detections = await mockRecognitionProvider.analyzePriceImage(punggol, {
    outlet: data.outlets.find((o) => o.id === 'out-e1'),
    jtiSkus: skus.filter((s) => s.is_jti),
    competitorSkus: skus.filter((s) => !s.is_jti),
    priceRules: data.price_rules,
    competitorMappings: data.competitor_mappings,
    observedAt: '2026-09-14T10:00:00.000Z',
  });

  const ids = detections.map((d) => d.sku_candidate);
  assert.ok(ids.includes('sku-jti-winston-red'), 'the strategic SKU is missing');

  // Winston Red's primary mapping, by mapping_priority, is Pall Mall Red. Without it on the
  // same shelf there is no price gap and no Price Index — the blank demo screen.
  const primary = data.competitor_mappings
    .filter((m) => m.jti_sku_id === 'sku-jti-winston-red' && m.active !== false)
    .sort((a, b) => b.mapping_priority - a.mapping_priority)[0];
  assert.equal(primary.competitor_sku_id, 'sku-bat-pallmall-red');
  assert.ok(ids.includes(primary.competitor_sku_id), 'the mapped competitor is missing');
});

test('the fixture arithmetic lands outside the configured corridor, so there is something to show', () => {
  const byId = Object.fromEntries(
    DEMO_FIXTURES['shelf-punggol-central.jpg'].detections.map((d) => [d.sku_id, d]),
  );
  const jti = byId['sku-jti-winston-red'].price;
  const competitor = byId['sku-bat-pallmall-red'].price;
  const mapping = data.competitor_mappings.find((m) => m.id === 'cm-1');

  const gap = Number((jti - competitor).toFixed(2));
  const index = Number(((jti / competitor) * 100).toFixed(1));

  assert.equal(gap, 0.7);
  assert.equal(index, 105.2);
  assert.ok(gap > mapping.desired_gap_max, 'the gap should sit outside the intended corridor');
  assert.ok(index > mapping.desired_price_index_max, 'the index should sit outside its band');
});

test('the same sample returns the same detections every time', async () => {
  const context = {
    outlet: data.outlets.find((o) => o.id === 'out-e1'),
    jtiSkus: skus.filter((s) => s.is_jti),
    competitorSkus: skus.filter((s) => !s.is_jti),
    priceRules: data.price_rules,
    competitorMappings: data.competitor_mappings,
    observedAt: '2026-09-14T10:00:00.000Z',
  };
  const first = await mockRecognitionProvider.analyzePriceImage(punggol, context);
  // A different image id and size, which is what the seed is built from: a generated result
  // would differ, a fixture must not.
  const second = await mockRecognitionProvider.analyzePriceImage(
    { id: 'img-99', name: 'shelf-punggol-central.jpg', size: 99999 },
    context,
  );
  assert.deepEqual(first, second);
});

test('a fixture carries the uncertain reading with its named alternative', () => {
  const detections = fixtureDetections(punggol, skus);
  const mevius = detections.find((d) => d.sku_candidate === 'sku-jti-mevius-original');
  assert.ok(mevius.confidence < 0.7, 'the uncertain reading should be uncertain');
  assert.deepEqual(mevius.alternatives, [
    { sku_id: 'sku-jti-mevius-sky', label: 'Mevius Sky Blue', confidence: 0.34 },
  ]);
});

test('a fixture counts facings and shelves, so the schematic has a shelf to draw', () => {
  const detections = fixtureDetections(punggol, skus);
  assert.ok(detections.every((d) => Number.isInteger(d.facings) && d.facings >= 1));
  assert.deepEqual([...new Set(detections.map((d) => d.shelf))].sort(), [1, 2]);
  assert.equal(detections.reduce((n, d) => n + d.facings, 0), 8);
});

test('a fixture is marked as fixture content rather than passed off as a reading', () => {
  assert.ok(fixtureDetections(punggol, skus).every((d) => d.fixture === true));
});

test('a catalogue with none of the fixture SKUs falls back rather than inventing them', () => {
  assert.equal(fixtureDetections(punggol, []), null);
});

test('a catalogue missing one fixture SKU drops that entry and keeps the rest', () => {
  const without = skus.filter((s) => s.id !== 'sku-bat-pallmall-red');
  const ids = fixtureDetections(punggol, without).map((d) => d.sku_candidate);
  assert.ok(!ids.includes('sku-bat-pallmall-red'));
  assert.ok(ids.includes('sku-jti-winston-red'));
});

/* ------------------------------------------------------- recognition mode */

const realProvider = {
  id: 'test-vision',
  label: 'Test Vision Model',
  kind: 'vision',
  reads_image: true,
  async analyzePriceImage() {
    return [];
  },
};

test('the simulator is named as simulated, before anything is processed', () => {
  registerProvider(mockRecognitionProvider);
  setActiveProvider(mockRecognitionProvider.id);

  const mode = describeRecognitionMode([{ name: 'IMG_4821.HEIC' }], () => false);
  assert.equal(mode.mode, 'simulated');
  assert.match(mode.label, /Demo recognition — simulated/);
  assert.match(mode.detail, /not read/);
});

test('a built-in sample is named as agreed demo content', () => {
  setActiveProvider(mockRecognitionProvider.id);
  const mode = describeRecognitionMode([punggol], (image) => Boolean(demoFixtureFor(image)));
  assert.equal(mode.mode, 'fixture');
  assert.match(mode.detail, /agreed demo content/);
});

test('a mixed batch says how many of the images are samples', () => {
  setActiveProvider(mockRecognitionProvider.id);
  const mode = describeRecognitionMode(
    [punggol, { name: 'IMG_4821.HEIC' }],
    (image) => Boolean(demoFixtureFor(image)),
  );
  assert.match(mode.detail, /1 of 2 images/);
});

test('a real model is named, and says it will fail rather than fall back', () => {
  registerProvider(realProvider);
  setActiveProvider(realProvider.id);

  const mode = describeRecognitionMode([punggol], (image) => Boolean(demoFixtureFor(image)));
  assert.equal(mode.mode, 'real');
  assert.equal(mode.label, 'Real recognition — Test Vision Model');
  assert.match(mode.detail, /rather than falling back/);

  // A fixture must never relabel a real model's run as demo content.
  assert.notEqual(mode.mode, 'fixture');

  setActiveProvider(mockRecognitionProvider.id);
});
