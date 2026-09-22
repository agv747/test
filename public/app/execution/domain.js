/** Shared deterministic domain. The server runs the same commands with a trusted actor.
 * Browser execution is ONLY for the explicitly labelled synthetic demo workspace. */
export class DomainError extends Error {
  constructor(code, message, status = 422) { super(message); this.code = code; this.status = status; }
}
export function requireThat(condition, code, message, status = 422) {
  if (!condition) throw new DomainError(code, message, status);
}
export const clone = value => structuredClone(value);
export const slotKey = (row, column) => `R${row}C${column}`;
export const OPEN_ISSUES = ['open', 'assigned', 'in_progress', 'awaiting_verification', 'blocked'];
const RIGHTS = {
  admin: ['audit.capture', 'audit.review', 'issue.assign', 'issue.verify', 'planogram.manage', 'ai.manage', 'ai.compare'],
  manager: ['audit.capture', 'audit.review', 'issue.assign', 'issue.verify', 'ai.compare'],
  field: ['audit.capture', 'audit.review'], viewer: [],
};
export const can = (actor, right) => Boolean(RIGHTS[actor?.role]?.includes(right));
export function authorize(actor, right, market = 'TW') {
  requireThat(actor?.markets?.includes(market) && can(actor, right), 'FORBIDDEN', 'You do not have access to this market or action.', 403);
}
export function validBox(box) {
  return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) &&
    box[0] >= 0 && box[1] >= 0 && box[2] > 0 && box[3] > 0 && box[0] + box[2] <= 1.000001 && box[1] + box[3] <= 1.000001;
}
export function validatePlan(plan, catalogue) {
  const errors = [], ids = new Set(catalogue.map(s => s.id));
  if (!plan.code?.trim() || plan.code.length > 80) errors.push('Code is required (maximum 80 characters).');
  if (![plan.rows, plan.columns].every(n => Number.isInteger(n) && n > 0 && n <= 50) || plan.rows * plan.columns > 500) errors.push('Use a regular grid of 1–500 slots; each dimension must be 1–50.');
  const seen = new Set();
  for (const [i, slot] of (plan.slots ?? []).entries()) {
    const label = `Row ${i + 2} (${slot.key ?? '?'})`;
    if (!Number.isInteger(slot.row) || !Number.isInteger(slot.column) || slot.row < 1 || slot.row > plan.rows || slot.column < 1 || slot.column > plan.columns || slot.key !== slotKey(slot.row, slot.column)) errors.push(`${label}: invalid coordinates.`);
    if (seen.has(slot.key)) errors.push(`${label}: duplicate cell.`);
    seen.add(slot.key);
    if (typeof slot.active !== 'boolean') errors.push(`${label}: active must be true or false.`);
    if (slot.active && (!Array.isArray(slot.allowedSkuIds) || !slot.allowedSkuIds.length)) errors.push(`${label}: choose at least one allowed SKU.`);
    if ((slot.allowedSkuIds ?? []).some(id => !ids.has(id))) errors.push(`${label}: unknown Taiwan SKU.`);
    if (slot.preferredSkuId && !slot.allowedSkuIds?.includes(slot.preferredSkuId)) errors.push(`${label}: preferred SKU must be allowed.`);
  }
  if (seen.size !== plan.rows * plan.columns) errors.push('Every grid cell must be defined, including inactive cells.');
  if (!Number.isFinite(Date.parse(plan.validFrom)) || (plan.validTo && (!Number.isFinite(Date.parse(plan.validTo)) || Date.parse(plan.validTo) <= Date.parse(plan.validFrom)))) errors.push('Effective dates must define a valid [from, to) interval.');
  if ((plan.requiredSkuIds ?? []).some(id => !ids.has(id))) errors.push('Required assortment contains an unknown SKU.');
  for (const rule of plan.facingRules ?? []) if (!ids.has(rule.skuId) || !Number.isInteger(rule.min) || !Number.isInteger(rule.max) || rule.min < 0 || rule.max < rule.min) errors.push('Facing rules require a known SKU and integer 0 ≤ min ≤ max.');
  requireThat(!errors.length, 'PLAN_INVALID', errors.join('\n'));
  return plan;
}

