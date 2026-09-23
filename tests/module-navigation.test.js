import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULES, selectedModule, moduleForPath, moduleHome } from '../public/app/module-navigation.js';
test('two country-neutral modules are available', () => {
  assert.deepEqual(Object.values(MODULES).map(m => m.label), ['Price Validation','Planogram Check']);
});
test('legacy sessions migrate without coupling module selection to market', () => {
  assert.equal(selectedModule({market:'TW'}), 'planogram');
  assert.equal(selectedModule({market:'SG',module:'planogram'}), 'planogram');
  assert.equal(selectedModule({market:'TW',module:'price'}), 'price');
  assert.equal(selectedModule({module:'invalid'}), 'price');
});
test('legacy links and shared settings retain the correct module', () => {
  assert.equal(moduleForPath('tw/overview',{module:'price'}),'planogram');
  assert.equal(moduleForPath('admin/ai',{module:'planogram'}),'planogram');
  assert.equal(moduleForPath('manager/overview',{module:'planogram'}),'price');
  assert.equal(moduleHome('price','field'),'field/home');
  assert.equal(moduleHome('price','manager'),'manager/overview');
  assert.equal(moduleHome('planogram','field'),'tw/overview');
});
