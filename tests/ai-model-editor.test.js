import test from 'node:test';
import assert from 'node:assert/strict';

test('Model editing is isolated from image polling and failed saves preserve fields', async t => {
  const data = new Map([['rei.last-probe', 'probe-1']]);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/session')) return Response.json({ actor: { id: 'admin', role: 'admin', markets: ['TW'] }, authConfigured: true });
    if (url.endsWith('/ai/state')) return Response.json({ models: [{ id: 'm1', connectionId: 'c1', displayName: 'Original', remoteModelId: 'fixture', enabled: true, revision: 3 }], connections: [{ id: 'c1', name: 'Gemini', enabled: true }], routes: [] });
    if (url.includes('/ai/models/')) { assert.equal(options.method, 'PATCH'); return Response.json({ error: { code: 'REVISION_CONFLICT', message: 'Reload required' } }, { status: 409 }); }
    if (url.includes('/ai/runs/')) return Response.json({ id: 'probe-1', state: 'processing' });
    throw new Error(`Unexpected request ${url}`);
  });
  const oldStorage = globalThis.localStorage, oldLocation = globalThis.location;
  globalThis.localStorage = { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) };
  globalThis.location = { hash: '#/admin/ai?tab=models' };
  t.after(() => { globalThis.localStorage = oldStorage; globalThis.location = oldLocation; });
  const client = await import('../public/app/execution/client.js');
  const ui = await import('../public/app/execution/ui-ai.js');
  await client.initExecution();
  let callback, scheduled = 0, renders = 0;
  t.mock.method(globalThis, 'setTimeout', cb => { callback = cb; scheduled++; return 1; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const ctx = { params: { tab: 'models' }, render: () => renders++, setParams: () => {} };
  await ui.onAction('ai-edit-model', { dataset: { id: 'm1' } }, ctx);
  let html = ui.render(ctx);
  assert.ok(!html.includes('data-action="ai-test-model"'));
  assert.ok(html.indexOf('data-form="ai-model"') < html.indexOf('Connection-specific models'));
  ui.mount(ctx); assert.equal(scheduled, 0);
  // A poll already in flight must not render after switching to the editor.
  ctx.params.tab = 'checks'; ui.render(ctx); ui.mount(ctx); assert.equal(scheduled, 1);
  const pending = callback();
  await ui.onAction('ai-tab', { dataset: { tab: 'models' } }, ctx);
  ctx.params.tab = 'models'; ui.render(ctx); ui.mount(ctx);
  await pending; assert.equal(renders, 0);
  const values = new Map(Object.entries({ connectionId: 'c1', remoteModelId: 'fixture', displayName: 'My unsaved name', maxOutputTokens: '4096', coordinateConvention: 'xywh_normalized', pricing: '', enabled: 'on' }));
  t.mock.method(globalThis, 'FormData', function () { return { get: k => values.get(k) ?? null, has: k => values.has(k) }; });
  await assert.rejects(() => ui.onSubmit({ dataset: { form: 'ai-model' } }, ctx), /Reload required/);
  html = ui.render(ctx); assert.ok(html.includes('value="My unsaved name"')); assert.ok(html.includes('value="4096"'));
  ctx.params.tab = 'checks'; html = ui.render(ctx); assert.ok(html.includes('data-action="ai-test-model"'));
});
