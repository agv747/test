/**
 * The provider error codes are opaque ("2021: Insufficient AI Gateway credits") and say
 * nothing about the fix. These assert that each one is turned into an instruction.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { explainModelFailure } from '../worker.js';
import { RECOGNITION_MODELS, RECOMMENDED_FREE_MODEL } from '../public/app/config.js';

const MODEL = '@cf/qwen/qwen3.8-27b';

test('an AI Gateway credits error points at the free models', () => {
  const message = explainModelFailure(new Error('2021: Insufficient AI Gateway credits'), MODEL);
  assert.match(message, /paid model/i);
  assert.match(message, /Free daily allocation/i);
  assert.match(message, /Llama 3\.2 11B Vision/);
  assert.match(message, new RegExp(MODEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a Workers Paid requirement is explained, not echoed', () => {
  const message = explainModelFailure(new Error('403: internal error 5035'), MODEL);
  assert.match(message, /Workers Paid plan/);
  assert.doesNotMatch(message, /^Model call failed/);
});

test('out of capacity suggests retrying rather than changing billing', () => {
  const message = explainModelFailure(new Error('3040: Out of Capacity'), MODEL);
  assert.match(message, /capacity/i);
  assert.match(message, /Retry/i);
});

test('rate limiting mentions the daily allocation and when it resets', () => {
  const message = explainModelFailure(new Error('429 Too Many Requests'), MODEL);
  assert.match(message, /10,000 Neurons/);
  assert.match(message, /00:00 UTC/);
});

test('an unknown model is reported as unavailable on this account', () => {
  const message = explainModelFailure(new Error('No such model'), '@cf/does/not-exist');
  assert.match(message, /not available on this account/i);
});

test('an unrecognised error still surfaces the original message', () => {
  const message = explainModelFailure(new Error('socket hang up'), MODEL);
  assert.match(message, /socket hang up/);
});

test('the recommended free model exists in the catalogue and is free', () => {
  const model = RECOGNITION_MODELS.find((m) => m.id === RECOMMENDED_FREE_MODEL);
  assert.ok(model, 'the recommended model is in the catalogue');
  assert.equal(model.tier, 'free');
  assert.equal(model.reads_image, true);
  assert.equal(model.recommended, true);
});

test('every model declares whether it reads the image and what it costs', () => {
  for (const model of RECOGNITION_MODELS) {
    assert.ok(['free', 'paid', 'byo-key'].includes(model.tier), `${model.id} declares a tier`);
    assert.equal(typeof model.reads_image, 'boolean', `${model.id} declares reads_image`);
    assert.ok(model.cost, `${model.id} declares a cost`);
    assert.ok(model.description, `${model.id} describes itself`);
  }
});

test('the default model is the simulator, so a fresh install spends nothing', async () => {
  const { DEFAULT_RECOGNITION_MODEL } = await import('../public/app/config.js');
  const model = RECOGNITION_MODELS.find((m) => m.id === DEFAULT_RECOGNITION_MODEL);
  assert.equal(model.kind, 'simulated');
  assert.equal(model.reads_image, false);
});

test('at least one image-reading model runs inside the free allocation', () => {
  const free = RECOGNITION_MODELS.filter((m) => m.tier === 'free' && m.reads_image);
  assert.ok(free.length >= 1, 'a real model is usable without arranging billing');
});

/* --------------------------------------------------- bring-your-own-key models */

test('a bring-your-own-key model names the secret it needs and the API model to call', () => {
  // Each vendor has its own secret. Assuming one for all of them is how Admin came to report
  // "API key not configured" against a Google model whenever the OpenAI key was absent.
  const SECRET_BY_KIND = { openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };

  const byoKey = RECOGNITION_MODELS.filter((m) => m.tier === 'byo-key');
  assert.ok(byoKey.length >= 1, 'at least one model runs on the account holder\'s own key');
  for (const model of byoKey) {
    assert.ok(SECRET_BY_KIND[model.kind], `${model.id} has an unrecognised kind: ${model.kind}`);
    assert.equal(model.requires_secret, SECRET_BY_KIND[model.kind]);
    assert.ok(model.api_model, `${model.id} names the provider-side model id`);
    assert.equal(model.reads_image, true);
  }
});

test('both vendors are offered, so one account being unavailable is not the end of it', () => {
  const kinds = new Set(RECOGNITION_MODELS.filter((m) => m.tier === 'byo-key').map((m) => m.kind));
  assert.ok(kinds.has('openai'));
  assert.ok(kinds.has('gemini'));
});

test('a missing key is explained with where to put it, not as a generic failure', () => {
  const message = explainModelFailure(
    new Error(
      'OPENAI_API_KEY is not configured. Add it as a Worker secret (Cloudflare dashboard → the Worker → Settings → Variables and Secrets → Add, type Secret).',
    ),
    'openai:gpt-4.1-mini',
  );
  assert.match(message, /Worker secret/);
  assert.match(message, /OPENAI_API_KEY/);
  assert.doesNotMatch(message, /^Model call failed/);
});

