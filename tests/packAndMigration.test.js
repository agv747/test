/**
 * Pack configuration, the two timestamps, and the migration that lets them exist.
 *
 * "SGD 14.20" is not a price until you know what it buys. Nothing on any screen said which
 * pack was meant, so two outlets selling the same brand in different configurations produced
 * two numbers that looked directly comparable and were not. The unit is now master data, it
 * is snapshotted onto the observation beside the rule and mapping, and it is labelled.
 *
 * Underneath that sits a quieter problem. Seeding creates tables with `CREATE TABLE IF NOT
 * EXISTS`, which does exactly nothing to a table that already exists — including adding a
 * column declared after it was made. Every column added to the descriptor since the first
 * deploy was therefore absent in the deployed database while the code read it back as
 * `undefined`: no error, no log, just a feature that never appeared. These pin the additive
 * migration that closes it, and the fact that re-running it is a no-op.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TABLES,
  columnNames,
  ddlStatements,
  fromRow,
  isDuplicateColumnError,
  migrationStatements,
  toRow,
} from '../shared/schema.js';
import { buildSeedData } from '../public/app/seed.js';
import { buildDraftObservation, correctDraft } from '../public/app/services/visitService.js';
import { packUnitLabel, packUnitPill, PACK_UNIT_NOTE } from '../public/app/ui/dom.js';

const data = buildSeedData('2026-09-14T10:00:00.000Z');

/* -------------------------------------------------------- master data */

test('every SKU carries a pack configuration', () => {
  for (const sku of data.skus) {
    assert.equal(sku.sticks_per_pack, 20, `${sku.id} has no pack size`);
    assert.equal(sku.pack_type, 'Pack of 20');
  }
});

test('pack configuration survives the round trip through a row', () => {
  const sku = data.skus[0];
  const columns = columnNames('skus');
  const row = Object.fromEntries(columns.map((c, i) => [c, toRow('skus', sku)[i]]));
  const back = fromRow('skus', row);
  assert.equal(back.sticks_per_pack, 20);
  assert.equal(back.pack_type, 'Pack of 20');
});

test('every seeded observation records the pack its price is for', () => {
  for (const observation of data.price_observations) {
    assert.equal(observation.sticks_per_pack_snapshot, 20);
    assert.equal(observation.pack_type_snapshot, 'Pack of 20');
  }
});

/* --------------------------------------------------------- the label */

test('a price is labelled with the pack it buys', () => {
  assert.equal(packUnitLabel({ pack_type: 'Pack of 20' }), 'SGD / pack of 20');
  assert.equal(packUnitLabel({ sticks_per_pack: 10 }), 'SGD / pack of 10');
  assert.equal(packUnitLabel({ sticks_per_pack_snapshot: 20 }), 'SGD / pack of 20');
});

test('an unconfigured SKU is labelled per pack rather than assigned a size it has not got', () => {
  assert.equal(packUnitLabel(null), 'SGD / pack');
  assert.equal(packUnitLabel({}), 'SGD / pack');
});

test('the pill carries the note that comparisons stay inside one configuration', () => {
  assert.match(packUnitPill({ pack_type: 'Pack of 20' }), /pack of 20/);
  assert.match(PACK_UNIT_NOTE, /not compared/);
});

/* ------------------------------------------- observation-level snapshots */

const outlet = data.outlets.find((o) => o.id === 'out-e1');
const config = { currency: 'SGD', confidence_review_threshold: 0.75 };
const detection = {
  raw_text: 'WINSTON RED  $14.20',
  brand_candidate: 'Winston',
  sku_candidate: 'sku-jti-winston-red',
  price_candidate: 14.2,
  confidence: 0.97,
};

function draft(overrides = {}) {
  return buildDraftObservation({
    detection: { ...detection, ...overrides },
    image: { id: 'img-1', image_source: 'camera' },
    provider: 'mock-simulator',
    visit: { id: 'vis-1' },
    outlet,
    data,
    config,
    observedAt: '2026-09-14T09:00:00.000Z',
  });
}

test('a new draft snapshots the pack configuration it was priced in', () => {
  const d = draft();
  assert.equal(d.sticks_per_pack_snapshot, 20);
  assert.equal(d.pack_type_snapshot, 'Pack of 20');
});