/** Quoted CSV including escaped quotes and embedded newlines; no partial publication. */
export function parseCsv(text) {
  requireThat(typeof text === 'string' && new TextEncoder().encode(text).length <= 1048576, 'IMPORT_TOO_LARGE', 'Import limit: 1 MB.');
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\n')) { row.push(field.replace(/\r$/, '')); field = ''; if (c === '\n') { if (row.some(Boolean)) rows.push(row); row = []; } }
    else field += c;
  }
  requireThat(!quoted, 'IMPORT_INVALID', 'Unclosed CSV quote.');
  row.push(field.replace(/\r$/, '')); if (row.some(Boolean)) rows.push(row);
  requireThat(rows.length > 1 && rows.length <= 2001, 'IMPORT_INVALID', 'CSV requires a header and 1–2,000 rows.');
  const headers = rows.shift().map(s => s.trim().replace(/^\uFEFF/, ''));
  for (const key of ['planogram_code', 'version', 'row', 'column', 'allowed_sku_codes', 'critical']) requireThat(headers.includes(key), 'IMPORT_INVALID', `Missing CSV column: ${key}`);
  return rows.map((values, i) => { requireThat(values.length === headers.length, 'IMPORT_INVALID', `Row ${i + 2}: wrong number of columns.`); return Object.fromEntries(headers.map((key, j) => [key, values[j].trim()])); });
}
export function importPlan(text, format, metadata, catalogue) {
  requireThat(typeof text === 'string' && new TextEncoder().encode(text).length <= 1048576, 'IMPORT_TOO_LARGE', 'Import limit: 1 MB.');
  let plan;
  if (format === 'csv') {
    const rows = parseCsv(text), codes = new Map(catalogue.map(s => [s.code, s.id]));
    requireThat(rows.every(r => r.planogram_code === rows[0].planogram_code && r.version === rows[0].version), 'IMPORT_INVALID', 'Import one planogram/version per file.');
    plan = { ...metadata, code: rows[0].planogram_code, version: Number(rows[0].version), rows: Math.max(...rows.map(r => +r.row)), columns: Math.max(...rows.map(r => +r.column)), slots: rows.map((r, i) => {
      requireThat(['true', 'false'].includes(r.critical), 'IMPORT_INVALID', `Row ${i + 2}: critical must be true or false.`);
      const allowedSkuIds = r.allowed_sku_codes.split(';').map(code => { requireThat(codes.has(code), 'IMPORT_INVALID', `Row ${i + 2}: unknown SKU ${code}.`); return codes.get(code); });
      return { key: slotKey(+r.row, +r.column), row: +r.row, column: +r.column, active: true, allowedSkuIds, preferredSkuId: allowedSkuIds[0], critical: r.critical === 'true' };
    }) };
  } else {
    try { plan = { ...metadata, ...JSON.parse(text) }; } catch { throw new DomainError('IMPORT_INVALID', 'Invalid JSON file.'); }
  }
  return validatePlan(plan, catalogue);
}
export function resolveReference(workspace, fixtureId, capturedAt) {
  if (!Number.isFinite(Date.parse(capturedAt))) return { status: 'time_uncertain', plan: null };
  const fixture = workspace.fixtures.find(f => f.id === fixtureId);
  const assignments = workspace.assignments.filter(a => a.fixtureId === fixtureId && Date.parse(a.validFrom) <= Date.parse(capturedAt) && (!a.validTo || Date.parse(capturedAt) < Date.parse(a.validTo)));
  if (!assignments.length) return { status: 'missing', plan: null };
  if (assignments.length !== 1) return { status: 'conflict', plan: null };
  const plan = workspace.plans.find(p => p.id === assignments[0].planId);
  if (!plan || plan.status === 'draft') return { status: 'missing', plan: null };
  if (fixture?.rows !== plan.rows || fixture?.columns !== plan.columns || fixture?.type !== plan.fixtureType) return { status: 'fixture_mismatch', plan: null };
  return { status: 'valid', plan: clone(plan), assignmentId: assignments[0].id };
}
export function emptyReview(plan) {
  return (plan?.slots ?? []).map(s => ({ key: s.key, state: 'unknown', confirmedSkuId: null, unknownReason: 'unreviewed', primaryEvidence: null, supportingEvidence: [], confirmedBy: null, confirmedAt: null }));
}
export function normalizeReviewedSlots(plan, review = []) {
  requireThat(new Set(review.map(s => s.key)).size === review.length, 'REVIEW_INVALID', 'Duplicate physical slot.');
  const keys = new Set(plan.slots.map(s => s.key));
  requireThat(review.every(s => keys.has(s.key)), 'REVIEW_INVALID', 'Review contains an unknown physical slot.');
  return plan.slots.map(slot => {
    const r = review.find(s => s.key === slot.key);
    if (!r || !r.confirmedBy || !r.confirmedAt || !r.primaryEvidence || !validBox(r.primaryEvidence.bbox) || !['product', 'empty'].includes(r.state) || (r.state === 'product' && !r.confirmedSkuId)) return { ...emptyReview({ slots: [slot] })[0], ...r, key: slot.key, state: 'unknown', confirmedSkuId: null };
    return { ...r, confirmedSkuId: r.state === 'empty' ? null : r.confirmedSkuId };
  });
}
export function evaluatePositions(plan, reviewed) {
  const rows = normalizeReviewedSlots(plan, reviewed);
  return plan.slots.map((slot, i) => {
    const r = rows[i];
    const status = !slot.active ? 'not_applicable' : r.state === 'unknown' ? 'unknown' : r.state === 'empty' ? 'fail' : slot.allowedSkuIds.includes(r.confirmedSkuId) ? 'pass' : 'fail';
    return { ruleKey: slot.key, family: 'position', status, expected: slot.allowedSkuIds, observed: r.state === 'product' ? r.confirmedSkuId : r.state, evidence: r.primaryEvidence ? [r.primaryEvidence] : [], reasonCode: status === 'fail' ? (r.state === 'empty' ? 'EMPTY_PLANNED_SLOT' : 'WRONG_SKU_AT_SLOT') : status === 'pass' && slot.preferredSkuId && r.confirmedSkuId !== slot.preferredSkuId ? 'ALLOWED_SUBSTITUTE' : status.toUpperCase() };
  });
}
function counts(plan, review) {
  const active = new Set(plan.slots.filter(s => s.active).map(s => s.key)), slots = normalizeReviewedSlots(plan, review).filter(s => active.has(s.key));
  const unknown = slots.filter(s => s.state === 'unknown').length;
  const count = id => slots.filter(s => s.state === 'product' && s.confirmedSkuId === id).length;
  return { slots, unknown, count };
}
export function evaluatePresence(plan, review) {
  const { unknown, count } = counts(plan, review);
  return (plan.requiredSkuIds ?? []).map(id => ({ ruleKey: `presence:${id}`, family: 'presence', expected: id, observed: count(id), status: count(id) ? 'pass' : unknown ? 'unknown' : 'fail' }));
}
export function evaluateFacings(plan, review) {
  const { unknown, count } = counts(plan, review);
  return (plan.facingRules ?? []).map(r => {
    const lower = count(r.skuId), upper = lower + unknown;
    return { ruleKey: `facings:${r.skuId}`, family: 'facings', skuId: r.skuId, expected: { min: r.min, max: r.max }, observed: { lower, upper }, status: lower >= r.min && upper <= r.max ? 'pass' : upper < r.min || lower > r.max ? 'fail' : 'unknown' };
  });
}
export function assess(reference, review, submitted = false) {
  if (reference.status !== 'valid' || !reference.plan) return { referenceStatus: reference.status, evidenceStatus: 'unusable', reviewStatus: submitted ? 'confirmed' : 'pending', findingStatus: 'not_evaluable', results: [], C: 0, D: 0, U: 0, N: 0, adherence: null, coverage: null, fullyVerified: false };
  const results = [...evaluatePositions(reference.plan, review), ...evaluatePresence(reference.plan, review), ...evaluateFacings(reference.plan, review)];
  const positions = results.filter(r => r.family === 'position');
  const [C, D, U, N] = ['pass', 'fail', 'unknown', 'not_applicable'].map(status => positions.filter(r => r.status === status).length);
  return { referenceStatus: 'valid', evidenceStatus: U ? 'partial' : C + D ? 'complete' : 'unusable', reviewStatus: submitted ? 'confirmed' : 'pending', findingStatus: results.some(r => r.status === 'fail') ? 'deviations' : U ? 'not_evaluable' : 'none', results, C, D, U, N, adherence: C + D ? C / (C + D) : null, coverage: C + D + U ? (C + D) / (C + D + U) : null, fullyVerified: submitted && C + D > 0 && results.every(r => ['pass', 'not_applicable'].includes(r.status)) };
}

