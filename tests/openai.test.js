/**
 * The live call cannot be exercised here, so these assert the request the Worker builds and
 * how it reacts to each documented failure — the parts most likely to be wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { callOpenAI } from '../worker.js';
import { RECOGNITION_MODELS } from '../public/app/config.js';

const DESCRIPTOR = RECOGNITION_MODELS.find((m) => m.id === 'openai:gpt-4.1-mini');
const BASE64 = 'QUJD';

/** Captures the outgoing request and answers with a canned response. */
function stubFetch(response) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.body,
    };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test('a missing key fails before any network call, naming where to put it', async () => {
  const stub = stubFetch({ body: {} });
  try {
    await assert.rejects(
      () => callOpenAI({}, DESCRIPTOR, 'read this', BASE64),
      /OPENAI_API_KEY is not configured/,
    );
    assert.equal(stub.calls.length, 0, 'no request is sent without a key');
  } finally {
    stub.restore();
  }
});

test('the request carries the key as a bearer token and never in the body', async () => {
  const stub = stubFetch({ body: { choices: [{ message: { content: '{"detections":[]}' } }] } });
  try {
    await callOpenAI({ OPENAI_API_KEY: 'sk-test-123' }, DESCRIPTOR, 'read this', BASE64);
    const [call] = stub.calls;

    assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(call.init.headers.authorization, 'Bearer sk-test-123');
    assert.doesNotMatch(JSON.stringify(call.body), /sk-test-123/, 'the key is not in the body');
  } finally {
    stub.restore();
  }
});

test('the request names the provider-side model, not the internal id', async () => {
  const stub = stubFetch({ body: { choices: [{ message: { content: '{}' } }] } });
  try {
    await callOpenAI({ OPENAI_API_KEY: 'sk-x' }, DESCRIPTOR, 'read this', BASE64);
    assert.equal(stub.calls[0].body.model, 'gpt-4.1-mini');
    assert.notEqual(stub.calls[0].body.model, DESCRIPTOR.id);
  } finally {
    stub.restore();
  }
});

test('JSON mode is requested, so the answer parses without unwrapping prose', async () => {
  const stub = stubFetch({ body: { choices: [{ message: { content: '{}' } }] } });
  try {
    await callOpenAI({ OPENAI_API_KEY: 'sk-x' }, DESCRIPTOR, 'read this', BASE64);
    assert.deepEqual(stub.calls[0].body.response_format, { type: 'json_object' });
  } finally {
    stub.restore();
  }
});

test('the image is sent as a data URL alongside the prompt', async () => {
  const stub = stubFetch({ body: { choices: [{ message: { content: '{}' } }] } });
  try {
    await callOpenAI({ OPENAI_API_KEY: 'sk-x' }, DESCRIPTOR, 'read the price list', BASE64);
    const [text, image] = stub.calls[0].body.messages[0].content;

    assert.equal(text.type, 'text');
    assert.equal(text.text, 'read the price list');
    assert.equal(image.type, 'image_url');
    assert.equal(image.image_url.url, `data:image/jpeg;base64,${BASE64}`);
    assert.equal(image.image_url.detail, 'high', 'a price list needs detail to be legible');
  } finally {
    stub.restore();
  }
});

test('an error response surfaces the provider message and code', async () => {
  const stub = stubFetch({
    ok: false,
    status: 401,
    body: { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } },
  });
  try {
    await assert.rejects(
      () => callOpenAI({ OPENAI_API_KEY: 'sk-bad' }, DESCRIPTOR, 'p', BASE64),
      /Incorrect API key provided.*invalid_api_key/,
    );
  } finally {
    stub.restore();
  }
});

test('an error response with no JSON body still fails with the status', async () => {
  const stub = stubFetch({ ok: false, status: 500, body: null });
  try {
    await assert.rejects(() => callOpenAI({ OPENAI_API_KEY: 'sk-x' }, DESCRIPTOR, 'p', BASE64), /HTTP 500/);
  } finally {
    stub.restore();
  }
});

test('the OpenAI answer shape is what the response extractor reads', async () => {
  const stub = stubFetch({
    body: { choices: [{ message: { content: '{"detections":[{"product":"Winston Red","price":13.6}]}' } }] },
  });
  try {
    const raw = await callOpenAI({ OPENAI_API_KEY: 'sk-x' }, DESCRIPTOR, 'p', BASE64);
    const text = raw?.choices?.[0]?.message?.content;
    const { parseModelResponse } = await import('../shared/recognition.js');
    const { detections } = parseModelResponse(text, [
      { id: 'sku-jti-winston-red', name: 'Winston Red', brand_name: 'Winston', sku_code: 'WIN-RED', is_jti: true },
    ]);
    assert.equal(detections.length, 1);
    assert.equal(detections[0].sku_candidate, 'sku-jti-winston-red');
    assert.equal(detections[0].price_candidate, 13.6);
  } finally {
    stub.restore();
  }
});
