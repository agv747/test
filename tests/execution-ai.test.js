import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { TASK_TW, TASK_SG, normalizeBox, validateOutput, recognitionPrompt, proposalToReview, compareProposal } from '../public/app/execution/ai-contracts.js';
import { buildTaiwanDemo } from '../public/app/execution/demo.js';
import { encryptCredential, getCredential, connectionDto } from '../server/execution/credentials.js';
import { validateConnection, buildProviderRequest, parseProviderResponse, runProvider, providerFetch, estimateCost, listProviderModels } from '../server/execution/adapters.js';
import { validateRoute, probeInput, inputForCapture, enqueueRun, executeRun, readRun, processDueJobs } from '../server/execution/jobs.js';
import { initDb, writeRecord, readRecord, fromBase64, saveMedia, readMedia } from '../server/execution/storage.js';
import { sqliteD1 } from './helpers/d1.js';

const secretEnv = { AI_CREDENTIALS_ENCRYPTION_KEY: Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64') };
const conn = provider => validateConnection({ id: `c-${provider}`, name: 'Fixture connection', provider, baseUrl: 'https://gateway.example.com/v1', protocol: 'responses', headerMode: 'bearer', allowedMarkets: ['TW', 'SG'], enabled: true }, { AI_COMPATIBLE_BASE_URLS: 'https://gateway.example.com/v1' });
const model = { id: 'model-fixture', displayName: 'Fixture-only model', remoteModelId: 'fixture-model', structuredOutput: true, maxOutputTokens: 8192, coordinateConvention: 'xywh_normalized', enabled: true, capabilities: { [TASK_TW]: { state: 'verified' } } };
const input = probeInput(TASK_TW);
const output = () => ({ schemaVersion: '1', task: TASK_TW, products: ['A', 'B'].map((v, i) => ({ detectionId: `d-${v}`, imageId: 'probe-image', bbox: [i ? .525 : .025, .23, .45, .71], slotKeyCandidate: `R1C${i + 1}`, skuCandidateId: `PROBE-${v}`, alternativeSkuIds: [], readableText: `PROBE-${v}`, score: null, scoreType: 'none' })), proposedEmptySlots: [], uncertainRegions: [], qualityWarnings: [] });
const geminiResponse = value => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }], modelVersion: 'fixture-resolved', usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 200 }, responseId: 'provider-response-fixture' });

