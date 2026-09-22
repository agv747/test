/**
 * End to end, from a gpt-4o answer to the shelf on screen.
 *
 * The one hop that cannot be exercised here is the network call: this environment reaches
 * neither api.openai.com nor the deployment (the egress proxy answers 403 to CONNECT), so
 * `fetch` is replaced with a recording of what gpt-4o returns for the cabinet photo that
 * exposed the bug — three Mevius facings on the top shelf, three Camel below.
 *
 * Everything after that hop is the real code: the Worker's own `/api/recognise` handler, the
 * real prompt, the real parser, the real draft builder and the real schematic renderer. The
 * bug being pinned is that a model reports a product once, not once per facing, so a row of
 * three identical packs was drawn as one pack.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { buildDraftObservation } from '../public/app/services/visitService.js';
import { shelfSchematic } from '../public/app/ui/shelfSchematic.js';
import { flagVariantConflicts } from '../public/app/services/visitService.js';
import { DEFAULT_CONFIG } from '../public/app/config.js';

const AUTH_TOKEN = 'test_only_access_token_000000000000000000000000';

const SKUS = [
  { id: 'sku-jti-mevius-original', name: 'Mevius Original', brand_name: 'Mevius', sku_code: 'MEV-ORG', is_jti: true },
  { id: 'sku-jti-mevius-sky', name: 'Mevius Sky Blue', brand_name: 'Mevius', sku_code: 'MEV-SKY', is_jti: true },
  { id: 'sku-jti-camel-blue', name: 'Camel Blue', brand_name: 'Camel', sku_code: 'CAM-BLU', is_jti: true },
  { id: 'sku-pmi-lm-red', name: 'L&M Red Label', brand_name: 'L&M', sku_code: 'LM-RED', is_jti: false },
];

/** What the model is expected to answer now that it is asked to count, not to locate. */
const MODEL_ANSWER = {
  detections: [
    { product: 'Mevius Original', price: 18.3, confidence: 0.95, text: 'MEVIUS Original $18.30', shelf: 1, facings: 2 },
    { product: 'Mevius Sky Blue', price: 18.3, confidence: 0.95, text: 'MEVIUS Sky Blue $18.30', shelf: 1, facings: 1 },
    { product: 'Camel Blue', price: 16.0, confidence: 0.93, text: 'CAMEL Blue $16.00', shelf: 2, facings: 3 },
    { product: 'L&M Red Label', price: 16.0, confidence: 0.9, text: 'L&M Red Label $16.00', shelf: 3, facings: 2 },
  ],
};

function stubOpenAI(answer) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }),
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function recognise(answer) {
  const stub = stubOpenAI(answer);
  try {
    const response = await worker.fetch(
      new Request('https://example.test/api/recognise', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `rei_session=${AUTH_TOKEN}` },
        body: JSON.stringify({
          image: 'data:image/jpeg;base64,QUJD',
          model: 'openai:gpt-4o',
          skus: SKUS,
          currency: 'SGD',
        }),
      }),
      { OPENAI_API_KEY: 'sk-test', ADMIN_ACCESS_TOKEN: AUTH_TOKEN },
    );
    return { response, body: await response.json(), sent: stub.calls[0] };
  } finally {
    stub.restore();
  }
}

/** The client's own next step: detections become drafts, drafts become the shelf. */
function drawShelf(detections) {
  const drafts = detections.map((detection, i) =>
    buildDraftObservation({
      detection,
      detectionIndex: i,
      image: { id: 'img-1', image_source: 'camera' },
      provider: 'openai:gpt-4o',
      visit: { id: 'visit-1' },
      outlet: { id: 'out-1', territory_id: 'ter-east', channel_id: 'ch-indep' },
      data: { skus: SKUS, price_rules: [], competitor_mappings: [], market: 'SG' },
      config: DEFAULT_CONFIG,
      observedAt: '2026-09-11T02:00:00.000Z',
    }),
  );
  const flagged = flagVariantConflicts(drafts);
  return { drafts: flagged, html: shelfSchematic(flagged) };
}

/* ------------------------------------------------------------- the request */

test('the Worker asks the model to count shelves and facings', async () => {
  const { sent } = await recognise(MODEL_ANSWER);
  const prompt = sent.body.messages[0].content[0].text;
  assert.match(prompt, /"shelf" is which shelf/);
  assert.match(prompt, /"facings" is HOW MANY packs/);
  assert.match(prompt, /Do not report coordinates/);
});

/* -------------------------------------------------------------- the answer */

test('shelf and facing counts survive the Worker and reach the detections', async () => {
  const { response, body } = await recognise(MODEL_ANSWER);
  assert.equal(response.status, 200);
  assert.equal(body.detections.length, 4);
  assert.deepEqual(body.detections.map((d) => d.shelf), [1, 1, 2, 3]);
  assert.deepEqual(body.detections.map((d) => d.facings), [2, 1, 3, 2]);
});

test('they survive the draft builder too, which is where the schematic reads them', async () => {
  const { body } = await recognise(MODEL_ANSWER);
  const { drafts } = drawShelf(body.detections);
  assert.deepEqual(drafts.map((d) => d.facings), [2, 1, 3, 2]);
  assert.deepEqual(drafts.map((d) => d.shelf), [1, 1, 2, 3]);
});

/* --------------------------------------------------------------- the shelf */

