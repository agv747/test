import { esc } from '../lib/format.js';
import { can } from './domain.js';
import { TASK_TW, TASK_SG, proposalToReview } from './ai-contracts.js';
import * as client from './client.js';
import { setActiveProvider } from '../services/recognition/provider.js';
import { updateConfig } from '../store.js';

const providers = { gemini: 'Google Gemini', openai: 'OpenAI', anthropic: 'Anthropic Claude', openai_compatible: 'OpenAI-compatible' };
const q = { tab: 'setup', connectionId: null, modelId: null, modelDraft: null, pollGeneration: 0, provider: 'gemini', run: null, experiment: null, timer: null, nextCursor: null, cursorConnectionId: null, notice: '' };
const btn = (action, text, attrs = '') => `<button type="button" class="btn btn--sm" data-action="${action}" ${attrs}>${text}</button>`;
const option = (id, name, selected) => `<option value="${esc(id)}"${id === selected ? ' selected' : ''}>${esc(name)}</option>`;
const badge = (label, good = false) => `<span class="rei-badge ${good ? 'rei-badge--good' : 'rei-badge--neutral'}">${esc(label)}</span>`;
const date = value => value ? new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Taipei' }) : 'Never';
export function render(ctx) {
  const { actor, auth, ai } = client.getExecution();
  const tab = ctx.params.tab ?? q.tab; q.tab = tab;
  return `<div class="rei-heading"><div><h2>AI settings</h2><p class="muted">Connect a provider, choose a model and save.</p></div>${actor ? `<div class="toolbar">${badge(actor.name, true)}${btn('ai-refresh', 'Refresh')}${btn('ai-signout', 'Sign out')}</div>` : ''}</div>
    ${!actor ? accessPanel(auth) : ''}
    <div class="rei-tabs" role="tablist">${['setup', 'connections'].map(t => `<button role="tab" aria-selected="${t === tab}" class="${t === tab ? 'active' : ''}" data-action="ai-tab" data-tab="${t}">${t === 'setup' ? 'Models for recognition' : 'Connections'}</button>`).join('')}</div>
    <details ${['models', 'checks', 'routing', 'compare'].includes(tab) ? 'open' : ''}><summary>Advanced settings</summary><div class="toolbar mt">${['models', 'checks', 'routing', 'compare'].map(t => btn('ai-tab', {models: 'Model details', checks: 'Optional image tests', routing: 'Advanced defaults', compare: 'Compare models'}[t], `data-tab="${t}"`)).join('')}</div></details>
    ${q.notice ? `<p role="status" class="rei-notice">${esc(q.notice)}</p>` : ''}
    ${!actor ? `<div class="rei-provider-cards">${Object.entries(providers).map(([key, name]) => `<div class="card"><span class="rei-provider-icon">${{ gemini: '✦', openai: '◎', anthropic: 'A', openai_compatible: '↗' }[key]}</span><h3>${name}</h3>${badge('Not configured')}<p class="small muted mt">${key === 'openai_compatible' ? 'Manual model IDs · Responses or Chat Completions · approved hosts only' : 'Discover models · Test image capability · Set market-specific defaults'}</p></div>`).join('')}</div>` : !ai ? '<div class="card">Loading model configuration…</div>' : tab === 'setup' ? setup(ai, actor) : tab === 'connections' ? connections(ai, actor) : tab === 'models' ? models(ai, actor) : tab === 'routing' ? routing(ai, actor) : tab === 'checks' ? checks(ai, actor) : compare(ai, actor)}
    ${q.run && ['checks', 'compare'].includes(tab) ? runPanel(q.run) : ''}`;
}
function accessPanel(auth) {
  return `<div class="card rei-access"><div><h3>Private AI administration</h3><p>Sign in to configure credentials and send images to real models.</p><p class="small muted">${auth.authConfigured ? 'Use your administrator-issued access token.' : 'Deployment setup required: add a random ADMIN_ACCESS_TOKEN and an AI_CREDENTIALS_ENCRYPTION_KEY in Cloudflare Worker secrets. Existing provider environment keys can also be used.'}</p><p class="small"><a href="https://dash.cloudflare.com/" target="_blank" rel="noopener noreferrer">Open Cloudflare dashboard ↗</a></p></div><form data-form="ai-signin"><label>Access token<input type="password" name="accessToken" required autocomplete="off" minlength="3" maxlength="512" pattern="[A-Za-z0-9_-]+" placeholder="Administrator-issued token"></label><button class="btn btn--primary mt" type="submit">Sign in</button><p class="xsmall muted mt">The token is used for an HttpOnly session. Model API keys are entered only after sign-in.</p></form></div>`;
}
function setup(ai, actor) {
  if (!can(actor, 'ai.manage')) return '<div class="card">Your administrator selects the models used for recognition.</div>';
  const connected = ai.connections.filter(c => c.enabled && c.credentialConfigured);
  return `<div class="card"><h3>1. Provider connection</h3><p>${connected.length ? connected.map(c => esc(c.name)).join(', ') : 'No provider connected yet.'}</p>${btn('ai-tab', connected.length ? 'Manage connection / refresh model list' : 'Connect a provider', 'data-tab="connections"')}</div><div class="card"><h3>2. Choose a model</h3><p class="small muted">Save one model for each module. You can analyze a photo immediately after saving; a separate image test is optional.</p>${actor.markets.map(market => {
    const task = market === 'TW' ? TASK_TW : TASK_SG;
    const current = ai.routes.find(r => r.task === task);
    const choices = ai.models.filter(m => connected.some(c => c.id === m.connectionId && c.allowedMarkets.includes(market)) && (!m.providerMetadata?.supportedGenerationMethods || m.providerMetadata.supportedGenerationMethods.includes('generateContent') || m.id === current?.defaultModelId));
    return `<form class="rei-form-grid mt" data-form="ai-default" data-market="${market}" data-task="${task}"><label>${market === 'TW' ? 'Planogram Check' : 'Price Validation'}<select name="modelId" required><option value="">Choose a model</option>${choices.map(m => option(m.id, `${m.displayName} · ${ai.connections.find(c => c.id === m.connectionId)?.name ?? ''}`, current?.defaultModelId)).join('')}</select></label><div class="toolbar"><button class="btn btn--primary" type="submit" ${choices.length ? '' : 'disabled'}>Save model</button></div></form>${!choices.length ? '<p class="small muted">Open Connections and click Refresh models first.</p>' : ''}`;
  }).join('')}<p class="small muted mt">Saving uses only the selected model for that module. Extra fallbacks and overrides remain available under Advanced settings. Provider compatibility is checked when a photo is analyzed.</p></div>`;
}
function connections(ai, actor) {
  if (!can(actor, 'ai.manage')) return '<div class="card">Connection administration requires an Admin. You can compare the models your administrator has approved.</div>';
  const c = ai.connections.find(c => c.id === q.connectionId), provider = c?.provider ?? q.provider;
  return `<div class="card rei-table-scroll"><div class="rei-card-head"><h3>Provider connections</h3>${btn('ai-new-connection', '+ Add connection')}</div><table class="rei-table"><thead><tr><th>Name / provider</th><th>Credential</th><th>Connection test</th><th>Markets</th><th>Active</th><th>Actions</th></tr></thead><tbody>${ai.connections.map(c => `<tr><td><strong>${esc(c.name)}</strong><small>${providers[c.provider]}</small></td><td>${badge(c.credentialConfigured ? 'Configured' : 'Not configured', c.credentialConfigured)}</td><td>${esc(c.lastTest?.state ?? 'Not tested')}<small>${c.lastTest ? date(c.lastTest.checkedAt) : 'Capability tested separately'}</small>${c.lastTest?.note ? `<small>${esc(c.lastTest.note)}</small>` : ''}</td><td>${esc(c.allowedMarkets.join(', ') || 'None')}</td><td>${c.enabled ? 'Enabled' : 'Disabled'}</td><td><div class="toolbar rei-wrap">${btn('ai-edit-connection', 'Edit', `data-id="${c.id}"`)}${btn('ai-test-connection', 'Test credentials', `data-id="${c.id}"`)}${btn('ai-refresh-models', 'Refresh models', `data-id="${c.id}"`)}</div></td></tr>`).join('') || '<tr><td colspan="6">Add the first connection. No real model is selected automatically.</td></tr>'}</tbody></table>${q.nextCursor ? `<div class="mt">${btn('ai-next-model-page', 'Load next model page', `data-id="${q.cursorConnectionId}"`)}</div>` : ''}</div>
    <div class="card"><h3>${c ? 'Edit connection' : 'Add connection'}</h3><form class="rei-form-grid" data-form="ai-connection"><label>Name<input name="name" required maxlength="80" value="${esc(c?.name ?? '')}" placeholder="Planogram Gemini"></label><label>Provider<select name="provider" data-action="ai-provider" ${c ? 'disabled' : ''}>${Object.entries(providers).map(([id, name]) => option(id, name, provider)).join('')}</select></label>
    ${provider === 'openai_compatible' ? `<label class="rei-full">Approved base URL<input name="baseUrl" type="url" required value="${esc(c?.baseUrl ?? '')}" placeholder="https://approved-gateway.example/v1" ${c ? 'readonly' : ''}></label><label>Protocol<select name="protocol">${option('responses', 'Responses API', c?.protocol ?? 'responses')}${option('chat_completions', 'Chat Completions', c?.protocol)}</select></label><label>Credential header<select name="headerMode">${option('bearer', 'Authorization: Bearer', c?.headerMode ?? 'bearer')}${option('api-key', 'api-key', c?.headerMode)}</select></label>` : `<p class="small muted rei-full">Native endpoint is fixed for ${providers[provider]}.</p>`}
    <label>Credential source<select name="credentialSource"><option value="encrypted"${c?.credentialSource !== 'environment' ? ' selected' : ''}>Encrypted API key${c?.credentialConfigured ? ' · keep existing if blank' : ''}</option><option value="environment"${c?.credentialSource === 'environment' ? ' selected' : ''}>Provider environment secret${ai.environmentCredentials[provider] ? ' · available' : ' · not configured'}</option></select></label><label>API key · write only<input name="apiKey" type="password" autocomplete="new-password" placeholder="${c?.credentialConfigured ? 'Leave blank to keep the key' : 'Enter a provider key'}" ${ai.secretStoreConfigured ? '' : 'disabled'}></label>
    ${!ai.secretStoreConfigured ? '<p class="small rei-full">Encrypted key storage is not configured. Use a provider environment secret or add AI_CREDENTIALS_ENCRYPTION_KEY in Cloudflare.</p>' : ''}
    <div><span class="small">Allowed markets</span><div class="toolbar mt">${actor.markets.map(m => `<label class="rei-check"><input name="markets" type="checkbox" value="${m}" ${c?.allowedMarkets.includes(m) ? 'checked' : ''}>${m === 'TW' ? 'Taiwan' : 'Singapore'}</label>`).join('')}</div></div><div><label class="rei-check"><input name="enabled" type="checkbox" ${c?.enabled !== false ? 'checked' : ''}>Enabled</label>${c ? '<label class="rei-check"><input name="removeKey" type="checkbox">Remove stored credential</label>' : ''}</div><div class="toolbar rei-full"><button class="btn btn--primary" type="submit">Save connection</button>${c ? btn('ai-new-connection', 'Cancel edit') : ''}</div></form></div>`;
}
function models(ai, actor) {
  if (!can(actor, 'ai.manage')) return '<div class="card">Model registration and capability testing require an Admin.</div>';
  const m = q.modelDraft ?? ai.models.find(m => m.id === q.modelId);
  const table = `<div class="card rei-table-scroll"><div class="rei-card-head"><h3>Connection-specific models</h3>${btn('ai-new-model', '+ Add exact model ID')}</div><p class="small muted">Edit and save your model here. Image checks are available in the separate Image checks tab.</p><table class="rei-table"><thead><tr><th>Model / remote ID</th><th>Connection</th><th>Structured output</th><th>Enabled</th><th>Actions</th></tr></thead><tbody>${ai.models.map(m => `<tr><td><strong>${esc(m.displayName)}</strong><small>${esc(m.remoteModelId)}</small></td><td>${esc(ai.connections.find(c => c.id === m.connectionId)?.name ?? 'Unavailable')}</td><td>${m.structuredOutput ? 'Native schema requested' : 'JSON + validation'}</td><td>${m.enabled ? 'Yes' : 'No'}</td><td><div class="toolbar rei-wrap">${btn('ai-edit-model', 'Edit', `data-id="${m.id}"`)}</div></td></tr>`).join('') || '<tr><td colspan="5">Refresh models from a connection, or enter the exact provider ID below.</td></tr>'}</tbody></table></div>`;
  return `<div class="card"><h3>${m ? 'Edit model' : 'Add model manually'}</h3><form class="rei-form-grid" data-form="ai-model"><label>Connection<select name="connectionId" required>${ai.connections.map(c => option(c.id, c.name, m?.connectionId)).join('')}</select></label><label>Exact remote model ID<input name="remoteModelId" required maxlength="160" value="${esc(m?.remoteModelId ?? '')}" placeholder="Copy the ID from your provider"></label><label>Display name<input name="displayName" required maxlength="120" value="${esc(m?.displayName ?? '')}"></label><label>Maximum output tokens<input name="maxOutputTokens" type="number" min="256" max="32768" required value="${m?.maxOutputTokens ?? 8192}"></label><label>Bounding box convention<select name="coordinateConvention">${option('xywh_normalized', '[x,y,width,height] · 0–1', m?.coordinateConvention ?? 'xywh_normalized')}${option('yxyx_1000', '[ymin,xmin,ymax,xmax] · 0–1000', m?.coordinateConvention)}${option('xywh_pixels', '[x,y,width,height] · source pixels', m?.coordinateConvention)}</select></label><div><label class="rei-check"><input name="enabled" type="checkbox" ${m?.enabled !== false ? 'checked' : ''}>Enabled</label><label class="rei-check"><input name="structuredOutput" type="checkbox" ${m?.structuredOutput !== false ? 'checked' : ''}>Request native structured output</label></div><label class="rei-full">Optional versioned pricing metadata · JSON<textarea name="pricing" rows="3" placeholder="Leave empty if pricing or usage categories are unknown">${esc(m?.pricingText ?? (m?.pricing ? JSON.stringify(m.pricing, null, 2) : ''))}</textarea></label><p class="small muted rei-full">No price table is assumed. Missing usage or a complete billing schedule is shown as Not available.</p><div class="toolbar rei-full"><button class="btn btn--primary" type="submit">Save model</button>${m ? btn('ai-new-model', 'Cancel edit') : ''}</div></form></div>${table}`;
}
function checks(ai, actor) {
  if (!can(actor, 'ai.manage')) return '<div class="card">Image checks require an Admin.</div>';
  const models = ai.models.filter(m => m.enabled);
  return `<div class="card rei-table-scroll"><h3>Image checks</h3><p class="small muted">Run checks here after saving a model. Optional diagnostics only. You can save a model and start recognition without this test.</p><table class="rei-table"><thead><tr><th>Model</th><th>Planogram Check</th><th>Price Validation</th></tr></thead><tbody>${models.map(m => `<tr><td>${esc(m.displayName)}</td>${[[TASK_TW, 'Check planogram images'], [TASK_SG, 'Check price images']].map(([task, label]) => `<td>${badge(m.capabilities?.[task]?.state ?? 'Not checked', m.capabilities?.[task]?.state === 'verified')}${btn('ai-test-model', label, `data-id="${esc(m.id)}" data-task="${task}"`)}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="3">Enable and save a model in Models first.</td></tr>'}</tbody></table></div>`;
}
function allowedFor(ai, task, market) {
  return ai.models.filter(m => m.enabled && ai.connections.some(c => c.id === m.connectionId && c.enabled && c.credentialConfigured && c.allowedMarkets.includes(market)));
}
function routing(ai, actor) {
  if (!can(actor, 'ai.manage')) return '<div class="card">Only an Admin can change task defaults. Existing runs keep their model snapshot.</div>';
  return actor.markets.map(market => {
    const task = market === 'TW' ? TASK_TW : TASK_SG, route = ai.routes.find(r => r.task === task), choices = allowedFor(ai, task, market);
    const unavailable = route?.defaultModelId && !choices.some(m => m.id === route.defaultModelId);
    return `<div class="card"><div class="rei-card-head"><div><h3>${market === 'TW' ? 'Planogram Check · Recognition' : 'Price Validation · Recognition'}</h3><p class="small muted">Independent default · ${route ? `revision ${route.revision}` : 'not configured'}</p></div>${badge(unavailable ? 'Default unavailable' : route ? 'Configured' : 'Not configured', route && !unavailable)}</div><form class="rei-form-grid" data-form="ai-route" data-market="${market}" data-task="${task}"><label>Default model<select name="defaultModelId" required><option value="">Choose a model</option>${unavailable ? option(route.defaultModelId, 'Unavailable — previous default', route.defaultModelId) : ''}${choices.map(m => option(m.id, m.displayName, route?.defaultModelId)).join('')}</select></label><label>Allowed models<select name="allowedModelIds" multiple required>${choices.map(m => `<option value="${m.id}"${route?.allowedModelIds.includes(m.id) ? ' selected' : ''}>${esc(m.displayName)}</option>`).join('')}</select></label><label>Timeout per attempt · seconds<input name="timeoutSeconds" type="number" min="5" max="60" value="${(route?.timeoutMs ?? 60000) / 1000}" required></label><label>Maximum output tokens<input name="maxOutputTokens" type="number" min="256" max="32768" value="${route?.maxOutputTokens ?? 8192}" required></label><label>Explicit fallback<select name="fallbackModelId"><option value="">None</option>${choices.map(m => option(m.id, m.displayName, route?.fallbackModelId)).join('')}</select></label><label class="rei-check"><input name="fieldOverride" type="checkbox" ${route?.fieldOverride ? 'checked' : ''}>Allow field users to select an alternative</label><p class="small muted rei-full">At most two transport attempts and one schema repair. Refusals never trigger fallback. A fallback records a separate provider/model result. Existing runs are unchanged.</p><button class="btn btn--primary" type="submit" ${choices.length ? '' : 'disabled'}>Save ${market} routing</button></form>${!choices.length ? '<p class="small mt">No eligible models. Configure a connection and enable a model first.</p>' : ''}</div>`;
  }).join('');
}
function compare(ai, actor) {
  if (!can(actor, 'ai.compare')) return '<div class="card">Model comparisons require Manager or Admin access.</div>';
  const { workspace: w, mode } = client.getExecution(), route = ai.routes.find(r => r.task === TASK_TW), choices = allowedFor(ai, TASK_TW, 'TW').filter(m => route?.allowedModelIds.includes(m.id));
  const experiment = q.experiment;
  return `<div class="card"><h3>Same evidence. Separate proposals.</h3><p class="muted">Choose 2–3 authorized models. This sends the same frozen images and catalogue to each selected connection.</p>${mode !== 'shared' ? '<p class="rei-notice">Switch to the private shared workspace to compare real models. Prepared demo results are not AI accuracy measurements.</p>' : ''}<form class="rei-form-grid" data-form="ai-compare"><label>Capture revision<select name="captureId" required>${w.captures.filter(c => c.images.length).map(c => option(c.id, `${w.fixtures.find(f => f.id === c.fixtureId)?.outletName ?? c.fixtureId} · ${date(c.capturedAt)} · revision ${c.revision}`, '')).join('')}</select></label><label>Models · select 2 or 3<select name="modelIds" multiple required>${choices.map(m => option(m.id, `${m.displayName} · ${providers[ai.connections.find(c => c.id === m.connectionId)?.provider]}`, '')).join('')}</select></label><label class="rei-check rei-full"><input name="useGroundTruth" type="checkbox">Freeze this capture’s latest saved human review as ground truth</label><p class="small muted rei-full">Without confirmed human labels, results show agreement/disagreement only. Comparisons never submit an audit, open an issue or change a production default.</p><button type="submit" class="btn btn--primary" ${mode !== 'shared' || choices.length < 2 ? 'disabled' : ''}>Run comparison</button></form></div>
    ${experiment ? `<div class="card rei-table-scroll"><h3>Comparison results</h3><p class="small muted">Frozen input ${esc(experiment.inputHash?.slice(0, 12))} · ${experiment.groundTruth ? 'Human ground truth frozen before comparison' : 'Agreement/disagreement only — accuracy not measured'}</p><table class="rei-table"><thead><tr><th>Model</th><th>Result</th><th>Raw proposals</th><th>Unknown</th><th>Exact slot accuracy</th><th>Latency</th><th>Estimated cost</th><th></th></tr></thead><tbody>${(experiment.runs ?? []).map(r => `<tr><td><strong>${esc(r.modelName)}</strong><small>${esc(r.remoteModelId)}</small></td><td>${esc(r.state)}${r.error ? `<small>${esc(r.error.message)}</small>` : ''}</td><td>${r.result?.products.length ?? '—'}</td><td>${r.comparison?.unknown ?? '—'}</td><td>${r.comparison?.accuracy == null ? 'Not measured' : `${(r.comparison.accuracy * 100).toFixed(1)}% (${r.comparison.correct}/${r.comparison.denominator})`}<small>${r.comparison?.excluded ?? 0} ground-truth slots excluded</small></td><td>${r.durationMs ? `${(r.durationMs / 1000).toFixed(1)} s` : '—'}</td><td>${cost(r)}<small>${r.unknownCostAttempts ?? 0} unknown-cost attempts</small></td><td>${btn('ai-view-run', 'Inspect', `data-id="${r.id}"`)}${r.result ? btn('ai-adopt-run', 'New review', `data-id="${r.id}" data-capture-id="${experiment.captureId}"`) : ''}</td></tr>`).join('')}</tbody></table>${disagreements(experiment)}</div>` : ''}`;
}
function disagreements(experiment) {
  const plan = experiment.reference?.plan, runs = (experiment.runs ?? []).filter(r => r.result);
  if (!plan || runs.length < 2) return '';
  const proposals = runs.map(r => ({ run: r, slots: proposalToReview(plan, r.result) }));
  const rows = plan.slots.map(s => ({ key: s.key, values: proposals.map(p => { const r = p.slots.find(r => r.key === s.key); return r?.confirmedSkuId ?? r?.state ?? 'unknown'; }) })).filter(s => new Set(s.values).size > 1);
  return `<h3 class="mt">Per-slot disagreements · ${rows.length}</h3>${rows.length ? `<table class="rei-table"><thead><tr><th>Physical slot</th>${runs.map(r => `<th>${esc(r.modelName)}</th>`).join('')}</tr></thead><tbody>${rows.map(s => `<tr><td>${s.key}</td>${s.values.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<p class="small muted">No different raw slot identities among completed models. Agreement alone does not establish accuracy.</p>'}`;
}
function cost(run) { return run.estimatedCost ? `${run.estimatedCost.currency} ${run.estimatedCost.amount.toFixed(6)}` : 'Not available'; }
function runPanel(run) {
  return `<div class="card"><div class="rei-card-head"><h3>${esc(run.modelName ?? 'Model run')} · ${esc(run.state)}</h3>${btn('ai-close-run', 'Close')}</div><p class="small muted">${esc(run.provider ?? '')} · ${esc(run.remoteModelId ?? '')} · task ${esc(run.task ?? '')} · ${cost(run)}</p>${run.error ? `<div class="rei-notice rei-notice--error">${esc(run.error.message)}</div>` : ''}${['queued', 'processing'].includes(run.state) ? '<p>Job saved. The server checks the queue every minute. You can leave this page; processing continues on the server.</p>' : ''}<p class="small">${run.purpose === 'capability' ? 'This synthetic image probe checks API compatibility. It does not measure cigarette recognition accuracy.' : 'Output is a proposal. Human review is required before operational use.'}</p><details><summary>Attempts, usage and provenance</summary><pre class="rei-json">${esc(JSON.stringify({ inputHash: run.inputHash, model: run.remoteModelId, resolvedModel: run.resolvedModelId, promptVersion: run.promptVersion, routeRevision: run.routeRevision, attempts: run.attempts }, null, 2))}</pre></details>${run.raw ? `<details><summary>Raw model output</summary><pre class="rei-json">${esc(run.raw)}</pre></details>` : ''}</div>`;
}
export async function onAction(action, el, ctx) {
  const { ai } = client.getExecution();
  q.notice = '';
  if (action === 'ai-tab') { clearTimeout(q.timer); q.pollGeneration++; q.tab = el.dataset.tab; ctx.setParams({ tab: q.tab }); }
  else if (action === 'ai-refresh') await client.refreshAi();
  else if (action === 'ai-signout') { await client.signOut(); q.run = null; q.experiment = null; }
  else if (action === 'ai-new-connection') { q.connectionId = null; q.provider = 'gemini'; }
  else if (action === 'ai-edit-connection') { q.connectionId = el.dataset.id; q.provider = ai.connections.find(c => c.id === q.connectionId).provider; }
  else if (action === 'ai-test-connection' || action === 'ai-refresh-models' || action === 'ai-next-model-page') {
    const op = action === 'ai-test-connection' ? 'test' : 'refresh-models';
    try { const result = await client.api(`/ai/connections/${el.dataset.id}/${op}`, { cursor: action === 'ai-next-model-page' ? q.nextCursor : null }); q.nextCursor = result.nextCursor; q.cursorConnectionId = el.dataset.id; } finally { await client.refreshAi(); }
  } else if (action === 'ai-new-model') { q.modelId = null; q.modelDraft = null; }
  else if (action === 'ai-edit-model') { q.modelId = el.dataset.id; q.modelDraft = null; }
  else if (action === 'ai-test-model') { q.run = await client.api(`/ai/models/${el.dataset.id}/test-task`, { task: el.dataset.task, idempotencyKey: crypto.randomUUID() }); localStorage.setItem('rei.last-probe', q.run.id); client.triggerRun(q.run.id); }
  else if (action === 'ai-view-run') q.run = await client.api(`/ai/runs/${el.dataset.id}`);
  else if (action === 'ai-close-run') { q.run = null; localStorage.removeItem('rei.last-probe'); }
  else if (action === 'ai-adopt-run') ctx.navigate('tw/audits/detail', { id: el.dataset.captureId, run: el.dataset.id });
}
export function onChange(target, ctx) {
  if (target.dataset.action === 'ai-provider') { q.provider = target.value; ctx.render(); return true; }
  return false;
}
export async function onSubmit(form, ctx) {
  const p = new FormData(form), { ai } = client.getExecution(), type = form.dataset.form;
  if (type === 'ai-signin') { const token = p.get('accessToken'); form.reset(); await client.signIn(token); return; }
  q.notice = '';
  if (type === 'ai-default') {
    const model = ai.models.find(m => m.id === p.get('modelId'));
    if (!model) throw new Error('Select a model first.');
    if (!model.enabled) await client.api(`/ai/models/${model.id}`, { connectionId: model.connectionId, remoteModelId: model.remoteModelId, displayName: model.displayName, maxOutputTokens: model.maxOutputTokens ?? 8192, coordinateConvention: model.coordinateConvention ?? 'xywh_normalized', enabled: true, structuredOutput: model.structuredOutput !== false, pricing: model.pricing ?? null, expectedRevision: model.revision }, 'PATCH');
    const current = ai.routes.find(r => r.task === form.dataset.task);
    await client.api(`/ai/routes/${form.dataset.market}/${form.dataset.task}`, { defaultModelId: model.id, allowedModelIds: [model.id], fallbackModelId: null, fieldOverride: false, timeoutMs: 60000, maxOutputTokens: Math.min(8192, model.maxOutputTokens ?? 8192), expectedRevision: current?.revision ?? 0 }, 'PUT');
    if (form.dataset.market === 'SG') { setActiveProvider('configured-sg'); updateConfig({ recognition_model: 'configured-sg' }); }
    q.notice = 'Model saved. Open the module, upload a photo and start analysis.';
  } else if (type === 'ai-connection') {
    const c = ai.connections.find(c => c.id === q.connectionId), key = p.get('apiKey');
    form.querySelector('[name="apiKey"]').value = '';
    await client.api(`/ai/connections${c ? `/${c.id}` : ''}`, { name: p.get('name'), provider: c?.provider ?? p.get('provider'), baseUrl: p.get('baseUrl'), protocol: p.get('protocol'), headerMode: p.get('headerMode'), allowedMarkets: p.getAll('markets'), enabled: p.has('enabled'), credentialSource: p.get('credentialSource'), apiKey: key || null, removeKey: p.has('removeKey'), expectedRevision: c?.revision }, c ? 'PATCH' : 'POST'); q.connectionId = null; q.notice = 'Connection saved. Click Refresh models to load the available models.';
  } else if (type === 'ai-model') {
    const m = q.modelDraft ?? ai.models.find(m => m.id === q.modelId), pricing = String(p.get('pricing') ?? '').trim();
    q.modelDraft = { ...m, connectionId: p.get('connectionId'), remoteModelId: p.get('remoteModelId'), displayName: p.get('displayName'), maxOutputTokens: p.get('maxOutputTokens'), coordinateConvention: p.get('coordinateConvention'), enabled: p.has('enabled'), structuredOutput: p.has('structuredOutput'), pricingText: pricing };
    await client.api(`/ai/models${q.modelId ? `/${q.modelId}` : ''}`, { connectionId: p.get('connectionId'), remoteModelId: p.get('remoteModelId'), displayName: p.get('displayName'), maxOutputTokens: Number(p.get('maxOutputTokens')), coordinateConvention: p.get('coordinateConvention'), enabled: p.has('enabled'), structuredOutput: p.has('structuredOutput'), pricing: pricing ? JSON.parse(pricing) : null, expectedRevision: m?.revision }, q.modelId ? 'PATCH' : 'POST'); q.modelId = null; q.modelDraft = null;
  } else if (type === 'ai-route') {
    const route = ai.routes.find(r => r.task === form.dataset.task);
    await client.api(`/ai/routes/${form.dataset.market}/${form.dataset.task}`, { defaultModelId: p.get('defaultModelId'), allowedModelIds: p.getAll('allowedModelIds'), timeoutMs: Number(p.get('timeoutSeconds')) * 1000, maxOutputTokens: Number(p.get('maxOutputTokens')), fieldOverride: p.has('fieldOverride'), fallbackModelId: p.get('fallbackModelId') || null, expectedRevision: route?.revision ?? 0 }, 'PUT');
    if (form.dataset.market === 'SG') { setActiveProvider('configured-sg'); updateConfig({ recognition_model: 'configured-sg' }); }
  } else if (type === 'ai-compare') {
    const capture = client.getExecution().workspace.captures.find(c => c.id === p.get('captureId'));
    const created = await client.api('/ai/experiments', { captureId: capture.id, captureRevision: capture.revision, modelIds: p.getAll('modelIds'), groundTruthReviewId: p.has('useGroundTruth') ? capture.reviews.at(-1)?.id : null });
    localStorage.setItem('rei.last-comparison', created.id); created.runIds.forEach(client.triggerRun); q.experiment = await client.api(`/ai/experiments/${created.id}`);
  }
  await client.refreshAi();
}
export function mount(ctx) {
  clearTimeout(q.timer);
  const generation = ++q.pollGeneration;
  if (!['checks', 'compare'].includes(q.tab)) return;
  if (!client.getExecution().actor) return;
  const runId = q.run?.id ?? localStorage.getItem('rei.last-probe'), experimentId = q.experiment?.id ?? localStorage.getItem('rei.last-comparison');
  const pollRun = q.tab === 'checks' && runId && (!q.run || ['queued', 'processing'].includes(q.run.state));
  const pollExperiment = q.tab === 'compare' && experimentId && (!q.experiment || q.experiment.runs?.some(r => ['queued', 'processing'].includes(r.state)));
  if (!pollRun && !pollExperiment) return;
  q.timer = setTimeout(async () => {
    if (!location.hash.includes('admin/ai') || generation !== q.pollGeneration) return;
    try {
      if (pollRun) { q.run = await client.api(`/ai/runs/${runId}`); if (q.run.state === 'queued') client.triggerRun(runId); else if (!['queued', 'processing'].includes(q.run.state)) await client.refreshAi(); }
      if (pollExperiment) { q.experiment = await client.api(`/ai/experiments/${experimentId}`); q.experiment.runs.filter(r => r.state === 'queued').forEach(r => client.triggerRun(r.id)); }
      if (generation === q.pollGeneration && location.hash.includes('admin/ai')) ctx.render();
    } catch { /* Logout or revoked access must not continue polling evidence. */ }
  }, 2000);
}
