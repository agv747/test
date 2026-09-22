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
  delete f.env.AI_CREDENTIALS_ENCRYPTION_KEY;
  assert.equal((await f.request('/ai/connections', { name: 'No encryption', provider: 'gemini', allowedMarkets: ['TW'], enabled: true, apiKey: secret })).body.error.code, 'AI_SECRET_STORE_UNAVAILABLE'); f.DB.close();
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
  assert.equal((await f.request(`/ai/routes/TW/${TASK_TW}`, route, { method: 'PUT' })).body.error.code, 'AI_MODEL_NOT_ALLOWED');
  const stored = await readRecord(f.DB, 'model', m.id); stored.data.capabilities = { [TASK_TW]: { state: 'verified' }, [TASK_SG]: { state: 'verified' } }; await writeRecord(f.DB, 'model', m.id, stored.data, stored.revision);
  assert.equal((await f.request(`/ai/routes/TW/${TASK_TW}`, route, { method: 'PUT' })).status, 200);
  assert.equal((await readRecord(f.DB, 'route', TASK_SG)), null);
  const response = await f.request('/ai/runs', { task: TASK_TW, modelId: m.id, captureId: 'invented', captureRevision: 1, idempotencyKey: 'fixture-run-key' }, { credential: fieldToken });
  assert.equal(response.status, 403); assert.equal(response.body.error.code, 'AI_MODEL_NOT_ALLOWED'); f.DB.close();
});