export function overview(w, { asOf = new Date().toISOString(), freshnessDays = 7, territory = '', outlet = '', owner = '', fixtureType = '' } = {}) {
  const now = Date.parse(asOf), start = now - freshnessDays * 86400000;
  const fixtures = w.fixtures.filter(f => f.active && (!territory || f.territory === territory) && (!outlet || f.outletId === outlet) && (!owner || f.ownerId === owner) && (!fixtureType || f.type === fixtureType));
  const rows = fixtures.map(f => {
    const audits = w.assessments.filter(a => a.fixtureId === f.id && Date.parse(a.capturedAt) <= now && Date.parse(a.submittedAt) <= now).sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt) || Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
    const latest = audits[0] ?? null, fresh = latest && Date.parse(latest.capturedAt) >= start;
    const reference = resolveReference(w, f.id, asOf), assigned = reference.status === 'valid';
    const complete = Boolean(assigned && fresh && latest.summary.referenceStatus === 'valid' && latest.reference.plan.id === reference.plan.id && latest.summary.evidenceStatus === 'complete');
    return { fixture: f, reference, latest, lastComplete: audits.find(a => a.summary.evidenceStatus === 'complete') ?? null, fresh, assigned, complete, verified: complete && latest.summary.fullyVerified, openIssues: w.issues.filter(i => i.fixtureId === f.id && OPEN_ISSUES.includes(i.status)), needsReview: Boolean(fresh && (latest.summary.U || latest.summary.reviewStatus !== 'confirmed')) };
  });
  const assigned = rows.filter(r => r.assigned).length, complete = rows.filter(r => r.complete).length, verified = rows.filter(r => r.verified).length;
  return { rows, assigned, complete, verified, completionRate: assigned ? complete / assigned : null, verifiedRate: complete ? verified / complete : null, deviations: rows.filter(r => r.openIssues.length).length, needsReview: rows.filter(r => r.needsReview).length, openIssues: rows.reduce((n, r) => n + r.openIssues.length, 0) };
}

