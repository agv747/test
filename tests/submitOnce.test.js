/**
 * One tap or two, the visit is filed once.
 *
 * The submit handler is synchronous, so a double-tap — routine on a phone, and likelier still
 * when the first tap appears to do nothing — ran it twice. The second run started after the
 * wizard had already been reset, so it filed a second visit against a null outlet: a duplicate
 * that is also malformed, in the one table the coverage denominators count. Visit coverage is
 * "outlets visited out of outlets in scope", and a phantom visit quietly inflates the
 * numerator while belonging to no outlet at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { onAction, reset } from '../public/app/ui/priceCheck.js';
import { buildSeedData } from '../public/app/seed.js';

const data = buildSeedData('2026-09-14T10:00:00.000Z');

function harness(overrides = {}) {
  const visits = [];
  const observations = [];
  const actions = [];
  let seq = 0;

  const store = {
    createVisit(visit) {
      seq += 1;
      const record = { id: `vis-test-${seq}`, ...visit };
      visits.push(record);
      return record;
    },
    addImage(image) {
      return { id: `img-test-${visits.length}`, ...image };
    },
    addObservations(rows) {
      observations.push(...rows);
    },
    addFieldAction(action) {
      actions.push(action);
    },
    updateVisit(id, patch) {
      Object.assign(visits.find((v) => v.id === id), patch);
    },
    ...overrides,
  };

  const navigated = [];
  const ctx = {
    data,
    config: { currency: 'SGD', confidence_review_threshold: 0.75 },
    user: { id: 'usr-tme-1', role: 'field' },
    store,
    render() {},
    navigate: (...args) => navigated.push(args),
  };
  return { ctx, visits, observations, actions, navigated };
}

function startVisit(ctx) {
  reset();
  onAction('pick-outlet', { dataset: { outlet: 'out-e1' } }, ctx);
}

test('a double tap on submit files one visit, not two', () => {
  const { ctx, visits, navigated } = harness();
  startVisit(ctx);

  onAction('submit-visit', {}, ctx);
  onAction('submit-visit', {}, ctx);

  assert.equal(visits.length, 1);
  assert.equal(visits[0].outlet_id, 'out-e1');
  assert.equal(visits[0].status, 'submitted');
  assert.equal(navigated.length, 1);
});

test('the second tap cannot file a visit against no outlet at all', () => {
  const { ctx, visits } = harness();
  startVisit(ctx);

  onAction('submit-visit', {}, ctx);
  onAction('submit-visit', {}, ctx);
  onAction('submit-visit', {}, ctx);

  assert.ok(visits.every((v) => v.outlet_id), 'a visit was filed with no outlet');
});

test('saving a draft and then submitting is also a single write', () => {
  const { ctx, visits } = harness();
  startVisit(ctx);

  onAction('save-draft', {}, ctx);
  onAction('submit-visit', {}, ctx);

  assert.equal(visits.length, 1);
  assert.equal(visits[0].status, 'draft');
});

test('a failed save releases the guard so a genuine retry still works', () => {
  let attempts = 0;
  const { ctx, visits } = harness({
    createVisit(visit) {
      attempts += 1;
      if (attempts === 1) throw new Error('network is down');
      return { id: 'vis-test-retry', ...visit };
    },
  });
  startVisit(ctx);

  onAction('submit-visit', {}, ctx);
  assert.equal(visits.length, 0, 'nothing should have been written');

  onAction('submit-visit', {}, ctx);
  assert.equal(attempts, 2, 'the retry never reached the store');
});

test('a fresh visit after a submitted one is not blocked by the previous guard', () => {
  const { ctx, visits } = harness();
  startVisit(ctx);
  onAction('submit-visit', {}, ctx);

  startVisit(ctx);
  onAction('submit-visit', {}, ctx);

  assert.equal(visits.length, 2);
});
