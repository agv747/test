import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrompt,
  extractJson,
  inferBoxes,
  matchSku,
  normalise,
  parseBox,
  parseModelResponse,
  parsePrice,
} from '../shared/recognition.js';

const SKUS = [
  { id: 'sku-jti-winston-red', name: 'Winston Red', brand_name: 'Winston', sku_code: 'WIN-RED', is_jti: true },
  { id: 'sku-jti-winston-blue', name: 'Winston Blue', brand_name: 'Winston', sku_code: 'WIN-BLU', is_jti: true },
  { id: 'sku-jti-mevius-original', name: 'Mevius Original', brand_name: 'Mevius', sku_code: 'MEV-ORG', is_jti: true },
  { id: 'sku-pmi-marlboro-red', name: 'Marlboro Red', brand_name: 'Marlboro', sku_code: 'MLB-RED', is_jti: false },
  { id: 'sku-pmi-lm-red', name: 'L&M Red Label', brand_name: 'L&M', sku_code: 'LM-RED', is_jti: false },
  { id: 'sku-bat-pallmall-red', name: 'Pall Mall Red', brand_name: 'Pall Mall', sku_code: 'PAL-RED', is_jti: false },
];

test('the prompt names the catalogue and the market context', () => {
  const prompt = buildPrompt(SKUS, 'SGD');
  assert.match(prompt, /Winston Red/);
  assert.match(prompt, /Pall Mall Red/);
  assert.match(prompt, /SGD/);
  assert.match(prompt, /Singapore/);
  // Standardised packaging is why the model must read text rather than look for colours.
  assert.match(prompt, /standardised/i);
  assert.match(prompt, /JSON only/i);
});

test('JSON is extracted from a bare response', () => {
  const parsed = extractJson('{"detections":[{"product":"Winston Red","price":13.6}]}');
  assert.equal(parsed.detections.length, 1);
});

test('JSON is extracted from a fenced code block', () => {
  const parsed = extractJson('Here you go:\n```json\n{"detections":[{"product":"X","price":1}]}\n```\nHope that helps.');
  assert.equal(parsed.detections.length, 1);
});

test('JSON is extracted when the model wraps it in prose', () => {
  const parsed = extractJson('I can see the following: {"detections":[{"product":"Y","price":2}]} — that is all.');
  assert.equal(parsed.detections[0].product, 'Y');
});

