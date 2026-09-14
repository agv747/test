/**
 * One signal is a group, and a case has a life.
 *
 * The opportunity card read as two things at once. "Winston Red — Tampines Hub Convenience" is
 * one outlet; its subtitle said "East · 19 outlets affected", and the identical subtitle
 * appeared on the card for a different outlet. Nineteen is how many outlets have that SKU
 * deviating; the card is about one of them. A reader cannot tell which they are looking at, so
 * the heading is now the group and the outlets are its evidence, counted where they are listed.
 *
 * And every opportunity was labelled "New" — including one at Punggol carrying eighty-seven days
 * of history and a recorded "Follow-up required". A GM cannot tell a case nobody has touched
 * from one somebody is three visits into, which is precisely what decides the next step.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSignals, NO_SIGNAL_NOTE, SIGNAL_THRESHOLDS } from '../public/app/services/signalService.js';
import { buildAnalytics, deriveOpportunities, enrichObservations } from '../public/app/services/analyticsService.js';
import { DEFAULT_CONFIG } from '../public/app/config.js';
import { buildSeedData } from '../public/app/seed.js';

const NOW = '2026-09-14T10:00:00.000Z';
const data = buildSeedData(NOW);
const config = DEFAULT_CONFIG;

const opp = (overrides = {}) => ({
  id: `opp-${Math.random()}`,
  category: 'Competitive Risk',
  jti_sku_id: 'sku-jti-winston-red',
  jti_sku_name: 'Winston Red',
  is_strategic: true,
  territory_id: 'ter-east',
  territory_name: 'East',
  outlet_id: 'out-e1',
  outlet_name: 'Punggol Central Minimart',
  competitor_sku_name: 'Pall Mall Red',
  jti_price: 14.3,
  competitor_price: 13.2,
  price_gap: 1.1,
  price_index: 108.3,
  priority_score: 50,
  priority_label: 'High',
  last_detected_at: NOW,
  status: 'New',
  overdue: false,
  assigned_user_id: 'usr-tme-1',
  suggested_action: 'Review competitive position',
  reason: 'because',
  ...overrides,
});

/* ------------------------------------------------ the group, not the card */

test('outlets with the same issue and SKU become one signal', () => {
  const { signals } = buildSignals(
    [opp({ outlet_id: 'out-e1' }), opp({ outlet_id: 'out-e2' }), opp({ outlet_id: 'out-e3' })],
    { now: NOW },
  );
  assert.equal(signals.length, 1);
  assert.equal(signals[0].outlet_count, 3);
});

test('the count a signal claims is the number of outlets it can list', () => {
  const { signals } = buildSignals([opp({ outlet_id: 'out-e1' }), opp({ outlet_id: 'out-e2' })], {
    now: NOW,
  });
  // The defect this replaces: a card about one outlet captioned with a group's count.
  assert.equal(signals[0].outlet_count, signals[0].opportunities.length);
});

test('a different issue on the same SKU is a different signal', () => {
  const { signals } = buildSignals(
    [
      opp({ outlet_id: 'out-e1' }),
      opp({ outlet_id: 'out-e2' }),
      opp({ outlet_id: 'out-e3', category: 'Persistent Deviation' }),
      opp({ outlet_id: 'out-e4', category: 'Persistent Deviation' }),
    ],
    { now: NOW },
  );
  assert.equal(signals.length, 2);
  assert.deepEqual(signals.map((s) => s.category).sort(), ['Competitive Risk', 'Persistent Deviation']);
});

test('at national scope territories are a property of the group, not three copies of it', () => {
  const members = [
    opp({ outlet_id: 'out-e1', territory_id: 'ter-east', territory_name: 'East' }),
    opp({ outlet_id: 'out-n1', territory_id: 'ter-north', territory_name: 'North' }),
    opp({ outlet_id: 'out-w1', territory_id: 'ter-west', territory_name: 'West' }),
  ];
  const national = buildSignals(members, { now: NOW, scopeBy: 'selection' });
  assert.equal(national.signals.length, 1, 'one story, not three near-identical rows');
  assert.equal(national.signals[0].outlet_count, 3);
  assert.match(national.signals[0].territory_name, /3 territories/);

  const scoped = buildSignals(members, { now: NOW, scopeBy: 'territory' });
  assert.equal(scoped.signals.length, 3, 'inside a selected territory the group is that territory');
});

