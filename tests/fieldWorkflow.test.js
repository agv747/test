import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, PRICE_POSITION_STATUS } from '../public/app/config.js';
import { buildSeedData } from '../public/app/seed.js';
import { registerProvider, listProviders, setActiveProvider } from '../public/app/services/recognition/provider.js';
import { mockRecognitionProvider } from '../public/app/services/recognition/mockProvider.js';
import {
  correctDraft,
  processVisitImages,
  recomputeDrafts,
  summariseVisit,
  toPersistableObservation,
} from '../public/app/services/visitService.js';
import { assessImageQuality, isSupportedImage } from '../public/app/services/imageService.js';
import { RANGE_BUCKET } from '../public/app/services/pricePositionService.js';

registerProvider(mockRecognitionProvider);
setActiveProvider(mockRecognitionProvider.id);

const NOW = '2026-09-09T12:00:00.000Z';
const config = defaultConfig();
const data = buildSeedData(NOW);
const outlet = data.outlets.find((o) => o.id === 'out-e1'); // Punggol, per the demo script
const visit = { id: 'vis-test', outlet_id: outlet.id, user_id: 'usr-tme-1' };
const image = {
  id: 'img-test-1',
  name: 'shelf-punggol.jpg',
  size: 2_400_000,
  type: 'image/jpeg',
  image_source: 'gallery',
};

async function drafts(img = image) {
  return processVisitImages({ visit, outlet, images: [img], data, config, observedAt: NOW });
}

test('provider abstraction exposes the registered MVP simulator', () => {
  const providers = listProviders();
  assert.ok(providers.some((p) => p.id === 'mock-simulator'));
  assert.throws(() => setActiveProvider('does-not-exist'), /Unknown recognition provider/);
  setActiveProvider('mock-simulator');
});

test('recognition returns SKU and price candidates with confidence', async () => {
  const result = await drafts();
  assert.ok(result.length >= 4);
  for (const d of result) {
    assert.ok(d.sku_id, 'SKU candidate present');
    assert.ok(Number.isFinite(d.detected_price), 'price candidate present');
    assert.ok(d.recognition_confidence > 0 && d.recognition_confidence <= 1);
    assert.equal(d.confirmed_price, d.detected_price, 'confirmed defaults to detected');
    assert.equal(d.manual_correction, false);
    assert.ok(d.raw_text);
  }
});

test('recognition is deterministic for the same image', async () => {
  const a = await drafts();
  const b = await drafts();
  assert.deepEqual(
    a.map((d) => [d.sku_id, d.confirmed_price, d.recognition_confidence]),
    b.map((d) => [d.sku_id, d.confirmed_price, d.recognition_confidence]),
  );
});

test('different images produce different detections', async () => {
  const a = await drafts();
  const b = await drafts({ ...image, id: 'img-test-2', name: 'other-shelf.jpg', size: 1_100_000 });
  assert.notDeepEqual(a.map((d) => d.confirmed_price), b.map((d) => d.confirmed_price));
});

test('JTI drafts carry the effective rule snapshot resolved at observation time', async () => {
  const result = await drafts();
  const jti = result.filter((d) => d.is_jti);
  assert.ok(jti.length >= 3);
  for (const d of jti) {
    assert.ok(d.price_rule_id, 'rule resolved');
    assert.ok(Number.isFinite(d.recommended_price_snapshot));
    assert.ok(Number.isFinite(d.recommended_min_snapshot));
    assert.ok(Number.isFinite(d.recommended_max_snapshot));
  }
});

test('drafts are evaluated against range and mapped competitor in-session', async () => {
  const result = await drafts();
  const jti = result.filter((d) => d.is_jti);
  assert.ok(jti.every((d) => d.evaluation));
  const compared = jti.filter((d) => d.competitor_price !== null);
  assert.ok(compared.length >= 1, 'at least one live competitor comparison in the visit');
  for (const d of compared) {
    assert.equal(d.price_gap, Math.round((d.confirmed_price - d.competitor_price) * 100) / 100);
    assert.ok(d.price_index > 0);
  }
});

test('the demo image yields the full status mix the script needs (§30)', async () => {
  const result = await drafts();
  const jti = result.filter((d) => d.is_jti);
  const buckets = new Set(jti.map((d) => d.evaluation.rangeBucket));
  const statuses = new Set(jti.map((d) => d.evaluation.status));
  assert.ok(buckets.has(RANGE_BUCKET.WITHIN), 'one Within Recommended Range');
  assert.ok(buckets.has(RANGE_BUCKET.ABOVE), 'one Above Recommended Range');
  assert.ok(statuses.has(PRICE_POSITION_STATUS.AT_RISK), 'one Competitive Position At Risk');
  assert.ok(statuses.has(PRICE_POSITION_STATUS.REVIEW), 'one Review Required (low confidence)');
});

test('every draft carries a field recommendation and none prescribes an amount', async () => {
  const result = await drafts();
  for (const d of result.filter((x) => x.is_jti)) {
    assert.ok(d.recommendation);
    assert.doesNotMatch(d.recommendation, /\d/);
  }
});

