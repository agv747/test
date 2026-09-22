import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
const port = 8798, base = process.env.SMOKE_BASE ?? `http://127.0.0.1:${port}`;
const server = process.env.SMOKE_BASE ? null : spawn(process.execPath, ['scripts/static-server.js', String(port), 'public'], { stdio: 'ignore' });
let browser;
const errors = [];
try {
  browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: process.env.CHROMIUM_ARGS ? JSON.parse(process.env.CHROMIUM_ARGS) : [] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.goto(`${base}/#/tw/overview`); await page.locator('.rei-kpis').waitFor();
  assert.match(await page.locator('.rei-kpis').innerText(), /2 of 4 assigned fixtures/);
  assert.match(await page.locator('.rei-kpis').innerText(), /3 open slot issues/);
  await page.locator('[data-action="tw-open-fixture"][data-fixture-id="F2"]').click();
  await page.locator('.rei-assessment-bar').waitFor();
  assert.match(await page.locator('.rei-assessment-bar').innerText(), /87.5%/);
  assert.match(await page.locator('.rei-assessment-bar').innerText(), /80%/);
  if (process.env.SHOTS) { await mkdir('.smoke-screenshots', { recursive: true }); await page.screenshot({ path: '.smoke-screenshots/tw-audit-desktop.png', fullPage: true }); }
  await page.locator('[data-action="tw-audit-issues"]').click();
  await page.locator('[data-action="tw-issue-open"]').first().click();
  await page.locator('[name="action"]').selectOption('assign'); await page.locator('[name="note"]').fill('Inspect the two swapped slots on the next authorized visit.');
  await page.locator('[data-form="tw-issue-event"] button[type="submit"]').click();
  await page.getByText('Issue event recorded with its evidence history.').waitFor();
  await page.goto(`${base}/#/tw/audits/detail?id=capture-F2-followup`); await page.locator('[data-action="tw-prepared"]').click();
  await page.locator('[data-action="tw-confirm-visible"]').click();
  await page.locator('[data-action="tw-submit-audit"]').click();
  await page.getByText('Audit submitted. Slot issues are updated; closures still require verification.').waitFor();
  await page.locator('[data-action="tw-audit-issues"]').click();
  for (let i = 0; i < 2; i++) {
    await page.locator('[data-action="tw-issue-open"]').nth(i).click();
    await page.locator('[name="action"]').selectOption('verify'); await page.locator('[name="assessmentId"]').selectOption({ index: 1 });
    await page.locator('[name="note"]').fill('Verified against the later confirmed image of this cabinet.');
    await page.locator('[data-form="tw-issue-event"] button[type="submit"]').click();
    await page.getByText('Issue event recorded with its evidence history.').waitFor();
  }
  assert.equal(await page.locator('tbody .rei-badge').filter({ hasText: 'closed verified' }).count(), 2);
  await page.goto(`${base}/#/tw/overview`); await page.locator('.rei-kpis').waitFor();
  assert.match(await page.locator('.rei-kpis').innerText(), /3 of 4 assigned fixtures/);
  assert.match(await page.locator('.rei-kpis').innerText(), /1 open slot issues/);
  await page.reload(); await page.locator('.rei-kpis').waitFor(); assert.match(await page.locator('.rei-kpis').innerText(), /1 open slot issues/);
  console.log('PASS: overview → F2 → assign issue → later capture → review → submit → verify two issues → reload.');
  await page.goto(`${base}/#/tw/planograms`); await page.locator('[data-action="tw-plan-open"]').first().click();
  assert.equal(await page.locator('[data-plan-field="code"]').isDisabled(), true);
  await page.locator('[data-action="tw-plan-duplicate"]').click(); await page.locator('[data-action="tw-plan-save"]').waitFor();
  await page.locator('[data-plan-field="code"]').fill('TW-REVIEW-DRAFT'); await page.locator('[data-action="tw-plan-save"]').click(); await page.getByText('Draft saved.').waitFor();
  console.log('PASS: published plan is immutable; duplicate draft saves.');
  await page.goto(`${base}/#/admin/ai`); await page.locator('[data-form="ai-signin"]').waitFor();
  for (const tab of ['connections', 'models', 'routing', 'compare']) { await page.locator(`[data-action="ai-tab"][data-tab="${tab}"]`).click(); assert.equal(await page.locator('.rei-provider-cards .card').count(), 4); }
  console.log('PASS: all four providers are shown as not configured without sign-in.');
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${base}/#/tw/overview`); await page.locator('.rei-kpis').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  if (process.env.SHOTS) await page.screenshot({ path: '.smoke-screenshots/tw-overview-mobile.png', fullPage: true });
  await page.goto(`${base}/#/tw/audits/detail?id=capture-F2`); await page.locator('.rei-mobile-tabs').waitFor();
  for (const tab of ['expected', 'photo', 'differences']) { await page.locator(`[data-action="tw-audit-tab"][data-tab="${tab}"]`).click(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true); }
  if (process.env.SHOTS) await page.screenshot({ path: '.smoke-screenshots/tw-audit-mobile.png', fullPage: true });
  console.log('PASS: mobile overview and Expected / Photo / Differences tabs have no page overflow.');
  await page.locator('[data-action="switch-market"]').selectOption('SG'); await page.locator('[data-action="switch-user"]').waitFor();
  assert.match(await page.locator('.sidebar__brand').innerText(), /Singapore/i);
  console.log('PASS: Singapore navigation remains available.');
  assert.deepEqual(errors, []); console.log('Taiwan smoke passed with no page exceptions.');
} finally { await browser?.close(); server?.kill(); }
