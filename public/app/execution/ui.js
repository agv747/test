import { esc } from '../lib/format.js';
import { assess, overview, emptyReview, can, importPlan, validatePlan, OPEN_ISSUES, clone } from './domain.js';
import { preparedProposal, cellBox } from './demo.js';
import * as client from './client.js';
import { proposalToReview, TASK_TW } from './ai-contracts.js';
import * as aiUi from './ui-ai.js';
import { demoNavigation, simplifyDemoMarkup } from './demo-ui.js';

const titles = { 'tw/overview': 'Planogram Check', 'tw/audits/new': 'Start cabinet audit', 'tw/audits/detail': 'Cabinet audit', 'tw/planograms': 'Planogram library', 'tw/planograms/detail': 'Reference planogram', 'tw/issues': 'Execution issues', 'admin/ai': 'AI models & connections' };
export const title = ctx => titles[ctx.path] ?? 'Retail Execution Intelligence';
export const subtitle = ctx => ctx.path === 'admin/ai' ? 'Connections, capability checks and independent market defaults' : 'Approved layout · Visible evidence · Verified follow-up';
const state = { error: '', message: '', busy: false, selectedSlot: 'R1C1', captureId: null, slots: [], run: null, poll: null, planId: null, plan: null, mobileTab: 'photo', filter: '', filters: {}, openIssue: null };
const pct = n => n == null ? '—' : `${Number((n * 100).toFixed(1))}%`;
export const time = value => value ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : 'Not captured';
export const localTime = value => new Date(value).toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', 'T').slice(0, 16);
const parseTime = value => value ? new Date(`${value}:00+08:00`).toISOString() : null;
export const badge = (text, variant = 'neutral') => `<span class="rei-badge rei-badge--${variant}">${esc(text)}</span>`;
export const button = (action, text, attrs = '', style = '') => `<button class="btn ${style}" data-action="${action}" ${attrs}>${text}</button>`;
const options = (values, selected, empty = null) => `${empty !== null ? `<option value="">${esc(empty)}</option>` : ''}${values.map(v => `<option value="${esc(v.id ?? v)}"${(v.id ?? v) === selected ? ' selected' : ''}>${esc(v.name ?? v.displayName ?? v)}</option>`).join('')}`;
function banner() {
  const { mode, actor } = client.getExecution();
  return `<div class="rei-scope"><div>${badge(mode === 'demo' ? 'Prepared demonstration' : 'Private workspace', mode === 'demo' ? 'info' : 'good')} <span>${mode === 'demo' ? 'Sample outlets · real products, unverified · 22 Sep 2026, 12:00 Taipei' : `Signed in as ${esc(actor?.name)} · Taiwan`}</span></div><div class="toolbar">${mode === 'demo' ? button('tw-reset', 'Reset example', '', 'btn--sm') : button('tw-refresh', 'Refresh', '', 'btn--sm')}<select data-action="tw-workspace" aria-label="Workspace"><option value="demo"${mode === 'demo' ? ' selected' : ''}>Demo · this browser</option><option value="shared"${mode === 'shared' ? ' selected' : ''}>Private · shared database</option></select></div></div>`;
}
export function render(ctx) {
  const { workspace: w } = client.getExecution();
  if (!w) return '<div class="card">Loading execution workspace…</div>';
  const notice = `${state.error ? `<div class="rei-notice rei-notice--error" role="alert">${esc(state.error)}</div>` : ''}${state.message ? `<div class="rei-notice" role="status">${esc(state.message)}</div>` : ''}${state.busy ? '<div class="rei-busy" role="status">Saving / processing…</div>' : ''}`;
  let page;
  if (ctx.path === 'admin/ai') page = aiUi.render(ctx);
  else if (ctx.path === 'tw/overview') page = renderOverview(w);
  else if (ctx.path === 'tw/audits/new') page = renderStart(w, ctx);
  else if (ctx.path === 'tw/audits/detail') page = renderAudit(w, ctx);
  else if (ctx.path === 'tw/planograms/detail') page = renderPlan(w, ctx);
  else if (ctx.path === 'tw/planograms') page = renderLibrary(w);
  else page = renderIssues(w, ctx);
  const demoPage = w.demo && ctx.path.startsWith('tw/');
  return `<div class="rei${demoPage ? ' rei--demo' : ''}">${banner()}${demoPage ? demoNavigation(ctx.path) : ''}${notice}${demoPage ? simplifyDemoMarkup(page, ctx.path, state.filters) : page}<p class="rei-footnote">Visible facings only. An empty slot does not establish a store stockout. This tool checks an approved reference; it does not assess legal requirements.</p></div>`;
}
function renderOverview(w) {
  const filters = { ...state.filters, asOf: state.filters.asOf || client.clock() }, a = overview(w, filters);
  const stats = [ ['complete', 'Audit completion', pct(a.completionRate), `${a.complete} of ${a.assigned} assigned fixtures`, 'Complete, confirmed current evidence'], ['verified', 'Verified to plan', pct(a.verifiedRate), `${a.verified} of ${a.complete} complete audits`, 'All mandatory checks pass'], ['deviations', 'Fixtures with deviations', a.deviations, `${a.openIssues} open slot issues`, 'One issue per physical slot'], ['review', 'Evidence review needed', a.needsReview, 'Incomplete or pending evidence', 'Unknown is kept separate from empty'] ];
  const shown = a.rows.filter(r => !state.filter || state.filter === 'complete' && r.complete || state.filter === 'verified' && r.verified || state.filter === 'deviations' && r.openIssues.length || state.filter === 'review' && r.needsReview);
  return `<div class="rei-heading"><div><h2>Know what is visible. Verify what changed.</h2><p class="muted">Current cabinet status, including stores that have not been visited.</p></div>${can(client.executionActor(), 'audit.capture') ? button('tw-new-audit', '+ Start audit', '', 'btn--primary') : ''}</div>
    <div class="rei-kpis">${stats.map(([key, name, value, denominator, help]) => `<button class="rei-kpi${state.filter === key ? ' is-selected' : ''}" data-action="tw-kpi" data-filter-key="${key}"><span>${name}</span><strong>${value}</strong><b>${denominator}</b><small>${help}</small></button>`).join('')}</div>
    <div class="card rei-table-card"><div class="rei-card-head"><div><h3>Cabinet coverage</h3><span class="small muted">Latest submitted audit · Fresh within ${filters.freshnessDays ?? 7} days${state.filter ? ` · ${state.filter} filter` : ''}</span></div>${state.filter ? button('tw-clear-filter', 'Clear filter', '', 'btn--sm') : ''}</div>
    <div class="rei-filters"><label>Territory<select data-tw-filter="territory">${options([...new Set(w.fixtures.map(f => f.territory))], filters.territory, 'All territories')}</select></label><label>Outlet<select data-tw-filter="outlet">${options(w.fixtures.map(f => ({ id: f.outletId, name: f.outletName })), filters.outlet, 'All outlets')}</select></label><label>Assigned user<select data-tw-filter="owner">${options([...new Set(w.fixtures.map(f => f.ownerId))], filters.owner, 'All users')}</select></label><label>As of · Taipei<input type="datetime-local" data-tw-filter="asOf" value="${localTime(filters.asOf)}"></label><label>Freshness days<input type="number" min="1" max="90" data-tw-filter="freshnessDays" value="${filters.freshnessDays ?? 7}"></label></div>
    <div class="rei-table-scroll"><table class="rei-table"><thead><tr><th>Outlet / fixture</th><th>Reference</th><th>Last capture</th><th>Correct / verified</th><th>Evidence coverage</th><th>Issues</th><th>Assigned user</th><th>Status</th></tr></thead><tbody>${shown.map(r => {
      const f = r.fixture, s = r.latest?.summary;
      const status = !r.assigned ? 'Reference missing' : !r.latest ? 'Unvisited' : !r.fresh ? 'Stale evidence' : r.verified ? 'Verified to plan' : s?.D && s?.U ? 'Deviations · partial' : s?.D ? 'Deviations found' : 'Needs review';
      return `<tr><td><button class="rei-link" data-action="tw-open-fixture" data-fixture-id="${esc(f.id)}"><strong>${esc(f.outletName)}</strong><small>${esc(f.name)}</small></button></td><td>${esc(r.reference.plan ? `${r.reference.plan.code} v${r.reference.plan.version}` : 'Not assigned')}</td><td>${time(r.latest?.capturedAt)}${r.latest && !r.complete && r.lastComplete ? `<small>Last complete: ${time(r.lastComplete.capturedAt)}</small>` : ''}</td><td>${s?.referenceStatus === 'valid' ? `<strong>${s.C}/${s.C + s.D}</strong><small>${pct(s.adherence)} adherence</small>` : '—'}</td><td>${s?.referenceStatus === 'valid' ? `${pct(s.coverage)}<small>${s.C + s.D}/${s.C + s.D + s.U} slots · ${s.U} unknown</small>` : '—'}</td><td>${r.openIssues.length ? badge(r.openIssues.length, 'risk') : '0'}</td><td>${esc(f.ownerId)}</td><td>${badge(status, r.verified ? 'good' : s?.D ? 'risk' : 'neutral')}</td></tr>`;
    }).join('') || '<tr><td colspan="8">No fixtures match these filters.</td></tr>'}</tbody></table></div></div>
    ${!w.fixtures.length ? `<div class="card"><h3>Set up the planogram workspace</h3><p>Import an approved catalogue and fixture list, then publish and assign a planogram.</p>${button('tw-open-library', 'Open planogram setup')}</div>` : ''}
    <div class="rei-callout"><strong>${a.rows.filter(r => !r.latest && r.assigned).length} assigned fixtures unvisited</strong><span>${a.rows.filter(r => !r.assigned).length} fixtures need a reference. A follow-up draft never improves these figures.</span></div>`;
}
function renderStart(w, ctx) {
  const selected = ctx.params.fixture ?? w.fixtures[0]?.id;
  return `<div class="card rei-form-card"><div class="rei-step">01 / OUTLET & CABINET</div><h2>Start with the physical cabinet</h2><p class="muted">Use the time the photo was taken, especially for gallery uploads.</p><form data-form="tw-start"><label>Outlet and fixture<select name="fixtureId" required>${options(w.fixtures, selected)}</select></label><label>Captured at · Taipei time<input name="capturedAt" type="datetime-local" required value="${localTime(client.clock())}"></label><label>Image source<select name="source"><option value="gallery">Gallery</option><option value="camera">Camera</option></select></label><label>Recognition mode<select name="mode"><option value="manual">Manual review</option><option value="real_model"${client.getExecution().mode !== 'shared' ? ' disabled' : ''}>Real model · private workspace</option></select></label><p class="small muted">Up to 4 images · 8 MB each · JPEG, PNG, WebP. Drafts show whether they are local or uploaded.</p><div class="toolbar"><button class="btn btn--primary" type="submit" ${w.fixtures.length ? '' : 'disabled'}>Create audit & add evidence →</button><button type="button" class="btn" data-nav="tw/overview">Cancel</button></div></form></div>`;
}
function initializeCapture(cap) {
  if (state.captureId === cap.id) return;
  state.captureId = cap.id; state.slots = clone(cap.reviews.at(-1)?.slots ?? emptyReview(cap.reference.plan)); state.run = null; state.selectedSlot = state.slots[0]?.key ?? 'R1C1';
}
function resultFor(plan, slots, key) { return assess({ status: 'valid', plan }, slots).results.find(r => r.family === 'position' && r.ruleKey === key); }
/**
 * A pack's identity, split the way a cabinet is actually read.
 *
 * The grid used to print the SKU id twice in every cell — once stripped of its market prefix
 * inside a 25px pack rectangle, once in full in a `white-space: nowrap` caption. At thirty
 * columns both overflowed their cell and landed on top of the neighbours, which is why a
 * 210-slot reference was unreadable. A person scanning a shelf reads a brand and then a
 * variant, so that is what a cell shows.
 *
 * Brand and variant are recovered from two sources that agree: the id carries the structure
 * (`TW-<owner>-<brand>-<variant…>`), the catalogue name carries the spelling
 * ("Seven Stars Original · JTI"). Matching the id's brand token against the name's leading
 * words is what separates "Seven Stars" from its "Original" — neither source alone can.
 *
 * The private workspace matters here: `setup` stores only id, code, name, market and artworks,
 * so `brand_name` exists in the browser demo and is absent on the server. Hence the fallback
 * chain rather than a field read.
 */
