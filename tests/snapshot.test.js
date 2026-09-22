/**
 * Current snapshot versus historical observations (GM review §B).
 *
 * The manager screens were reading every observation ever recorded: an outlet visited ten
 * times counted ten times against one visited once, June prices sat in a view labelled as
 * the current picture, and a low-confidence reading nobody had confirmed carried the same
 * weight as a verified one. None of that is visible in a percentage, which is why these are
 * pinned rather than eyeballed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INELIGIBLE,
  SNAPSHOT_MODE,
  applySnapshot,
  currentSnapshot,
  isConfirmed,
  snapshotKey,
  supersededByPending,
} from '../public/app/services/snapshotService.js';
import { defaultConfig } from '../public/app/config.js';

const NOW = '2026-09-14T12:00:00.000Z';
const config = defaultConfig();

const obs = (overrides = {}) => ({
  id: 'o1',
  outlet_id: 'out-1',
  sku_id: 'sku-1',
  observed_at: '2026-09-13T09:00:00.000Z',
  recognition_confidence: 0.95,
  review_resolved: false,
  manual_correction: false,
  sku: { sticks_per_pack: 20 },
  ...overrides,
});

/* --------------------------------------------------------------- eligibility */

test('a confident reading needs nobody to confirm it', () => {
  assert.equal(isConfirmed(obs({ recognition_confidence: 0.95 }), config), true);
});

test('a low-confidence reading is not trusted until a person has been back to it', () => {
  assert.equal(isConfirmed(obs({ recognition_confidence: 0.4 }), config), false);
});

test('confirming as read counts, without any value having changed', () => {
  // This is why confirmation must not require editing a number: a correct low-confidence
  // reading is confirmed by a person saying so, not by nudging the price.
  assert.equal(isConfirmed(obs({ recognition_confidence: 0.4, review_resolved: true }), config), true);
  assert.equal(isConfirmed(obs({ recognition_confidence: 0.4, manual_correction: true }), config), true);
});

test('an observation with no confidence at all is not treated as a bad one', () => {
  assert.equal(isConfirmed(obs({ recognition_confidence: null }), config), true);
});

/* ----------------------------------------------------------------- selection */

test('repeat visits give an outlet one place in the current picture, not ten', () => {
  const snapshot = currentSnapshot(
    [
      obs({ id: 'a', observed_at: '2026-09-08T09:00:00.000Z', confirmed_price: 13.4 }),
      obs({ id: 'b', observed_at: '2026-09-12T09:00:00.000Z', confirmed_price: 13.6 }),
      obs({ id: 'c', observed_at: '2026-09-10T09:00:00.000Z', confirmed_price: 13.5 }),
    ],
    config,
    { now: NOW },
  );
  assert.equal(snapshot.observations.length, 1);
  assert.equal(snapshot.observations[0].id, 'b', 'the latest one');
  assert.equal(snapshot.excluded[INELIGIBLE.SUPERSEDED], 2);
});

test('the same SKU in two outlets is two observations, not a duplicate', () => {
  const snapshot = currentSnapshot(
    [obs({ id: 'a', outlet_id: 'out-1' }), obs({ id: 'b', outlet_id: 'out-2' })],
    config,
    { now: NOW },
  );
  assert.equal(snapshot.observations.length, 2);
});

test('one pack configuration is not compared with another', () => {
  // SGD 14.20 for a pack of 20 and for a carton are not two readings of the same thing.
  const snapshot = currentSnapshot(
    [
      obs({ id: 'a', sku: { sticks_per_pack: 20 } }),
      obs({ id: 'b', sku: { sticks_per_pack: 10 } }),
    ],
    config,
    { now: NOW },
  );
  assert.equal(snapshot.observations.length, 2);
  assert.notEqual(snapshotKey(snapshot.observations[0]), snapshotKey(snapshot.observations[1]));
});

/* ---------------------------------------------------------------- exclusions */