test('at most three signals are shown', () => {
  const many = ['a', 'b', 'c', 'd', 'e'].flatMap((sku) => [
    opp({ jti_sku_id: sku, jti_sku_name: sku, outlet_id: `${sku}-1` }),
    opp({ jti_sku_id: sku, jti_sku_name: sku, outlet_id: `${sku}-2` }),
  ]);
  assert.equal(buildSignals(many, { now: NOW }).signals.length, 3);
});

/* ------------------------------------------- materiality, not filler */

test('a single non-strategic outlet is not a signal', () => {
  const { signals, suppressed } = buildSignals([opp({ is_strategic: false })], { now: NOW });
  assert.equal(signals.length, 0);
  assert.match(suppressed[0].suppressed_because, /only 1 outlet/);
});

test('a single outlet on a Strategic SKU is', () => {
  const { signals } = buildSignals([opp({ is_strategic: true })], { now: NOW });
  assert.equal(signals.length, 1);
});

test('stale evidence is a prompt to re-observe, not a priority', () => {
  const old = new Date(new Date(NOW).getTime() - 40 * 86400000).toISOString();
  const { signals, suppressed } = buildSignals(
    [opp({ outlet_id: 'out-1', last_detected_at: old }), opp({ outlet_id: 'out-2', last_detected_at: old })],
    { now: NOW },
  );
  assert.equal(signals.length, 0);
  assert.match(suppressed[0].suppressed_because, /40 days old/);
});

test('the age used is the freshest evidence, not the oldest', () => {
  const old = new Date(new Date(NOW).getTime() - 40 * 86400000).toISOString();
  const { signals } = buildSignals(
    [opp({ outlet_id: 'out-1', last_detected_at: old }), opp({ outlet_id: 'out-2', last_detected_at: NOW })],
    { now: NOW },
  );
  assert.equal(signals.length, 1);
  assert.equal(signals[0].evidence_age_days, 0);
});

test('nothing material says so rather than promoting the next-largest number', () => {
  const { signals, suppressed } = buildSignals([opp({ is_strategic: false })], { now: NOW });
  assert.equal(signals.length, 0);
  assert.ok(suppressed.length, 'the near-misses are kept so the absence can be explained');
  assert.match(NO_SIGNAL_NOTE, /not filled with the next-largest/);
});

test('the thresholds a reader is shown are the thresholds applied', () => {
  const loose = buildSignals([opp({ is_strategic: false })], {
    now: NOW,
    thresholds: { ...SIGNAL_THRESHOLDS, min_outlets: 1 },
  });
  assert.equal(loose.signals.length, 1);
});

/* --------------------------------------------------- case lifecycle */

test('an opportunity with a recorded field action is not labelled New', () => {
  const all = enrichObservations(data, config, NOW);
  const opportunities = deriveOpportunities(
    all,
    { fieldActions: data.field_actions, states: {} },
    config,
    NOW,
  );
  const engaged = opportunities.filter((o) => o.status === 'Engaged' || o.status === 'Follow-up overdue');
  assert.ok(engaged.length, 'the seeded fixture records field engagement');
  for (const o of engaged) assert.ok(o.next_step, 'an engaged case names its last action');
});

test('a promised follow-up date that has passed is called overdue', () => {
  const all = enrichObservations(data, config, NOW);
  const opportunities = deriveOpportunities(
    all,
    { fieldActions: data.field_actions, states: {} },
    config,
    NOW,
  );
  for (const o of opportunities.filter((x) => x.overdue)) {
    assert.equal(o.status, 'Follow-up overdue');
    assert.ok(new Date(o.due_date) < new Date(NOW));
  }
});

test('a status somebody set by hand wins over the inferred one', () => {
  const all = enrichObservations(data, config, NOW);
  const first = deriveOpportunities(all, { fieldActions: data.field_actions }, config, NOW)[0];
  const withState = deriveOpportunities(
    all,
    { fieldActions: data.field_actions, states: { [first.id]: { status: 'Monitoring' } } },
    config,
    NOW,
  ).find((o) => o.id === first.id);

  assert.equal(withState.status, 'Monitoring');
  assert.equal(withState.status_set_by_hand, true);
});

test('the analytics bundle exposes signals grouped for the overview', () => {
  const analytics = buildAnalytics(data, {}, config, NOW);
  assert.ok(analytics.signals.signals.length <= 3);
  for (const signal of analytics.signals.signals) {
    assert.equal(signal.outlet_count, signal.opportunities.length);
    assert.ok(signal.evidence_age_days !== null);
  }
});
