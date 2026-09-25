import { authorize, can, requireThat, DomainError } from '../../public/app/execution/domain.js';
import { TASK_TW, TASK_SG, PROMPT_VERSION } from '../../public/app/execution/ai-contracts.js';
import { cellBox } from '../../public/app/execution/demo.js';
import { initDb, readRecord, writeRecord, readMedia, digest, toBase64 } from './storage.js';
import { connectionDto, ENV_KEYS, getCredential, readEnvSecret } from './credentials.js';
import { runRecognition, validateConnection } from './adapters.js';
import { PROBE_PNG } from './probe-image.js';

export function validateRoute(route, models, connections, market, task) {
  requireThat((market === 'TW' ? TASK_TW : TASK_SG) === task, 'AI_MODEL_NOT_ALLOWED', 'Task and market do not match.');
  requireThat(Array.isArray(route.allowedModelIds) && route.allowedModelIds.length <= 30 && route.allowedModelIds.includes(route.defaultModelId), 'AI_MODEL_NOT_ALLOWED', 'The default must be one of the allowed models.');
  if (route.fallbackModelId) requireThat(route.allowedModelIds.includes(route.fallbackModelId) && route.fallbackModelId !== route.defaultModelId, 'AI_MODEL_NOT_ALLOWED', 'Fallback must be a different allowed model.');
  requireThat(Number.isInteger(route.timeoutMs) && route.timeoutMs >= 5000 && route.timeoutMs <= 60000 && Number.isInteger(route.maxOutputTokens) && route.maxOutputTokens >= 256 && route.maxOutputTokens <= 32768, 'ROUTE_INVALID', 'Timeout: 5–60 seconds. Output limit: 256–32,768 tokens.');
  for (const id of route.allowedModelIds) {
    const model = models.find(m => m.id === id), connection = connections.find(c => c.id === model?.connectionId);
    requireThat(model?.enabled && connection?.enabled && connection.credentialConfigured && connection.allowedMarkets.includes(market), 'AI_MODEL_NOT_ALLOWED', 'Every allowed model must be enabled, configured, market-authorized.');
    requireThat(route.maxOutputTokens <= (model.maxOutputTokens ?? 8192), 'ROUTE_INVALID', 'Output limit exceeds a selected model’s configured limit.');
  }
  return { defaultModelId: route.defaultModelId, allowedModelIds: [...new Set(route.allowedModelIds)], fallbackModelId: route.fallbackModelId || null, fieldOverride: route.fieldOverride === true, timeoutMs: route.timeoutMs, maxOutputTokens: route.maxOutputTokens, market, task };
}
export async function selectModel(env, actor, market, task, requestedModelId, purpose = 'audit') {
  authorize(actor, purpose === 'capability' ? 'ai.manage' : purpose === 'comparison' ? 'ai.compare' : 'audit.capture', market);
  const routeRecord = await readRecord(env.DB, 'route', task), route = routeRecord?.data;
  if (purpose !== 'capability') requireThat(route, 'AI_NOT_CONFIGURED', 'Choose and save a model in AI settings.', 503);
  if (purpose === 'audit' && requestedModelId && actor.role === 'field') requireThat(route.fieldOverride, 'AI_MODEL_NOT_ALLOWED', 'Field users cannot override this task’s default model.', 403);
  const modelId = requestedModelId ?? route?.defaultModelId;
  if (purpose !== 'capability') requireThat(route.allowedModelIds.includes(modelId), 'AI_MODEL_NOT_ALLOWED', 'This model is not allowed for the selected market/task.', 403);
  const model = (await readRecord(env.DB, 'model', modelId))?.data;
  const connection = model && (await readRecord(env.DB, 'connection', model.connectionId))?.data;
  requireThat(model && connection?.enabled && connection.allowedMarkets.includes(market) && connectionDto(connection, env).credentialConfigured, 'AI_NOT_CONFIGURED', 'The selected connection is disabled, unavailable or not configured.', 503);
  if (purpose !== 'capability') requireThat(model.enabled, 'AI_MODEL_NOT_ALLOWED', 'This model is disabled.', 403);
  validateConnection(connection, env); // Recheck administrator allowlist at enqueue AND execution.
  return { model: structuredClone(model), connection: structuredClone(connection), route: purpose === 'capability' ? { timeoutMs: 60000, maxOutputTokens: Math.min(8192, model.maxOutputTokens), fallbackModelId: null } : structuredClone(route), routeRevision: routeRecord?.revision ?? null, task, market, promptVersion: PROMPT_VERSION, schemaVersion: '1', selectedAt: new Date().toISOString() };
}
export function inputForCapture(capture, workspace) {
  requireThat(capture.images.length > 0, 'EVIDENCE_REQUIRED', 'Upload evidence before running recognition.');
  const fixture = workspace.fixtures.find(f => f.id === capture.fixtureId);
  requireThat(fixture, 'NOT_FOUND', 'Fixture not found.', 404);
  const images = capture.images.map(i => ({ imageId: i.id, mimeType: i.mimeType, width: i.width, height: i.height, role: 'audit', hash: i.processedHash, transform: i.transform ?? null }));
  requireThat(images.every(i => i.hash && ['image/jpeg', 'image/png', 'image/webp'].includes(i.mimeType)), 'AI_IMAGE_UNSUPPORTED', 'Upload raster images to the private workspace before real recognition.');
  // Geometry and catalogue only. Never include allowed SKU arrays, facing rules or reviews.
  const geometry = Array.from({ length: fixture.rows * fixture.columns }, (_, index) => {
    const row = Math.floor(index / fixture.columns) + 1, column = index % fixture.columns + 1, key = `R${row}C${column}`;
    const applicable = capture.images.filter(i => !i.slotKeys?.length || i.slotKeys.includes(key));
    return { key, row, column, views: applicable.map(i => ({ imageId: i.id, bbox: i.slotBoxes?.[key] ?? cellBox(row, column, fixture.rows, fixture.columns), primary: applicable.at(-1).id === i.id })) };
  });
  return { task: TASK_TW, captureId: capture.id, captureRevision: capture.revision, images, catalogue: workspace.catalogue.map(({ id, code, name, distinguishingAttributes }) => ({ id, code, name, distinguishingAttributes })), geometry };
}
export function probeInput(task) {
  return { task, images: [{ imageId: 'probe-image', mimeType: 'image/png', width: 400, height: 180, role: 'audit', base64: PROBE_PNG }], catalogue: [{ id: 'PROBE-A', code: 'PROBE-A', name: 'Labelled green rectangle' }, { id: 'PROBE-B', code: 'PROBE-B', name: 'Labelled blue rectangle' }], geometry: task === TASK_TW ? [{ key: 'R1C1', row: 1, column: 1, views: [{ imageId: 'probe-image', bbox: [.025, 40 / 180, .45, 130 / 180], primary: true }] }, { key: 'R1C2', row: 1, column: 2, views: [{ imageId: 'probe-image', bbox: [.525, 40 / 180, .45, 130 / 180], primary: true }] }] : [] };
}
export async function enqueueRun(env, actor, input, selection, { idempotencyKey, purpose = 'audit', experimentId = null, fallbackFrom = null, deadline = null } = {}) {
  await initDb(env.DB);
  requireThat(typeof idempotencyKey === 'string' && idempotencyKey.length >= 8 && idempotencyKey.length <= 160, 'KEY_REQUIRED', 'Provide an idempotency key (8–160 characters).');
  const inputHash = await digest(JSON.stringify(input)), key = `${actor.id}:${idempotencyKey}`;
  const identityHash = await digest(JSON.stringify({ inputHash, modelId: selection.model.id, purpose, experimentId }));
  const old = await env.DB.prepare('SELECT * FROM rei_jobs WHERE idem_key=?').bind(key).first();
  if (old) { requireThat(old.input_hash === identityHash, 'REVISION_CONFLICT', 'This run key already identifies a different input or model.', 409); return publicRun(old); }
  const id = crypto.randomUUID(), now = Date.now();
  const payload = { input, inputHash, selection, purpose, experimentId, fallbackFrom, deadline, attempts: [], queuedAt: new Date(now).toISOString(), result: null, error: null };
  const inserted = await env.DB.prepare('INSERT INTO rei_jobs(id,market,actor_id,capture_id,idem_key,input_hash,status,next_at,created_at,payload) VALUES(?,?,?,?,?,?,\'queued\',?,?,?) ON CONFLICT(idem_key) DO NOTHING').bind(id, selection.market, actor.id, input.captureId ?? null, key, identityHash, now, now, JSON.stringify(payload)).run();
  if (!inserted.meta.changes) { const existing = await env.DB.prepare('SELECT * FROM rei_jobs WHERE idem_key=?').bind(key).first(); requireThat(existing.input_hash === identityHash, 'REVISION_CONFLICT', 'Run key conflict.', 409); return publicRun(existing); }
  return { id, runId: id, state: 'queued', inputHash, purpose };
}
export function publicRun(row) {
  const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload, s = p.selection;
  const estimates = p.attempts.map(a => a.estimatedCost), allKnown = estimates.length && estimates.every(Boolean) && new Set(estimates.filter(Boolean).map(c => c.currency)).size === 1;
  return { id: row.id, runId: row.id, state: row.status, purpose: p.purpose, captureId: row.capture_id, captureRevision: p.input.captureRevision ?? null, inputHash: p.inputHash, modelId: s.model.id, modelName: s.model.displayName, provider: s.connection.provider, connectionId: s.connection.id, remoteModelId: s.model.remoteModelId, resolvedModelId: p.resolvedModelId ?? null, task: s.task, routeRevision: s.routeRevision, promptVersion: s.promptVersion, schemaVersion: s.schemaVersion, queuedAt: p.queuedAt, startedAt: p.startedAt ?? null, completedAt: p.completedAt ?? null, result: p.result, error: p.error, raw: p.raw ?? null, attempts: p.attempts, durationMs: p.attempts.reduce((n, a) => n + (a.durationMs ?? 0), 0), estimatedCost: allKnown ? { amount: estimates.reduce((n, c) => n + c.amount, 0), currency: estimates[0].currency } : null, unknownCostAttempts: estimates.filter(c => !c).length, fallbackFrom: p.fallbackFrom, fallbackRunId: p.fallbackRunId ?? null };
}
export async function readRun(env, actor, id) {
  await initDb(env.DB); const row = await env.DB.prepare('SELECT * FROM rei_jobs WHERE id=?').bind(id).first();
  requireThat(row && actor.markets.includes(row.market) && (actor.role !== 'field' || row.actor_id === actor.id), 'NOT_FOUND', 'Run not found.', 404); return publicRun(row);
}
async function persistRun(db, row, payload, state, nextAt = Date.now()) {
  return db.prepare('UPDATE rei_jobs SET payload=?,status=?,next_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?').bind(JSON.stringify(payload), state, nextAt, row.id, row.lease_token).run();
}
/**
 * A run's wall-clock limit and attempt ceiling. Five minutes, not three: a run split into rows
 * retries only the rows still missing, one cron tick apart, and on an overloaded model that
 * takes a few ticks — each attempt that answers more rows earns another, up to MAX_ATTEMPTS.
 */
