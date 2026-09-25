import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The connection screen, which replaced six tabs and three disagreeing checks.
 *
 * What these pin is the behaviour that was missing when a model that does not exist spent two
 * days as the configured default: the check reports each step separately, and a model the key
 * does not offer is called out rather than silently accepted.
 */
const state = (over = {}) => ({
  models: [{ id: 'm2', connectionId: 'c2', displayName: 'Gemini fixture', remoteModelId: 'fixture', enabled: true, revision: 1, maxOutputTokens: 4096 }],
  connections: [{ id: 'c2', name: 'Google Gemini', provider: 'gemini', enabled: true, credentialConfigured: true, credentialSource: 'encrypted', allowedMarkets: ['SG', 'TW'], revision: 2 }],
  routes: [], secretStoreConfigured: true, environmentCredentials: {}, ...over,
});

test('the check reports every step, and names a model the key does not offer', async t => {
  const report = {
    ok: false,
    steps: [
      { key: 'credential', label: 'API key', state: 'passed', detail: 'Stored in this application, encrypted.', durationMs: null },
      { key: 'listing', label: 'Model list', state: 'passed', detail: '61 models offered by this key.', durationMs: 420 },
      { key: 'vision', label: 'Image recognition', state: 'failed', detail: 'This key does not offer gemini-3.7-flash. Pick one of the 61 models listed above.', durationMs: 900 },
    ],
    models: [{ remoteModelId: 'fixture', displayName: 'Gemini fixture' }],
  };
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/session')) return Response.json({ actor: { id: 'admin', role: 'admin', markets: ['SG', 'TW'] }, authConfigured: true });
    if (url.endsWith('/ai/state')) return Response.json(state({ routes: [{ task: 'tw_planogram_recognition', defaultModelId: 'ghost', revision: 1 }], models: [{ id: 'ghost', connectionId: 'c2', displayName: 'Gemini 3.7 Flash', remoteModelId: 'gemini-3.7-flash', enabled: true, revision: 1 }] }));
    if (url.endsWith('/verify')) return Response.json(report);
    throw new Error(`Unexpected request ${url}`);
  });
  const oldStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  t.after(() => { globalThis.localStorage = oldStorage; });
  const client = await import('../public/app/execution/client.js');
  const ui = await import('../public/app/execution/ui-ai.js');
  await client.initExecution();
  const ctx = { params: { tab: 'connect' }, render: () => {}, setParams: () => {} };

  await ui.onAction('ai-verify', { dataset: { id: 'c2' } }, ctx);
  const html = ui.render(ctx);
  for (const label of ['API key', 'Model list', 'Image recognition']) assert.match(html, new RegExp(label));
  assert.match(html, /61 models offered by this key/);
  assert.match(html, /rei-step--passed/);
  assert.match(html, /rei-step--failed/);
  // The saved default is not in the provider's list, so the screen must say so.
  assert.match(html, /gemini-3\.7-flash is saved here but this key does not offer it/);
  // The removed tabs must not come back with their hand-typed model id field.
  assert.ok(!html.includes('name="remoteModelId"'));
  assert.ok(!html.includes('name="timeoutSeconds"'));
  assert.ok(!html.includes('name="allowedModelIds"'));
});

test('choosing a model saves exactly one route, with no advanced fields', async t => {
  let saved;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/session')) return Response.json({ actor: { id: 'admin', role: 'admin', markets: ['SG', 'TW'] } });
    if (url.endsWith('/ai/state')) return Response.json(state());
    if (url.includes('/ai/routes/')) { saved = JSON.parse(options.body); return Response.json({}); }
    throw new Error(`Unexpected request ${url}`);
  });
  const oldStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  t.after(() => { globalThis.localStorage = oldStorage; });
  const client = await import('../public/app/execution/client.js');
  const ui = await import('../public/app/execution/ui-ai.js');
  await client.initExecution();
  const ctx = { params: { tab: 'connect' } };
  assert.match(ui.render(ctx), /Gemini fixture/);

  t.mock.method(globalThis, 'FormData', function () { return { get: k => (k === 'modelId' ? 'm2' : null) }; });
  await ui.onSubmit({ dataset: { form: 'ai-default', market: 'TW', task: 'tw_planogram_recognition' } }, ctx);
  assert.equal(saved.defaultModelId, 'm2');
  assert.deepEqual(saved.allowedModelIds, ['m2']);
  assert.equal(saved.maxOutputTokens, 4096);
  assert.equal(saved.fieldOverride, false);
  assert.equal(saved.fallbackModelId, null);
  assert.match(ui.render(ctx), /Model saved/);
});

test('models that make images or speech are not offered for recognition', async () => {
  const { readsImages } = await import('../public/app/execution/ui-ai.js');
  // The one that was actually picked for a planogram audit, and its neighbours in the listing.
  for (const id of ['gemini-3.1-flash-lite-image', 'gemini-2.5-flash-image', 'gemini-3.8-flash-tts', 'gemini-2.5-flash-native-audio-latest', 'gemini-3.1-flash-live-preview', 'text-embedding-004', 'imagen-3.0', 'veo-2']) {
    assert.equal(readsImages(id), false, `${id} cannot read a shelf`);
  }
  for (const id of ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite']) {
    assert.equal(readsImages(id), true, `${id} must stay selectable`);
  }
});

test('saving with an empty key does not claim a key was saved', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/session')) return Response.json({ actor: { id: 'admin', role: 'admin', markets: ['SG', 'TW'] } });
    if (url.endsWith('/ai/state')) return Response.json(state({ connections: [{ id: 'c2', name: 'Google Gemini', provider: 'gemini', enabled: true, credentialConfigured: false, credentialSource: 'environment', allowedMarkets: ['SG', 'TW'], revision: 2 }] }));
    if (url.includes('/ai/connections')) {
      // Whatever else is sent, an empty field must not send a key.
      assert.ok(!('apiKey' in JSON.parse(options.body)), 'an empty field must not post a key');
      return Response.json({ connection: { id: 'c2', credentialSource: 'environment' } });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  const oldStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  t.after(() => { globalThis.localStorage = oldStorage; });
  const client = await import('../public/app/execution/client.js');
  const ui = await import('../public/app/execution/ui-ai.js');
  await client.initExecution();
  const ctx = { params: { tab: 'connect' } };
  t.mock.method(globalThis, 'FormData', function () { return { get: () => '', getAll: () => [] }; });
  await ui.onSubmit({ dataset: { form: 'ai-connect' }, querySelector: () => ({ value: '' }) }, ctx);
  const html = ui.render(ctx);
  assert.match(html, /still depends on a Worker secret/);
  assert.ok(!html.includes('Key saved'), 'it must not report a save that did not happen');
});
