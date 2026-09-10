import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findOverlappingRules,
  resolveEffectivePriceRule,
  ruleScopeLabel,
  ruleSpecificity,
  snapshotPriceRule,
} from '../public/app/services/priceRuleService.js';

const base = {
  market: 'SG',
  sku_id: 'sku-1',
  recommended_price: 13.7,
  recommended_min: 13.5,
  recommended_max: 13.9,
  effective_from: '2026-01-01T00:00:00.000Z',
  effective_to: null,
  priority: 0,
  active: true,
};

const rules = [
  { ...base, id: 'market' },
  { ...base, id: 'territory', territory_id: 'ter-east', recommended_price: 13.9 },
  { ...base, id: 'channel', channel_id: 'ch-chain', recommended_price: 13.8 },
  {
    ...base,
    id: 'territory-channel',
    territory_id: 'ter-east',
    channel_id: 'ch-chain',
    recommended_price: 14.0,
  },
  { ...base, id: 'outlet', outlet_id: 'out-1', recommended_price: 14.2 },
];

const ctx = {
  sku_id: 'sku-1',
  market: 'SG',
  territory_id: 'ter-east',
  channel_id: 'ch-chain',
  outlet_id: 'out-1',
};
const at = '2026-06-01T00:00:00.000Z';

test('specificity ordering: outlet > territory+channel > territory > channel > market', () => {
  assert.ok(ruleSpecificity(rules[4]) > ruleSpecificity(rules[3]));
  assert.ok(ruleSpecificity(rules[3]) > ruleSpecificity(rules[1]));
  assert.ok(ruleSpecificity(rules[1]) > ruleSpecificity(rules[2]));
  assert.ok(ruleSpecificity(rules[2]) > ruleSpecificity(rules[0]));
  assert.equal(ruleScopeLabel(rules[3]), 'Territory + Channel');
});

test('outlet-specific rule wins when everything matches', () => {
  assert.equal(resolveEffectivePriceRule(rules, ctx, at).id, 'outlet');
});

test('falls back down the specificity chain as scope stops matching', () => {
  const noOutlet = rules.filter((r) => r.id !== 'outlet');
  assert.equal(resolveEffectivePriceRule(noOutlet, ctx, at).id, 'territory-channel');

  const otherChannel = { ...ctx, channel_id: 'ch-indep' };
  assert.equal(resolveEffectivePriceRule(noOutlet, otherChannel, at).id, 'territory');

  const otherTerritory = { ...ctx, territory_id: 'ter-west' };
  assert.equal(resolveEffectivePriceRule(noOutlet, otherTerritory, at).id, 'channel');

  const neither = { ...ctx, territory_id: 'ter-west', channel_id: 'ch-indep' };
  assert.equal(resolveEffectivePriceRule(noOutlet, neither, at).id, 'market');
});

test('rules outside their effective window are ignored (historical integrity)', () => {
  const superseded = { ...base, id: 'old', recommended_price: 13.5, effective_to: '2026-03-01T00:00:00.000Z' };
  const current = { ...base, id: 'new', effective_from: '2026-03-02T00:00:00.000Z' };
  const set = [superseded, current];

  assert.equal(resolveEffectivePriceRule(set, ctx, '2026-02-01T00:00:00.000Z').id, 'old');
  assert.equal(resolveEffectivePriceRule(set, ctx, '2026-06-01T00:00:00.000Z').id, 'new');
});

test('future-dated rules do not apply to past observations', () => {
  const future = { ...base, id: 'future', effective_from: '2027-01-01T00:00:00.000Z', priority: 99 };
  assert.equal(resolveEffectivePriceRule([rules[0], future], ctx, at).id, 'market');
});

test('inactive rules are never resolved', () => {
  const inactive = [{ ...rules[4], active: false }, rules[0]];
  assert.equal(resolveEffectivePriceRule(inactive, ctx, at).id, 'market');
});

test('returns null when no rule exists for the SKU', () => {
  assert.equal(resolveEffectivePriceRule(rules, { ...ctx, sku_id: 'sku-unknown' }, at), null);
});

test('priority breaks ties at equal specificity', () => {
  const a = { ...base, id: 'a', priority: 1 };
  const b = { ...base, id: 'b', priority: 5 };
  assert.equal(resolveEffectivePriceRule([a, b], ctx, at).id, 'b');
});

test('snapshotPriceRule captures thresholds and handles a missing rule', () => {
  assert.deepEqual(snapshotPriceRule(rules[0]), {
    price_rule_id: 'market',
    recommended_price_snapshot: 13.7,
    recommended_min_snapshot: 13.5,
    recommended_max_snapshot: 13.9,
  });
  assert.equal(snapshotPriceRule(null).price_rule_id, null);
});

test('overlap validation flags ambiguous same-scope rules only', () => {
  const conflicting = [
    { ...base, id: 'x' },
    { ...base, id: 'y' },
  ];
  assert.equal(findOverlappingRules(conflicting).length, 1);

  const differentPriority = [{ ...base, id: 'x' }, { ...base, id: 'y', priority: 3 }];
  assert.equal(findOverlappingRules(differentPriority).length, 0);

  const differentScope = [{ ...base, id: 'x' }, { ...base, id: 'y', territory_id: 'ter-east' }];
  assert.equal(findOverlappingRules(differentScope).length, 0);

  const nonOverlappingDates = [
    { ...base, id: 'x', effective_to: '2026-03-01T00:00:00.000Z' },
    { ...base, id: 'y', effective_from: '2026-03-02T00:00:00.000Z' },
  ];
  assert.equal(findOverlappingRules(nonOverlappingDates).length, 0);
});