test('a rejected OpenAI key points at the secret rather than the model', () => {
  const message = explainModelFailure(
    new Error('OpenAI: Incorrect API key provided (invalid_api_key)'),
    'openai:gpt-4.1-mini',
  );
  assert.match(message, /OPENAI_API_KEY secret/);
});

test('an exhausted OpenAI quota offers the free Cloudflare models as a way out', () => {
  const message = explainModelFailure(
    new Error('OpenAI: You exceeded your current quota (insufficient_quota)'),
    'openai:gpt-4o',
  );
  assert.match(message, /quota/i);
  assert.match(message, /Free allocation/);
});

test('a model the OpenAI account cannot see is distinguished from a bad key', () => {
  const message = explainModelFailure(
    new Error('OpenAI: The model `gpt-4o` does not exist or you do not have access to it'),
    'openai:gpt-4o',
  );
  assert.match(message, /not available on this OpenAI account/);
  assert.doesNotMatch(message, /secret/);
});

test('no model descriptor carries a credential', () => {
  // The key belongs in the Worker's secret store; a value here would reach every browser.
  for (const model of RECOGNITION_MODELS) {
    const serialised = JSON.stringify(model);
    assert.doesNotMatch(serialised, /sk-[A-Za-z0-9]/, `${model.id} embeds no API key`);
    assert.equal(model.api_key, undefined);
  }
});

/* ----------------------------------- a failure is a failure, not a fallback */
//
// The worst outcome available here is not an error. It is a screen full of plausible prices
// that nobody read off a shelf, presented under the name of a model. A demo audience cannot
// tell the two apart — the numbers look identical — so the failure has to reach them.
//
// The real provider is exercised; only the browser APIs it needs are stubbed. No live model
// call is possible from this environment, so the boundary is where the stub goes.

import { createRemoteProvider } from '../public/app/services/recognition/remoteProvider.js';

const context = {
  jtiSkus: [{ id: 'sku-jti-winston-red', name: 'Winston Red', brand_name: 'Winston', is_jti: true }],
  competitorSkus: [],
  currency: 'SGD',
};
const image = { id: 'img-1', name: 'shelf.jpg', file: { name: 'shelf.jpg', size: 1024 } };

/** The minimum of the browser the provider touches: reading the file it was handed. */
function withBrowserStubs(respond) {
  const previousReader = globalThis.FileReader;
  const previousFetch = globalThis.fetch;

  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = 'data:image/jpeg;base64,AAAA';
      queueMicrotask(() => this.onload?.());
    }
  };
  globalThis.fetch = async () => respond();

  return () => {
    globalThis.FileReader = previousReader;
    globalThis.fetch = previousFetch;
  };
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('a model that errors throws rather than returning invented detections', async () => {
  const restore = withBrowserStubs(() => jsonResponse(502, { error: 'upstream exploded' }));
  try {
    const provider = createRemoteProvider({ id: 'openai:gpt-4o', label: 'GPT-4o' });
    await assert.rejects(() => provider.analyzePriceImage(image, context), /upstream exploded/);
  } finally {
    restore();
  }
});

test('a model that reads nothing says so instead of falling back to the simulator', async () => {
  const restore = withBrowserStubs(() => jsonResponse(200, { detections: [] }));
  try {
    const provider = createRemoteProvider({ id: 'openai:gpt-4o', label: 'GPT-4o' });
    await assert.rejects(
      () => provider.analyzePriceImage(image, context),
      /did not read any product prices/,
    );
  } finally {
    restore();
  }
});

test('a model asked to read an image it has not got refuses rather than guessing', async () => {
  const restore = withBrowserStubs(() => jsonResponse(200, { detections: [] }));
  try {
    const provider = createRemoteProvider({ id: 'openai:gpt-4o', label: 'GPT-4o' });
    await assert.rejects(
      () => provider.analyzePriceImage({ id: 'img-2', name: 'x.jpg' }, context),
      /needs the original image file/,
    );
  } finally {
    restore();
  }
});

test('a model that answers is the one whose detections are used', async () => {
  // The positive control for the three above: the same path, succeeding, returns exactly what
  // came back — so a rejection above means the failure was raised, not that nothing ran.
  const detections = [{ sku_candidate: 'sku-jti-winston-red', price_candidate: 14.2, confidence: 0.96 }];
  const restore = withBrowserStubs(() => jsonResponse(200, { detections }));
  try {
    const provider = createRemoteProvider({ id: 'openai:gpt-4o', label: 'GPT-4o' });
    assert.deepEqual(await provider.analyzePriceImage(image, context), detections);
  } finally {
    restore();
  }
});
