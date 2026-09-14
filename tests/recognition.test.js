import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrompt,
  extractJson,
  matchSku,
  normalise,
  parseAlternatives,
  parseCount,
  parseModelResponse,
  parsePrice,
  parseTicketColour,
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

/* --------------------------------------------- the model is not asked to locate anything */

test('the model is not asked for coordinates at all', () => {
  // Asked for them, gpt-4o twice returned a tidy grid of identical rectangles sitting above
  // the packs it had just read correctly. Asking invites the fabrication; the photograph
  // itself. Detections are shown as a shelf schematic instead of drawn on the photo.
  const prompt = buildPrompt(SKUS, 'SGD');
  assert.match(prompt, /Do not report coordinates/);
  assert.doesNotMatch(prompt, /"box"/);
  assert.doesNotMatch(prompt, /\bbbox\b/);
});

test('the prompt asks for the two things a vision model can actually count', () => {
  // Which shelf, and how many packs stand on it. Both are counts; neither can be
  // interpolated into existence the way a rectangle can.
  const prompt = buildPrompt(SKUS, 'SGD');
  assert.match(prompt, /ORDER THEY APPEAR/);
  assert.match(prompt, /top to bottom, left to right/);
  assert.match(prompt, /"shelf" is which shelf/);
  assert.match(prompt, /counting from the TOP/);
  assert.match(prompt, /"facings" is HOW MANY packs/);
  assert.match(prompt, /Count\s+them/);
  // A price list has lines, not facings, and the photo is usually a price list.
  assert.match(prompt, /1 for a printed price list/);
});

test('shelf and facings are read back off the response', () => {
  const response = JSON.stringify({
    detections: [
      { product: 'Winston Red', price: 13.6, shelf: 2, facings: 3 },
      { product: 'Marlboro Red', price: 16, shelf: 2, facings: 1 },
    ],
  });
  const { detections } = parseModelResponse(response, SKUS);
  assert.equal(detections[0].shelf, 2);
  assert.equal(detections[0].facings, 3);
  assert.equal(detections[1].facings, 1);
});

test('a model that says nothing about shelves or facings yields one pack and no shelf', () => {
  const { detections } = parseModelResponse('[{"product":"Winston Red","price":13.6}]', SKUS);
  assert.equal(detections[0].shelf, null);
  assert.equal(detections[0].facings, 1, 'one pack is the only count that can be assumed');
});

test('a count that is not a whole number in range is dropped, not coerced', () => {
  // "several" or 1.5 means the model did not count, and a row of packs nobody counted is
  // exactly the kind of invention this application refuses to draw.
  assert.equal(parseCount(3), 3);
  assert.equal(parseCount('4'), 4);
  assert.equal(parseCount(0), null);
  assert.equal(parseCount(1.5), null);
  assert.equal(parseCount(-2), null);
  assert.equal(parseCount('several'), null);
  assert.equal(parseCount(null), null);
  assert.equal(parseCount(999, { max: 20 }), null);
});

test('alternative field names a model might use are accepted', () => {
  const response = JSON.stringify({
    detections: [{ product: 'Winston Red', price: 13.6, row: 3, count: 2 }],
  });
  const { detections } = parseModelResponse(response, SKUS);
  assert.equal(detections[0].shelf, 3);
  assert.equal(detections[0].facings, 2);
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

/* ----------------------------------------- telling two plain packs apart */

test('the prompt forbids merging two products that share a price', () => {
  // The reported failure: two variants side by side, same price, pack text unreadable, and
  // the model returns them as one product.
  const prompt = buildPrompt(SKUS, 'SGD');
  assert.match(prompt, /NEVER merge two products into one line because their prices match/);
  assert.match(prompt, /an equal\s+price is not evidence/);
  assert.match(prompt, /PRICE TICKET/);
});

test('the prompt asks for the ticket colour, which is what actually separates them', () => {
  const prompt = buildPrompt(SKUS, 'SGD');
  assert.match(prompt, /"ticket" is the colour/);
  assert.match(prompt, /Use null if there is no ticket or you cannot tell/);
});

test('the prompt asks for a named second guess rather than a confident wrong answer', () => {
  const prompt = buildPrompt(SKUS, 'SGD');
  assert.match(prompt, /"alternatives" is OPTIONAL/);
  assert.match(prompt, /probability between 0 and 1/);
  assert.match(prompt, /A named second guess is worth far more than a confident wrong answer/);
});

test('an unreadable variant is asked for as its own uncertain line, not folded into a neighbour', () => {
  assert.match(buildPrompt(SKUS, 'SGD'), /A separate uncertain line is useful; a merged confident one is not/);
});

test('the ticket colour comes back as the model described it', () => {
  const response = JSON.stringify({
    detections: [{ product: 'Winston Red', price: 13.6, ticket: '  Dark Blue ' }],
  });
  const { detections } = parseModelResponse(response, SKUS);
  assert.equal(detections[0].ticket_colour, 'Dark Blue');
});

test('a missing or unusable ticket colour is null, never invented', () => {
  assert.equal(parseTicketColour(undefined), null);
  assert.equal(parseTicketColour(null), null);
  assert.equal(parseTicketColour('   '), null);
  assert.equal(parseTicketColour(7), null);
  assert.equal(parseTicketColour('a'.repeat(80)).length, 24, 'and it cannot be a paragraph');
});

test('alternatives become one-tap corrections with the model probability on them', () => {
  const response = JSON.stringify({
    detections: [
      {
        product: 'Winston Red',
        price: 13.6,
        confidence: 0.6,
        alternatives: [
          { product: 'Winston Blue', probability: 0.3 },
          { product: 'Mevius Original', probability: 0.1 },
        ],
      },
    ],
  });
  const { detections } = parseModelResponse(response, SKUS);
  assert.deepEqual(detections[0].alternatives, [
    { sku_id: 'sku-jti-winston-blue', label: 'Winston Blue', confidence: 0.3 },
    { sku_id: 'sku-jti-mevius-original', label: 'Mevius Original', confidence: 0.1 },
  ]);
});

test('an alternative that is the detection itself, or matches nothing, is dropped', () => {
  // An alternative that cannot be applied is not an alternative.
  const alts = parseAlternatives(
    [
      { product: 'Winston Red', probability: 0.4 },
      { product: 'Gudang Garam Surya', probability: 0.3 },
      { product: 'Winston Blue', probability: 0.2 },
    ],
    SKUS,
    { exclude: 'sku-jti-winston-red' },
  );
  assert.deepEqual(alts.map((a) => a.sku_id), ['sku-jti-winston-blue']);
});

test('alternatives are capped, deduplicated and given a probability when none was stated', () => {
  const alts = parseAlternatives(
    [{ product: 'Winston Blue' }, { product: 'Winston Blue' }, { product: 'Mevius Original' }, { product: 'Marlboro Red' }],
    SKUS,
  );
  assert.equal(alts.length, 2);
  assert.deepEqual(alts.map((a) => a.sku_id), ['sku-jti-winston-blue', 'sku-jti-mevius-original']);
  assert.ok(alts.every((a) => a.confidence > 0 && a.confidence <= 1));
});

test('a response with no alternatives yields an empty list rather than undefined', () => {
  const { detections } = parseModelResponse('[{"product":"Winston Red","price":13.6}]', SKUS);
  assert.deepEqual(detections[0].alternatives, []);
  assert.equal(detections[0].ticket_colour, null);
});