test('AI-01/02: credentials use unique authenticated encryption and write-only DTOs', async () => {
  const c = conn('gemini'), key = 'fixture-secret-not-a-live-key';
  const a = await encryptCredential(secretEnv, key, c.id), b = await encryptCredential(secretEnv, key, c.id);
  assert.notEqual(a.iv, b.iv); assert.notEqual(a.ciphertext, b.ciphertext); assert.ok(!JSON.stringify(a).includes(key));
  const stored = { ...c, credentialSource: 'encrypted', encryptedCredential: a };
  assert.equal(await getCredential(secretEnv, stored), key);
  assert.ok(!JSON.stringify(connectionDto(stored, secretEnv)).includes(a.ciphertext));
  assert.equal(connectionDto(stored, secretEnv).credentialConfigured, true);
  await assert.rejects(() => getCredential(secretEnv, { ...stored, id: 'other-connection' }), { code: 'AI_SECRET_STORE_UNAVAILABLE' });
  await assert.rejects(() => encryptCredential({}, key, c.id), { code: 'AI_SECRET_STORE_UNAVAILABLE' });
});
test('AI-03/04: all four provider adapters send native image and structured-output contracts', async () => {
  for (const provider of ['gemini', 'openai', 'anthropic', 'openai_compatible']) {
    const c = conn(provider), r = buildProviderRequest(c, model, input, { maxOutputTokens: 8192 });
    assert.ok(!JSON.stringify(r.body).includes('Bearer'));
    if (provider === 'gemini') { assert.match(r.suffix, /fixture-model:generateContent$/); assert.equal(r.body.contents[0].parts[2].inlineData.mimeType, 'image/png'); assert.equal(r.body.generationConfig.responseJsonSchema.type, 'object'); }
    else if (provider === 'anthropic') { assert.equal(r.suffix, '/messages'); assert.equal(r.body.messages[0].content[2].source.media_type, 'image/png'); assert.equal(r.body.output_config.format.type, 'json_schema'); }
    else { assert.equal(r.suffix, '/responses'); assert.equal(r.body.input[0].content[2].type, 'input_image'); assert.equal(r.body.store, false); assert.equal(r.body.text.format.strict, true); }
  }
  const r = buildProviderRequest({ ...conn('openai_compatible'), protocol: 'chat_completions' }, model, input, {});
  assert.equal(r.suffix, '/chat/completions'); assert.equal(r.body.messages[0].content[1].type, 'image_url');
  const response = await runProvider(conn('gemini'), 'fixture-key', model, input, { timeoutMs: 1000, maxOutputTokens: 8192 }, { fetchImpl: async (url, options) => { assert.equal(new URL(url).host, 'generativelanguage.googleapis.com'); assert.equal(options.headers['x-goog-api-key'], 'fixture-key'); assert.equal(options.redirect, 'manual'); return Response.json(geminiResponse(output()), { headers: { 'x-request-id': 'req-fixture' } }); } });
  assert.equal(response.resolvedModelId, 'fixture-resolved'); assert.equal(response.requestId, 'req-fixture'); assert.equal(response.result.products.length, 2);
});
test('AI-05: model listing is paginated and carries no assumed capability', async () => {
  const page = await listProviderModels(conn('gemini'), 'fixture-key', 'token with spaces', { fetchImpl: async url => { assert.match(url, /pageToken=token%20with%20spaces/); return Response.json({ models: [{ name: 'models/a', displayName: 'A' }], nextPageToken: 'next' }); } });
  assert.equal(page.models[0].remoteModelId, 'a'); assert.equal(page.nextCursor, 'next'); assert.equal(page.models[0].capabilities, undefined);
});
test('AI-06: optional probes do not block selection; disabled and wrong-market models are rejected', () => {
  const route = { defaultModelId: model.id, allowedModelIds: [model.id], timeoutMs: 60000, maxOutputTokens: 8192 }, c = { ...conn('gemini'), credentialConfigured: true }, m = { ...model, connectionId: c.id };
  assert.equal(validateRoute(route, [m], [c], 'TW', TASK_TW).fallbackModelId, null);
  assert.equal(validateRoute(route, [{ ...m, capabilities: {} }], [c], 'TW', TASK_TW).defaultModelId, m.id);
  for (const bad of [{ ...m, enabled: false }]) assert.throws(() => validateRoute(route, [bad], [c], 'TW', TASK_TW), { code: 'AI_MODEL_NOT_ALLOWED' });
  assert.throws(() => validateRoute(route, [m], [{ ...c, allowedMarkets: ['SG'] }], 'TW', TASK_TW), { code: 'AI_MODEL_NOT_ALLOWED' });
});
test('AI-09: errors are typed; only transient transport failures are retryable', async () => {
  for (const [status, code, retryable] of [[401, 'AI_AUTH_FAILED', false], [403, 'AI_AUTH_FAILED', false], [429, 'AI_RATE_LIMITED', true], [500, 'AI_MODEL_UNAVAILABLE', true], [404, 'AI_MODEL_UNAVAILABLE', false], [400, 'AI_IMAGE_UNSUPPORTED', false]]) {
    await assert.rejects(() => providerFetch(conn('gemini'), 'fixture-key', '/models', { fetchImpl: async () => new Response('provider may echo a secret here', { status, headers: { 'retry-after': '7' } }) }), e => e.code === code && e.retryable === retryable && !e.message.includes('echo'));
  }
  await assert.rejects(() => providerFetch(conn('gemini'), 'fixture-key', '/models', { timeoutMs: 10, fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }), { code: 'AI_TIMEOUT' });
  assert.throws(() => parseProviderResponse('gemini', 'gemini', { promptFeedback: { blockReason: 'SAFETY' } }), e => e.code === 'AI_REFUSED' && !e.retryable);
});
test('a failing status says what to do about it, without echoing the response', async () => {
  const body = 'provider may echo a secret here';
  const expect = { 404: /refresh the model list/i, 500: /outage on the provider side/i, 429: /limit to reset/i, 401: /Check the API key/i };
  for (const [status, pattern] of Object.entries(expect)) {
    await assert.rejects(
      () => providerFetch(conn('gemini'), 'fixture-key', '/models', { fetchImpl: async () => new Response(body, { status: Number(status) }) }),
      e => pattern.test(e.message) && !e.message.includes('echo'),
      `status ${status} should carry its own hint and never the body`);
  }
});
test('AI-10/18: invalid IDs, malformed boxes, unknown fields and incomplete responses fail', () => {
  assert.equal(validateOutput(output(), input).products.length, 2);
  for (const mutate of [o => { o.products[0].skuCandidateId = 'invented'; }, o => { o.products[0].imageId = 'another-outlet'; }, o => { o.products[0].bbox = [.9, 0, .5, 1]; }, o => { o.products[0].slotKeyCandidate = 'R99C1'; }, o => { o.adherence = 100; }, o => { o.products[0].score = 90; }]) { const bad = output(); mutate(bad); assert.throws(() => validateOutput(bad, input), { code: 'AI_INVALID_OUTPUT' }); }
  assert.throws(() => validateOutput('not json', input), { code: 'AI_INVALID_OUTPUT' });
  assert.throws(() => parseProviderResponse('gemini', 'gemini', { candidates: [{ finishReason: 'MAX_TOKENS' }] }), { code: 'AI_RESPONSE_TRUNCATED' });
  assert.throws(() => parseProviderResponse('openai', 'responses', { status: 'incomplete', output: [] }), { code: 'AI_RESPONSE_TRUNCATED' });
  assert.throws(() => parseProviderResponse('anthropic', 'anthropic', { stop_reason: 'refusal' }), { code: 'AI_REFUSED' });
  assert.match(recognitionPrompt(input), /untrusted observation data/);
});
test('AI-11: coordinate conventions are explicit, never assumed from the provider name', () => {
  assert.deepEqual(normalizeBox([100, 200, 500, 600], 'yxyx_1000'), [.2, .1, .4, .4]);
  assert.deepEqual(normalizeBox([200, 100, 400, 400], 'xywh_pixels', { width: 1000, height: 2000 }), [.2, .05, .4, .2]);
});
test('AI-13: raw unknowns count against accuracy; no labels means no accuracy', () => {
  const w = buildTaiwanDemo(), a = w.assessments[0], proposal = cloneSlots(a.slots); proposal[0].state = 'unknown'; proposal[0].confirmedSkuId = null;
  assert.equal(compareProposal(a.reference.plan, proposal, a.slots).accuracy, 19 / 20);
  assert.equal(compareProposal(a.reference.plan, proposal, null).accuracy, null);
  assert.equal(compareProposal(a.reference.plan, proposal, a.slots).unknown, 1);
});
function cloneSlots(slots) { return structuredClone(slots); }
test('AI-14: missing usage/pricing is unavailable, complete versioned schedules are explicit', () => {
  assert.equal(estimateCost({}, null), null); assert.equal(estimateCost(null, {}), null);
  const p = { version: 'v1', source: 'Fixture only', currency: 'USD', effectiveFrom: '2026-01-01', completeBillingCoverage: true, categories: [{ usagePath: 'input_tokens', ratePerMillion: 1 }] };
  assert.equal(estimateCost({ input_tokens: 1000 }, p).amount, .001); assert.equal(estimateCost({}, p), null);
});
test('AI-17: compatible endpoint policy rejects private/IP/unapproved and credential-bearing URLs', () => {
  for (const url of ['http://gateway.example.com/v1', 'https://127.0.0.1/v1', 'https://169.254.169.254/v1', 'https://[::1]/v1', 'https://user:password@gateway.example.com/v1', 'https://gateway.example.com/v1?token=x', 'https://not-approved.example/v1', 'https://host.internal/v1']) assert.throws(() => validateConnection({ ...conn('openai_compatible'), baseUrl: url }, { AI_COMPATIBLE_BASE_URLS: 'https://gateway.example.com/v1' }), /approved|allowlist/);
});
test('Recognition input excludes expected SKU arrangement, facing rules and ground truth', () => {
  const w = buildTaiwanDemo(), cap = w.captures[0]; cap.images[0] = { ...cap.images[0], processedHash: 'fixturehash', mimeType: 'image/png' };
  const text = JSON.stringify(inputForCapture(cap, w));
  assert.ok(!text.includes('allowedSkuIds')); assert.ok(!text.includes('facingRules')); assert.ok(!text.includes('confirmedSkuId')); assert.ok(!text.includes('groundTruth'));
});
test('AI-08/16: durable jobs freeze selection, lease once, retain results without changing reviewed evidence', async () => {
  const DB = sqliteD1(), env = { DB, GEMINI_API_KEY: 'fixture-key' }, actor = { id: 'admin', role: 'admin', markets: ['TW'] };
  const selection = { model, connection: { ...conn('gemini'), credentialSource: 'environment' }, route: { timeoutMs: 1000, maxOutputTokens: 8192 }, routeRevision: 1, task: TASK_TW, market: 'TW', promptVersion: '1', schemaVersion: '1' };
  const run = await enqueueRun(env, actor, input, selection, { idempotencyKey: 'durable-key' }); selection.model = { ...model, remoteModelId: 'changed-later' };
  let count = 0;
  const fetchImpl = async () => { count++; return Response.json(geminiResponse(output())); };
  await Promise.all([executeRun(env, run.id, { fetchImpl }), executeRun(env, run.id, { fetchImpl })]);
  const result = await readRun(env, actor, run.id); assert.equal(count, 1); assert.equal(result.remoteModelId, 'fixture-model'); assert.equal(result.state, 'needs_review'); assert.equal(result.estimatedCost, null);
  assert.equal(await readRecord(DB, 'workspace', 'TW'), null); DB.close();
});
test('AI-10: a single schema repair is recorded and a second invalid response fails', async () => {
  const DB = sqliteD1(), env = { DB, GEMINI_API_KEY: 'fixture-key' }, actor = { id: 'admin', role: 'admin', markets: ['TW'] };
  const selection = { model, connection: { ...conn('gemini'), credentialSource: 'environment' }, route: { timeoutMs: 1000, maxOutputTokens: 8192 }, task: TASK_TW, market: 'TW' };
  const run = await enqueueRun(env, actor, input, selection, { idempotencyKey: 'repair-key' });
  const fetchImpl = async () => Response.json(geminiResponse({ invalid: true }));
  await executeRun(env, run.id, { fetchImpl }); assert.equal((await readRun(env, actor, run.id)).state, 'queued');
  await executeRun(env, run.id, { fetchImpl }); const result = await readRun(env, actor, run.id);
  assert.equal(result.state, 'failed'); assert.equal(result.attempts.length, 2); assert.equal(result.attempts[1].repair, true); assert.equal(result.error.code, 'AI_INVALID_OUTPUT'); DB.close();
});
test('Durable image chunks reconstruct exact original bytes', async () => {
  const DB = sqliteD1(); await initDb(DB); const bytes = new Uint8Array(300000); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  await saveMedia(DB, 'private-image', bytes); assert.deepEqual(await readMedia(DB, 'private-image'), bytes); DB.close();
});