test('an observation older than the window is counted out, not averaged in', () => {
  const snapshot = currentSnapshot([obs({ observed_at: '2026-06-01T09:00:00.000Z' })], config, {
    now: NOW,
    window_days: 14,
  });
  assert.deepEqual(snapshot.observations, []);
  assert.equal(snapshot.excluded[INELIGIBLE.STALE], 1);
});

test('an observation dated after the as-of time cannot be part of it', () => {
  const snapshot = currentSnapshot([obs({ observed_at: '2026-09-20T09:00:00.000Z' })], config, {
    now: NOW,
  });
  assert.deepEqual(snapshot.observations, []);
  assert.equal(snapshot.excluded[INELIGIBLE.FUTURE], 1);
});

test('an unconfirmed low-confidence reading is held out and counted separately', () => {
  const snapshot = currentSnapshot([obs({ recognition_confidence: 0.4 })], config, { now: NOW });
  assert.deepEqual(snapshot.observations, []);
  assert.equal(snapshot.excluded[INELIGIBLE.PENDING], 1);
  assert.equal(snapshot.pending.length, 1, 'and stays visible rather than disappearing');
});

test('every exclusion is counted, so missing data is never read as an aligned price', () => {
  const snapshot = currentSnapshot(
    [
      obs({ id: 'a' }),
      obs({ id: 'b', observed_at: '2026-06-01T09:00:00.000Z' }),
      obs({ id: 'c', observed_at: '2026-09-20T09:00:00.000Z' }),
      obs({ id: 'd', recognition_confidence: 0.3 }),
    ],
    config,
    { now: NOW },
  );
  assert.equal(snapshot.observations.length, 1);
  assert.equal(snapshot.excluded[INELIGIBLE.STALE], 1);
  assert.equal(snapshot.excluded[INELIGIBLE.FUTURE], 1);
  assert.equal(snapshot.excluded[INELIGIBLE.PENDING], 1);
});

test('the as-of time and window come back with the result', () => {
  const snapshot = currentSnapshot([obs()], config, { now: NOW, window_days: 7 });
  assert.equal(snapshot.as_of, NOW);
  assert.equal(snapshot.window_days, 7);
});

/* ------------------------------------------------- a newer reading nobody confirmed */

test('a pending reading newer than the shown one is surfaced, not silently ignored', () => {
  // Somebody has already been back and read something else. Presenting the older verified
  // price alone would show it as the current state of the shelf.
  const snapshot = currentSnapshot(
    [
      obs({ id: 'verified', observed_at: '2026-09-10T09:00:00.000Z' }),
      obs({ id: 'newer', observed_at: '2026-09-13T09:00:00.000Z', recognition_confidence: 0.4 }),
    ],
    config,
    { now: NOW },
  );
  const conflicts = supersededByPending(snapshot);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].shown.id, 'verified');
  assert.equal(conflicts[0].pending.id, 'newer');
});

test('a pending reading older than the shown one raises nothing', () => {
  const snapshot = currentSnapshot(
    [
      obs({ id: 'verified', observed_at: '2026-09-13T09:00:00.000Z' }),
      obs({ id: 'older', observed_at: '2026-09-10T09:00:00.000Z', recognition_confidence: 0.4 }),
    ],
    config,
    { now: NOW },
  );
  assert.deepEqual(supersededByPending(snapshot), []);
});

/* ---------------------------------------------------------------------- modes */

test('historical keeps everything, and says that is what it is', () => {
  const rows = [obs({ id: 'a' }), obs({ id: 'b', observed_at: '2026-01-01T09:00:00.000Z' })];
  const snapshot = applySnapshot(rows, config, { now: NOW, mode: SNAPSHOT_MODE.HISTORICAL });
  assert.equal(snapshot.mode, SNAPSHOT_MODE.HISTORICAL);
  assert.equal(snapshot.observations.length, 2);
  assert.equal(snapshot.window_days, null);
});

test('current is the default, so a screen cannot silently show ten years of prices', () => {
  const snapshot = applySnapshot([obs()], config, { now: NOW });
  assert.equal(snapshot.mode, SNAPSHOT_MODE.CURRENT);
  assert.equal(snapshot.window_days, 14);
});