test('a draft separates when the shelf was seen from when the reading arrived', () => {
  const d = draft();
  // The observed time comes from the visit; the recorded time is taken here, now. They are
  // equal for a live capture and differ for an offline one, and an "as of" date that quietly
  // means whichever happened to be stored is not an as-of date.
  assert.equal(d.observed_at, '2026-09-14T09:00:00.000Z');
  assert.ok(d.recorded_at, 'the upload time is missing');
  assert.ok(Number.isFinite(new Date(d.recorded_at).getTime()), 'the upload time is not a time');
  assert.notEqual(Object.keys(d).indexOf('recorded_at'), Object.keys(d).indexOf('observed_at'));
});

test('a new draft is not yet reviewed by anybody', () => {
  const d = draft();
  assert.equal(d.review_resolved, false);
  assert.equal(d.reviewed_at, null);
  assert.equal(d.reviewed_by, null);
});

test('confirming a reading as read is a review, not a correction', () => {
  const confirmed = correctDraft(
    draft({ confidence: 0.58 }),
    { review_resolved: true, reviewed_at: '2026-09-14T09:05:00.000Z', reviewed_by: 'usr-tme-1' },
    data,
    config,
    '2026-09-14T09:00:00.000Z',
  );
  // The whole point: the value did not change, so this must not be filed as a correction —
  // that record is what future model training is built from.
  assert.equal(confirmed.manual_correction, false);
  assert.equal(confirmed.confirmed_price, 14.2);
  assert.equal(confirmed.review_resolved, true);
  assert.equal(confirmed.reviewed_by, 'usr-tme-1');
});

test('correcting to a different SKU moves the pack snapshot with it', () => {
  const skus = data.skus.map((s) =>
    s.id === 'sku-jti-winston-blue' ? { ...s, sticks_per_pack: 10, pack_type: 'Pack of 10' } : s,
  );
  const corrected = correctDraft(
    draft(),
    { sku_id: 'sku-jti-winston-blue' },
    { ...data, skus },
    config,
    '2026-09-14T09:00:00.000Z',
  );
  assert.equal(corrected.sticks_per_pack_snapshot, 10);
  assert.equal(corrected.pack_type_snapshot, 'Pack of 10');
  assert.equal(corrected.manual_correction, true);
});

/* ---------------------------------------------------------- migration */

test('the migration offers an ALTER for every declared column except the primary key', () => {
  const statements = migrationStatements();
  const declared = Object.entries(TABLES).flatMap(([table, columns]) =>
    Object.keys(columns).filter((c) => c !== 'id').map((c) => `${table}.${c}`),
  );
  assert.deepEqual(
    statements.map((s) => `${s.table}.${s.column}`).sort(),
    declared.sort(),
  );
  assert.ok(statements.every((s) => s.sql.startsWith('ALTER TABLE ')));
});

test('the columns added for this change are in the migration', () => {
  const columns = new Set(migrationStatements().map((s) => `${s.table}.${s.column}`));
  for (const column of [
    'skus.sticks_per_pack',
    'skus.pack_type',
    'price_observations.sticks_per_pack_snapshot',
    'price_observations.pack_type_snapshot',
    'price_observations.recorded_at',
    'price_observations.reviewed_by',
  ]) {
    assert.ok(columns.has(column), `${column} is not migrated`);
  }
});

test('an already-migrated database is recognised rather than reported as broken', () => {
  assert.equal(isDuplicateColumnError(new Error('duplicate column name: pack_type')), true);
  assert.equal(isDuplicateColumnError(new Error('D1_ERROR: duplicate column name: x')), true);
  assert.equal(isDuplicateColumnError(new Error('no such table: skus')), false);
  assert.equal(isDuplicateColumnError(null), false);
});

test('the DDL and the migration agree on the column set', () => {
  // The reason the two drifted in the first place: only one of them ran against a deployed
  // database, and nothing checked that it carried the same columns.
  const create = ddlStatements().find((s) => s.startsWith('CREATE TABLE IF NOT EXISTS skus '));
  for (const column of Object.keys(TABLES.skus)) {
    assert.ok(create.includes(`${column} `), `${column} missing from CREATE TABLE`);
  }
});
