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
    assert.ok(['free', 'paid'].includes(model.tier), `${model.id} declares a tier`);
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