export const RUN_DEADLINE_MS = 300000;
export const MAX_ATTEMPTS = 5;
export async function executeRun(env, runId, { fetchImpl = fetch } = {}) {
  const now = Date.now(), lease = crypto.randomUUID();
  const row = await env.DB.prepare('UPDATE rei_jobs SET status=\'processing\',lease_token=?,lease_until=? WHERE id=? AND status=\'queued\' AND next_at<=? RETURNING *').bind(lease, now + 75000, runId, now).first();
  if (!row) return; // Atomic claim, duplicate triggers do not issue another provider call.
  const p = JSON.parse(row.payload); p.startedAt ??= new Date(now).toISOString(); p.deadline ??= now + RUN_DEADLINE_MS;
  if (now >= p.deadline) { p.error = { code: 'AI_TIMEOUT', message: `The run reached its ${RUN_DEADLINE_MS / 1000}-second wall-clock limit.`, retryable: false }; p.completedAt = new Date().toISOString(); await persistRun(env.DB, row, p, 'timed_out'); return; }
  const attempt = { number: p.attempts.length + 1, startedAt: new Date().toISOString(), state: 'processing', repair: Boolean(p.repairNext), estimatedCost: null };
  p.attempts.push(attempt);
  await env.DB.prepare('UPDATE rei_jobs SET payload=? WHERE id=? AND lease_token=?').bind(JSON.stringify(p), row.id, lease).run();
  try {
    validateConnection(p.selection.connection, env);
    const credential = await getCredential(env, p.selection.connection).catch(e => { throw handedOff(e, row, now); });
    const input = { ...p.input, images: await Promise.all(p.input.images.map(async i => ({ ...i, base64: i.base64 ?? toBase64(await readMedia(env.DB, i.imageId)) }))) };
    const response = await runRecognition(p.selection.connection, credential, p.selection.model, input, { timeoutMs: Math.min(p.selection.route.timeoutMs, p.deadline - Date.now()), maxOutputTokens: p.selection.route.maxOutputTokens, repair: p.repairNext }, { fetchImpl, done: p.partsDone });
    if (p.purpose === 'capability') {
      const found = new Set((response.result.products ?? response.result.prices ?? []).map(x => x.skuCandidateId));
      requireThat(found.has('PROBE-A') && found.has('PROBE-B'), 'AI_INVALID_OUTPUT', 'The API accepted the image but did not identify both labelled test rectangles.');
    }
    Object.assign(attempt, { state: 'succeeded', durationMs: response.durationMs, usage: response.usage, requestId: response.requestId, responseId: response.responseId, estimatedCost: response.estimatedCost, schema: response.schema ?? null, thinking: response.thinking ?? null, parts: response.parts ?? null });
    p.result = response.result; p.raw = response.raw; p.resolvedModelId = response.resolvedModelId; p.completedAt = new Date().toISOString(); delete p.partsDone;
    if (p.purpose === 'capability') await recordCapability(env, p, row.id, 'verified');
    await persistRun(env.DB, row, p, 'needs_review');
  } catch (e) {
    const ours = typeof e.code === 'string', code = ours ? e.code : 'AI_NETWORK_ERROR';
    Object.assign(attempt, { state: 'failed', error: { code, message: ours ? e.message : 'Recognition processing failed.' }, durationMs: e.durationMs ?? Date.now() - now, httpStatus: e.httpStatus ?? null, providerStatus: e.providerStatus ?? null, schema: e.schema ?? null, thinking: e.thinking ?? null, part: e.part ?? null, usage: e.usage ?? null, requestId: e.requestId ?? null, raw: e.raw ?? null });
    const transportAttempts = p.attempts.filter(a => !a.repair).length;
    const repair = code === 'AI_INVALID_OUTPUT' && !p.attempts.some(a => a.repair);
    // Rows already answered are kept, and an attempt that answered more of them earns another.
    const before = (p.partsDone ?? []).filter(Boolean).length;
    if (Array.isArray(e.done)) p.partsDone = e.done;
    const progressed = (p.partsDone ?? []).filter(Boolean).length > before;
    const retry = e.retryable && !attempt.repair && (transportAttempts < 2 || (progressed && transportAttempts < MAX_ATTEMPTS));
    const retryAt = Date.now() + (retry ? Math.max(2000, e.retryAfterMs ?? 2000) : 0);
    if ((repair || retry) && retryAt < p.deadline) { p.repairNext = repair; await persistRun(env.DB, row, p, 'queued', retryAt); return; }
    p.error = { code, message: ours ? e.message : 'Recognition processing failed.', retryable: Boolean(e.retryable) }; p.completedAt = new Date().toISOString();
    if (p.purpose === 'capability') await recordCapability(env, p, row.id, 'failed').catch(() => {});
    if (p.selection.route.fallbackModelId && !p.fallbackFrom && e.retryable && !['AI_REFUSED', 'AI_AUTH_FAILED'].includes(code) && Date.now() < p.deadline) {
      try {
        const actor = { id: row.actor_id, role: 'admin', markets: [row.market] };
        // Pre-authorized at route save; a disabled/revoked fallback is rechecked here.
        const selection = await selectModel(env, actor, row.market, p.selection.task, p.selection.route.fallbackModelId, p.purpose === 'comparison' ? 'comparison' : 'audit');
        const child = await enqueueRun(env, actor, p.input, selection, { idempotencyKey: `fallback-${row.id}`, purpose: p.purpose, experimentId: p.experimentId, fallbackFrom: row.id, deadline: p.deadline });
        p.fallbackRunId = child.id;
      } catch { p.fallbackUnavailable = true; }
    }
    await persistRun(env.DB, row, p, code === 'AI_TIMEOUT' ? 'timed_out' : 'failed');
  }
}
async function recordCapability(env, p, runId, state) {
  const record = await readRecord(env.DB, 'model', p.selection.model.id);
  if (!record) return;
  const model = record.data;
  // A probe of an older edited model must not verify its replacement.
  if (model.remoteModelId !== p.selection.model.remoteModelId || model.connectionId !== p.selection.model.connectionId) return;
  model.capabilities ??= {}; model.capabilities[p.selection.task] = { state, testedAt: new Date().toISOString(), runId, promptVersion: PROMPT_VERSION, schemaVersion: '1', note: 'Synthetic API capability probe; tobacco recognition accuracy is not measured.' };
  await writeRecord(env.DB, 'model', model.id, model, record.revision, p.selection.market);
}
export async function processDueJobs(env) {
  if (!env.DB) return; await initDb(env.DB);
  const expired = (await env.DB.prepare('SELECT * FROM rei_jobs WHERE status=\'processing\' AND lease_until<? LIMIT 10').bind(Date.now()).all()).results;
  for (const row of expired) {
    const p = JSON.parse(row.payload); p.error = { code: 'AI_INTERRUPTED', message: 'The worker stopped before a response was recorded. The provider may have processed and billed the request. Start a new run explicitly.', retryable: false }; p.completedAt = new Date().toISOString();
    if (p.attempts.at(-1)?.state === 'processing') p.attempts.at(-1).state = 'response_unknown';
    await persistRun(env.DB, row, p, 'failed');
  }
  const seen = await keyHeartbeat(env);
  // Cron gives durable recovery; bounded rounds also execute a schema repair without waiting a minute.
  for (let round = 0; round < 3; round++) {
    const queued = (await env.DB.prepare('SELECT id,next_at,payload FROM rei_jobs WHERE status=\'queued\' AND next_at<=? ORDER BY created_at LIMIT 10').bind(Date.now()).all()).results;
    const due = queued.filter(row => canRun(env, row, seen)).slice(0, 2);
    if (!due.length) break;
    await Promise.allSettled(due.map(row => executeRun(env, row.id)));
  }
}
/**
 * How long a Worker without the key leaves a job for one that has it.
 *
 * Several Workers can be built from this repository and bound to the same database — on the
 * live account there were three, each with the same one-minute cron, all draining one queue.
 * A Worker secret belongs to one of them. So the connection check, answered by the Worker that
 * served the page, passed, and then a cron on a Worker that had never been given the key claimed
 * the run and failed it with "no provider key is visible here" — true of that Worker, false of
 * the deployment the reader was looking at. A job is therefore claimed only by a Worker that can
 * read its key; once it has been due this long, anyone may take it, so a key that exists nowhere
 * still ends in a failure with its diagnosis instead of a run that stays queued forever.
 *
 * The window runs from when the job became due, not from when it was created. Counted from
 * creation, a retry scheduled after a provider 5xx fell outside it and went to a Worker with no
 * key — which replaced a transient provider error with a false configuration one.
 */
