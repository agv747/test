import test from 'node:test';
import assert from 'node:assert/strict';
import { handleExecution } from '../server/execution/api.js';
import { readRecord, writeRecord, readWorkspace } from '../server/execution/storage.js';
import { sqliteD1 } from './helpers/d1.js';
import { buildTaiwanDemo } from '../public/app/execution/demo.js';
import { TASK_TW, TASK_SG } from '../public/app/execution/ai-contracts.js';
import { PROBE_PNG } from '../server/execution/probe-image.js';
const token = 'test_only_admin_token_0000000000000000000000000000000000000';
const fieldToken = 'test_only_field_token_0000000000000000000000000000000000000';
function fixture() {
  const DB = sqliteD1();
  const env = { DB, ADMIN_ACCESS_TOKEN: token, APP_ACCESS_USERS_JSON: JSON.stringify([{ id: 'tw-field-1', name: 'Field', role: 'field', markets: ['TW'], token: fieldToken }]), GEMINI_API_KEY: 'test-only-provider-key', AI_CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64') };
  async function request(path, body, { method = body === undefined ? 'GET' : 'POST', credential = token, origin = 'https://app.example' } = {}) {
    const headers = { origin, ...(credential ? { cookie: `rei_session=${credential}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };
    const response = await handleExecution(new Request(`https://app.example/api/execution${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
    return { response, status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? await response.json() : new Uint8Array(await response.arrayBuffer()) };
  }
  return { env, DB, request };
}
test('Private endpoints require a server session, enforce CSRF and never trust demo role switches', async () => {
  const f = fixture();
  assert.equal((await f.request('/workspace', undefined, { credential: null })).status, 401);
  const login = await f.request('/session', { accessToken: token }, { credential: null });
  assert.equal(login.status, 200); assert.match(login.response.headers.get('set-cookie'), /HttpOnly/); assert.match(login.response.headers.get('set-cookie'), /SameSite=Strict/);
  assert.equal((await f.request('/commands', { expectedRevision: 0, command: { type: 'setup', payload: { catalogue: [], fixtures: [] } } }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/ai/connections', { role: 'admin' }, { credential: fieldToken })).status, 403); f.DB.close();
});
test('Credential storage is encrypted and API DTOs are redacted; lack of encryption is a hard error', async () => {
  const f = fixture(), secret = 'not-a-real-api-key-fixture';
  const created = await f.request('/ai/connections', { name: 'Gemini fixture', provider: 'gemini', allowedMarkets: ['TW', 'SG'], enabled: true, apiKey: secret });
  assert.equal(created.status, 201); const id = created.body.connection.id;
  const row = await readRecord(f.DB, 'connection', id); assert.ok(row.data.encryptedCredential.ciphertext); assert.ok(!JSON.stringify(row).includes(secret));
  const state = await f.request('/ai/state'); assert.ok(!JSON.stringify(state.body).includes(secret)); assert.ok(!JSON.stringify(state.body).includes('ciphertext'));
  assert.equal(state.body.secretStoreMode, 'worker_secret');

  // Without the Worker secret the store keeps working, because a deployment that cannot see
  // secrets otherwise has no way to configure a provider at all. The credential is still
  // encrypted, and the key that encrypts it must never leave through the API.
  delete f.env.AI_CREDENTIALS_ENCRYPTION_KEY;
  const fallback = await f.request('/ai/connections', { name: 'Database mode', provider: 'openai', allowedMarkets: ['TW'], enabled: true, apiKey: secret });
  assert.equal(fallback.status, 201);
  const stored = await readRecord(f.DB, 'connection', fallback.body.connection.id);
  assert.ok(stored.data.encryptedCredential.ciphertext);
  assert.ok(!JSON.stringify(stored).includes(secret));
  const degraded = await f.request('/ai/state');
  assert.equal(degraded.body.secretStoreMode, 'database');
  const keyRecord = await readRecord(f.DB, 'secret_store', 'ai_credentials');
  assert.ok(keyRecord.data.key, 'a key is provisioned once and kept');
  assert.ok(!JSON.stringify(degraded.body).includes(keyRecord.data.key), 'the encryption key must not reach any DTO');
  // Storing is half the job: the credential must come back out, with no Worker secret in sight.
  const { getCredential } = await import('../server/execution/credentials.js');
  assert.equal(await getCredential(f.env, stored.data), secret);
  // The same key is reused, or half the stored credentials would become undecryptable.
  await f.request('/ai/connections', { name: 'Second', provider: 'anthropic', allowedMarkets: ['TW'], enabled: true, apiKey: secret });
  assert.equal((await readRecord(f.DB, 'secret_store', 'ai_credentials')).data.key, keyRecord.data.key);
  f.DB.close();
});
test('API stores original and processed private evidence and rejects another fixture image', async () => {
  const f = fixture(), seed = buildTaiwanDemo();
  let r = await f.request('/commands', { expectedRevision: 0, command: { type: 'setup', payload: { catalogue: seed.catalogue, fixtures: seed.fixtures } } }); assert.equal(r.status, 200);
  r = await f.request('/commands', { expectedRevision: r.body.revision, command: { type: 'capture.create', payload: { fixtureId: 'F4', capturedAt: '2026-09-20T01:00:00Z', source: 'camera', mode: 'manual' } } }); const cap = r.body.result;
  r = await f.request(`/captures/${cap.id}/images`, { expectedRevision: r.body.revision, original: `data:image/png;base64,${PROBE_PNG}`, processed: `data:image/png;base64,${PROBE_PNG}`, width: 400, height: 180, name: 'Synthetic private probe' });
  assert.equal(r.status, 201); assert.ok(r.body.image.originalHash); assert.equal(r.body.image.originalHash, r.body.image.processedHash);
  assert.equal((await f.request(`/images/${r.body.image.id}`)).status, 200);
  assert.equal((await f.request(`/images/${r.body.image.id}`, undefined, { credential: fieldToken })).status, 404);
  const fieldWorkspace = await f.request('/workspace', undefined, { credential: fieldToken }); assert.ok(!fieldWorkspace.body.workspace.captures.some(c => c.fixtureId === 'F4')); f.DB.close();
});
test('PG-11: a repeated HTTP submission returns the same assessment even with stale workspace revision', async () => {
  const f = fixture(), w = buildTaiwanDemo(), a = w.assessments[0]; await writeRecord(f.DB, 'workspace', 'TW', w);
  const result = await f.request('/commands', { expectedRevision: 0, command: { type: 'assessment.submit', payload: { captureId: a.captureId, reviewId: a.reviewId, incompleteReason: a.incompleteReason, idempotencyKey: a.idempotencyKey, expectedRevision: 1 } } });
  assert.equal(result.status, 200); assert.equal(result.body.result.id, a.id); assert.equal((await readWorkspace(f.DB)).revision, 1); f.DB.close();
});
test('AI-07/08: field override is denied; server settings and market defaults stay separate', async () => {
  const f = fixture();
  const c = (await f.request('/ai/connections', { name: 'Fixture connection', provider: 'gemini', allowedMarkets: ['TW', 'SG'], enabled: true, credentialSource: 'environment' })).body.connection;
  const m = (await f.request('/ai/models', { connectionId: c.id, remoteModelId: 'fixture-model-only', displayName: 'Fixture model', maxOutputTokens: 8192, enabled: true, structuredOutput: true })).body.model;
  assert.deepEqual(m.capabilities, {});
  const route = { expectedRevision: 0, defaultModelId: m.id, allowedModelIds: [m.id], timeoutMs: 60000, maxOutputTokens: 8192, fieldOverride: false };
  assert.equal((await f.request(`/ai/routes/TW/${TASK_TW}`, route, { method: 'PUT' })).status, 200);
  route.expectedRevision = 1;
  const stored = await readRecord(f.DB, 'model', m.id); stored.data.capabilities = { [TASK_TW]: { state: 'verified' }, [TASK_SG]: { state: 'verified' } }; await writeRecord(f.DB, 'model', m.id, stored.data, stored.revision);
  assert.equal((await f.request(`/ai/routes/TW/${TASK_TW}`, route, { method: 'PUT' })).status, 200);
  assert.equal((await readRecord(f.DB, 'route', TASK_SG)), null);
  const response = await f.request('/ai/runs', { task: TASK_TW, modelId: m.id, captureId: 'invented', captureRevision: 1, idempotencyKey: 'fixture-run-key' }, { credential: fieldToken });
  assert.equal(response.status, 403); assert.equal(response.body.error.code, 'AI_MODEL_NOT_ALLOWED'); f.DB.close();
});


test('Administrator login accepts three characters while user tokens retain their minimum', async () => {
  const f = fixture();
  try {
    f.env.ADMIN_ACCESS_TOKEN = 'a_3';
    assert.equal((await f.request('/session', undefined, { credential: null })).body.authConfigured, true);
    const login = await f.request('/session', { accessToken: 'a_3' }, { credential: null });
    assert.equal(login.status, 200);
    assert.equal(login.body.actor.role, 'admin');
    assert.match(login.response.headers.get('set-cookie'), /rei_session=a_3;/);
    assert.equal((await f.request('/workspace', undefined, { credential: 'a_3' })).status, 200);
    assert.equal((await f.request('/session', { accessToken: 'bad' }, { credential: null })).status, 401);
    for (const invalid of ['a', 'ab', 'a b', 'a;b', 'a'.repeat(513)]) {
      f.env.ADMIN_ACCESS_TOKEN = invalid;
      assert.equal((await f.request('/session', { accessToken: invalid }, { credential: null })).status, 401);
    }
    delete f.env.ADMIN_ACCESS_TOKEN;
    f.env.APP_ACCESS_USERS_JSON = JSON.stringify([{ id: 'short-user', name: 'User', role: 'admin', markets: ['TW'], token: 'xyz' }]);
    assert.equal((await f.request('/session', undefined, { credential: null })).body.authConfigured, false);
    assert.equal((await f.request('/session', { accessToken: 'xyz' }, { credential: null })).status, 401);
  } finally { f.DB.close(); }
});

test('a pasted key alone configures a provider end to end, with no Worker secret anywhere', async t => {
  // The environment a deployment that cannot see secrets actually has: a database and a way in.
  const DB = sqliteD1();
  const env = { DB, ADMIN_ACCESS_TOKEN: token };
  const call = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const headers = { origin: 'https://app.example', cookie: `rei_session=${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };
    const response = await handleExecution(new Request(`https://app.example/api/execution${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
    return { status: response.status, body: await response.json() };
  };
  const PASTED = 'pasted-key-fixture-value';
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push({ url: String(url), key: options?.headers?.['x-goog-api-key'] ?? null });
    if (String(url).includes(':generateContent')) {
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ schemaVersion: '1', task: TASK_TW, products: [
        { detectionId: 'd1', imageId: 'probe-image', bbox: [0.1, 0.1, 0.2, 0.2], slotKeyCandidate: null, skuCandidateId: 'PROBE-A', alternativeSkuIds: [], readableText: null, score: null, scoreType: 'none' },
        { detectionId: 'd2', imageId: 'probe-image', bbox: [0.5, 0.1, 0.2, 0.2], slotKeyCandidate: null, skuCandidateId: 'PROBE-B', alternativeSkuIds: [], readableText: null, score: null, scoreType: 'none' },
      ], proposedEmptySlots: [], uncertainRegions: [], qualityWarnings: [] }) }] }, finishReason: 'STOP' }] });
    }
    return Response.json({ models: [{ name: 'models/gemini-vision-fixture', displayName: 'Vision fixture', supportedGenerationMethods: ['generateContent'], outputTokenLimit: 8192 }] });
  });

  // 1. Paste the key. Nothing else is asked for, and it must land encrypted, not as a plain field.
  const created = await call('/ai/connections', { name: 'Google Gemini', provider: 'gemini', allowedMarkets: ['SG', 'TW'], enabled: true, apiKey: PASTED });
  assert.equal(created.status, 201);
  const id = created.body.connection.id;
  const row = await readRecord(DB, 'connection', id);
  assert.equal(row.data.credentialSource, 'encrypted', 'a pasted key must switch the source away from the environment');
  assert.ok(!JSON.stringify(row).includes(PASTED));

  // 2. Check the connection. Every step passes, and the provider is reached with the pasted key.
  const report = await call(`/ai/connections/${id}/verify`, { remoteModelId: 'gemini-vision-fixture' });
  assert.equal(report.status, 200);
  assert.deepEqual(report.body.steps.map(s => s.state), ['passed', 'passed', 'passed'], JSON.stringify(report.body.steps));
  assert.ok(seen.every(r => r.key === PASTED), 'every provider call must carry the pasted key');
  assert.ok(seen.some(r => r.url.includes(':generateContent')), 'the check must actually send the probe image');

  // 3. Models come from the listing, enabled, and a route can be saved against one.
  await call(`/ai/connections/${id}/refresh-models`, {});
  const state = await call('/ai/state');
  const model = state.body.models.find(m => m.remoteModelId === 'gemini-vision-fixture');
  assert.ok(model?.enabled, 'a refreshed model must be usable without another edit');
  assert.equal(state.body.secretStoreMode, 'database');
  const route = await call(`/ai/routes/TW/${TASK_TW}`, { defaultModelId: model.id, allowedModelIds: [model.id], fallbackModelId: null, fieldOverride: false, timeoutMs: 60000, maxOutputTokens: 8192, expectedRevision: 0 }, 'PUT');
  assert.equal(route.status, 200);

  // 4. A real run reaches the provider on the stored key, which is the thing that kept failing.
  const { executeRun, processDueJobs } = await import('../server/execution/jobs.js');
  const probe = await call(`/ai/models/${model.id}/test-task`, { task: TASK_TW, idempotencyKey: crypto.randomUUID() });
  assert.equal(probe.status, 202);
  await processDueJobs(env);
  const finished = await call(`/ai/runs/${probe.body.id}`);
  assert.equal(finished.body.state, 'needs_review', JSON.stringify(finished.body.error));
  assert.ok(!JSON.stringify(finished.body).includes(PASTED), 'the key must not come back through the run API');
  DB.close();
});