test('Provider requests use Workers-compatible manual redirects and never forward credentials', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    await assert.rejects(() => providerFetch(conn('gemini'), 'fixture-key', '/models', {
      fetchImpl: async (url, options) => {
        calls++;
        assert.equal(new URL(url).host, 'generativelanguage.googleapis.com');
        assert.equal(options.redirect, 'manual');
        return new Response(null, { status, headers: { location: 'https://untrusted.example/key' } });
      }
    }), e => e.code === 'AI_REDIRECT_BLOCKED' && e.retryable === false && !e.message.includes('fixture-key'));
    assert.equal(calls, 1);
  }
});

test('Browser process requests do not own provider calls; scheduled jobs execute once', async t => {
  const { handleExecution } = await import('../server/execution/api.js');
  const DB = sqliteD1(), token = 'fixture_admin_token_for_scheduled_jobs_123456';
  const env = { DB, ADMIN_ACCESS_TOKEN: token, GEMINI_API_KEY: 'fixture-key' }, actor = { id: 'admin', role: 'admin', markets: ['TW'] };
  const selection = { model, connection: { ...conn('gemini'), credentialSource: 'environment' }, route: { timeoutMs: 1000, maxOutputTokens: 8192 }, task: TASK_TW, market: 'TW' };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(geminiResponse(output())); });
  try {
    const run = await enqueueRun(env, actor, input, selection, { idempotencyKey: 'scheduled-regression' });
    const response = await handleExecution(new Request(`https://app.example/api/execution/ai/runs/${run.id}/process`, { method: 'POST', headers: { origin: 'https://app.example', cookie: `rei_session=${token}` } }), env);
    assert.equal(response.status, 202); assert.equal(calls, 0);
    assert.equal((await readRun(env, actor, run.id)).state, 'queued');
    await processDueJobs(env);
    assert.equal((await readRun(env, actor, run.id)).state, 'needs_review'); assert.equal(calls, 1);
    await processDueJobs(env); assert.equal(calls, 1);
    const interrupted = await enqueueRun(env, actor, input, selection, { idempotencyKey: 'interrupted-regression' });
    await DB.prepare("UPDATE rei_jobs SET status='processing',lease_token='expired',lease_until=1 WHERE id=?").bind(interrupted.id).run();
    await processDueJobs(env);
    assert.equal((await readRun(env, actor, interrupted.id)).error.code, 'AI_INTERRUPTED'); assert.equal(calls, 1);
  } finally { DB.close(); }
});