test('manual correction stores both the detection and the confirmed value (§8.7)', async () => {
  const result = await drafts();
  const target = result.find((d) => d.is_jti);
  const corrected = correctDraft(target, { confirmed_price: 15.55 }, data, config, NOW);
  assert.equal(corrected.detected_price, target.detected_price, 'original detection preserved');
  assert.equal(corrected.confirmed_price, 15.55);
  assert.equal(corrected.manual_correction, true);
  assert.equal(corrected.detected_sku_id, target.detected_sku_id);
});

test('correcting the SKU re-resolves the rule and mapping snapshots', async () => {
  const result = await drafts();
  const target = result.find((d) => d.is_jti && d.sku_id !== 'sku-jti-mevius-original');
  const corrected = correctDraft(target, { sku_id: 'sku-jti-mevius-original' }, data, config, NOW);
  assert.equal(corrected.sku_id, 'sku-jti-mevius-original');
  assert.equal(corrected.detected_sku_id, target.detected_sku_id, 'original detection preserved');
  assert.equal(corrected.manual_correction, true);
  // Punggol is in the East, where the territory override sets 14.50.
  assert.equal(corrected.recommended_price_snapshot, 14.5);
});

test('a correction changes the evaluation after recompute', async () => {
  const result = await drafts();
  const target = result.find((d) => d.is_jti && d.evaluation.rangeBucket === RANGE_BUCKET.WITHIN);
  const corrected = correctDraft(target, { confirmed_price: 20 }, data, config, NOW);
  const recomputed = recomputeDrafts(
    result.map((d) => (d.draft_id === corrected.draft_id ? corrected : d)),
    config,
  );
  const updated = recomputed.find((d) => d.draft_id === corrected.draft_id);
  assert.equal(updated.evaluation.rangeBucket, RANGE_BUCKET.ABOVE);
});

test('visit summary counts each position bucket', async () => {
  const result = await drafts();
  const summary = summariseVisit(result, [image]);
  assert.equal(summary.images_processed, 1);
  assert.equal(
    summary.jti_observations + summary.competitor_observations,
    result.filter((d) => !d.excluded).length,
  );
  assert.ok(summary.within_range + summary.above_range + summary.below_range <= summary.jti_observations);
  assert.ok(summary.review_required >= 1);
});

test('drafts strip UI-only fields before persistence', async () => {
  const result = await drafts();
  const persistable = toPersistableObservation(result[0]);
  assert.equal(persistable.evaluation, undefined);
  assert.equal(persistable.sku, undefined);
  assert.equal(persistable.draft_id, undefined);
  assert.ok(persistable.sku_id);
  assert.ok(persistable.observed_at);
  assert.equal(persistable.detected_price !== undefined, true);
  assert.equal(persistable.confirmed_price !== undefined, true);
});

test('multiple images in one visit are all processed', async () => {
  const many = await processVisitImages({
    visit,
    outlet,
    images: [image, { ...image, id: 'img-test-3', name: 'b.jpg', size: 900_000 }],
    data,
    config,
    observedAt: NOW,
  });
  const imageIds = new Set(many.map((d) => d.image_id));
  assert.equal(imageIds.size, 2);
});

test('gallery and camera sources are both carried through to observations', async () => {
  const gallery = await drafts({ ...image, image_source: 'gallery' });
  const camera = await drafts({ ...image, id: 'img-cam', image_source: 'camera' });
  assert.ok(gallery.every((d) => d.image_source === 'gallery'));
  assert.ok(camera.every((d) => d.image_source === 'camera'));
});

test('supported image formats include JPG, PNG and HEIC', () => {
  assert.equal(isSupportedImage({ name: 'a.jpg', type: 'image/jpeg' }), true);
  assert.equal(isSupportedImage({ name: 'a.png', type: 'image/png' }), true);
  assert.equal(isSupportedImage({ name: 'a.HEIC', type: '' }), true);
  assert.equal(isSupportedImage({ name: 'a.pdf', type: 'application/pdf' }), false);
});

test('image quality validation rejects unsupported and undersized files', () => {
  const q = config.image_quality;
  const unsupported = assessImageQuality({ name: 'doc.pdf', type: 'application/pdf', size: 1e6 }, q);
  assert.equal(unsupported.status, 'Unsupported Image');
  assert.equal(unsupported.usable, false);
  assert.equal(unsupported.canContinue, false);

  const tiny = assessImageQuality(
    { name: 'thumb.jpg', type: 'image/jpeg', size: 8000, width: 200, height: 200 },
    q,
  );
  assert.equal(tiny.status, 'Low Resolution');
  assert.equal(tiny.usable, false);
  assert.equal(tiny.canContinue, true, 'TME may continue anyway when configured');
  assert.ok(tiny.reasons.length > 0);
});

test('a good photo passes quality validation', () => {
  const good = assessImageQuality(
    { name: 'shelf-punggol.jpg', type: 'image/jpeg', size: 2_400_000, width: 3024, height: 4032 },
    config.image_quality,
  );
  assert.equal(good.usable, true);
  assert.ok(['Good', 'Multiple Ambiguous Labels'].includes(good.status));
});