test('unparseable responses yield null rather than throwing', () => {
  assert.equal(extractJson('I am sorry, I cannot read this image.'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
});

test('normalise folds punctuation and ampersands', () => {
  assert.equal(normalise('L&M Red Label'), 'l and m red label');
  assert.equal(normalise('  Pall  Mall—Red '), 'pall mall red');
});

test('exact catalogue names match their SKU', () => {
  assert.equal(matchSku('Winston Red', SKUS).sku.id, 'sku-jti-winston-red');
  assert.equal(matchSku('Mevius Original', SKUS).sku.id, 'sku-jti-mevius-original');
  assert.equal(matchSku('Pall Mall Red', SKUS).sku.id, 'sku-bat-pallmall-red');
});

test('a shared variant word never matches across brands', () => {
  // "Red" appears in four SKUs; the brand token has to decide.
  assert.equal(matchSku('Marlboro Red', SKUS).sku.id, 'sku-pmi-marlboro-red');
  assert.equal(matchSku('Winston Red', SKUS).sku.id, 'sku-jti-winston-red');
});

test('the more specific SKU wins over the bare brand', () => {
  const match = matchSku('WINSTON BLUE', SKUS);
  assert.equal(match.sku.id, 'sku-jti-winston-blue');
});

test('unknown products do not match', () => {
  assert.equal(matchSku('Gudang Garam Surya', SKUS), null);
  assert.equal(matchSku('', SKUS), null);
  assert.equal(matchSku('   ', SKUS), null);
});

test('prices parse from numbers and from messy strings', () => {
  assert.equal(parsePrice(13.6), 13.6);
  assert.equal(parsePrice('13.60'), 13.6);
  assert.equal(parsePrice('$13.60'), 13.6);
  assert.equal(parsePrice('SGD 13.60'), 13.6);
  assert.equal(parsePrice('13,60'), 13.6);
  assert.equal(parsePrice('not a price'), null);
  assert.equal(parsePrice(null), null);
});

test('a model response becomes detections in the shape the app consumes', () => {
  const response = JSON.stringify({
    detections: [
      { product: 'Winston Red', price: 13.6, confidence: 0.96, text: 'WINSTON Red $13.60' },
      { product: 'Marlboro Red', price: '$16.00', confidence: 0.91, text: 'MARLBORO Red $16.00' },
    ],
  });
  const { detections, unmatched } = parseModelResponse(response, SKUS);

  assert.equal(detections.length, 2);
  assert.equal(unmatched, 0);
  assert.equal(detections[0].sku_candidate, 'sku-jti-winston-red');
  assert.equal(detections[0].price_candidate, 13.6);
  assert.equal(detections[0].confidence, 0.96);
  assert.equal(detections[0].detected_is_jti, true);
  assert.equal(detections[1].sku_candidate, 'sku-pmi-marlboro-red');
  assert.equal(detections[1].price_candidate, 16);
  assert.equal(detections[1].detected_is_jti, false);
});

test('a readable line that matches no SKU is kept for manual correction, not dropped', () => {
  const response = JSON.stringify({
    detections: [{ product: 'Gudang Garam Surya', price: 12.5, confidence: 0.9 }],
  });
  const { detections, unmatched } = parseModelResponse(response, SKUS);

  assert.equal(detections.length, 1, 'the price is surfaced rather than silently discarded');
  assert.equal(unmatched, 1);
  assert.equal(detections[0].sku_candidate, null);
  assert.ok(detections[0].confidence <= 0.5, 'an unmatched product cannot be high confidence');
});

test('rows without a readable price are skipped', () => {
  const response = JSON.stringify({
    detections: [
      { product: 'Winston Red', price: 'unreadable' },
      { product: 'Winston Blue', price: 13.6 },
    ],
  });
  const { detections } = parseModelResponse(response, SKUS);
  assert.equal(detections.length, 1);
  assert.equal(detections[0].sku_candidate, 'sku-jti-winston-blue');
});

test('confidence is clamped into 0..1 whatever the model reports', () => {
  const response = JSON.stringify({
    detections: [
      { product: 'Winston Red', price: 13.6, confidence: 5 },
      { product: 'Winston Blue', price: 13.6, confidence: -2 },
    ],
  });
  const { detections } = parseModelResponse(response, SKUS);
  assert.ok(detections.every((d) => d.confidence >= 0 && d.confidence <= 1));
});

test('a refusal or unparseable answer yields no detections rather than throwing', () => {
  const { detections, unmatched } = parseModelResponse('I cannot read this image.', SKUS);
  assert.deepEqual(detections, []);
  assert.equal(unmatched, 0);
});

test('a bare array response is accepted too', () => {
  const { detections } = parseModelResponse('[{"product":"Winston Red","price":13.6}]', SKUS);
  assert.equal(detections.length, 1);
});

test('the detection count is capped so one bad response cannot flood a visit', () => {
  const rows = Array.from({ length: 200 }, () => ({ product: 'Winston Red', price: 13.6 }));
  const { detections } = parseModelResponse(JSON.stringify({ detections: rows }), SKUS, {
    maxDetections: 40,
  });
  assert.equal(detections.length, 40);
});

/* ------------------------------------------------------- model input shapes */

test('image_url models receive a data URL', async () => {
  const { buildModelInput } = await import('../shared/recognition.js');
  const input = buildModelInput('image_url', 'read this', 'QUJD');
  assert.equal(input.prompt, 'read this');
  assert.match(input.image, /^data:image\/jpeg;base64,QUJD$/);
});

test('image_bytes models receive raw bytes, not a string', async () => {
  const { buildModelInput, base64ToBytes } = await import('../shared/recognition.js');
  const input = buildModelInput('image_bytes', 'read this', 'QUJD');
  assert.ok(Array.isArray(input.image), 'LLaVA takes a byte array');
  assert.deepEqual(input.image, [65, 66, 67], '"QUJD" decodes to ABC');
  assert.deepEqual(base64ToBytes('QUJD'), [65, 66, 67]);
});

test('messages models receive multimodal content', async () => {
  const { buildModelInput } = await import('../shared/recognition.js');
  const input = buildModelInput('messages', 'read this', 'QUJD');
  assert.equal(input.messages.length, 1);
  const [text, image] = input.messages[0].content;
  assert.equal(text.text, 'read this');
  assert.match(image.image_url.url, /^data:image\/jpeg;base64,/);
});

test('every image-reading model declares an input shape the builder understands', async () => {
  const { RECOGNITION_MODELS } = await import('../public/app/config.js');
  const shapes = new Set(['image_url', 'image_bytes', 'messages']);
  for (const model of RECOGNITION_MODELS.filter((m) => m.reads_image)) {
    assert.ok(shapes.has(model.input), `${model.id} declares a known input shape`);
  }
});

test('a licence-gated model carries the terms it needs shown before acceptance', async () => {
  const { RECOGNITION_MODELS } = await import('../public/app/config.js');
  for (const model of RECOGNITION_MODELS.filter((m) => m.licence)) {
    assert.ok(model.licence.name, `${model.id} names its licence`);
    assert.match(model.licence.terms, /^https:\/\//, `${model.id} links its terms`);
    assert.match(model.licence.policy, /^https:\/\//, `${model.id} links its use policy`);
  }
});

/* ------------------------------------------------- where a detection sits on the photo */

test('a box arrives as corner coordinates or as x/y/w/h', () => {
  assert.deepEqual(parseBox([0.1, 0.2, 0.6, 0.3]), { x: 0.1, y: 0.2, w: 0.5, h: 0.1, source: 'model' });
  assert.deepEqual(parseBox({ x: 0.1, y: 0.2, w: 0.5, h: 0.1 }), { x: 0.1, y: 0.2, w: 0.5, h: 0.1, source: 'model' });
  assert.deepEqual(parseBox({ x: 0.1, y: 0.2, width: 0.5, height: 0.1 }).w, 0.5);
});

test('models that report on a 0-1000 grid are rescaled, not discarded', () => {
  assert.deepEqual(parseBox([100, 200, 600, 300]), { x: 0.1, y: 0.2, w: 0.5, h: 0.1, source: 'model' });
});

test('a percentage-scaled box is rescaled too', () => {
  assert.deepEqual(parseBox([10, 20, 60, 30]), { x: 0.1, y: 0.2, w: 0.5, h: 0.1, source: 'model' });
});

test('reversed corners are normalised rather than producing a negative box', () => {
  assert.deepEqual(parseBox([0.6, 0.3, 0.1, 0.2]), { x: 0.1, y: 0.2, w: 0.5, h: 0.1, source: 'model' });
});

test('a box that describes no usable area is dropped', () => {
  // A rectangle over the wrong line invites a TME to confirm a price they never checked.
  assert.equal(parseBox([0.5, 0.5, 0.5, 0.5]), null);
  assert.equal(parseBox([0.5, 0.5, 0.505, 0.9]), null, 'too narrow to be a price line');
  assert.equal(parseBox('somewhere near the top'), null);
  assert.equal(parseBox([1, 2, 3]), null);
  assert.equal(parseBox(null), null);
  assert.equal(parseBox({ x: 0.1, y: 0.2 }), null);
});

test('a box is clamped to the image', () => {
  const box = parseBox([-0.4, 0.5, 1.4, 0.9]);
  assert.equal(box.x, 0);
  assert.equal(box.w, 1);
});

test('detections with no reported position are laid out in reading order', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const placed = inferBoxes(rows);

  assert.equal(placed.length, 4);
  assert.ok(placed.every((r) => r.bounding_box.source === 'inferred'));
  // Bands descend the image in order, and none overlaps the next.
  for (let i = 1; i < placed.length; i += 1) {
    const previous = placed[i - 1].bounding_box;
    assert.ok(placed[i].bounding_box.y >= previous.y + previous.h, `band ${i} clears band ${i - 1}`);
  }
  const last = placed.at(-1).bounding_box;
  assert.ok(last.y + last.h <= 1, 'the last band stays inside the image');
});

test('reported positions are never mixed with inferred ones', () => {
  // Half-measured, half-invented geometry in one picture cannot be labelled honestly.
  const rows = [{ bounding_box: { x: 0, y: 0, w: 1, h: 0.1, source: 'model' } }, { bounding_box: null }];
  const placed = inferBoxes(rows);
  assert.equal(placed[1].bounding_box, null);
});

test('inferring over an empty response yields an empty response', () => {
  assert.deepEqual(inferBoxes([]), []);
});

test('the model is not asked for coordinates at all', () => {
  // Asked for them, gpt-4o twice returned a tidy grid of identical rectangles sitting above
  // the packs it had just read correctly. Asking invites the fabrication; the photograph
  // itself is what places a price (see public/app/lib/shelfRows.js).
  const prompt = buildPrompt(SKUS, 'SGD');
  assert.match(prompt, /Do not report coordinates/);
  assert.doesNotMatch(prompt, /"box"/);
  assert.doesNotMatch(prompt, /\bbbox\b/);
});

test('the prompt asks for reading order instead, and says why it matters', () => {
  const prompt = buildPrompt(SKUS, 'SGD');
  assert.match(prompt, /ORDER THEY APPEAR/);
  assert.match(prompt, /top to bottom, left to right/);
  assert.match(prompt, /used to place each price back on the photograph/);
  assert.match(prompt, /report each facing/);
});

test('a model that volunteers coordinates anyway has them ignored', () => {
  const response = JSON.stringify({
    detections: [
      { product: 'Winston Red', price: 13.6, confidence: 0.95, box: [0.05, 0.2, 0.95, 0.27] },
      { product: 'Marlboro Red', price: 16, confidence: 0.93, box: [0.05, 0.3, 0.95, 0.37] },
    ],
  });
  const { detections } = parseModelResponse(response, SKUS);
  assert.equal(detections.length, 2);
  assert.ok(detections.every((d) => d.bounding_box === null), 'no position comes back from the model');
});

test('the recommended free model has no licence click-through', async () => {
  const { RECOGNITION_MODELS, RECOMMENDED_FREE_MODEL } = await import('../public/app/config.js');
  const model = RECOGNITION_MODELS.find((m) => m.id === RECOMMENDED_FREE_MODEL);
  assert.equal(model.licence, undefined, 'the default suggestion works without a legal step');
  assert.equal(model.tier, 'free');
});