test('the analyze button names a missing deployment credential before a run is queued', async () => {
  const { analyzeBlocker } = await import('../public/app/execution/ui.js');
  const route = { defaultModelId: 'm1' };
  const capture = { images: [{ id: 'i1' }] };
  const ai = { models: [{ id: 'm1', connectionId: 'c1' }], connections: [{ id: 'c1', name: 'Gemini', credentialConfigured: false }] };
  const ok = { ...ai, connections: [{ id: 'c1', name: 'Gemini', credentialConfigured: true }] };
  assert.match(analyzeBlocker('shared', route, capture, ai), /no key on this deployment/);
  assert.match(analyzeBlocker('shared', route, capture, ok), /require review/);
  assert.match(analyzeBlocker('demo', route, capture, ok), /private workspace/);
  assert.match(analyzeBlocker('shared', null, capture, ok), /Choose a model/);
  assert.match(analyzeBlocker('shared', route, { images: [] }, ok), /photograph/);
  // An actor whose /ai/state omits the connection must not be blocked by a guess.
  assert.match(analyzeBlocker('shared', route, capture, { models: [], connections: [] }), /require review/);
});

test('an environment key is found under its aliases, trimmed, and its absence is diagnosed', async () => {
  const { getCredential, hasEnvironmentCredential } = await import('../server/execution/credentials.js');
  const connection = { provider: 'gemini', credentialSource: 'environment', id: 'c1' };
  assert.equal(await getCredential({ GEMINI_API_KEY: '  k1  ' }, connection), 'k1');
  assert.equal(await getCredential({ GOOGLE_API_KEY: 'k2' }, connection), 'k2');
  assert.equal(hasEnvironmentCredential({ GEMINI_API_KEY: '   ' }, 'gemini'), false);
  // Nothing at all on the deployment: point at the Deploy button, not at the key's name.
  await assert.rejects(() => getCredential({}, connection), e => /nothing has reached this Worker/.test(e.message) && e.code === 'AI_NOT_CONFIGURED');
  // Secrets clearly do arrive, so this one is named wrong rather than missing.
  await assert.rejects(() => getCredential({ OPENAI_API_KEY: 'x' }, connection), e => /stored under a different name/.test(e.message));
});