const OWNER_GROUP = { JTI: 'own', TTL: 'ttl' };
export const GROUP_LABEL = { own: 'JTI', ttl: 'Taiwan Tobacco & Liquor', other: 'Other competitors' };
const token = (s) => String(s ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase();
export function packOf(id, catalogue) {
  if (!id) return null;
  const sku = catalogue?.find((s) => s.id === id) ?? null;
  const parts = String(id).split('-');
  const product = String(sku?.name ?? '').split(' · ')[0].trim();
  const words = product ? product.split(/\s+/) : [];
  let brand = '', variant = '';
  if (sku?.brand_name && product.toUpperCase().startsWith(String(sku.brand_name).toUpperCase())) {
    brand = sku.brand_name; variant = product.slice(brand.length).trim();
  } else if (words.length && parts[2]) {
    let acc = '';
    for (let i = 0; i < words.length; i += 1) {
      acc += token(words[i]);
      if (acc === token(parts[2])) { brand = words.slice(0, i + 1).join(' '); variant = words.slice(i + 1).join(' '); break; }
    }
  }
  if (!brand) { brand = words[0] ?? parts.slice(2, 3).join(' ') ?? id; variant = words.slice(1).join(' '); }
  return { group: OWNER_GROUP[parts[1]] ?? 'other', brand, variant, full: sku?.name ?? id };
}
function grid(plan, slots, catalogue, expected = false) {
  return `<div class="rei-grid" style="--columns:${plan.columns}" role="group" aria-label="${plan.rows} by ${plan.columns} cabinet">${plan.slots.map(s => {
    const actual = slots.find(r => r.key === s.key), result = expected ? null : resultFor(plan, slots, s.key);
    const id = expected ? s.preferredSkuId ?? s.allowedSkuIds[0] : actual?.state === 'product' ? actual.confirmedSkuId : null;
    const status = !s.active ? 'not_applicable' : expected ? 'reference' : result.status;
    const pack = s.active ? packOf(id, catalogue) : null;
    const verdict = expected ? '' : status === 'pass' ? '✓ Correct' : status === 'fail' ? '! Deviation' : status === 'unknown' ? (actual?.proposed ? '? Review' : '? Unknown') : '— N/A';
    // The colour band carries the owner; the words carry the product. Identity is never colour alone.
    const face = !s.active ? '—' : pack ? '' : actual?.state === 'empty' ? '∅' : '?';
    const described = pack?.full ?? (!s.active ? 'Not applicable' : actual?.state === 'empty' ? 'Visibly empty' : 'Unknown');
    const title = [s.key, described, verdict].filter(Boolean).join(' · ');
    return `<button class="rei-cell rei-cell--${status}${state.selectedSlot === s.key ? ' is-selected' : ''}" data-action="tw-select-slot" data-slot="${esc(s.key)}" data-owner="${pack?.group ?? 'none'}" title="${esc(title)}" aria-label="${esc(title)}"><small class="rei-cell__key">${s.key}</small><span class="rei-pack">${esc(face)}</span><span class="rei-cell__brand">${esc(pack?.brand ?? (s.active ? described : ''))}</span><span class="rei-cell__variant">${esc(pack?.variant ?? '')}</span>${expected ? '' : `<span class="rei-cell__verdict">${esc(verdict)}</span>`}</button>`;
  }).join('')}</div>`;
}
/** Colour is a three-way grouping, so it needs naming once per grid rather than per cell. */
function ownerLegend() {
  return `<div class="rei-owner-legend">${['own', 'ttl', 'other'].map(g => `<span class="rei-owner-key"><i data-owner="${g}"></i>${esc(GROUP_LABEL[g])}</span>`).join('')}<span class="rei-owner-key"><i data-owner="none"></i>Empty, unknown or not applicable</span></div>`;
}
/**
 * Why "Analyze with real model" is unavailable, in the words of the thing that is missing.
 *
 * The button is gated on three independent conditions, and the screen used to report all of
 * them as "Real model not configured." That reading is wrong for the most common case by far:
 * a visitor in the demo workspace has not configured anything badly, they simply are not
 * signed in — `refreshAi()` returns null without an actor, so there is no route to find. Being
 * told the model is misconfigured sends them to look at provider settings they cannot even
 * open, instead of at the sign-in that would actually unblock them.
 *
 * Reported in gating order, because that is the order they have to be fixed in.
 */
/** Whether the connection behind a route's default model has no key on this deployment. */
function credentialMissing(route, ai) {
  const model = ai?.models?.find((m) => m.id === route?.defaultModelId);
  return ai?.connections?.find((c) => c.id === model?.connectionId)?.credentialConfigured === false;
}
export function analyzeBlocker(mode, route, capture, ai) {
  if (mode !== 'shared') return 'Available in the private workspace. Sign in to send photographs to a real model.';
  if (!route) return 'Choose a model in AI settings, then save it.';
  // A credential that the deployment has stopped providing is worth saying here rather than
  // letting the run reach the queue and come back a minute later with the same news.
  const model = ai?.models?.find((m) => m.id === route.defaultModelId);
  const connection = ai?.connections?.find((c) => c.id === model?.connectionId);
  if (connection && connection.credentialConfigured === false) return `${connection.name} has no key on this deployment. Set it in AI settings before running.`;
  if (!capture.images.length) return 'Add at least one photograph first.';
  return 'New proposals require review before submission.';
}
function renderAudit(w, ctx) {
  const cap = w.captures.find(c => c.id === ctx.params.id);
  if (!cap) return '<div class="card">Audit not found. <a href="#/tw/overview">Open overview</a></div>';
  initializeCapture(cap); const f = w.fixtures.find(x => x.id === cap.fixtureId), plan = cap.reference.plan, summary = assess(cap.reference, state.slots), writable = can(client.executionActor(), 'audit.review');
  const audit = w.assessments.filter(a => a.captureId === cap.id).at(-1), selected = state.slots.find(s => s.key === state.selectedSlot), expected = plan?.slots.find(s => s.key === state.selectedSlot);
  const image = cap.images.find(i => i.id === selected?.primaryEvidence?.imageId) ?? cap.images[0];
  const route = client.getExecution().ai?.routes.find(r => r.task === TASK_TW);
  return `<div class="rei-heading"><div><a class="small" href="#/tw/overview">← Cabinet coverage</a><h2>${esc(f.outletName)} <span class="muted">/ ${esc(f.name)}</span></h2><p class="small muted">${time(cap.capturedAt)} Taipei · ${esc(plan ? `${plan.code} v${plan.version}` : `Reference ${cap.reference.status}`)} · ${cap.mode === 'prepared_demo' ? 'Prepared example' : cap.mode === 'real_model' ? 'Real model + human review' : 'Manual review'} · ${audit ? `Submitted by ${esc(audit.submittedBy)}` : 'Draft'}</p></div>${cap.fixtureId === 'F2' && w.demo && cap.id !== 'capture-F2-followup' ? button('tw-followup', 'Open prepared follow-up →') : ''}</div>
    ${summary.referenceStatus !== 'valid' ? `<div class="rei-notice">Evidence is retained. No score is calculated until a valid reference applies at capture time.</div>` : `<div class="rei-assessment-bar"><div><strong>${summary.C}/${summary.C + summary.D}</strong><span>correct / verified slots</span></div><div><strong>${pct(summary.adherence)}</strong><span>position adherence</span></div><div><strong>${pct(summary.coverage)}</strong><span>${summary.C + summary.D}/${summary.C + summary.D + summary.U} evidence coverage</span></div><div><strong>${summary.U}</strong><span>unknown slots</span></div>${badge(audit ? audit.summary.fullyVerified ? 'Verified to plan' : audit.summary.U ? 'Submitted · incomplete' : 'Submitted · deviations' : 'Review preview', audit?.summary.fullyVerified ? 'good' : 'info')}</div>`}
    <div class="card"><div class="rei-card-head"><h3>Evidence & recognition</h3>${badge(client.getExecution().mode === 'demo' ? 'Local demo draft' : 'Uploaded · shared database', 'info')}</div>
    <div class="toolbar rei-wrap">${cap.images.map(i => `<span class="rei-image-chip">${esc(i.name)} <small>${esc(i.range)}</small></span>`).join('') || '<span class="muted">No photographs yet.</span>'}</div>
    ${writable && !cap.reviews.length && cap.images.length < 4 ? `<form class="rei-upload" data-form="tw-upload"><label>Camera / gallery<input type="file" name="image" accept="image/jpeg,image/png,image/webp" ${cap.source === 'camera' ? 'capture="environment"' : ''} required></label><label>Image range<select name="range"><option value="Overview">Overview · all slots</option>${Array.from({ length: f.rows }, (_, i) => `<option value="Row ${i + 1}">Detail · row ${i + 1}</option>`).join('')}<option value="Custom">Custom slot range</option></select></label><label>Custom slots, comma separated<input name="slotKeys" placeholder="R1C1,R1C2" aria-label="Custom image slots"></label><button class="btn" type="submit">Upload & save draft</button></form>` : ''}
    ${writable ? `<div class="toolbar mt rei-wrap">${cap.mode === 'prepared_demo' && !cap.reviews.length ? button('tw-prepared', 'Load prepared observations', '', 'btn--primary') : ''}${button('tw-analyze', 'Analyze with real model', client.getExecution().mode !== 'shared' || !route || !cap.images.length || credentialMissing(route, client.getExecution().ai) ? 'disabled' : '', 'btn--primary')}${route && (client.executionActor()?.role !== 'field' || route.fieldOverride) ? `<select id="tw-model" aria-label="Recognition model"><option value="">Use configured default</option>${options((client.getExecution().ai?.models ?? []).filter(m => route.allowedModelIds.includes(m.id)), '')}</select>` : ''}<span class="small muted">${analyzeBlocker(client.getExecution().mode, route, cap, client.getExecution().ai)}</span><a class="small" href="#/admin/ai">AI settings</a></div>` : ''}
    ${state.run ? `<div class="rei-notice"><strong>${esc(state.run.modelName ?? 'Recognition')} · ${esc(state.run.state)}</strong>${state.run.queuedAt ? `<span class="rei-run-when"> · ${time(state.run.queuedAt)}</span>` : ''}<span> ${esc(state.run.remoteModelId ?? '')}${state.run.durationMs ? ` · ${(state.run.durationMs / 1000).toFixed(1)} s` : ''}</span>${state.run.state === 'queued' ? '<p>Waiting for the server. The queue is checked every minute; you can leave this page.</p>' : ''}${state.run.error ? `<p>${esc(state.run.error.message)}</p>` : ''}${state.run.state === 'needs_review' && state.run.result ? button('tw-use-proposal', 'Use as a new review proposal', '', 'btn--sm') : ''}${state.run.fallbackRunId ? button('tw-show-fallback', 'Inspect fallback run', `data-run-id="${esc(state.run.fallbackRunId)}"`, 'btn--sm') : ''}</div>` : ''}</div>
    ${plan ? `<div class="rei-mobile-tabs"><button data-action="tw-audit-tab" data-tab="expected" class="${state.mobileTab === 'expected' ? 'active' : ''}">Expected</button><button data-action="tw-audit-tab" data-tab="photo" class="${state.mobileTab === 'photo' ? 'active' : ''}">Photo</button><button data-action="tw-audit-tab" data-tab="differences" class="${state.mobileTab === 'differences' ? 'active' : ''}">Differences</button></div>
    <div class="rei-audit-layout"><section class="card rei-pane ${state.mobileTab === 'expected' ? 'mobile-active' : ''}"><div class="rei-card-head"><h3>Approved reference</h3><span class="small muted">${plan.rows} rows × ${plan.columns} slots</span></div>${grid(plan, state.slots, w.catalogue, true)}${ownerLegend()}<div class="rei-legend"><span>Rows: top → bottom</span><span>Slots: left → right</span></div></section>
    <section class="card rei-pane ${state.mobileTab === 'photo' ? 'mobile-active' : ''}"><div class="rei-card-head"><h3>Observed evidence</h3><span class="small muted">${esc(image?.name ?? 'Upload an image')}</span></div>${image && client.imageUrl(image) ? `<div class="rei-photo"><img src="${esc(client.imageUrl(image))}" alt="${esc(image.name)}"><svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="Evidence slot overlays">${state.slots.filter(s => s.primaryEvidence?.imageId === image.id).map(s => { const [x, y, width, height] = s.primaryEvidence.bbox.map(v => v * 1000), r = resultFor(plan, state.slots, s.key); return `<rect x="${x}" y="${y}" width="${width}" height="${height}" class="rei-overlay rei-overlay--${r.status}${s.key === state.selectedSlot ? ' selected' : ''}" data-action="tw-select-slot" data-slot="${esc(s.key)}"><title>${esc(s.key)} · ${r.status}</title></rect>`; }).join('')}</svg></div>` : '<div class="rei-empty">Add evidence to inspect physical slots.</div>'}<div class="rei-legend"><span>✓ Correct</span><span>! Deviation</span><span>? Unknown</span></div></section></div>
    <section class="card rei-pane ${state.mobileTab === 'differences' ? 'mobile-active' : ''}"><div class="rei-card-head"><h3>Observed slots · click to review</h3><span class="small muted">An empty response stays Unknown</span></div>${grid(plan, state.slots, w.catalogue)}
    ${selected ? `<div class="rei-slot-editor"><div><span class="rei-step">${esc(selected.key)} / REVIEW</span><h3>Expected ${esc(expected.allowedSkuIds.map(id => packOf(id, w.catalogue)?.full ?? id).join(' or '))}</h3><p class="small muted">${selected.confirmedBy ? `Reviewed by ${esc(selected.confirmedBy)}` : 'Not confirmed'}${selected.score != null ? ` · Model score ${selected.score.toFixed(2)} (uncalibrated)` : ''}</p>${image && selected.primaryEvidence ? `<div class="rei-crop" style="background-image:url('${esc(client.imageUrl(image))}');background-size:${100 / selected.primaryEvidence.bbox[2]}% ${100 / selected.primaryEvidence.bbox[3]}%;background-position:${selected.primaryEvidence.bbox[0] / Math.max(.0001, 1 - selected.primaryEvidence.bbox[2]) * 100}% ${selected.primaryEvidence.bbox[1] / Math.max(.0001, 1 - selected.primaryEvidence.bbox[3]) * 100}%" role="img" aria-label="Primary evidence crop for ${selected.key}"></div>` : '<p class="small">Select primary evidence and confirm the crop.</p>'}</div><div class="rei-form-grid"><label>Observed product / state<select data-action="tw-slot-value" ${writable ? '' : 'disabled'}><option value="unknown"${selected.state === 'unknown' ? ' selected' : ''}>? Unknown / obscured</option><option value="empty"${selected.state === 'empty' ? ' selected' : ''}>∅ Visibly empty</option>${options(w.catalogue, selected.confirmedSkuId)}</select></label><label>Primary evidence<select data-action="tw-slot-image" ${writable ? '' : 'disabled'}>${options(cap.images.map(i => ({ id: i.id, name: i.name })), selected.primaryEvidence?.imageId, 'Choose image')}</select></label><label class="rei-full">Crop · x, y, width, height (0–1)<input data-action="tw-slot-box" value="${selected.primaryEvidence?.bbox.map(v => Number(v.toFixed(4))).join(', ') ?? ''}" placeholder="0, 0, 0.1, 0.5" ${writable ? '' : 'disabled'}></label><div class="toolbar rei-full">${writable ? button('tw-confirm-slot', 'Confirm this slot', '', 'btn--primary') : ''}${writable ? button('tw-confirm-visible', 'Confirm visible proposals') : ''}</div></div></div>` : ''}</section>
    <div class="rei-audit-layout"><div class="card"><h3>Assortment & visible facings</h3><table class="rei-table"><thead><tr><th>SKU</th><th>Presence</th><th>Visible count bounds</th><th>Expected</th><th>Result</th></tr></thead><tbody>${summary.results.filter(r => r.family === 'facings').map(r => `<tr><td>${esc(packOf(r.skuId, w.catalogue)?.full ?? r.skuId)}</td><td>${esc(summary.results.find(p => p.ruleKey === `presence:${r.skuId}`)?.status)}</td><td>${r.observed.lower}${r.observed.upper !== r.observed.lower ? `–${r.observed.upper}` : ''}</td><td>${r.expected.min}–${r.expected.max}</td><td>${badge(r.status, r.status === 'pass' ? 'good' : r.status === 'fail' ? 'risk' : 'neutral')}</td></tr>`).join('')}</tbody></table></div><div class="card"><h3>Save reviewed evidence</h3><p class="small muted">Submission saves an immutable revision. It creates slot issues for confirmed deviations; closing an issue requires later evidence and verification.</p><label>Reason for incomplete evidence<textarea id="tw-incomplete-reason" rows="2" placeholder="Required when any slot remains unknown">${esc(audit?.incompleteReason ?? '')}</textarea></label><div class="toolbar mt">${writable ? button('tw-save-review', 'Save review draft') + button('tw-submit-audit', 'Submit audit', '', 'btn--primary') : ''}</div>${audit ? `<p class="small mt">Latest submission: ${time(audit.submittedAt)} · ${cap.reviews.length} review revision(s)</p>` : ''}${button('tw-audit-issues', 'View fixture issues →', `data-fixture-id="${esc(f.id)}"`, 'btn--sm')}</div></div>` : ''}`;
}
function renderLibrary(w) {
  return `${w.demo ? `<section class="card rei-table-scroll"><h3>Demo catalogue · ${w.catalogue.length} products</h3><p class="small muted">Brand and manufacturer are real. There is no GTIN and no approved assortment behind these records, so none of them is verified as listed, priced or authorised for a given outlet.</p><table class="rei-table"><thead><tr><th>Code</th><th>Product</th><th>Brand</th><th>Manufacturer</th><th>Unit</th><th>Status</th></tr></thead><tbody>${w.catalogue.map(s => `<tr><td>${esc(s.code)}</td><td>${esc(s.name)}</td><td>${esc(s.brand_name ?? '—')}</td><td>${esc(s.manufacturer ?? '—')}</td><td>${esc(s.pack_type ?? '—')}</td><td>${s.synthetic ? 'Synthetic / Demo' : s.market_verified ? 'Verified master data' : 'Reference · not verified'}</td></tr>`).join('')}</tbody></table></section>` : ''}<div class="rei-heading"><div><h2>One approved reference for each capture</h2><p class="muted">Published versions are immutable. Assignments use capture time.</p></div>${can(client.executionActor(), 'planogram.manage') ? button('tw-plan-new', '+ New planogram', '', 'btn--primary') : ''}</div><div class="card rei-table-scroll"><table class="rei-table"><thead><tr><th>Code / version</th><th>Fixture</th><th>Effective from</th><th>Effective to</th><th>Status</th><th>Assignments</th><th>Updated by</th></tr></thead><tbody>${w.plans.map(p => `<tr><td><button class="rei-link" data-action="tw-plan-open" data-plan-id="${esc(p.id)}"><strong>${esc(p.code)} v${p.version}</strong></button></td><td>${p.rows} × ${p.columns}</td><td>${time(p.validFrom)}</td><td>${p.validTo ? time(p.validTo) : 'Open-ended'}</td><td>${badge(p.status, p.status === 'published' ? 'good' : 'neutral')}</td><td>${w.assignments.filter(a => a.planId === p.id).length}</td><td>${esc(p.updatedBy)}</td></tr>`).join('') || '<tr><td colspan="7">No reference plans. Import or create the first draft.</td></tr>'}</tbody></table></div>
    ${can(client.executionActor(), 'planogram.manage') ? `<div class="rei-audit-layout"><section class="card"><h3>Import a planogram draft</h3><p class="small muted">JSON or CSV · up to 1 MB / 2,000 rows · All errors are checked before saving.</p><form data-form="tw-plan-import"><label>Source file<input name="file" type="file" accept=".json,.csv" required></label><label>Effective from · Taipei<input name="validFrom" type="datetime-local" value="${localTime(client.clock())}" required></label><button class="btn mt" type="submit">Validate & import draft</button></form><p class="small mt"><a href="/demo/tw/planogram.json" download>Download example JSON</a></p></section><section class="card"><h3>Catalogue & fixture setup</h3><p class="small muted">Import approved SKU IDs for this dataset and regular cabinet dimensions. Existing records are preserved.</p><form data-form="tw-setup"><label>Setup JSON<input name="file" type="file" accept=".json" required></label><button class="btn mt" type="submit">Validate & add records</button></form><p class="small mt"><a href="/demo/tw/setup.json" download>Download setup example</a></p></section></div>` : ''}`;
}
function renderPlan(w, ctx) {
  const original = w.plans.find(p => p.id === ctx.params.id);
  if (!original) return '<div class="card">Planogram not found.</div>';
  if (state.planId !== original.id) { state.planId = original.id; state.plan = clone(original); state.selectedSlot = original.slots[0].key; }
  const p = state.plan, editable = original.status === 'draft' && can(client.executionActor(), 'planogram.manage'), s = p.slots.find(s => s.key === state.selectedSlot) ?? p.slots[0];
  return `<div class="rei-heading"><div><a class="small" href="#/tw/planograms">← Planogram library</a><h2>${esc(p.code)} · v${p.version}</h2><p class="small muted">${esc(p.sourceName ?? 'Manual reference')} · ${esc(p.changeNote ?? '')}</p></div><div class="toolbar">${badge(original.status, original.status === 'published' ? 'good' : 'neutral')}${button('tw-plan-export', 'Export JSON')}${can(client.executionActor(), 'planogram.manage') ? button('tw-plan-duplicate', 'Duplicate as draft') : ''}</div></div>
    <div class="card"><div class="rei-form-grid"><label>Code<input data-plan-field="code" value="${esc(p.code)}" ${editable ? '' : 'disabled'}></label><label>Effective from · Taipei<input data-plan-field="validFrom" type="datetime-local" value="${localTime(p.validFrom)}" ${editable ? '' : 'disabled'}></label><label>Effective to · Taipei<input data-plan-field="validTo" type="datetime-local" value="${p.validTo ? localTime(p.validTo) : ''}" ${editable ? '' : 'disabled'}></label><label>Change note<input data-plan-field="changeNote" value="${esc(p.changeNote ?? '')}" ${editable ? '' : 'disabled'}></label></div><div class="mt">${grid(p, [], true)}</div>
    <div class="rei-slot-editor"><div><h3>${s.key}</h3><p class="small muted">One front-facing pack per physical slot. Allowed substitutes are explicit.</p></div><div class="rei-form-grid"><label>Allowed SKUs<select multiple data-action="tw-plan-allowed" ${editable ? '' : 'disabled'}>${w.catalogue.map(sku => `<option value="${esc(sku.id)}"${s.allowedSkuIds.includes(sku.id) ? ' selected' : ''}>${esc(sku.code)}</option>`).join('')}</select></label><label>Preferred SKU<select data-action="tw-plan-preferred" ${editable ? '' : 'disabled'}>${options(w.catalogue.filter(sku => s.allowedSkuIds.includes(sku.id)), s.preferredSkuId, 'No preference')}</select></label><label><input type="checkbox" data-action="tw-plan-active" ${s.active ? 'checked' : ''} ${editable ? '' : 'disabled'}> Applicable slot</label><label><input type="checkbox" data-action="tw-plan-critical" ${s.critical ? 'checked' : ''} ${editable ? '' : 'disabled'}> Mandatory position</label></div></div>
    <label class="mt">Assortment and facing rules (JSON)<textarea data-plan-field="requirements" rows="4" ${editable ? '' : 'disabled'}>${esc(JSON.stringify({ requiredSkuIds: p.requiredSkuIds ?? [], facingRules: p.facingRules ?? [] }, null, 2))}</textarea></label>
    <div class="toolbar mt">${editable ? button('tw-plan-save', 'Save draft') + button('tw-plan-publish', 'Validate & publish', '', 'btn--primary') : ''}${original.status === 'published' && can(client.executionActor(), 'planogram.manage') ? button('tw-plan-retire', 'Retire version') : ''}</div></div>
    ${original.status === 'published' && can(client.executionActor(), 'planogram.manage') ? `<div class="card"><h3>Assign published version</h3><form class="rei-filters" data-form="tw-assign-plan"><label>Fixture<select name="fixtureId">${options(w.fixtures, '')}</select></label><label>Valid from · Taipei<input name="validFrom" type="datetime-local" value="${localTime(client.clock())}" required></label><label>Valid to · Taipei<input name="validTo" type="datetime-local"></label><button type="submit" class="btn">Assign without overlap</button></form></div>` : ''}`;
}
function renderIssues(w, ctx) {
  const issues = w.issues.filter(i => !ctx.params.fixture || i.fixtureId === ctx.params.fixture);
  const selected = issues.find(i => i.id === (state.openIssue ?? ctx.params.id));
  return `<div class="rei-heading"><div><h2>Close the loop with evidence</h2><p class="muted">${issues.filter(i => OPEN_ISSUES.includes(i.status)).length} open issues · Repeated findings retain the same issue episode.</p></div>${ctx.params.fixture ? '<a href="#/tw/issues">All fixtures</a>' : ''}</div><div class="card rei-table-scroll"><table class="rei-table"><thead><tr><th>Status</th><th>Outlet / fixture</th><th>Slot</th><th>Expected → observed</th><th>First / last observed</th><th>Owner / due</th><th></th></tr></thead><tbody>${issues.map(i => { const f = w.fixtures.find(f => f.id === i.fixtureId); return `<tr><td>${badge(i.status.replaceAll('_', ' '), i.status === 'closed_verified' ? 'good' : 'risk')}</td><td>${esc(f.outletName)}<small>${esc(f.name)} · Episode ${i.episode}</small></td><td>${esc(i.slotKey)}</td><td>${esc(i.expected.join(' / '))} → ${esc(i.observed)}</td><td>${time(i.firstDetected)}<small>${time(i.lastObserved)}</small></td><td>${esc(i.ownerId ?? 'Unassigned')}<small>${esc(i.dueDate ?? 'No due date')}</small></td><td>${button('tw-issue-open', 'Open', `data-issue-id="${esc(i.id)}"`, 'btn--sm')}</td></tr>`; }).join('') || '<tr><td colspan="7">No issues in this scope.</td></tr>'}</tbody></table></div>
    ${selected ? `<div class="card"><div class="rei-card-head"><h3>${esc(selected.fixtureId)} · ${esc(selected.slotKey)} · Episode ${selected.episode}</h3>${button('tw-open-evidence', 'Open latest evidence', `data-assessment-id="${esc(selected.latestAssessmentId)}"`, 'btn--sm')}</div>
    <ol class="rei-timeline">${selected.history.map(e => `<li><strong>${esc(e.type.replaceAll('_', ' '))}</strong><span>${time(e.at)} · ${esc(e.actorId)}</span>${e.note ? `<p>${esc(e.note)}</p>` : ''}${e.assessmentId ? button('tw-open-evidence', 'View audit', `data-assessment-id="${esc(e.assessmentId)}"`, 'btn--sm') : ''}</li>`).join('')}</ol>
    ${OPEN_ISSUES.includes(selected.status) && can(client.executionActor(), 'audit.capture') ? `<form data-form="tw-issue-event" class="rei-form-grid"><label>Action<select name="action"><option value="in_progress">Start action</option><option value="awaiting_verification">Request verification</option><option value="blocked">Blocked</option>${can(client.executionActor(), 'issue.assign') ? '<option value="assign">Assign owner / due date</option>' : ''}${can(client.executionActor(), 'issue.verify') ? '<option value="verify">Verify with later audit</option><option value="closed_invalid">Close invalid finding</option><option value="superseded_by_reference_change">Close — reference changed</option>' : ''}</select></label><label>Owner<input name="ownerId" value="${esc(selected.ownerId ?? w.fixtures.find(f => f.id === selected.fixtureId).ownerId)}"></label><label>Due date<input name="dueDate" type="date" value="${selected.dueDate ?? client.clock().slice(0, 10)}"></label><label>Later confirmed audit<select name="assessmentId">${options(w.assessments.filter(a => a.fixtureId === selected.fixtureId && Date.parse(a.capturedAt) > Date.parse(selected.lastObserved)).map(a => ({ id: a.id, name: `${time(a.capturedAt)} · ${a.summary.C}/${a.summary.C + a.summary.D} correct · ${a.summary.U} unknown` })), '', 'Select evidence for verification')}</select></label><label class="rei-full">Action / reason<textarea name="note" rows="2" required minlength="3" maxlength="2000"></textarea></label><div class="toolbar"><button class="btn btn--primary" type="submit">Record action</button>${button('tw-verify-new-audit', 'Capture later evidence', `data-fixture-id="${esc(selected.fixtureId)}"`)}</div></form>` : ''}</div>` : ''}`;
}

async function perform(ctx, action) {
  if (state.busy) return; state.busy = true; state.error = ''; state.message = '';
  try { await action(); } catch (e) { state.error = e.message; } finally { state.busy = false; ctx.render(); }
}
function currentCapture() { return client.getExecution().workspace.captures.find(c => c.id === state.captureId); }
function markConfirmed(slot) { slot.confirmedBy = client.executionActor().id; slot.confirmedAt = client.clock(); slot.proposed = false; }
async function saveReview() {
  const cap = currentCapture();
  const slots = state.slots.map(s => s.proposed && !s.confirmedBy ? { ...s, state: 'unknown', confirmedSkuId: null, unknownReason: 'unreviewed' } : s);
  const review = await client.command('review.save', { captureId: cap.id, expectedRevision: cap.revision, slots, runId: state.run?.id ?? null });
  state.slots = clone(review.slots); return review;
}
export function onAction(action, el, ctx) {
  if (el.matches('select,input,textarea,label')) return;
  if (action.startsWith('ai-')) return perform(ctx, () => aiUi.onAction(action, el, ctx));
  const { workspace: w } = client.getExecution();
  if (action === 'tw-select-slot') { state.selectedSlot = el.dataset.slot; ctx.render(); return; }
  if (action === 'tw-audit-tab') { state.mobileTab = el.dataset.tab; ctx.render(); return; }
  if (action === 'tw-kpi') { state.filter = state.filter === el.dataset.filterKey ? '' : el.dataset.filterKey; ctx.render(); return; }
  if (action === 'tw-clear-filter') { state.filter = ''; ctx.render(); return; }
  if (action === 'tw-new-audit' || action === 'tw-verify-new-audit') { ctx.navigate('tw/audits/new', { fixture: el.dataset.fixtureId }); return; }
  if (action === 'tw-open-library') { ctx.navigate('tw/planograms'); return; }
  if (action === 'tw-open-fixture') {
    const fixtureId = el.dataset.fixtureId, cap = w.captures.filter(c => c.fixtureId === fixtureId && c.id !== 'capture-F2-followup').sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))[0];
    ctx.navigate(cap ? 'tw/audits/detail' : 'tw/audits/new', cap ? { id: cap.id } : { fixture: fixtureId }); return;
  }
  if (action === 'tw-followup') { ctx.navigate('tw/audits/detail', { id: 'capture-F2-followup' }); return; }
  if (action === 'tw-audit-issues') { ctx.navigate('tw/issues', { fixture: el.dataset.fixtureId }); return; }
  if (action === 'tw-issue-open') { state.openIssue = el.dataset.issueId; ctx.render(); return; }
  if (action === 'tw-open-evidence') { const a = w.assessments.find(a => a.id === el.dataset.assessmentId); if (a) ctx.navigate('tw/audits/detail', { id: a.captureId }); return; }
  if (action === 'tw-plan-open') { ctx.navigate('tw/planograms/detail', { id: el.dataset.planId }); return; }
  // Capture text before render/persistence so a re-render cannot erase user input.
  const incompleteReason = document.getElementById('tw-incomplete-reason')?.value;
  const modelId = document.getElementById('tw-model')?.value;
  return perform(ctx, async () => {
    if (action === 'tw-reset') { if (confirm('Reset only this browser’s planogram example?')) { await client.resetDemo(); state.captureId = null; state.planId = null; state.filter = ''; state.openIssue = null; state.message = 'Prepared example restored. Shared data is unchanged.'; } }
    else if (action === 'tw-refresh') { await client.refreshWorkspace(); state.captureId = null; state.planId = null; }
    else if (action === 'tw-prepared') { state.slots = preparedProposal(currentCapture()); state.message = 'Prepared observations loaded. Inspect and confirm visible slots before submission.'; }
    else if (action === 'tw-confirm-slot') { const slot = state.slots.find(s => s.key === state.selectedSlot); if (slot.state !== 'unknown' && !slot.primaryEvidence) throw new Error('Choose a primary image and crop first.'); markConfirmed(slot); }
    else if (action === 'tw-confirm-visible') { if (confirm('Have you inspected all visible proposed values and their evidence? Unknown slots will stay unknown.')) state.slots.filter(s => s.state !== 'unknown' && s.primaryEvidence).forEach(markConfirmed); }
    else if (action === 'tw-save-review') { await saveReview(); state.message = 'Review draft saved. It does not change submitted audit metrics.'; }
    else if (action === 'tw-submit-audit') {
      const summary = assess(currentCapture().reference, state.slots);
      if (summary.U && (!incompleteReason || incompleteReason.trim().length < 3)) throw new Error('Add a reason for the incomplete evidence before submitting.');
      const review = await saveReview(), cap = currentCapture();
      await client.command('assessment.submit', { captureId: cap.id, expectedRevision: cap.revision, reviewId: review.id, incompleteReason: incompleteReason || null, idempotencyKey: `submit-${review.id}` }); state.message = 'Audit submitted. Slot issues are updated; closures still require verification.';
    } else if (action === 'tw-analyze') { state.run = await client.launchRun(state.captureId, modelId); }
    else if (action === 'tw-use-proposal') { const cap = currentCapture(); state.slots = proposalToReview(cap.reference.plan, state.run.result); state.message = 'New model proposal loaded. Existing submitted evidence is preserved.'; }
    else if (action === 'tw-show-fallback') { state.run = await client.api(`/ai/runs/${el.dataset.runId}`); }
    else if (action === 'tw-plan-new') {
      if (!w.catalogue.length) throw new Error('Import the planogram catalogue and fixtures first.');
      const code = prompt('Planogram code', 'TW-CABINET'); if (!code) return;
      const dimensions = prompt('Rows × columns', '2x10'); if (!dimensions) return;
      const [rows, columns] = dimensions.toLowerCase().split('x').map(Number); if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows <= 0 || columns <= 0 || rows * columns > 500) throw new Error('Use dimensions such as 2x10, up to 500 cells.');
      const plan = { code, rows, columns, fixtureType: 'regular_cabinet', validFrom: client.clock(), validTo: null, slots: Array.from({ length: rows * columns }, (_, i) => ({ key: `R${Math.floor(i / columns) + 1}C${i % columns + 1}`, row: Math.floor(i / columns) + 1, column: i % columns + 1, active: true, allowedSkuIds: [w.catalogue[0].id], preferredSkuId: w.catalogue[0].id, critical: true })), requiredSkuIds: [], facingRules: [], changeNote: 'Draft — review every cell before publishing.' };
      const created = await client.command('plan.create', { plan }); ctx.navigate('tw/planograms/detail', { id: created.id });
    } else if (action === 'tw-plan-export') client.downloadJson(state.plan, `${state.plan.code}-v${state.plan.version}.json`);
    else if (action === 'tw-plan-duplicate') { const p = w.plans.find(p => p.id === state.planId), created = await client.command('plan.duplicate', { planId: p.id, expectedRevision: p.revision }); ctx.navigate('tw/planograms/detail', { id: created.id }); }
    else if (['tw-plan-save', 'tw-plan-publish'].includes(action)) {
      const p = w.plans.find(p => p.id === state.planId); validatePlan(state.plan, w.catalogue);
      let updated = await client.command('plan.edit', { planId: p.id, expectedRevision: p.revision, patch: state.plan });
      if (action === 'tw-plan-publish') updated = await client.command('plan.publish', { planId: p.id, expectedRevision: updated.revision });
      state.plan = clone(updated); state.message = action === 'tw-plan-publish' ? 'Immutable version published. Assign it to a matching fixture.' : 'Draft saved.';
    } else if (action === 'tw-plan-retire') { const note = prompt('Reason for retiring this version'); if (note) { const p = w.plans.find(p => p.id === state.planId); await client.command('plan.retire', { planId: p.id, expectedRevision: p.revision, note }); state.planId = null; } }
  });
}
export function onChange(target, ctx) {
  if (target.dataset.action === 'tw-workspace') { perform(ctx, async () => { await client.setWorkspaceMode(target.value); state.captureId = null; state.planId = null; state.filters = {}; }); return true; }
  if (target.dataset.twFilter) {
    try { state.filters[target.dataset.twFilter] = target.dataset.twFilter === 'asOf' ? parseTime(target.value) : target.dataset.twFilter === 'freshnessDays' ? Math.max(1, Math.min(90, +target.value)) : target.value; } catch { state.error = 'Choose a valid date.'; } ctx.render(); return true;
  }
  if (target.dataset.action?.startsWith('ai-')) return aiUi.onChange(target, ctx);
  if (target.dataset.planField) {
    try { const field = target.dataset.planField; if (field === 'requirements') Object.assign(state.plan, JSON.parse(target.value)); else state.plan[field] = ['validFrom', 'validTo'].includes(field) ? parseTime(target.value) : target.value; } catch { state.error = 'Invalid planogram field. Check JSON and dates.'; } return true;
  }
  const action = target.dataset.action;
  if (action?.startsWith('tw-plan-')) {
    const s = state.plan.slots.find(s => s.key === state.selectedSlot);
    if (action === 'tw-plan-allowed') { s.allowedSkuIds = [...target.selectedOptions].map(o => o.value); if (!s.allowedSkuIds.includes(s.preferredSkuId)) s.preferredSkuId = s.allowedSkuIds[0] ?? null; }
    if (action === 'tw-plan-preferred') s.preferredSkuId = target.value || null;
    if (action === 'tw-plan-active') s.active = target.checked;
    if (action === 'tw-plan-critical') s.critical = target.checked;
    ctx.render(); return true;
  }
  if (action?.startsWith('tw-slot-')) {
    const s = state.slots.find(s => s.key === state.selectedSlot), cap = currentCapture(), planned = cap.reference.plan.slots.find(p => p.key === s.key);
    if (action === 'tw-slot-value') { s.state = ['unknown', 'empty'].includes(target.value) ? target.value : 'product'; s.confirmedSkuId = s.state === 'product' ? target.value : null; if (!s.primaryEvidence && cap.images[0]) s.primaryEvidence = { imageId: cap.images[0].id, bbox: cellBox(planned.row, planned.column, cap.reference.plan.rows, cap.reference.plan.columns) }; markConfirmed(s); }
    if (action === 'tw-slot-image') { s.primaryEvidence = target.value ? { imageId: target.value, bbox: s.primaryEvidence?.bbox ?? cellBox(planned.row, planned.column, cap.reference.plan.rows, cap.reference.plan.columns) } : null; s.confirmedBy = null; }
    if (action === 'tw-slot-box') { const box = target.value.split(',').map(Number); if (s.primaryEvidence) s.primaryEvidence.bbox = box; s.confirmedBy = null; }
    ctx.render(); return true;
  }
  return false;
}
export function onSubmit(form, ctx) {
  const kind = form.dataset.form;
  if (kind?.startsWith('ai-')) return perform(ctx, () => aiUi.onSubmit(form, ctx));
  const values = new FormData(form);
  return perform(ctx, async () => {
    if (kind === 'tw-start') { const cap = await client.command('capture.create', { fixtureId: values.get('fixtureId'), capturedAt: parseTime(values.get('capturedAt')), source: values.get('source'), mode: values.get('mode') }); ctx.navigate('tw/audits/detail', { id: cap.id }); }
    else if (kind === 'tw-upload') {
      const file = values.get('image'), range = values.get('range'), cap = currentCapture(), f = client.getExecution().workspace.fixtures.find(f => f.id === cap.fixtureId);
      const slotKeys = range === 'Custom' ? String(values.get('slotKeys')).split(',').map(s => s.trim()).filter(Boolean) : range.startsWith('Row') ? Array.from({ length: f.columns }, (_, i) => `R${range.split(' ')[1]}C${i + 1}`) : [];
      await client.uploadImage(cap.id, file, range, slotKeys); state.message = 'Image saved. Inspect the crop and primary image for each reviewed slot.';
    } else if (kind === 'tw-plan-import') {
      const file = values.get('file'); if (file.size > 1048576) throw new Error('Import limit: 1 MB.');
      const text = await file.text(), plan = importPlan(text, file.name.endsWith('.csv') ? 'csv' : 'json', { fixtureType: 'regular_cabinet', validFrom: parseTime(values.get('validFrom')), validTo: null, requiredSkuIds: [], facingRules: [] }, client.getExecution().workspace.catalogue);
      plan.sourceName = file.name; plan.sourceText = text;
      const created = await client.command('plan.create', { plan }); ctx.navigate('tw/planograms/detail', { id: created.id });
    } else if (kind === 'tw-setup') { const file = values.get('file'); if (file.size > 1048576) throw new Error('Setup limit: 1 MB.'); await client.command('setup', JSON.parse(await file.text())); state.message = 'Catalogue and fixture records added.'; }
    else if (kind === 'tw-assign-plan') { await client.command('assignment.create', { planId: state.planId, fixtureId: values.get('fixtureId'), validFrom: parseTime(values.get('validFrom')), validTo: parseTime(values.get('validTo')) }); state.message = 'Assignment saved.'; }
    else if (kind === 'tw-issue-event') { await client.command('issue.event', { issueId: state.openIssue ?? ctx.params.id, ...Object.fromEntries(values) }); state.message = 'Issue event recorded with its evidence history.'; }
  });
}
export function mount(ctx) {
  clearTimeout(state.poll); state.poll = null;
  if (ctx.path === 'admin/ai') { aiUi.mount(ctx); return; }
  if (ctx.path !== 'tw/audits/detail' || client.getExecution().mode !== 'shared') return;
  const id = ctx.params.run ?? state.run?.id ?? client.savedRunId(ctx.params.id);
  if (!id || state.run?.id === id && !['queued', 'processing'].includes(state.run.state)) return;
  state.poll = setTimeout(async () => {
    if (!location.hash.includes('tw/audits/detail')) return;
    try {
      const next = await client.api(`/ai/runs/${id}`);
      // A queued run waits for the scheduled worker, so most polls come back identical. Redrawing
      // on those rebuilds the whole page for no visible change — which collapsed open disclosures
      // and threw the reader back to the top every two seconds. Re-arm quietly instead, and draw
      // only when the run actually moved.
      const changed = next.id !== state.run?.id || next.state !== state.run?.state
        || next.error?.message !== state.run?.error?.message;
      state.run = next;
      if (next.state === 'queued') client.triggerRun(id);
      if (changed) ctx.render(); else mount(ctx);
    } catch (e) { state.error = e.message; ctx.render(); }
  }, 2000);
}