export const HANDOFF_MS = 90000;
/**
 * How recently a Worker holding a key must have run the queue for keyless Workers to keep
 * leaving that key's jobs alone.
 *
 * The handoff window alone was not enough. Crons do not fire like clockwork: on the live account
 * none ran for nine minutes, and when they resumed a keyless Worker won the race for a job that
 * had long passed its window, while price-check — which held the key, and whose connection check
 * passed minutes later — lost it. So each Worker that can read a key says so at every cron, and a
 * keyless Worker takes that key's job only when no such Worker has been heard from for this long.
 */
export const KEY_FRESH_MS = 300000;
async function keyHeartbeat(env, now = Date.now()) {
  for (const provider of Object.keys(ENV_KEYS)) {
    if (!readEnvSecret(env, provider)) continue;
    await env.DB.prepare("INSERT INTO rei_records(kind,id,market,revision,payload) VALUES('key_heartbeat',?,'',1,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,revision=rei_records.revision+1").bind(provider, JSON.stringify({ at: now })).run();
  }
  const { results } = await env.DB.prepare("SELECT id,payload FROM rei_records WHERE kind='key_heartbeat'").all();
  return Object.fromEntries(results.map(r => [r.id, JSON.parse(r.payload).at]));
}
/**
 * The "no key here" message is true of the Worker that says it and misleading about the rest.
 * A run only reaches a keyless Worker after waiting HANDOFF_MS for one that has the key, so by
 * then the fact worth reporting is that no Worker sharing this database could read it — and the
 * fix is a key stored in that database, not another trip to one Worker's dashboard.
 */
function handedOff(e, row, now) {
  if (e?.code !== 'AI_NOT_CONFIGURED' || now - row.next_at < HANDOFF_MS) return e;
  const waited = Math.round((now - row.next_at) / 1000);
  return Object.assign(new Error(`No Worker that shares this database could read the provider key: this run waited ${waited} s, and none that holds it has run the queue in the last ${KEY_FRESH_MS / 60000} minutes. Several Workers are built from this repository and a Worker secret belongs to only one of them, so a secret can disappear from the one that serves the app. Paste the key on the AI connection screen instead — it is stored encrypted in the shared database, every Worker can read it, and deploys do not remove it.`), { code: 'AI_NOT_CONFIGURED', status: 503, retryable: false });
}
function canRun(env, row, seen = {}, now = Date.now()) {
  const connection = JSON.parse(row.payload).selection?.connection;
  if (connection?.credentialSource !== 'environment' || readEnvSecret(env, connection.provider)) return true;
  if (now - row.next_at < HANDOFF_MS) return false;
  // A Worker that holds this key has run the queue recently, so it will take the job.
  return now - (seen[connection.provider] ?? 0) >= KEY_FRESH_MS;
}