test('the connection check reports each step and stops at the first real failure', async () => {
  const { verifyConnection } = await import('../server/execution/verify.js');
  const connection = { id: 'c1', name: 'Gemini', provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', headerMode: 'x-goog-api-key', credentialSource: 'environment', allowedMarkets: ['TW'], enabled: true };
  const env = { GEMINI_API_KEY: 'k' };
  const listing = { models: [{ name: 'models/real-model', displayName: 'Real', supportedGenerationMethods: ['generateContent'] }] };
  const list = async () => new Response(JSON.stringify(listing), { status: 200, headers: { 'content-type': 'application/json' } });

  // No credential: the later steps are honestly reported as not reached, not as failures.
  const noKey = await verifyConnection({}, connection, 'real-model', { fetchImpl: list });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.steps[0].state, 'failed');
  assert.deepEqual(noKey.steps.slice(1).map(s => s.state), ['not_reached', 'not_reached']);

  // The failure that cost two days: a model the key does not offer is refused before any call.
  let calls = 0;
  const ghost = await verifyConnection(env, connection, 'gemini-3.7-flash', { fetchImpl: async (...a) => { calls += 1; return list(...a); } });
  assert.equal(ghost.steps[1].state, 'passed');
  assert.equal(ghost.steps[2].state, 'failed');
  assert.match(ghost.steps[2].detail, /does not offer gemini-3\.7-flash/);
  assert.equal(calls, 1, 'a model that is not offered must not reach the provider');

  // Listing refused, generation may still work: a warning, not a stop.
  const refused = await verifyConnection(env, connection, null, { fetchImpl: async () => new Response('{}', { status: 403 }) });
  assert.equal(refused.steps[0].state, 'passed');
  assert.equal(refused.steps[1].state, 'warned');
});