test('a row of three packs is drawn as three packs, not one', async () => {
  // The reported bug: "показывает 1 пачку на схеме, а на фото целый ряд".
  const { body } = await recognise(MODEL_ANSWER);
  const { html } = drawShelf(body.detections);

  assert.equal(html.match(/class="pack /g).length, 8, '2 + 1 + 3 + 2 packs');
  assert.match(html, /×3/, 'the three Camel facings are labelled as three');
});

test('the shelves the model counted become the shelves on screen', async () => {
  const { body } = await recognise(MODEL_ANSWER);
  const { html } = drawShelf(body.detections);

  assert.match(html, /Shelf 1/);
  assert.match(html, /Shelf 2/);
  assert.match(html, /Shelf 3/);
  assert.doesNotMatch(html, /Shelf 4/, 'four products did not become four shelves');
  // Two products share the top shelf, as reported.
  assert.match(html, /2 products\s*·\s*3 facings/);
});

test('the schematic says the shelves were counted rather than guessed', async () => {
  const { body } = await recognise(MODEL_ANSWER);
  const { html } = drawShelf(body.detections);
  assert.match(html, /sit on the shelf the model counted them on/);
});

test('a model that answers without counts still produces a usable shelf', async () => {
  // Older models, and any model having a bad day, simply omit the fields.
  const { body } = await recognise({
    detections: [
      { product: 'Mevius Original', price: 18.3, confidence: 0.95 },
      { product: 'Camel Blue', price: 16, confidence: 0.93 },
    ],
  });
  const { html } = drawShelf(body.detections);

  assert.equal(html.match(/class="pack /g).length, 2, 'one pack each, none invented');
  assert.match(html, /reported no shelf numbers/, 'and it says the grouping is a guess');
});

test('an unreadable answer fails visibly rather than drawing an empty shelf', async () => {
  const stub = stubOpenAI({});
  try {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'I cannot read this image.' } }] }),
    });
    const response = await worker.fetch(
      new Request('https://example.test/api/recognise', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `rei_session=${AUTH_TOKEN}` },
        body: JSON.stringify({ image: 'x', model: 'openai:gpt-4o', skus: SKUS }),
      }),
      { OPENAI_API_KEY: 'sk-test', ADMIN_ACCESS_TOKEN: AUTH_TOKEN },
    );
    const body = await response.json();
    assert.deepEqual(body.detections, []);
    assert.equal(body.raw_response, 'I cannot read this image.', 'what it said is returned');
  } finally {
    stub.restore();
  }
});

/* ------------------------------------ two variants at one price, told apart */

/**
 * The reported failure: "модель распознает разные скю как один скю. например на них цена
 * одинаковая, пачка плохо читается, но ценник разного цвета".
 */
test('the second variant comes back as its own product with a named second guess', async () => {
  const { body } = await recognise({
    detections: [
      {
        product: 'Mevius Original',
        price: 18.3,
        confidence: 0.92,
        shelf: 1,
        facings: 2,
        ticket: 'red',
      },
      {
        // Same brand, same price, pack unreadable — the case that used to be merged away.
        product: 'Mevius',
        price: 18.3,
        confidence: 0.45,
        shelf: 1,
        facings: 2,
        ticket: 'blue',
        alternatives: [
          { product: 'Mevius Sky Blue', probability: 0.55 },
          { product: 'Mevius Original', probability: 0.2 },
        ],
      },
    ],
  });

  assert.equal(body.detections.length, 2, 'two products, not one');
  assert.deepEqual(body.detections.map((d) => d.ticket_colour), ['red', 'blue']);
  // A bare "Mevius" already resolves to Mevius Original, so that alternative is the
  // detection itself and is dropped; what is left is the one correction worth offering.
  assert.equal(body.detections[1].sku_candidate, 'sku-jti-mevius-original');
  assert.deepEqual(
    body.detections[1].alternatives.map((a) => `${a.label} ${Math.round(a.confidence * 100)}%`),
    ['Mevius Sky Blue 55%'],
    'the TME gets a one-tap correction with the model probability on it',
  );
});

test('when the model merges them anyway, the different tickets give it away', async () => {
  // Both lines resolve to the same SKU. The same product does not have two ticket colours on
  // one shelf, so this is flagged for the person standing at the shelf.
  const { body } = await recognise({
    detections: [
      { product: 'Mevius Original', price: 18.3, confidence: 0.9, shelf: 1, facings: 2, ticket: 'red' },
      { product: 'Mevius Original', price: 18.3, confidence: 0.9, shelf: 1, facings: 2, ticket: 'blue' },
    ],
  });
  const { drafts, html } = drawShelf(body.detections);

  assert.deepEqual(drafts.map((d) => d.variant_conflict), [true, true]);
  assert.match(html, /check variant/);
});

test('the same product read consistently raises nothing', async () => {
  const { body } = await recognise({
    detections: [
      { product: 'Mevius Original', price: 18.3, confidence: 0.9, shelf: 1, facings: 2, ticket: 'red' },
      { product: 'Camel Blue', price: 16, confidence: 0.9, shelf: 2, facings: 3, ticket: 'blue' },
    ],
  });
  const { drafts, html } = drawShelf(body.detections);

  assert.ok(drafts.every((d) => !d.variant_conflict));
  assert.doesNotMatch(html, /check variant/);
});

test('the ticket colour reaches the shelf drawing', async () => {
  const { body } = await recognise({
    detections: [{ product: 'Camel Blue', price: 16, confidence: 0.9, shelf: 1, facings: 1, ticket: 'green' }],
  });
  const { html } = drawShelf(body.detections);
  assert.match(html, /class="swatch"/);
  assert.match(html, /title="green price ticket"/);
});

test('unauthenticated callers cannot spend credentials through legacy recognition', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/recognise', { method: 'POST', body: '{}' }), { OPENAI_API_KEY: 'sk-test', ADMIN_ACCESS_TOKEN: AUTH_TOKEN });
  assert.equal(response.status, 401);
});
