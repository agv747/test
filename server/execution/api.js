import { applyCommand, authorize, can, overview, requireThat, DomainError, clone } from '../../public/app/execution/domain.js';
import { TASK_TW, TASK_SG, compareProposal, proposalToReview } from '../../public/app/execution/ai-contracts.js';
import { initDb, readRecord, readWorkspace, writeRecord, listRecords, scopeWorkspace, parseImage, saveMedia, deleteMedia, readMedia, digest } from './storage.js';
import { getActor, actorForToken, authConfigured, sameOrigin, sessionCookie } from './auth.js';
import { encryptCredential, getCredential, connectionDto, hasEnvironmentCredential } from './credentials.js';
import { BUILD_SHA } from '../../build-info.js';
import { validateConnection, listProviderModels } from './adapters.js';
import { selectModel, validateRoute, inputForCapture, enqueueRun, readRun, probeInput } from './jobs.js';

export const reply = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
async function bodyJson(request, limit = 2100000) {
  requireThat(request.headers.get('content-type')?.includes('application/json'), 'CONTENT_TYPE', 'Use application/json.', 415);
  requireThat(!request.headers.get('content-length') || Number(request.headers.get('content-length')) <= limit, 'REQUEST_TOO_LARGE', 'Request exceeds the size limit.', 413);
  const reader = request.body?.getReader(); requireThat(reader, 'BODY_REQUIRED', 'A JSON body is required.');
  let size = 0; const chunks = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) { await reader.cancel(); throw new DomainError('REQUEST_TOO_LARGE', 'Request exceeds the size limit.', 413); } chunks.push(value); }
  const bytes = new Uint8Array(size); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new DomainError('JSON_INVALID', 'Invalid JSON request.'); }
}
const taskMarket = task => { requireThat([TASK_TW, TASK_SG].includes(task), 'TASK_INVALID', 'Unknown recognition task.'); return task === TASK_TW ? 'TW' : 'SG'; };
async function recordAudit(env, actor, action, entityId) {
  const id = crypto.randomUUID(); await writeRecord(env.DB, 'configuration_event', id, { id, actorId: actor.id, action, entityId, at: new Date().toISOString() }, 0, 'SG,TW');
}
function visibleCapture(workspace, actor, id) {
  const scoped = scopeWorkspace(workspace, actor), capture = scoped.captures.find(c => c.id === id);
  requireThat(capture, 'NOT_FOUND', 'Capture not found in your assignments.', 404); return capture;
}
async function configState(env, actor) {
  const connections = (await listRecords(env.DB, 'connection')).map(c => connectionDto(c, env));
  const models = await listRecords(env.DB, 'model'), routes = await listRecords(env.DB, 'route');
  if (can(actor, 'ai.manage')) return { connections, models, routes, secretStoreConfigured: Boolean(env.AI_CREDENTIALS_ENCRYPTION_KEY), environmentCredentials: Object.fromEntries(['gemini', 'openai', 'anthropic', 'openai_compatible'].map(p => [p, hasEnvironmentCredential(env, p)])) };
  const allowedIds = new Set(routes.filter(r => actor.markets.includes(r.market)).flatMap(r => r.allowedModelIds));
  return { connections: connections.filter(c => c.allowedMarkets.some(m => actor.markets.includes(m))).map(({ id, name, provider, allowedMarkets, enabled, credentialConfigured }) => ({ id, name, provider, allowedMarkets, enabled, credentialConfigured })), models: models.filter(m => allowedIds.has(m.id)), routes: routes.filter(r => actor.markets.includes(r.market)), secretStoreConfigured: false, environmentCredentials: {} };
}

