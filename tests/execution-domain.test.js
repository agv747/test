import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaiwanDemo, DEMO_ACTOR, DEMO_TIME, preparedProposal } from '../public/app/execution/demo.js';
import { assess, applyCommand, overview, resolveReference, emptyReview, importPlan, clone } from '../public/app/execution/domain.js';
const env = { now: DEMO_TIME };
const apply = (w, type, payload, actor = DEMO_ACTOR) => applyCommand(w, { type, payload }, actor, env);
const fixtureAssessment = (w, id) => w.assessments.find(a => a.fixtureId === id);

test('PG-01/02/03: deterministic Taiwan fixtures have exact independent denominators', () => {
  const w = buildTaiwanDemo();
  const a = fixtureAssessment(w, 'F1').summary, b = fixtureAssessment(w, 'F2').summary, c = fixtureAssessment(w, 'F3').summary;
  assert.deepEqual([a.C, a.D, a.U, a.fullyVerified], [20, 0, 0, true]);
  assert.deepEqual([b.C, b.D, b.U, b.adherence, b.coverage], [14, 2, 4, .875, .8]);
  assert.deepEqual(b.results.filter(r => r.family === 'facings').map(r => [r.status, r.observed.lower, r.observed.upper]), [['unknown', 4, 8], ['unknown', 4, 8], ['unknown', 4, 8], ['unknown', 2, 6], ['unknown', 2, 6]]);
  assert.equal(b.results.filter(r => r.family === 'presence' && r.status === 'pass').length, 5);
  assert.deepEqual([c.C, c.D, c.U, c.adherence, c.coverage], [19, 1, 0, .95, 1]);
  assert.deepEqual(c.results.find(r => r.ruleKey === 'facings:TW-A').observed, { lower: 3, upper: 3 });
  assert.equal(w.issues.length, 3);
  const stats = overview(w, { asOf: DEMO_TIME });
  assert.deepEqual([stats.complete, stats.assigned, stats.verified, stats.completionRate, stats.verifiedRate, stats.deviations, stats.needsReview, stats.openIssues], [2, 4, 1, .5, .5, 2, 1, 3]);
});
test('PG-04/05/06: unknown is not empty; supporting images do not add facings', () => {
  const w = buildTaiwanDemo(), a = fixtureAssessment(w, 'F1');
  const unknown = assess(a.reference, emptyReview(a.reference.plan), true);
  assert.equal(unknown.adherence, null); assert.equal(unknown.coverage, 0); assert.equal(unknown.fullyVerified, false);
  const slots = clone(a.slots); slots[0].supportingEvidence.push(slots[1].primaryEvidence, slots[1].primaryEvidence);
  assert.equal(assess(a.reference, slots).results.find(r => r.ruleKey === 'facings:TW-A').observed.lower, 4);
  assert.equal(assess(a.reference, slots).C, 20);
});
test('PG-07/08: reference resolves at capture time and detects overlapping legacy assignments', () => {
  const w = buildTaiwanDemo();
  assert.equal(resolveReference(w, 'F5', DEMO_TIME).status, 'missing');
  assert.equal(resolveReference(w, 'F1', 'not-a-time').status, 'time_uncertain');
  w.assignments.push(clone(w.assignments[0]));
  assert.equal(resolveReference(w, 'F1', DEMO_TIME).status, 'conflict');
  assert.equal(assess(resolveReference(w, 'F1', DEMO_TIME), []).adherence, null);
  w.assignments.pop(); w.assignments[0].validTo = DEMO_TIME;
  assert.equal(resolveReference(w, 'F1', '2026-09-21T04:00:00Z').plan.id, 'tw-plan-v1');
  assert.equal(resolveReference(w, 'F1', DEMO_TIME).status, 'missing');
});
test('PG-09: publication is immutable; duplicate version and assignment overlap checks', () => {
  const w = buildTaiwanDemo(), plan = w.plans[0];
  assert.throws(() => apply(w, 'plan.edit', { planId: plan.id, expectedRevision: 1, patch: { code: 'changed' } }), { code: 'PLAN_IMMUTABLE' });
  const duplicated = apply(w, 'plan.duplicate', { planId: plan.id, expectedRevision: 1 });
  assert.equal(duplicated.result.version, 2); assert.equal(duplicated.result.status, 'draft'); assert.equal(duplicated.result.lineageId, plan.lineageId);
  assert.throws(() => apply(w, 'assignment.create', { fixtureId: 'F1', planId: plan.id, validFrom: DEMO_TIME }), { code: 'REFERENCE_CONFLICT' });
  assert.equal(w.plans[0].code, plan.code);
});
test('PG-10: latest incomplete evidence replaces an older full audit', () => {
  const w = buildTaiwanDemo(), newer = clone(fixtureAssessment(w, 'F1'));
  newer.id = 'later'; newer.capturedAt = DEMO_TIME; newer.submittedAt = DEMO_TIME; newer.summary = assess(newer.reference, emptyReview(newer.reference.plan), true);
  w.assessments.push(newer); const stats = overview(w, { asOf: DEMO_TIME });
  assert.equal(stats.complete, 1); assert.equal(stats.verified, 0);
  assert.equal(stats.rows[0].latest.id, 'later'); assert.notEqual(stats.rows[0].lastComplete.id, 'later');
});
test('PG-11: repeated submission is idempotent and repeated failures reuse open issues', () => {
  let w = buildTaiwanDemo(), cap = w.captures.find(c => c.fixtureId === 'F2');
  const saved = apply(w, 'review.save', { captureId: cap.id, expectedRevision: cap.revision, slots: cap.reviews[0].slots }); w = saved.workspace; cap = w.captures.find(c => c.id === cap.id);
  const payload = { captureId: cap.id, expectedRevision: cap.revision, reviewId: saved.result.id, incompleteReason: 'Four slots obscured', idempotencyKey: 'repeat-request' };
  const submitted = apply(w, 'assessment.submit', payload), repeated = apply(submitted.workspace, 'assessment.submit', payload);
  assert.equal(submitted.result.id, repeated.result.id); assert.equal(submitted.workspace.issues.length, 3); assert.equal(repeated.workspace.assessments.length, submitted.workspace.assessments.length);
  assert.throws(() => apply(submitted.workspace, 'assessment.submit', { ...payload, incompleteReason: 'different' }), { code: 'REVISION_CONFLICT' });
});
test('PG-12/13: action alone cannot close an issue; a later confirmed slot can', () => {
  let w = buildTaiwanDemo(), issue = w.issues.find(i => i.fixtureId === 'F2');
  assert.throws(() => apply(w, 'issue.event', { issueId: issue.id, action: 'verify', assessmentId: issue.latestAssessmentId, note: 'Marked complete' }), { code: 'EVIDENCE_REQUIRED' });
  let cap = w.captures.find(c => c.id === 'capture-F2-followup');
  const saved = apply(w, 'review.save', { captureId: cap.id, expectedRevision: cap.revision, slots: preparedProposal(cap) }); w = saved.workspace; cap = w.captures.find(c => c.id === cap.id);
  assert.equal(overview(w, { asOf: DEMO_TIME }).openIssues, 3);
  const submitted = apply(w, 'assessment.submit', { captureId: cap.id, expectedRevision: cap.revision, reviewId: saved.result.id, idempotencyKey: 'followup-request' }); w = submitted.workspace;
  assert.equal(overview(w, { asOf: DEMO_TIME }).openIssues, 3);
  for (const i of w.issues.filter(i => i.fixtureId === 'F2')) w = apply(w, 'issue.event', { issueId: i.id, action: 'verify', assessmentId: submitted.result.id, note: 'Verified against later capture' }).workspace;
  assert.equal(overview(w, { asOf: DEMO_TIME }).openIssues, 1);
  assert.equal(w.issues.filter(i => i.status === 'closed_verified').length, 2);
});
test('PG-14: unchanged reference cannot be used as a reference-change closure', () => {
  const w = buildTaiwanDemo();
  assert.throws(() => apply(w, 'issue.event', { issueId: w.issues[0].id, action: 'superseded_by_reference_change', note: 'New plan' }), { code: 'REFERENCE_UNCHANGED' });
});
test('PG-15/16: artwork aliases retain one SKU; field and market scopes are enforced', () => {
  const w = buildTaiwanDemo(); assert.equal(w.catalogue[0].artworks.length, 2);
  assert.throws(() => apply(w, 'capture.create', { fixtureId: 'F1', capturedAt: DEMO_TIME, source: 'camera', mode: 'manual' }, { id: 'other-field', role: 'field', markets: ['TW'] }), { code: 'NOT_FOUND' });
  assert.throws(() => apply(w, 'capture.create', {}, { id: 'sg-admin', role: 'admin', markets: ['SG'] }), { code: 'FORBIDDEN' });
  const cap = w.captures[0], slots = clone(cap.reviews[0].slots); slots[0].primaryEvidence.imageId = 'image-other-capture';
  assert.throws(() => apply(w, 'review.save', { captureId: cap.id, expectedRevision: cap.revision, slots }), { code: 'EVIDENCE_REQUIRED' });
  slots[0].primaryEvidence.imageId = cap.images[0].id; slots[0].confirmedSkuId = 'SG-SKU';
  assert.throws(() => apply(w, 'review.save', { captureId: cap.id, expectedRevision: cap.revision, slots }), { code: 'REVIEW_INVALID' });
});
test('CSV import rejects duplicate, unknown and incomplete cells atomically', () => {
  const w = buildTaiwanDemo(), header = 'planogram_code,version,row,column,allowed_sku_codes,critical\n', metadata = { fixtureType: 'regular_cabinet', validFrom: DEMO_TIME };
  const good = importPlan(header + 'TEST,1,1,1,TW-A;TW-B,true', 'csv', metadata, w.catalogue);
  assert.deepEqual(good.slots[0].allowedSkuIds, ['TW-A', 'TW-B']);
  assert.throws(() => importPlan(header + 'TEST,1,1,1,UNKNOWN,true', 'csv', metadata, w.catalogue), /Row 2: unknown SKU/);
  assert.throws(() => importPlan(header + 'TEST,1,1,1,TW-A,true\nTEST,1,1,1,TW-B,true', 'csv', metadata, w.catalogue), /duplicate cell/);
  assert.throws(() => importPlan(header + 'TEST,1,2,2,TW-A,true', 'csv', metadata, w.catalogue), /Every grid cell/);
});
