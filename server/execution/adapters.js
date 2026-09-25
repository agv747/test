import { DomainError, requireThat } from '../../public/app/execution/domain.js';
import { TASK_TW, recognitionPrompt, schemaFor, validateOutput } from '../../public/app/execution/ai-contracts.js';
import { toBase64 } from './storage.js';

export const NATIVE_BASES = { gemini: 'https://generativelanguage.googleapis.com/v1beta', openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1' };
export function validateConnection(input, env) {
  requireThat(['gemini', 'openai', 'anthropic', 'openai_compatible'].includes(input.provider), 'CONNECTION_INVALID', 'Choose a supported provider.');
  requireThat(typeof input.name === 'string' && input.name.trim().length > 0 && input.name.length <= 80, 'CONNECTION_INVALID', 'Connection name is required (maximum 80 characters).');
  requireThat(Array.isArray(input.allowedMarkets) && input.allowedMarkets.every(m => ['SG', 'TW'].includes(m)), 'CONNECTION_INVALID', 'Choose allowed markets.');
  if (input.provider !== 'openai_compatible') return { ...input, baseUrl: NATIVE_BASES[input.provider], protocol: input.provider === 'openai' ? 'responses' : input.provider, headerMode: input.provider === 'gemini' ? 'x-goog-api-key' : input.provider === 'anthropic' ? 'x-api-key' : 'bearer' };
  let url;
  try { url = new URL(input.baseUrl); } catch { throw new DomainError('CONNECTION_INVALID', 'Invalid compatible endpoint URL.'); }
  const host = url.hostname.toLowerCase();
  requireThat(url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && !url.search && !url.hash && !/^[\d.]+$/.test(host) && !host.includes(':') && !/(^|\.)(localhost|local|internal|invalid|test)$/.test(host) && host.includes('.') && !/%|\\/.test(input.baseUrl), 'ENDPOINT_NOT_ALLOWED', 'Use an approved public HTTPS hostname without credentials, query parameters or nonstandard ports.');
  const base = url.href.replace(/\/$/, '');
  const allowed = (env.AI_COMPATIBLE_BASE_URLS ?? '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  requireThat(allowed.includes(base), 'ENDPOINT_NOT_ALLOWED', 'This exact base URL is not in the deployment administrator’s AI_COMPATIBLE_BASE_URLS allowlist.', 403);
  requireThat(['responses', 'chat_completions'].includes(input.protocol) && ['bearer', 'api-key'].includes(input.headerMode), 'CONNECTION_INVALID', 'Choose Responses or Chat Completions and Bearer or api-key authentication.');
  return { ...input, baseUrl: base };
}
const MESSAGES = {
  AI_REDIRECT_BLOCKED: 'The provider returned a redirect. Use the approved API endpoint; credentials were not forwarded.', AI_AUTH_FAILED: 'The provider rejected the credential or account permission.', AI_RATE_LIMITED: 'The provider rate limit was reached.', AI_MODEL_UNAVAILABLE: 'The model or endpoint is unavailable.', AI_IMAGE_UNSUPPORTED: 'The model rejected the image task or request format.', AI_REFUSED: 'The provider refused this request. No fallback was used.', AI_TIMEOUT: 'The provider request timed out.', AI_NETWORK_ERROR: 'The provider could not be reached.', AI_RESPONSE_TRUNCATED: 'The provider stopped before returning a complete result.',
};
/**
 * What to do about a failing status, in our own words.
 *
 * One code covers two unrelated situations: 404 means this model id is not there for this key,
 * 5xx means the provider is down. The fix differs completely, and "The model or endpoint is
 * unavailable." leaves the reader unable to tell which they have — the state a real Gemini 404
 * on a hand-typed model id puts them in.
 *
 * The provider's own sentence would say it better, and it is deliberately not used: AI-09 fixes
 * that no part of a provider response body may reach a message, because a provider can echo a
 * secret back. So the hint is written here and keyed only by status — nothing crosses over from
 * the response.
 */
const STATUS_HINT = {
  404: 'Check the exact model id: open AI settings, refresh the model list for this connection and choose from it rather than typing the id.',
  429: 'Wait for the provider limit to reset, or route this task to another model.',
  401: 'Check the API key for this connection, and that the account may use this model.',
  403: 'Check the API key for this connection, and that the account may use this model.',
};
/**
 * The provider's own status word — INTERNAL, UNAVAILABLE, INVALID_ARGUMENT — and nothing else.
 *
 * Without it a 500 and a 503 read the same, and they call for opposite things: one is the
 * request, the other is load. The body is never kept: a provider may echo request content in
 * it, so only a closed-vocabulary token from a known field survives.
 */
async function statusToken(response) {
  try {
    const data = JSON.parse((await response.text()).slice(0, 20000));
    const token = data?.error?.status ?? data?.error?.type ?? data?.error?.code;
    return typeof token === 'string' && /^[A-Za-z_]{3,40}$/.test(token) ? token : null;
  } catch { return null; }
}
function statusHint(status) { return STATUS_HINT[status] ?? (status >= 500 ? 'This is an outage on the provider side; the run is retried automatically.' : null); }
export function providerError(code, details = {}) {
  const { hint = null, ...rest } = details;
  const base = MESSAGES[code] ?? 'Recognition failed.';
  return Object.assign(new DomainError(code, hint ? `${base} ${hint}` : base, 502), {
    retryable: ['AI_RATE_LIMITED', 'AI_NETWORK_ERROR', 'AI_MODEL_UNAVAILABLE'].includes(code), ...rest,
  });
}
function headers(connection, credential) {
  const h = { 'content-type': 'application/json' };
  if (connection.provider === 'gemini') h['x-goog-api-key'] = credential;
  else if (connection.provider === 'anthropic') { h['x-api-key'] = credential; h['anthropic-version'] = '2023-06-01'; }
  else if (connection.headerMode === 'api-key') h['api-key'] = credential;
  else h.authorization = `Bearer ${credential}`;
  return h;
}
export async function providerFetch(connection, credential, suffix, { body, timeoutMs = 60000, fetchImpl = fetch } = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs), start = Date.now();
  try {
    const response = await fetchImpl(`${connection.baseUrl}${suffix}`, { method: body ? 'POST' : 'GET', headers: headers(connection, credential), ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: controller.signal });
    // Workers rejects redirect: 'error'. Never follow redirects with provider credentials.
    if (response.status >= 300 && response.status < 400) throw providerError('AI_REDIRECT_BLOCKED', { httpStatus: response.status, durationMs: Date.now() - start });
    const retryHeader = response.headers.get('retry-after');
    const retryAfterMs = retryHeader ? (/^\d+(\.\d+)?$/.test(retryHeader) ? Number(retryHeader) * 1000 : Math.max(0, Date.parse(retryHeader) - Date.now())) : 2000;
    if (!response.ok) throw providerError(response.status === 401 || response.status === 403 ? 'AI_AUTH_FAILED' : response.status === 429 ? 'AI_RATE_LIMITED' : response.status === 404 || response.status >= 500 ? 'AI_MODEL_UNAVAILABLE' : 'AI_IMAGE_UNSUPPORTED', { httpStatus: response.status, providerStatus: await statusToken(response), retryable: response.status === 429 || response.status >= 500, retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : 2000, durationMs: Date.now() - start, hint: statusHint(response.status) });
    const text = await response.text();
    requireThat(text.length <= 2000000, 'AI_INVALID_OUTPUT', 'The provider response exceeded the output limit.');
    let data; try { data = JSON.parse(text); } catch { throw new DomainError('AI_INVALID_OUTPUT', 'The provider returned a non-JSON response.'); }
    return { data, requestId: response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? null, durationMs: Date.now() - start };
  } catch (e) {
    // Only our own errors carry a string code. The runtime's AbortError is a DOMException with a
    // numeric code (20), and passing it on recorded a timeout as "code 20, operation aborted".
    if (typeof e.code === 'string') throw e;
    throw providerError(controller.signal.aborted ? 'AI_TIMEOUT' : 'AI_NETWORK_ERROR', { durationMs: Date.now() - start });
  } finally { clearTimeout(timer); }
}
export async function listProviderModels(connection, credential, cursor = null, options = {}) {
  requireThat(!cursor || typeof cursor === 'string' && cursor.length <= 1000, 'CURSOR_INVALID', 'Invalid pagination cursor.');
  const suffix = connection.provider === 'gemini' ? `/models?pageSize=100${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ''}` : `/models${connection.provider === 'anthropic' ? `?limit=100${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ''}` : cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`;
  const { data } = await providerFetch(connection, credential, suffix, { ...options, timeoutMs: 15000 });
  const list = connection.provider === 'gemini' ? data.models : data.data;
  requireThat(Array.isArray(list), 'AI_INVALID_OUTPUT', 'The provider did not return a model list. Add an exact model ID manually.');
  return { models: list.map(m => ({ remoteModelId: (m.name ?? m.id).replace(/^models\//, ''), displayName: m.displayName ?? m.display_name ?? m.id ?? m.name, providerMetadata: { inputTokenLimit: m.inputTokenLimit ?? null, outputTokenLimit: m.outputTokenLimit ?? null, supportedGenerationMethods: m.supportedGenerationMethods ?? null } })), nextCursor: data.nextPageToken ?? (data.has_more ? data.last_id ?? list.at(-1)?.id : null) };
}
export function buildProviderRequest(connection, model, input, settings = {}) {
  let prompt = recognitionPrompt(input, settings.repair);
  if (model.coordinateConvention === 'yxyx_1000') prompt += '\nFor this explicitly configured model, express every bbox as [ymin,xmin,ymax,xmax] on a 0–1000 scale instead of xywh. The adapter converts it before validation.';
  if (model.coordinateConvention === 'xywh_pixels') prompt += '\nFor this explicitly configured model, express every bbox as [x,y,width,height] in the declared source image pixels instead of normalized coordinates. The adapter converts it before validation.';
  const schema = schemaFor(input.task), max = settings.maxOutputTokens ?? 8192;
  const images = input.images.map(i => ({ ...i, base64: i.base64 ?? toBase64(i.bytes) }));
  const structured = model.structuredOutput !== false;
  if (connection.provider === 'gemini') {
    const parts = [{ text: prompt }, ...images.flatMap(i => [{ text: `Audit image ID: ${i.imageId}` }, { inlineData: { mimeType: i.mimeType, data: i.base64 } }])];
    return { suffix: `/models/${encodeURIComponent(model.remoteModelId.replace(/^models\//, ''))}:generateContent`, body: { contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: max, responseMimeType: 'application/json', ...(structured ? { responseJsonSchema: schema } : {}) } } };
  }
  if (connection.provider === 'anthropic') return { suffix: '/messages', body: { model: model.remoteModelId, max_tokens: max, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images.flatMap(i => [{ type: 'text', text: `Audit image ID: ${i.imageId}` }, { type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.base64 } }])] }], ...(structured ? { output_config: { format: { type: 'json_schema', schema } } } : {}) } };
  if (connection.protocol === 'chat_completions') return { suffix: '/chat/completions', body: { model: model.remoteModelId, max_tokens: max, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images.map(i => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.base64}` } }))] }], ...(structured ? { response_format: { type: 'json_schema', json_schema: { name: 'retail_observations', strict: true, schema } } } : {}) } };
  return { suffix: '/responses', body: { model: model.remoteModelId, store: false, max_output_tokens: max, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, ...images.flatMap(i => [{ type: 'input_text', text: `Audit image ID: ${i.imageId}` }, { type: 'input_image', image_url: `data:${i.mimeType};base64,${i.base64}` }])] }], ...(structured ? { text: { format: { type: 'json_schema', name: 'retail_observations', strict: true, schema } } } : {}) } };
}
export function parseProviderResponse(provider, protocol, data) {
  let raw, usage, resolvedModelId = data.model ?? null;
  if (provider === 'gemini') {
    const candidate = data.candidates?.[0];
    if (data.promptFeedback?.blockReason || ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'RECITATION'].includes(candidate?.finishReason)) throw providerError('AI_REFUSED');
    if (candidate?.finishReason === 'MAX_TOKENS') throw providerError('AI_RESPONSE_TRUNCATED', { usage: data.usageMetadata ?? null });
    requireThat(candidate?.finishReason === 'STOP', 'AI_INVALID_OUTPUT', 'The provider did not produce a complete candidate.');
    raw = (candidate.content?.parts ?? []).filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join(''); usage = data.usageMetadata ?? null; resolvedModelId = data.modelVersion ?? null;
  } else if (provider === 'anthropic') {
    if (data.stop_reason === 'refusal') throw providerError('AI_REFUSED');
    if (data.stop_reason === 'max_tokens') throw providerError('AI_RESPONSE_TRUNCATED', { usage: data.usage ?? null });
    requireThat(data.stop_reason === 'end_turn', 'AI_INVALID_OUTPUT', 'The model did not finish the requested observation.');
    raw = (data.content ?? []).filter(p => p.type === 'text').map(p => p.text).join(''); usage = data.usage ?? null;
  } else if (protocol === 'chat_completions') {
    const choice = data.choices?.[0];
    if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw providerError('AI_REFUSED');
    if (choice?.finish_reason === 'length') throw providerError('AI_RESPONSE_TRUNCATED', { usage: data.usage ?? null });
    requireThat(choice?.finish_reason === 'stop', 'AI_INVALID_OUTPUT', 'The model did not finish the requested observation.'); raw = choice.message?.content; usage = data.usage ?? null;
  } else {
    const content = (data.output ?? []).flatMap(o => o.content ?? []);
    if (content.some(c => c.type === 'refusal')) throw providerError('AI_REFUSED');
    if (data.status === 'incomplete') throw providerError('AI_RESPONSE_TRUNCATED', { usage: data.usage ?? null });
    requireThat(data.status === 'completed', 'AI_INVALID_OUTPUT', 'The model did not complete the response.'); raw = content.filter(c => c.type === 'output_text').map(c => c.text).join(''); usage = data.usage ?? null;
  }
  requireThat(typeof raw === 'string' && raw.trim(), 'AI_INVALID_OUTPUT', 'The provider returned no observation JSON.');
  return { raw, usage, resolvedModelId, responseId: data.id ?? data.responseId ?? null };
}
/**
 * Gemini answered every Planogram Check request carrying its response schema with a 5xx within a
 * second or four, on two models, while the same request without the schema succeeded and Price
 * Validation's smaller schema was accepted. A schema is how the provider is asked to keep to the
 * shape; `validateOutput` is what guarantees it, and it runs either way. So a structured request
 * the provider fails on is sent once more without the schema, and the run records that it was.
 */
const schemaRejected = (connection, model, e) => connection.provider === 'gemini' && model.structuredOutput !== false && e?.code === 'AI_MODEL_UNAVAILABLE' && e.httpStatus >= 500;
export async function runProvider(connection, credential, model, input, settings, options = {}) {
  const started = Date.now();
  let response, schema = null;
  try {
    const request = buildProviderRequest(connection, model, input, settings);
    response = await providerFetch(connection, credential, request.suffix, { body: request.body, timeoutMs: settings.timeoutMs, ...options });
  } catch (e) {
    if (!schemaRejected(connection, model, e)) throw e;
    schema = { enforced: false, rejectedWith: { httpStatus: e.httpStatus, providerStatus: e.providerStatus ?? null } };
    const request = buildProviderRequest(connection, { ...model, structuredOutput: false }, input, settings);
    const remaining = Math.max(1000, (settings.timeoutMs ?? 60000) - (Date.now() - started));
    try { response = await providerFetch(connection, credential, request.suffix, { body: request.body, timeoutMs: remaining, ...options }); }
    catch (retry) { throw Object.assign(retry, { schema, durationMs: Date.now() - started }); }
  }
  const durationMs = Date.now() - started;
  let parsed;
  try { parsed = parseProviderResponse(connection.provider, connection.protocol, response.data); }
  catch (e) { Object.assign(e, { durationMs, requestId: response.requestId, schema }); throw e; }
  // `requestMs` is the answering request alone, without a rejected first try — what a speed is measured from.
  try { return { ...parsed, result: validateOutput(parsed.raw, input, model.coordinateConvention ?? 'xywh_normalized', { otherParts: input.part ? new Set(input.part.otherKeys) : null }), requestId: response.requestId, durationMs, requestMs: response.durationMs, schema, estimatedCost: estimateCost(parsed.usage, model.pricing) }; }
  catch (e) { Object.assign(e, parsed, { durationMs, requestId: response.requestId, schema }); throw e; }
}
/**
 * The most positions one Planogram Check request is asked to describe.
 *
 * A live 7×30 audit in one request never completed: its prompt alone was 29,790 tokens of
 * geometry, and the answer was cut off at 8,192 output tokens after 7,860 went to thinking, or
 * ran past the 60-second limit. Whole rows are kept together, so a 7×30 cabinet goes as seven
 * requests of 30 positions, sent at once; a cabinet this small or smaller goes as one.
 */
export const PART_POSITIONS = 40;
export function partPlan(rows, columns) {
  const rowsPerPart = rows * columns <= PART_POSITIONS ? rows : Math.max(1, Math.floor(PART_POSITIONS / columns));
  return { parts: Math.ceil(rows / rowsPerPart), rowsPerPart, positionsPerPart: rowsPerPart * columns };
}
export function splitInput(input) {
  const geometry = input.geometry ?? [];
  if (input.task !== TASK_TW || geometry.length <= PART_POSITIONS) return [input];
  const rows = [...new Set(geometry.map(g => g.row))].sort((a, b) => a - b);
  const columns = Math.max(...rows.map(r => geometry.filter(g => g.row === r).length));
  const { rowsPerPart } = partPlan(rows.length, columns), parts = [];
  for (let i = 0; i < rows.length; i += rowsPerPart) parts.push(rows.slice(i, i + rowsPerPart));
  return parts.map((own, i) => {
    const mine = new Set(own);
    return { ...input, geometry: geometry.filter(g => mine.has(g.row)), part: { index: i + 1, of: parts.length, rows: [own[0], own.at(-1)], otherKeys: geometry.filter(g => !mine.has(g.row)).map(g => g.key) } };
  });
}
const sumUsage = list => list.reduce((total, usage) => {
  for (const [k, v] of Object.entries(usage ?? {})) if (Number.isFinite(v)) total[k] = (total[k] ?? 0) + v;
  return total;
}, {});
/**
 * What a run and the connection check both call: one request, or one per part of a large
 * cabinet, merged into a single result that is validated against the whole input again.
 */
export async function runRecognition(connection, credential, model, input, settings, options = {}) {
  const parts = splitInput(input);
  if (parts.length === 1) return runProvider(connection, credential, model, input, settings, options);
  const started = Date.now();
  const settled = await Promise.allSettled(parts.map(part => runProvider(connection, credential, model, part, settings, options)));
  const failed = settled.findIndex(s => s.status === 'rejected');
  if (failed >= 0) {
    const e = settled[failed].reason;
    const done = settled.filter(s => s.status === 'fulfilled').length;
    throw Object.assign(e, { part: { index: failed + 1, of: parts.length, succeeded: done }, durationMs: Date.now() - started });
  }
  const responses = settled.map(s => s.value);
  const merged = { schemaVersion: '1', task: input.task, products: [], proposedEmptySlots: [], uncertainRegions: [], qualityWarnings: [] };
  responses.forEach((r, i) => {
    merged.products.push(...r.result.products.map(p => ({ ...p, detectionId: `part${i + 1}-${p.detectionId}` })));
    merged.proposedEmptySlots.push(...r.result.proposedEmptySlots);
    merged.uncertainRegions.push(...r.result.uncertainRegions);
    for (const w of r.result.qualityWarnings) if (!merged.qualityWarnings.includes(w)) merged.qualityWarnings.push(w);
  });
  const costs = responses.map(r => r.estimatedCost);
  return {
    // Boxes are already normalized by each part, so the whole is checked in the normalized convention.
    result: validateOutput(merged, input, 'xywh_normalized'),
    raw: JSON.stringify(merged), usage: sumUsage(responses.map(r => r.usage)),
    resolvedModelId: responses[0].resolvedModelId, responseId: responses.map(r => r.responseId).filter(Boolean).join(',') || null,
    requestId: responses[0].requestId, durationMs: Date.now() - started, requestMs: Math.max(...responses.map(r => r.requestMs ?? r.durationMs)),
    schema: responses.find(r => r.schema)?.schema ?? null,
    estimatedCost: costs.every(Boolean) && new Set(costs.map(c => c.currency)).size === 1 ? { ...costs[0], amount: costs.reduce((n, c) => n + c.amount, 0) } : null,
    parts: responses.map((r, i) => ({ index: i + 1, rows: parts[i].part.rows, requestMs: r.requestMs ?? r.durationMs, usage: r.usage, schema: r.schema ?? null })),
  };
}
/** Explicit usage-field schedules only. Unmapped billing categories => cost unavailable. */
export function estimateCost(usage, pricing) {
  if (!usage || !pricing?.currency || !pricing?.version || !pricing?.source || !pricing?.effectiveFrom || !pricing?.categories?.length || !pricing.completeBillingCoverage) return null;
  let amount = 0;
  for (const c of pricing.categories) {
    const value = c.usagePath.split('.').reduce((v, key) => v?.[key], usage);
    if (!Number.isFinite(value) || value < 0 || !Number.isFinite(c.ratePerMillion) || c.ratePerMillion < 0) return null;
    amount += value * c.ratePerMillion / 1000000;
  }
  return { amount, currency: pricing.currency, pricingVersion: pricing.version, source: pricing.source, label: 'Estimated cost' };
}