export async function handleExecution(request, env) {
  try { return await route(request, env); }
  catch (e) { return reply({ error: { code: e.code ?? 'INTERNAL_ERROR', message: e.code ? e.message : 'The server could not complete this request.', retryable: Boolean(e.retryable), requestId: crypto.randomUUID() } }, e.status ?? 500); }
}
async function route(request, env) {
  const url = new URL(request.url), path = url.pathname.replace(/^\/api\/execution/, ''), method = request.method;
  if (!['GET', 'HEAD'].includes(method)) sameOrigin(request);
  if (path === '/session') {
    if (method === 'GET') return reply({ actor: await getActor(request, env), authConfigured: authConfigured(env), databaseConfigured: Boolean(env.DB), version: '3.0.0', buildSha: BUILD_SHA !== 'development' ? BUILD_SHA : env.DEPLOY_COMMIT ?? null });
    if (method === 'DELETE') return reply({ actor: null }, 200, { 'set-cookie': sessionCookie('', request, true) });
    if (method === 'POST') {
      const p = await bodyJson(request, 3000), actor = await actorForToken(env, p.accessToken);
      requireThat(actor, 'AUTH_REQUIRED', authConfigured(env) ? 'Invalid access token.' : 'Private access is not configured. Set ADMIN_ACCESS_TOKEN or APP_ACCESS_USERS_JSON in Cloudflare secrets.', 401);
      return reply({ actor }, 200, { 'set-cookie': sessionCookie(p.accessToken, request) });
    }
  }
  const actor = await getActor(request, env); requireThat(actor, 'AUTH_REQUIRED', 'Sign in to use shared evidence or real AI connections.', 401); await initDb(env.DB);
  if (path === '/workspace' && method === 'GET') {
    const record = await readWorkspace(env.DB); return reply({ revision: record.revision, workspace: scopeWorkspace(record.data, actor) });
  }
  if (path === '/overview' && method === 'GET') {
    const record = await readWorkspace(env.DB), scoped = scopeWorkspace(record.data, actor);
    const asOf = url.searchParams.get('asOf') ?? new Date().toISOString(), freshnessDays = Number(url.searchParams.get('freshnessDays') ?? 7);
    requireThat(Number.isFinite(Date.parse(asOf)) && freshnessDays >= 1 && freshnessDays <= 90, 'FILTER_INVALID', 'Choose a date and 1–90 freshness days.');
    return reply(overview(scoped, { asOf, freshnessDays, territory: url.searchParams.get('territory') ?? '', outlet: url.searchParams.get('outlet') ?? '', owner: url.searchParams.get('owner') ?? '', fixtureType: url.searchParams.get('fixtureType') ?? '' }));
  }
  if (path === '/commands' && method === 'POST') {
    const p = await bodyJson(request), record = await readWorkspace(env.DB);
    if (p.command?.type === 'assessment.submit') {
      const prior = record.data.assessments.find(a => a.idempotencyKey === p.command.payload?.idempotencyKey);
      if (prior) {
        authorize(actor, 'audit.review'); visibleCapture(record.data, actor, prior.captureId);
        requireThat(prior.captureId === p.command.payload.captureId && prior.reviewId === p.command.payload.reviewId && prior.incompleteReason === (p.command.payload.incompleteReason ?? null), 'REVISION_CONFLICT', 'Submission key already identifies different evidence.', 409);
        return reply({ revision: record.revision, workspace: scopeWorkspace(record.data, actor), result: prior });
      }
    }
    requireThat(p.expectedRevision === record.revision, 'REVISION_CONFLICT', 'Workspace changed. Reload before saving.', 409);
    requireThat(p.command?.type !== 'capture.image', 'FORBIDDEN', 'Use the authorized image upload endpoint.', 403);
    if (p.command?.type === 'review.save' && p.command.payload?.runId) {
      const run = await readRun(env, actor, p.command.payload.runId);
      requireThat(run.state === 'needs_review' && run.captureId === p.command.payload.captureId && run.task === TASK_TW, 'REVIEW_INVALID', 'The selected proposal must belong to this capture.');
    }
    const applied = applyCommand(record.data, p.command, actor);
    const revision = await writeRecord(env.DB, 'workspace', 'TW', applied.workspace, record.revision);
    return reply({ revision, workspace: scopeWorkspace(applied.workspace, actor), result: applied.result });
  }
  const imagePath = /^\/captures\/([^/]+)\/images$/.exec(path);
  if (imagePath && method === 'POST') {
    authorize(actor, 'audit.capture'); const p = await bodyJson(request, 24000000), record = await readWorkspace(env.DB), cap = visibleCapture(record.data, actor, imagePath[1]);
    requireThat(p.expectedRevision === record.revision, 'REVISION_CONFLICT', 'Workspace changed. Reload before uploading.', 409);
    requireThat(cap.images.length < 4 && !cap.reviews.length, 'CAPTURE_LOCKED', 'Use a new capture after review; maximum four images.');
    const original = parseImage(p.original), processed = parseImage(p.processed);
    requireThat(Number.isInteger(p.width) && Number.isInteger(p.height) && p.width > 0 && p.height > 0 && p.width * p.height <= 40000000, 'IMAGE_INVALID', 'Invalid image dimensions.');
    const imageId = crypto.randomUUID(), originalId = crypto.randomUUID();
    const fixture = record.data.fixtures.find(f => f.id === cap.fixtureId), keys = new Set(Array.from({ length: fixture.rows * fixture.columns }, (_, i) => `R${Math.floor(i / fixture.columns) + 1}C${i % fixture.columns + 1}`));
    requireThat(!p.slotKeys || Array.isArray(p.slotKeys) && p.slotKeys.every(k => keys.has(k)), 'GEOMETRY_UNRESOLVED', 'Image range contains an unknown slot.');
    const image = { id: imageId, originalId, name: String(p.name ?? 'Audit image').slice(0, 160), mimeType: processed.mimeType, originalMimeType: original.mimeType, width: p.width, height: p.height, originalHash: await digest(original.bytes), processedHash: await digest(processed.bytes), range: String(p.range ?? 'Overview').slice(0, 120), slotKeys: p.slotKeys ?? [], transform: { orientationNormalized: true, method: 'browser-createImageBitmap-from-image', originalWidth: p.originalWidth ?? null, originalHeight: p.originalHeight ?? null, processedWidth: p.width, processedHeight: p.height }, url: `/api/execution/images/${imageId}` };
    await saveMedia(env.DB, originalId, original.bytes);
    try {
      await saveMedia(env.DB, imageId, processed.bytes);
      const applied = applyCommand(record.data, { type: 'capture.image', payload: { captureId: cap.id, expectedRevision: cap.revision, image } }, actor);
      const revision = await writeRecord(env.DB, 'workspace', 'TW', applied.workspace, record.revision);
      return reply({ revision, workspace: scopeWorkspace(applied.workspace, actor), image }, 201);
    } catch (e) { await deleteMedia(env.DB, originalId); await deleteMedia(env.DB, imageId); throw e; }
  }
  const mediaPath = /^\/images\/([^/]+)$/.exec(path);
  if (mediaPath && method === 'GET') {
    const record = await readWorkspace(env.DB), visible = scopeWorkspace(record.data, actor);
    const image = visible.captures.flatMap(c => c.images).find(i => i.id === mediaPath[1] || i.originalId === mediaPath[1]);
    requireThat(image, 'NOT_FOUND', 'Image not found.', 404);
    return new Response(await readMedia(env.DB, mediaPath[1]), { headers: { 'content-type': image.originalId === mediaPath[1] ? image.originalMimeType : image.mimeType, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
  }
  if (path === '/ai/state' && method === 'GET') return reply(await configState(env, actor));
  const connPath = /^\/ai\/connections(?:\/([^/]+)(?:\/(test|refresh-models))?)?$/.exec(path);
  if (connPath) {
    authorize(actor, 'ai.manage', actor.markets[0]);
    const [, connectionId, operation] = connPath;
    if (method === 'POST' && !connectionId || method === 'PATCH' && connectionId && !operation) {
      const p = await bodyJson(request, 12000), previous = connectionId ? await readRecord(env.DB, 'connection', connectionId) : null;
      requireThat(!connectionId || previous, 'NOT_FOUND', 'Connection not found.', 404);
      if (previous) requireThat(previous.revision === p.expectedRevision, 'REVISION_CONFLICT', 'Connection changed. Reload before saving.', 409);
      const old = previous?.data, id = old?.id ?? crypto.randomUUID();
      const data = validateConnection({ id, name: p.name, provider: p.provider, baseUrl: p.baseUrl, protocol: p.protocol, headerMode: p.headerMode, allowedMarkets: p.allowedMarkets, enabled: p.enabled === true }, env);
      requireThat(data.allowedMarkets.every(m => actor.markets.includes(m)), 'FORBIDDEN', 'Cannot grant a market outside your access.', 403);
      if (old) requireThat(data.provider === old.provider && data.baseUrl === old.baseUrl, 'CONNECTION_IMMUTABLE', 'Create a new connection to change provider or endpoint.');
      data.credentialSource = p.removeKey ? 'none' : p.credentialSource === 'environment' ? 'environment' : old?.credentialSource ?? 'none';
      data.encryptedCredential = p.removeKey ? null : old?.encryptedCredential ?? null;
      if (p.apiKey) { data.encryptedCredential = await encryptCredential(env, p.apiKey, id); data.credentialSource = 'encrypted'; }
      if (data.credentialSource === 'environment') data.encryptedCredential = null;
      data.lastTest = p.apiKey || p.removeKey || !old ? null : old.lastTest; data.updatedAt = new Date().toISOString(); data.updatedBy = actor.id;
      const revision = await writeRecord(env.DB, 'connection', id, data, previous?.revision ?? 0, data.allowedMarkets.join(',')); await recordAudit(env, actor, 'connection.save', id);
      return reply({ connection: { ...connectionDto(data, env), revision } }, old ? 200 : 201);
    }
    if (connectionId && operation && method === 'POST') {
      const p = await bodyJson(request, 5000), record = await readRecord(env.DB, 'connection', connectionId); requireThat(record, 'NOT_FOUND', 'Connection not found.', 404);
      const connection = validateConnection(record.data, env); let page;
      try { page = await listProviderModels(connection, await getCredential(env, connection), p.cursor ?? null); connection.lastTest = { state: 'passed', checkedAt: new Date().toISOString(), note: 'Model listing succeeded. Run an image capability test before routing.' }; }
      catch (e) { connection.lastTest = { state: 'failed', checkedAt: new Date().toISOString(), code: e.code ?? 'AI_NETWORK_ERROR', note: e.code ? e.message : 'Connection test failed. Manual model IDs may still work if listing permission is absent.' }; await writeRecord(env.DB, 'connection', connectionId, connection, record.revision, connection.allowedMarkets.join(',')); return reply({ connection: connectionDto(connection, env), error: connection.lastTest }, 422); }
      await writeRecord(env.DB, 'connection', connectionId, connection, record.revision, connection.allowedMarkets.join(','));
      if (operation === 'refresh-models') {
        const existing = await listRecords(env.DB, 'model');
        for (const m of page.models) if (!existing.some(x => x.connectionId === connectionId && x.remoteModelId === m.remoteModelId)) {
          const id = crypto.randomUUID(), model = { ...m, id, connectionId, enabled: false, structuredOutput: true, coordinateConvention: 'xywh_normalized', capabilities: {}, maxOutputTokens: Math.min(m.providerMetadata.outputTokenLimit ?? 8192, 32768), createdAt: new Date().toISOString() };
          await writeRecord(env.DB, 'model', id, model, 0, connection.allowedMarkets.join(','));
        }
      }
      return reply({ ...page, connection: connectionDto(connection, env) });
    }
  }
  const modelPath = /^\/ai\/models(?:\/([^/]+)(?:\/(test-task))?)?$/.exec(path);
  if (modelPath) {
    authorize(actor, 'ai.manage', actor.markets[0]); const [, modelId, operation] = modelPath;
    if (operation === 'test-task' && method === 'POST') {
      const p = await bodyJson(request, 5000), market = taskMarket(p.task), selection = await selectModel(env, actor, market, p.task, modelId, 'capability');
      const result = await enqueueRun(env, actor, probeInput(p.task), selection, { idempotencyKey: p.idempotencyKey, purpose: 'capability' }); return reply(result, 202);
    }
    if (method === 'POST' && !modelId || method === 'PATCH' && modelId && !operation) {
      const p = await bodyJson(request, 20000), old = modelId ? await readRecord(env.DB, 'model', modelId) : null;
      requireThat(!modelId || old, 'NOT_FOUND', 'Model not found.', 404);
      if (old) requireThat(old.revision === p.expectedRevision, 'REVISION_CONFLICT', 'Model changed. Reload before saving.', 409);
      const connection = (await readRecord(env.DB, 'connection', p.connectionId))?.data;
      requireThat(connection && connection.allowedMarkets.some(m => actor.markets.includes(m)), 'NOT_FOUND', 'Connection not found.', 404);
      requireThat(typeof p.remoteModelId === 'string' && /^[\w./:@-]{1,160}$/.test(p.remoteModelId) && !p.remoteModelId.includes('..'), 'MODEL_INVALID', 'Enter an exact provider model ID.');
      requireThat(typeof p.displayName === 'string' && p.displayName.trim() && p.displayName.length <= 120 && Number.isInteger(p.maxOutputTokens) && p.maxOutputTokens >= 256 && p.maxOutputTokens <= 32768, 'MODEL_INVALID', 'Name and output limit (256–32,768) are required.');
      requireThat(['xywh_normalized', 'yxyx_1000', 'xywh_pixels'].includes(p.coordinateConvention ?? 'xywh_normalized'), 'MODEL_INVALID', 'Unsupported box convention.');
      const id = old?.data.id ?? crypto.randomUUID();
      const changed = !old || old.data.remoteModelId !== p.remoteModelId || old.data.connectionId !== p.connectionId || old.data.structuredOutput !== (p.structuredOutput !== false) || old.data.coordinateConvention !== (p.coordinateConvention ?? 'xywh_normalized');
      const model = { id, connectionId: p.connectionId, remoteModelId: p.remoteModelId.replace(/^models\//, ''), displayName: p.displayName, enabled: p.enabled === true, structuredOutput: p.structuredOutput !== false, coordinateConvention: p.coordinateConvention ?? 'xywh_normalized', maxOutputTokens: p.maxOutputTokens, capabilities: changed ? {} : old.data.capabilities, pricing: p.pricing ?? old?.data.pricing ?? null, updatedAt: new Date().toISOString() };
      const revision = await writeRecord(env.DB, 'model', id, model, old?.revision ?? 0, connection.allowedMarkets.join(',')); await recordAudit(env, actor, 'model.save', id); return reply({ model: { ...model, revision } }, old ? 200 : 201);
    }
  }
  const routePath = /^\/ai\/routes\/(SG|TW)\/(sg_price_recognition|tw_planogram_recognition)$/.exec(path);
  if (routePath && method === 'PUT') {
    const [, market, task] = routePath; authorize(actor, 'ai.manage', market); const p = await bodyJson(request, 10000), state = await configState(env, actor), previous = await readRecord(env.DB, 'route', task);
    requireThat((previous?.revision ?? 0) === p.expectedRevision, 'REVISION_CONFLICT', 'Routing changed. Reload before saving.', 409);
    const data = { ...validateRoute(p, state.models, state.connections, market, task), updatedAt: new Date().toISOString(), updatedBy: actor.id };
    const revision = await writeRecord(env.DB, 'route', task, data, previous?.revision ?? 0, market); await recordAudit(env, actor, 'route.save', task); return reply({ route: { ...data, revision } });
  }
  if (path === '/ai/runs' && method === 'POST') {
    const p = await bodyJson(request, 12000000), market = taskMarket(p.task), selection = await selectModel(env, actor, market, p.task, p.modelId);
    let input;
    if (market === 'TW') {
      const record = await readWorkspace(env.DB), capture = visibleCapture(record.data, actor, p.captureId);
      requireThat(capture.revision === p.captureRevision, 'REVISION_CONFLICT', 'Capture changed. Reload before analysis.', 409); input = inputForCapture(capture, record.data);
    } else {
      const image = parseImage(p.image), imageId = crypto.randomUUID();
      requireThat(Number.isInteger(p.width) && Number.isInteger(p.height) && p.width > 0 && p.height > 0 && p.width * p.height <= 40000000, 'IMAGE_INVALID', 'Image dimensions required.');
      const { results } = await env.DB.prepare('SELECT * FROM skus').all();
      const catalogue = results.filter(s => !s.market_id || s.market_id === 'mkt-sg').map(s => ({ id: s.id, code: s.sku_code, name: s.name }));
      requireThat(catalogue.length > 0, 'CATALOGUE_MISSING', 'Load the approved Singapore catalogue first.');
      await saveMedia(env.DB, imageId, image.bytes);
      input = { task: TASK_SG, images: [{ imageId, mimeType: image.mimeType, width: p.width, height: p.height, role: 'audit', hash: await digest(image.bytes) }], catalogue, geometry: [] };
    }
    const run = await enqueueRun(env, actor, input, selection, { idempotencyKey: p.idempotencyKey }); return reply(run, 202);
  }
  const runPath = /^\/ai\/runs\/([^/]+)(?:\/(process))?$/.exec(path);
  if (runPath) {
    const run = await readRun(env, actor, runPath[1]);
    if (method === 'GET' && !runPath[2]) return reply(run);
    if (method === 'POST' && runPath[2]) { authorize(actor, run.purpose === 'capability' ? 'ai.manage' : run.purpose === 'comparison' ? 'ai.compare' : 'audit.capture', taskMarket(run.task)); /* Execution belongs to the scheduled worker, never to a browser connection. */ return reply(run, ['queued', 'processing'].includes(run.state) ? 202 : 200); }
  }
  if (path === '/ai/experiments' && method === 'POST') {
    authorize(actor, 'ai.compare'); const p = await bodyJson(request, 12000), record = await readWorkspace(env.DB), capture = visibleCapture(record.data, actor, p.captureId);
    requireThat(p.captureRevision === capture.revision && Array.isArray(p.modelIds) && new Set(p.modelIds).size === p.modelIds.length && p.modelIds.length >= 2 && p.modelIds.length <= 3, 'EXPERIMENT_INVALID', 'Select 2 or 3 different models and the current capture revision.');
    const selections = await Promise.all(p.modelIds.map(id => selectModel(env, actor, 'TW', TASK_TW, id, 'comparison'))), input = inputForCapture(capture, record.data);
    const truth = p.groundTruthReviewId ? capture.reviews.find(r => r.id === p.groundTruthReviewId) : null;
    requireThat(!p.groundTruthReviewId || truth, 'NOT_FOUND', 'Ground truth must be a confirmed human review of this capture.', 404);
    const id = crypto.randomUUID(), experiment = { id, actorId: actor.id, captureId: capture.id, captureRevision: capture.revision, inputHash: await digest(JSON.stringify(input)), groundTruth: truth ? clone(truth) : null, reference: clone(capture.reference), runIds: [], createdAt: new Date().toISOString() };
    for (const selection of selections) { const run = await enqueueRun(env, actor, input, selection, { idempotencyKey: `compare-${id}-${selection.model.id}`, purpose: 'comparison', experimentId: id }); experiment.runIds.push(run.id); }
    await writeRecord(env.DB, 'experiment', id, experiment); return reply({ id, runIds: experiment.runIds }, 202);
  }
  const experimentPath = /^\/ai\/experiments\/([^/]+)$/.exec(path);
  if (experimentPath && method === 'GET') {
    authorize(actor, 'ai.compare'); const experiment = (await readRecord(env.DB, 'experiment', experimentPath[1]))?.data;
    requireThat(experiment, 'NOT_FOUND', 'Comparison not found.', 404);
    visibleCapture((await readWorkspace(env.DB)).data, actor, experiment.captureId);
    const runs = await Promise.all(experiment.runIds.map(id => readRun(env, actor, id)));
    return reply({ ...experiment, runs: runs.map(run => ({ ...run, comparison: run.result && experiment.reference.plan ? compareProposal(experiment.reference.plan, proposalToReview(experiment.reference.plan, run.result), experiment.groundTruth?.slots) : null })) });
  }
  throw new DomainError('NOT_FOUND', 'Endpoint not found.', 404);
}
