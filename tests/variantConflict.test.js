/**
 * Catching two variants reported as one product.
 *
 * Under plain packaging, two variants of a brand stand side by side, look nearly identical
 * and usually cost the same. A model reading such a shelf resolves both to whichever variant
 * it could read, and the two facings come back as one product at one price — the failure a
 * TME will not notice, because the answer looks entirely reasonable.
 *
 * The price ticket is what tells them apart, so the model is asked for its colour. These pin
 * the rule that follows from it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { flagVariantConflicts, summariseVisit } from '../public/app/services/visitService.js';
import { ticketColour, ticketSwatch } from '../public/app/ui/dom.js';

const draft = (overrides) => ({
  draft_id: 'd',
  sku_id: 'sku-jti-winston-red',
  shelf: 1,
  ticket_colour: 'red',
  confirmed_price: 13.6,
  is_jti: true,
  excluded: false,
  ...overrides,
});

test('the same SKU twice on one shelf with different tickets is flagged', () => {
  const flagged = flagVariantConflicts([
    draft({ draft_id: 'a', ticket_colour: 'red' }),
    draft({ draft_id: 'b', ticket_colour: 'blue' }),
  ]);
  assert.deepEqual(flagged.map((d) => d.variant_conflict), [true, true]);
});

test('the same SKU twice with the same ticket is not', () => {
  // One product genuinely split across two blocks is ordinary, not a merge.
  const flagged = flagVariantConflicts([
    draft({ draft_id: 'a', ticket_colour: 'red' }),
    draft({ draft_id: 'b', ticket_colour: 'Red' }),
  ]);
  assert.deepEqual(flagged.map((d) => d.variant_conflict), [false, false]);
});

test('different SKUs with different tickets are exactly what is expected', () => {
  const flagged = flagVariantConflicts([
    draft({ draft_id: 'a', sku_id: 'sku-jti-winston-red', ticket_colour: 'red' }),
    draft({ draft_id: 'b', sku_id: 'sku-jti-winston-blue', ticket_colour: 'blue' }),
  ]);
  assert.ok(flagged.every((d) => !d.variant_conflict));
});

test('the same SKU on two different shelves is not a merge', () => {
  // A brand is often stocked on more than one shelf; that is not the failure being caught.
  const flagged = flagVariantConflicts([
    draft({ draft_id: 'a', shelf: 1, ticket_colour: 'red' }),
    draft({ draft_id: 'b', shelf: 2, ticket_colour: 'blue' }),
  ]);
  assert.ok(flagged.every((d) => !d.variant_conflict));
});

test('a detection with no ticket colour cannot raise or defeat the flag', () => {
  // Nothing is claimed from an absent reading in either direction.
  const flagged = flagVariantConflicts([
    draft({ draft_id: 'a', ticket_colour: null }),
    draft({ draft_id: 'b', ticket_colour: 'blue' }),
  ]);
  assert.ok(flagged.every((d) => !d.variant_conflict));
});

test('an unmatched detection is never flagged, having no SKU to collide on', () => {
  const flagged = flagVariantConflicts([
    draft({ draft_id: 'a', sku_id: null, ticket_colour: 'red' }),
    draft({ draft_id: 'b', sku_id: null, ticket_colour: 'blue' }),
  ]);
  assert.ok(flagged.every((d) => !d.variant_conflict));
});

test('flagging is additive: nothing else about the draft changes', () => {
  const original = draft({ draft_id: 'a' });
  const [flagged] = flagVariantConflicts([original]);
  assert.deepEqual({ ...flagged, variant_conflict: undefined }, { ...original, variant_conflict: undefined });
});

test('flagging nothing is not an error', () => {
  assert.deepEqual(flagVariantConflicts([]), []);
  assert.deepEqual(flagVariantConflicts(null), []);
});

test('the visit summary counts conflicts, so they are visible before submitting', () => {
  const summary = summariseVisit(
    [
      draft({ draft_id: 'a', variant_conflict: true }),
      draft({ draft_id: 'b', variant_conflict: true, excluded: true }),
      draft({ draft_id: 'c', variant_conflict: false }),
    ],
    [],
  );
  assert.equal(summary.variant_conflicts, 1, 'an excluded observation is not still a problem');
});

/* ------------------------------------------------------------ the swatch */

test('a colour word that is understood is drawn, in a readable colour', () => {
  assert.equal(ticketColour('red'), '#c2362c');
  assert.equal(ticketColour(' Dark Blue '), '#1b3f73');
  assert.match(ticketSwatch('green'), /background:#2e8b4f/);
});

test('a colour word that is not understood is not guessed at', () => {
  // A wrong swatch beside the word "teal" would undermine the one signal separating two
  // plain packs, so there is no swatch at all.
  assert.equal(ticketColour('teal'), null);
  assert.equal(ticketColour(null), null);
  assert.equal(ticketSwatch('teal'), '');
  assert.equal(ticketSwatch(undefined), '');
});

test('the swatch names the colour for anyone who cannot see it', () => {
  assert.match(ticketSwatch('red'), /title="red price ticket"/);
});

test('a correction made by hand ends the question, for that facing and its neighbour', () => {
  // The flag exists to catch what the model merged. Once a person at the shelf has said what
  // the pack is, there is nothing left to raise — and without this, correcting one facing to
  // a variant already on the same shelf simply re-raised the flag against itself.
  const flagged = flagVariantConflicts([
    draft({ draft_id: 'a', ticket_colour: 'red' }),
    draft({ draft_id: 'b', ticket_colour: 'blue', manual_correction: true }),
  ]);
  assert.deepEqual(flagged.map((d) => d.variant_conflict), [false, false]);
});

test('correcting one of three still leaves a real conflict between the other two', () => {
  const flagged = flagVariantConflicts([
    draft({ draft_id: 'a', ticket_colour: 'red' }),
    draft({ draft_id: 'b', ticket_colour: 'green' }),
    draft({ draft_id: 'c', ticket_colour: 'blue', manual_correction: true }),
  ]);
  assert.deepEqual(flagged.map((d) => d.variant_conflict), [true, true, false]);
});
