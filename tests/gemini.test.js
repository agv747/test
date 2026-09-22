/**
 * Reading a shelf with Gemini.
 *
 * A second vendor is not just another entry in the catalogue. Gemini's request shape, its
 * response shape and — most importantly — its failure shapes are all different from OpenAI's,
 * and two of the failures arrive as HTTP 200.
 *
 * That is the part worth testing. When a safety filter stops the request, or the answer runs
 * out of output tokens before any of it arrives, Gemini returns 200 with no usable text. Passed
 * straight to the parser, both read as "the model found no prices in this image" — which sends
 * a TME back to the shelf to retake a photograph that was never the problem. Each is named.
 *
 * No live call is possible from this environment (the egress proxy refuses CONNECT to
 * generativelanguage.googleapis.com), so `fetch` is stubbed at the boundary and everything
 * inside it is the real Worker code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { callGemini, explainModelFailure } from '../worker.js';
import { RECOGNITION_MODELS } from '../public/app/config.js';

const descriptor = RECOGNITION_MODELS.find((m) => m.id === 'gemini:gemini-3.8-flash');
const BASE64 = '/9j/4AAQSkZJRgABAQ';
const PROMPT = 'Read every product and price from this shelf.';

/** Captures the outgoing request and answers with whatever the test supplies. */
function stubFetch(respond) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const { status = 200, body } = respond(calls.length);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, restore: () => { globalThis.fetch = previous; } };
}

const answer = (text) => ({
  body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] },
});

/* --------------------------------------------------------- the catalogue */

test('the Gemini models declare what the Worker needs to call them', () => {
  const gemini = RECOGNITION_MODELS.filter((m) => m.kind === 'gemini');
  assert.ok(gemini.length >= 2, 'a fallback model exists alongside the current one');
  for (const model of gemini) {
    assert.equal(model.requires_secret, 'GEMINI_API_KEY');
    assert.equal(model.reads_image, true);
    assert.ok(model.api_model, `${model.id} names the provider-side model id`);
    // The catalogue id is namespaced; the API id is not. Confusing the two puts the prefix
    // into the request URL and produces a 404 that reads like a retired model.
    assert.ok(!model.api_model.includes(':'), `${model.api_model} must not carry the prefix`);
    assert.equal(model.id, `gemini:${model.api_model}`);
  }
});

/* ------------------------------------------------------- the request */

test('the image and the prompt are sent in one Gemini-shaped request', async () => {
  const { calls, restore } = stubFetch(() => answer('{"detections":[]}'));
  try {
    await callGemini({ GEMINI_API_KEY: 'k' }, descriptor, PROMPT, BASE64);
  } finally {
    restore();
  }

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com/);
  assert.match(calls[0].url, new RegExp(`models/${descriptor.api_model}:generateContent$`));

  const parts = calls[0].body.contents[0].parts;
  assert.equal(parts[0].text, PROMPT);
  assert.deepEqual(parts[1].inline_data, { mime_type: 'image/jpeg', data: BASE64 });
});

test('the key travels in a header, not in the URL', async () => {
  const { calls, restore } = stubFetch(() => answer('{}'));
  try {
    await callGemini({ GEMINI_API_KEY: 'secret-key' }, descriptor, PROMPT, BASE64);
  } finally {
    restore();
  }
  // A key in the query string ends up in every proxy and gateway access log the request passes.
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'secret-key');
  assert.ok(!String(calls[0].url).includes('secret-key'));
});

test('JSON mode is requested and sampling is off', async () => {
  const { calls, restore } = stubFetch(() => answer('{}'));
  try {
    await callGemini({ GEMINI_API_KEY: 'k' }, descriptor, PROMPT, BASE64);
  } finally {
    restore();
  }
  // Reading a price off a ticket is transcription. There is nothing for sampling to improve.
  assert.equal(calls[0].body.generationConfig.responseMimeType, 'application/json');
  assert.equal(calls[0].body.generationConfig.temperature, 0);
});

test('a missing key is refused before any request is made', async () => {
  const { calls, restore } = stubFetch(() => answer('{}'));
  try {
    await assert.rejects(
      () => callGemini({}, descriptor, PROMPT, BASE64),
      /GEMINI_API_KEY is not configured/,
    );
    assert.equal(calls.length, 0, 'nothing should have been sent');
  } finally {
    restore();
  }
});

/* ------------------------------------------------------- the response */

test('the answer comes back from the candidate', async () => {
  const { restore } = stubFetch(() => answer('{"detections":[{"price":14.2}]}'));
  try {
    const raw = await callGemini({ GEMINI_API_KEY: 'k' }, descriptor, PROMPT, BASE64);
    assert.equal(raw.candidates[0].content.parts[0].text, '{"detections":[{"price":14.2}]}');
  } finally {
    restore();
  }
});

/* -------------------------------------------- the failures that arrive as 200 */

