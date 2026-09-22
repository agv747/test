import test from 'node:test';
import assert from 'node:assert/strict';
import { demoNavigation, simplifyDemoMarkup } from '../public/app/execution/demo-ui.js';
import { buildDemoCatalogue, upgradeDemoCatalogue } from '../public/app/execution/catalogue.js';
import { buildTaiwanDemo } from '../public/app/execution/demo.js';

test('demo navigation exposes four destinations and marks the current one', () => {
  const html = demoNavigation('tw/planograms/detail');
  assert.equal((html.match(/href=/g) || []).length, 4);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  assert.match(html, /href="#\/tw\/planograms" aria-current/);
});
test('secondary filters are collapsed until an active filter must be visible', () => {
  const page = '<div class="rei-filters"><label>Territory</label></div><p>Results</p>';
  assert.match(simplifyDemoMarkup(page, 'tw/overview'), /<details class="demo-disclosure">/);
  assert.match(simplifyDemoMarkup(page, 'tw/overview', {territory:'West'}), /demo-disclosure" open/);
  assert.equal(simplifyDemoMarkup(page, 'admin/ai'), page);
});
test('synthetic catalogue contains 15 unique records without real product claims', () => {
  const records = buildDemoCatalogue();
  assert.equal(records.length, 15);
  assert.equal(new Set(records.map(s => s.id)).size, 15);
  assert.ok(records.every(s => s.synthetic && !s.market_verified && s.gtin === null));
});
test('catalogue upgrade preserves evidence and custom records and is demo-only', () => {
  const w = buildTaiwanDemo(), before = JSON.stringify([w.plans,w.assessments]);
  w.catalogue = w.catalogue.slice(0,5);
  w.catalogue.push({id:'custom',name:'User record'});
  upgradeDemoCatalogue(w); upgradeDemoCatalogue(w);
  assert.equal(w.catalogue.length,16);
  assert.equal(w.catalogue[5].name,'User record');
  assert.equal(JSON.stringify([w.plans,w.assessments]),before);
  const shared={demo:false,catalogue:[]};
  upgradeDemoCatalogue(shared);
  assert.equal(shared.catalogue.length,0);
});