export function blankWorkspace() {
  return { schemaVersion: 1, market: 'TW', catalogue: [], fixtures: [], plans: [], assignments: [], captures: [], assessments: [], issues: [], events: [] };
}
function visibleFixture(w, id, actor) {
  const f = w.fixtures.find(f => f.id === id);
  requireThat(f && actor.markets.includes('TW') && (actor.role !== 'field' || f.ownerId === actor.id), 'NOT_FOUND', 'Fixture not found in your assignments.', 404);
  return f;
}
function revision(actual, expected) { requireThat(actual === expected, 'REVISION_CONFLICT', 'This record changed. Reload before saving.', 409); }
function requiredNote(note) { requireThat(typeof note === 'string' && note.trim().length >= 3 && note.length <= 2000, 'NOTE_REQUIRED', 'Add a reason or action note (3–2,000 characters).'); }

/** One command produces a complete atomic workspace revision. Never accepts a client score. */
export function applyCommand(workspace, command, actor, { now = new Date().toISOString(), id = () => crypto.randomUUID() } = {}) {
  const w = clone(workspace), p = command.payload ?? {}, type = command.type; let result;
  requireThat(w.market === 'TW' && actor?.markets?.includes('TW'), 'FORBIDDEN', 'Taiwan access required.', 403);
  if (type === 'setup') {
    authorize(actor, 'planogram.manage');
    requireThat(Array.isArray(p.catalogue) && p.catalogue.length <= 2000 && Array.isArray(p.fixtures) && p.fixtures.length <= 500, 'SETUP_INVALID', 'Provide catalogue and fixture arrays.');
    for (const sku of p.catalogue) {
      requireThat(/^[\w-]{1,80}$/.test(sku.id) && sku.code?.length <= 80 && sku.name?.length <= 200 && (!sku.market || sku.market === 'TW'), 'SETUP_INVALID', 'Invalid Taiwan SKU.');
      if (!w.catalogue.some(s => s.id === sku.id)) w.catalogue.push({ id: sku.id, code: sku.code, name: sku.name, market: 'TW', artworks: sku.artworks ?? [] });
    }
    for (const f of p.fixtures) {
      requireThat(/^[\w-]{1,80}$/.test(f.id) && f.outletId && f.outletName && f.ownerId && Number.isInteger(f.rows) && Number.isInteger(f.columns) && f.rows > 0 && f.columns > 0 && f.rows * f.columns <= 500 && (!f.market || f.market === 'TW'), 'SETUP_INVALID', 'Invalid Taiwan fixture.');
      if (!w.fixtures.some(x => x.id === f.id)) w.fixtures.push({ id: f.id, outletId: String(f.outletId), outletName: String(f.outletName), name: String(f.name ?? f.id), territory: String(f.territory ?? ''), ownerId: String(f.ownerId), rows: f.rows, columns: f.columns, type: 'regular_cabinet', active: true });
    }
    result = { added: true };
  } else if (['plan.create', 'plan.edit', 'plan.publish', 'plan.duplicate', 'plan.retire', 'assignment.create'].includes(type)) {
    authorize(actor, 'planogram.manage');
    if (type === 'plan.create') {
      const plan = validatePlan(clone(p.plan), w.catalogue);
      result = { ...plan, id: id(), lineageId: id(), market: 'TW', status: 'draft', revision: 1, version: 1, updatedAt: now, updatedBy: actor.id };
      w.plans.push(result);
    } else if (type === 'assignment.create') {
      const fixture = visibleFixture(w, p.fixtureId, actor), plan = w.plans.find(x => x.id === p.planId);
      requireThat(plan?.status === 'published' && fixture.rows === plan.rows && fixture.columns === plan.columns && fixture.type === plan.fixtureType, 'REFERENCE_INVALID', 'Select a published plan matching this cabinet.');
      const from = Date.parse(p.validFrom), to = p.validTo ? Date.parse(p.validTo) : Infinity;
      requireThat(Number.isFinite(from) && to > from && from >= Date.parse(plan.validFrom) && (!plan.validTo || to <= Date.parse(plan.validTo)), 'REFERENCE_INVALID', 'Assignment dates must be inside the plan effective interval.');
      requireThat(!w.assignments.some(a => a.fixtureId === fixture.id && from < (a.validTo ? Date.parse(a.validTo) : Infinity) && Date.parse(a.validFrom) < to), 'REFERENCE_CONFLICT', 'This fixture already has an overlapping assignment.', 409);
      result = { id: id(), fixtureId: fixture.id, planId: plan.id, validFrom: new Date(from).toISOString(), validTo: p.validTo ? new Date(to).toISOString() : null }; w.assignments.push(result);
    } else {
      const plan = w.plans.find(x => x.id === p.planId); requireThat(plan, 'NOT_FOUND', 'Plan not found.', 404); revision(plan.revision, p.expectedRevision);
      if (type === 'plan.duplicate') {
        result = { ...clone(plan), id: id(), status: 'draft', revision: 1, version: Math.max(...w.plans.filter(x => x.lineageId === plan.lineageId).map(x => x.version)) + 1, updatedAt: now, updatedBy: actor.id }; w.plans.push(result);
      } else {
        if (type === 'plan.retire') { requiredNote(p.note); plan.status = 'retired'; }
        else {
          requireThat(plan.status === 'draft', 'PLAN_IMMUTABLE', 'Published plans are immutable. Duplicate as a new draft.', 409);
          if (type === 'plan.edit') {
            const allowed = ['code', 'rows', 'columns', 'fixtureType', 'slots', 'validFrom', 'validTo', 'requiredSkuIds', 'facingRules', 'changeNote', 'sourceName', 'sourceText'];
            const patch = Object.fromEntries(Object.entries(p.patch ?? {}).filter(([key]) => allowed.includes(key)));
            Object.assign(plan, validatePlan({ ...plan, ...patch }, w.catalogue));
          }
          if (type === 'plan.publish') { validatePlan(plan, w.catalogue); plan.status = 'published'; plan.publishedAt = now; }
        }
        plan.revision++; plan.updatedAt = now; plan.updatedBy = actor.id; result = plan;
      }
    }
  } else if (type === 'capture.create') {
    authorize(actor, 'audit.capture'); const f = visibleFixture(w, p.fixtureId, actor);
    requireThat(Number.isFinite(Date.parse(p.capturedAt)) && Date.parse(p.capturedAt) <= Date.parse(now) + 300000, 'CAPTURE_TIME_UNCERTAIN', 'Specify the actual capture time, no later than now.');
    requireThat(['manual', 'real_model', 'prepared_demo'].includes(p.mode) && ['gallery', 'camera', 'prepared_demo'].includes(p.source), 'CAPTURE_INVALID', 'Choose a supported capture mode/source.');
    requireThat(w.demo || p.mode !== 'prepared_demo', 'CAPTURE_INVALID', 'Prepared examples belong to the demo workspace.');
    result = { id: id(), fixtureId: f.id, outletId: f.outletId, capturedAt: new Date(p.capturedAt).toISOString(), source: p.source, mode: p.mode, reference: resolveReference(w, f.id, p.capturedAt), images: [], reviews: [], revision: 1, createdBy: actor.id, createdAt: now }; w.captures.push(result);
  } else if (['capture.image', 'review.save', 'assessment.submit'].includes(type)) {
    authorize(actor, type === 'capture.image' ? 'audit.capture' : 'audit.review');
    const cap = w.captures.find(c => c.id === p.captureId); requireThat(cap, 'NOT_FOUND', 'Capture not found.', 404); visibleFixture(w, cap.fixtureId, actor);
    if (type === 'assessment.submit') {
      requireThat(typeof p.idempotencyKey === 'string' && p.idempotencyKey.length >= 8 && p.idempotencyKey.length <= 128, 'KEY_REQUIRED', 'Submission needs an idempotency key.');
      const prior = w.assessments.find(a => a.idempotencyKey === p.idempotencyKey);
      if (prior) { requireThat(prior.captureId === cap.id && prior.reviewId === p.reviewId && prior.incompleteReason === (p.incompleteReason ?? null), 'REVISION_CONFLICT', 'This submission key already identifies different evidence.', 409); return { workspace: w, result: prior }; }
    }
    revision(cap.revision, p.expectedRevision);
    if (type === 'capture.image') {
      requireThat(!cap.reviews.length && cap.images.length < 4, 'CAPTURE_LOCKED', 'Use a new capture after review; maximum four images.');
      requireThat(p.image?.id && !cap.images.some(i => i.id === p.image.id) && p.image.width > 0 && p.image.height > 0, 'EVIDENCE_REQUIRED', 'Image metadata is required.');
      cap.images.push(clone(p.image)); cap.revision++; result = cap;
    } else if (type === 'review.save') {
      requireThat(cap.reference.status === 'valid', 'REFERENCE_MISSING', 'Capture saved. A valid reference is required before review.');
      requireThat(Array.isArray(p.slots) && p.slots.length <= 500, 'REVIEW_INVALID', 'Invalid slot review.');
      const images = new Set(cap.images.map(i => i.id)), skus = new Set(w.catalogue.map(s => s.id));
      const slots = p.slots.map(s => {
        requireThat(['product', 'empty', 'unknown'].includes(s.state) && (s.state !== 'product' || skus.has(s.confirmedSkuId)), 'REVIEW_INVALID', 'Choose an approved Taiwan SKU, Empty or Unknown.');
        const refs = [s.primaryEvidence, ...(s.supportingEvidence ?? [])].filter(Boolean);
        requireThat(refs.every(e => images.has(e.imageId) && validBox(e.bbox)), 'EVIDENCE_REQUIRED', 'Evidence must belong to this capture and use a valid crop.');
        requireThat(s.state === 'unknown' || s.primaryEvidence, 'EVIDENCE_REQUIRED', 'Inspect a primary image/crop before confirming a slot.');
        return { key: s.key, state: s.state, confirmedSkuId: s.state === 'product' ? s.confirmedSkuId : null, primaryEvidence: clone(s.primaryEvidence ?? null), supportingEvidence: clone(s.supportingEvidence ?? []), unknownReason: s.state === 'unknown' ? String(s.unknownReason ?? 'unreviewed').slice(0, 120) : null, confirmedBy: actor.id, confirmedAt: now };
      });
      normalizeReviewedSlots(cap.reference.plan, slots);
      result = { id: id(), revision: cap.reviews.length + 1, slots, actorId: actor.id, createdAt: now, runId: p.runId ?? null }; cap.reviews.push(result); cap.revision++;
    } else {
      const review = cap.reviews.find(r => r.id === p.reviewId); requireThat(review, 'REVIEW_REQUIRED', 'Save a reviewed revision before submitting.');
      requireThat(review.id === cap.reviews.at(-1).id, 'REVISION_CONFLICT', 'Submit the latest review revision.', 409);
      const summary = assess(cap.reference, review.slots, true);
      requireThat(summary.referenceStatus === 'valid', 'REFERENCE_MISSING', 'A valid reference is required.');
      if (summary.evidenceStatus !== 'complete') requiredNote(p.incompleteReason);
      result = { id: id(), fixtureId: cap.fixtureId, captureId: cap.id, reviewId: review.id, reference: clone(cap.reference), slots: clone(review.slots), capturedAt: cap.capturedAt, submittedAt: now, submittedBy: actor.id, mode: cap.mode, runId: review.runId, summary, incompleteReason: p.incompleteReason ?? null, idempotencyKey: p.idempotencyKey };
      w.assessments.push(result); cap.revision++;
      for (const failure of summary.results.filter(r => r.family === 'position' && r.status === 'fail')) {
        const key = `TW:${cap.fixtureId}:${cap.reference.plan.lineageId}:${failure.ruleKey}`;
        let issue = w.issues.find(i => i.key === key && OPEN_ISSUES.includes(i.status));
        if (!issue) {
          const previous = w.issues.filter(i => i.key === key).at(-1);
          issue = { id: id(), key, fixtureId: cap.fixtureId, lineageId: cap.reference.plan.lineageId, slotKey: failure.ruleKey, episode: (previous?.episode ?? 0) + 1, previousIssueId: previous?.id ?? null, expected: failure.expected, observed: failure.observed, status: 'open', ownerId: null, dueDate: null, firstAssessmentId: result.id, firstDetected: cap.capturedAt, lastObserved: cap.capturedAt, latestAssessmentId: result.id, history: [] }; w.issues.push(issue);
        }
        if (Date.parse(cap.capturedAt) >= Date.parse(issue.lastObserved)) { issue.latestAssessmentId = result.id; issue.lastObserved = cap.capturedAt; issue.observed = failure.observed; }
        issue.history.push({ id: id(), type: 'observed', assessmentId: result.id, actorId: actor.id, at: now });
      }
    }
  } else if (type === 'issue.event') {
    const issue = w.issues.find(i => i.id === p.issueId); requireThat(issue, 'NOT_FOUND', 'Issue not found.', 404); visibleFixture(w, issue.fixtureId, actor);
    requireThat(OPEN_ISSUES.includes(issue.status), 'ISSUE_CLOSED', 'This issue episode is already closed.', 409);
    requiredNote(p.note);
    const event = { id: id(), type: p.action, actorId: actor.id, at: now, note: p.note };
    if (p.action === 'assign') { authorize(actor, 'issue.assign'); requireThat(p.ownerId && /^\d{4}-\d{2}-\d{2}$/.test(p.dueDate ?? ''), 'OWNER_REQUIRED', 'Choose an owner and due date.'); issue.ownerId = String(p.ownerId); issue.dueDate = p.dueDate; issue.status = 'assigned'; }
    else if (['in_progress', 'awaiting_verification', 'blocked'].includes(p.action)) { authorize(actor, 'audit.capture'); issue.status = p.action; }
    else if (p.action === 'verify') {
      authorize(actor, 'issue.verify'); const a = w.assessments.find(x => x.id === p.assessmentId);
      requireThat(a && a.fixtureId === issue.fixtureId && Date.parse(a.capturedAt) > Date.parse(issue.lastObserved) && a.reference.plan.lineageId === issue.lineageId && a.reference.plan.id === w.assessments.find(x => x.id === issue.latestAssessmentId)?.reference.plan.id && a.summary.reviewStatus === 'confirmed' && a.summary.results.some(r => r.family === 'position' && r.ruleKey === issue.slotKey && r.status === 'pass'), 'EVIDENCE_REQUIRED', 'Verification requires a later confirmed capture of the same fixture and reference with this slot passing.');
      issue.status = 'closed_verified'; issue.closedAt = now; issue.closingAssessmentId = a.id; event.assessmentId = a.id;
    } else if (['closed_invalid', 'superseded_by_reference_change'].includes(p.action)) {
      authorize(actor, 'issue.verify');
      if (p.action === 'superseded_by_reference_change') { const ref = resolveReference(w, issue.fixtureId, now); const old = w.assessments.find(a => a.id === issue.latestAssessmentId); requireThat(ref.status === 'valid' && ref.plan.id !== old?.reference.plan.id, 'REFERENCE_UNCHANGED', 'A different applicable reference is required.'); }
      issue.status = p.action; issue.closedAt = now;
    } else throw new DomainError('TRANSITION_INVALID', 'Unsupported issue action.');
    issue.history.push(event); result = issue;
  } else throw new DomainError('COMMAND_INVALID', 'Unknown workspace action.');
  w.events.push({ id: id(), type, actorId: actor.id, at: now, entityId: result?.id ?? null });
  return { workspace: w, result: clone(result) };
}