test('a safety block is named, not reported as an unreadable photograph', async () => {
  const { restore } = stubFetch(() => ({
    status: 200,
    body: { promptFeedback: { blockReason: 'SAFETY' } },
  }));
  try {
    await assert.rejects(
      () => callGemini({ GEMINI_API_KEY: 'k' }, descriptor, PROMPT, BASE64),
      (err) => {
        assert.match(err.message, /blocked by a safety filter \(SAFETY\)/);
        // The distinction that matters at the shelf: retaking the photo will not help.
        assert.match(err.message, /retaking it will not help/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('an answer cut off before it began says so, and says what to do', async () => {
  const { restore } = stubFetch(() => ({
    status: 200,
    body: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] },
  }));
  try {
    await assert.rejects(
      () => callGemini({ GEMINI_API_KEY: 'k' }, descriptor, PROMPT, BASE64),
      /MAX_TOKENS[\s\S]*fewer products at once/,
    );
  } finally {
    restore();
  }
});

test('any other silent stop is surfaced with its reason', async () => {
  const { restore } = stubFetch(() => ({
    status: 200,
    body: { candidates: [{ finishReason: 'RECITATION', content: { parts: [] } }] },
  }));
  try {
    await assert.rejects(
      () => callGemini({ GEMINI_API_KEY: 'k' }, descriptor, PROMPT, BASE64),
      /stopped without answering \(RECITATION\)/,
    );
  } finally {
    restore();
  }
});

test('a finish reason with text alongside it is not treated as a failure', async () => {
  // MAX_TOKENS after a complete answer is common and harmless; only an empty one is fatal.
  const { restore } = stubFetch(() => ({
    status: 200,
    body: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"a":1}' }] } }] },
  }));
  try {
    const raw = await callGemini({ GEMINI_API_KEY: 'k' }, descriptor, PROMPT, BASE64);
    assert.equal(raw.candidates[0].content.parts[0].text, '{"a":1}');
  } finally {
    restore();
  }
});

/* ------------------------------------------------- the failures that arrive as errors */

test('an HTTP error carries the provider message and status', async () => {
  const { restore } = stubFetch(() => ({
    status: 400,
    body: { error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } },
  }));
  try {
    await assert.rejects(
      () => callGemini({ GEMINI_API_KEY: 'k' }, descriptor, PROMPT, BASE64),
      // Not anchored: assert.rejects matches against "Error: <message>".
      /Gemini: API key not valid[\s\S]*INVALID_ARGUMENT/,
    );
  } finally {
    restore();
  }
});

/* ------------------------------------------------------ the explanations */

const explain = (message) => explainModelFailure(new Error(message), 'gemini:gemini-3.8-flash');

test('a rejected Google key points at the secret and at AI Studio', () => {
  const message = explain('Gemini: API key not valid. Please pass a valid API key. (INVALID_ARGUMENT)');
  assert.match(message, /GEMINI_API_KEY/);
  assert.match(message, /Google AI Studio/);
  assert.doesNotMatch(message, /^Model call failed/);
});

test('a disabled API is distinguished from a bad key', () => {
  const message = explain(
    'Gemini: Generative Language API has not been used in project 123 before (SERVICE_DISABLED)',
  );
  assert.match(message, /Generative Language API/);
  assert.doesNotMatch(message, /key was rejected/);
});

test('an exhausted Google quota offers the free Cloudflare models as a way out', () => {
  const message = explain('Gemini: Quota exceeded (RESOURCE_EXHAUSTED)');
  assert.match(message, /quota is spent/i);
  assert.match(message, /Free daily allocation/);
});

test('a retired model name is explained as a model name, not as a broken account', () => {
  const message = explain(
    'Gemini: models/gemini-3.8-flash is not found for API version v1beta (NOT_FOUND)',
  );
  assert.match(message, /model names change/i);
  assert.match(message, /Gemini 3\.7 Flash/);
});

test('an oversized request points at the image rather than the key', () => {
  const message = explain('Gemini: Request payload size exceeds the limit (INVALID_ARGUMENT)');
  assert.match(message, /20 MB/);
});

test('a Gemini quota error is not mistaken for a Cloudflare Neurons allocation', () => {
  // Both mention 429, and the Cloudflare branch used to be the only one. Whichever branch
  // matches first wins, so the vendor prefix has to be checked before the shared symptoms.
  const message = explain('Gemini: 429 Too Many Requests (RESOURCE_EXHAUSTED)');
  assert.doesNotMatch(message, /Neurons/);
  assert.match(message, /Google AI Studio/);
});

test('an OpenAI quota error still gets the OpenAI explanation', () => {
  const message = explainModelFailure(
    new Error('OpenAI: You exceeded your current quota (insufficient_quota)'),
    'openai:gpt-4o',
  );
  assert.match(message, /platform\.openai\.com/);
});

test('a missing Google key is explained with where to put it', () => {
  const message = explain(
    'GEMINI_API_KEY is not configured. Add it as a Worker secret (Cloudflare dashboard → the Worker → Settings → Variables and Secrets → Add, type Secret).',
  );
  assert.match(message, /Worker secret/);
  assert.match(message, /GEMINI_API_KEY/);
  assert.doesNotMatch(message, /^Model call failed/);
});

/* ------------------------------------------------------------ custody */

test('no Gemini descriptor carries a credential', () => {
  for (const model of RECOGNITION_MODELS.filter((m) => m.kind === 'gemini')) {
    assert.equal(model.api_key, undefined);
    assert.doesNotMatch(JSON.stringify(model), /AIza[0-9A-Za-z_-]/, `${model.id} embeds no key`);
  }
});
