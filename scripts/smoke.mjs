#!/usr/bin/env node
/**
 * End-to-end browser smoke test.
 *
 * Boots the static server, drives a real Chromium through the full field workflow and
 * every manager/admin route, and fails on any console error, page error or empty page.
 *
 * Usage:
 *   npm run smoke              # headless
 *   SHOTS=1 npm run smoke      # also writes screenshots to ./.smoke-screenshots
 *
 * Requires Playwright: `npm install --no-save playwright`
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

/**
 * By default the suite boots its own static server, which exercises the local-seed
 * fallback. Point SMOKE_BASE at a running `wrangler dev` (or a deployment) to run the same
 * checks against the real Worker and its database instead.
 */
const EXTERNAL_BASE = process.env.SMOKE_BASE ?? null;
const PORT = Number(process.env.PORT ?? 8799);
const BASE = EXTERNAL_BASE ?? `http://127.0.0.1:${PORT}`;
const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const SHOTS = process.env.SHOTS === '1';
const SHOT_DIR = '.smoke-screenshots';

const errors = [];
const fail = (msg) => errors.push(msg);
const check = (ok, msg) => (ok ? console.log(`  ✓ ${msg}`) : fail(msg));

const server = EXTERNAL_BASE
  ? null
  : spawn(process.execPath, ['scripts/static-server.js', String(PORT), 'public'], { stdio: 'ignore' });
process.on('exit', () => server?.kill());
await new Promise((r) => setTimeout(r, 900));
console.log(`Target: ${BASE}${EXTERNAL_BASE ? ' (external)' : ' (bundled static server)'}`);
if (SHOTS) await mkdir(SHOT_DIR, { recursive: true });

/** Row counts before the run, when the target actually has a database behind it. */
const dbBaseline = await readDbCounts();
console.log(
  dbBaseline
    ? `Database: reachable (${dbBaseline.price_observations} observations)`
    : 'Database: not reachable — exercising the local-seed fallback',
);

async function readDbCounts() {
  try {
    const response = await fetch(`${BASE}/api/health`);
    if (!response.ok) return null;
    const body = await response.json();
    return body?.counts ?? null;
  } catch {
    return null;
  }
}

/** Writes are sent in the background, so poll briefly rather than assuming instant arrival. */
async function waitForDbGrowth(from, attempts = 12) {
  for (let i = 0; i < attempts; i += 1) {
    const counts = await readDbCounts();
    if (counts && counts.price_observations > from) return counts.price_observations;
    await new Promise((r) => setTimeout(r, 500));
  }
  return (await readDbCounts())?.price_observations ?? from;
}

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage({ viewport: { width: 414, height: 896 } });
page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') fail(`console error: ${m.text()}`);
});

const wait = (ms = 350) => page.evaluate((t) => new Promise((r) => setTimeout(r, t)), ms);
const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true }) : Promise.resolve());

try {
  /* ------------------------------------------------ field workflow (mobile) */
  console.log('\nField workflow (414×896)');
  await page.goto(BASE, { waitUntil: 'load' });
  await wait(450);
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE, { waitUntil: 'load' });
  await wait(450);

  // Baseline observation count, read before the field flow starts so that reading it
  // never navigates away from the wizard.
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.selectOption('[data-action="switch-user"]', 'usr-mgr-1');
  await wait(450);
  const before = await observationCount(page);
  await page.goto(BASE, { waitUntil: 'load' });
  await wait(400);
  await page.selectOption('[data-action="switch-user"]', 'usr-tme-1');
  await wait(450);
  await page.setViewportSize({ width: 414, height: 896 });
  await wait(200);

  check((await page.locator('.topbar__title h1').textContent()).includes('TME'), 'field home renders');
  await shot('01-field-home');

  await page.locator('[data-nav="field/check"]:visible').first().click();
  await wait();
  await page.fill('#outlet-search', 'Punggol');
  await wait();
  check((await page.locator('.outlet-card').count()) > 0, 'outlet search by name returns results');
  await page.fill('#outlet-search', 'SG-E-1042');
  await wait();
  check((await page.locator('.outlet-card').count()) === 1, 'outlet search by outlet ID returns results');
  await shot('02-outlet-select');
  await page.locator('.outlet-card').first().click();
  await wait();

  check((await page.getAttribute('#gallery-input', 'capture')) === null, 'gallery picker does not force the camera');
  check((await page.getAttribute('#camera-input', 'capture')) === 'environment', 'camera button opens the device camera');
  check(/heic/i.test(await page.getAttribute('#gallery-input', 'accept')), 'gallery picker accepts HEIC');
  check(await page.getAttribute('#gallery-input', 'multiple') !== null, 'gallery picker accepts multiple images');

  await page.setInputFiles('#gallery-input', ['public/demo-images/shelf-punggol-central.jpg']);
  await wait(600);
  check((await page.locator('.thumb').count()) === 1, 'image preview appears after gallery selection');
  check((await page.locator('.thumb__meta').first().textContent()).length > 0, 'image quality status is shown before processing');
  await shot('03-acquire');

  await page.setInputFiles('#gallery-input', ['public/demo-images/shelf-yishun-mini-mart.jpg']);
  await wait(500);
  check((await page.locator('.thumb').count()) === 2, 'multiple images can be added to one visit');
  await page.locator('.thumb__remove').last().click();
  await wait(250);
  check((await page.locator('.thumb').count()) === 1, 'an image can be removed');

  await page.click('[data-action="process"]');
  await wait(250);
  check((await page.locator('.processing__step').count()) > 0, 'staged processing feedback is shown');
  await shot('04-processing');
  await wait(1800);

  const detections = await page.locator('.detection').count();
  check(detections >= 4, `recognition returned ${detections} detections`);
  const pills = await page.locator('.detection .pill').evaluateAll((els) => els.map((e) => e.textContent.trim()));
  check(pills.some((p) => /Review Required/.test(p)), 'low-confidence detection is flagged Review Required');
  check(pills.some((p) => /Competitive Position At Risk|Recommended Range/.test(p)), 'price position statuses are shown');
  check((await page.locator('.confbar').count()) > 0, 'recognition confidence is visible');
  const confText = await page.locator('.conf').first().innerText();
  check(/Recognition/.test(confText), 'the confidence percentage says what it measures');
  check(/read clearly|read with doubt|needs confirming/.test(confText), 'confidence is readable without colour');
  check((await page.locator('.decision__value').textContent()).length > 0, 'immediate field recommendation is shown');
  await shot('05-results');

  /* ------------------------------------------------- shelf overlay (AR view) */

  check((await page.locator('.ar').count()) === 0, 'the working list is the default view');
  await page.click('[data-action="set-results-view"][data-view="overlay"]');
  await wait(400);
  check((await page.locator('.ar__img').count()) === 1, 'the captured photo is shown in the overlay');
  const markers = await page.locator('.ar__box').count();
  check(markers >= 4, `${markers} detections are marked on the photo`);
  const firstMarker = await page.locator('.ar__box').first().innerText();
  check(/\d+\.\d\d/.test(firstMarker), 'a marker shows the price');
  check(/\d+%/.test(firstMarker), 'a marker shows the recognition percentage');
  const legend = await page.locator('.ar__legend').innerText();
  check(/read both the product name and the price/.test(legend), 'the overlay explains the percentage');
  check(
    /Simulated positions|Approximate positions|Positions reported by/.test(legend),
    'the overlay states where the rectangles came from',
  );
  await shot('05b-shelf-overlay');

  // A marker is the way into the correction form for that detection.
  const markerDraft = await page.locator('.ar__box').first().getAttribute('data-draft');
  await page.locator('.ar__box').first().click();
  await wait(400);
  check(
    (await page.locator(`[id="draft-${markerDraft}"] .detection__detail`).count()) === 1,
    'tapping a marker opens that detection for correction',
  );

  // A marker that lands off the pack can be dragged onto it.
  await page.click('[data-action="toggle-overlay-placing"]');
  await wait(350);
  check((await page.locator('.ar--placing').count()) === 1, 'markers can be put into placing mode');
  // Some detections are already open (Review Required expands itself, and a marker was
  // tapped above), so the test is that dragging changes nothing about what is open.
  const openBeforeDrag = await page.locator('.detection__detail').count();
  const target = page.locator('.ar__box').first();
  const markerBefore = await target.boundingBox();
  await page.mouse.move(markerBefore.x + markerBefore.width / 2, markerBefore.y + markerBefore.height / 2);
  await page.mouse.down();
  await page.mouse.move(markerBefore.x + markerBefore.width / 2 + 40, markerBefore.y + markerBefore.height / 2 + 60, { steps: 8 });
  await page.mouse.up();
  await wait(400);
  const markerAfter = await page.locator('.ar__box').first().boundingBox();
  const moved = Math.round(markerAfter.y - markerBefore.y);
  check(moved >= 40, `a marker can be dragged onto the right pack (moved ${moved}px down)`);
  check(
    (await page.locator('.ar__legend').innerText()).includes('placed by hand') ||
      (await page.locator('.ar__box--manual').count()) > 0,
    'a hand-placed marker is recorded as placed by hand',
  );
  check(
    (await page.locator('.detection__detail').count()) === openBeforeDrag,
    'dragging a marker does not also open it for correction',
  );
  await shot('05d-shelf-overlay-placing');
  await page.click('[data-action="toggle-overlay-placing"]');
  await wait(300);

  await page.click('[data-action="toggle-overlay-fullscreen"]');
  await wait(350);
  check((await page.locator('.ar--full').count()) === 1, 'the overlay opens full screen');
  await shot('05c-shelf-overlay-fullscreen');
  await page.click('[data-action="toggle-overlay-fullscreen"]');
  await wait(300);
  check((await page.locator('.ar--full').count()) === 0, 'full screen can be left again');

  await page.click('[data-action="set-results-view"][data-view="list"]');
  await wait(300);
  check((await page.locator('.ar').count()) === 0, 'the overlay can be switched back off');

  await page.locator('.detection__head').first().click();
  await wait(250);
  const detail = await page.locator('.detection__detail').first().innerText();
  check(/Recommended range/i.test(detail), 'recommended range is shown on the detection');
  check(/Price Index/i.test(detail), 'Price Index is shown on the detection');
  check(/Detected price \(original\)/i.test(detail), 'original detected value is preserved and displayed');

  await page.locator('.detection input[data-edit="price"]').first().fill('15.20');
  await page.locator('.detection input[data-edit="price"]').first().dispatchEvent('change');
  await wait(350);
  check((await page.locator('.detection .tag', { hasText: 'corrected' }).count()) > 0, 'manual correction is flagged');
  await shot('06-correction');

  await page.click('[data-action="to-action"]');
  await wait();
  await page.selectOption('#action-type', 'Discussed with outlet');
  await page.fill('#action-notes', 'Shared observed competitive position.');
  await page.dispatchEvent('#action-notes', 'input');
  await wait(200);
  await shot('07-field-action');

  await page.click('[data-action="to-summary"]');
  await wait();
  check((await page.locator('.summary-grid dd').count()) >= 8, 'visit summary shows all counters');
  await shot('08-summary');

  await page.click('[data-action="submit-visit"]');
  await wait(700);
  check((await page.locator('.disclaimer', { hasText: 'Visit submitted' }).count()) > 0, 'submission is confirmed');
  await shot('09-outlet-after-submit');

  // The point of the database layer: the visit must exist outside this browser. Checking the
  // in-page count would pass just as happily on memory-only state, so ask the API directly
  // and then re-read it in a browser context that has never seen this session's storage.
  if (dbBaseline) {
    const after = await waitForDbGrowth(dbBaseline.price_observations);
    check(
      after > dbBaseline.price_observations,
      `visit persisted to the database (${dbBaseline.price_observations} → ${after} observations)`,
    );

    const fresh = await browser.newContext();
    const freshPage = await fresh.newPage();
    await freshPage.goto(`${BASE}/#/manager/tower`, { waitUntil: 'load' });
    await freshPage.evaluate(() => new Promise((r) => setTimeout(r, 1200)));
    const indicator = await freshPage.locator('.topbar .pill').first().textContent();
    check(/Shared database/.test(indicator), 'a new browser reads from the shared database');
    await fresh.close();
  }

  /* --------------------------------------------- manager routes (desktop) */
  console.log('\nManager and admin routes (1440×950)');
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.selectOption('[data-action="switch-user"]', 'usr-mgr-1');
  await wait(500);

  const after = await observationCount(page);
  check(after > before, `submitted visit reached manager analytics (${before} → ${after} observations)`);

  const routes = [
    ['manager/tower', 'Price Control Tower'],
    ['manager/opportunities', 'Pricing Opportunities'],
    ['manager/sku', 'SKU Intelligence'],
    ['manager/architecture', 'Price Architecture'],
    ['manager/competitor-moves', 'Competitor Moves'],
    ['manager/field-effectiveness', 'Field Effectiveness'],
    ['manager/territories', 'Territories'],
    ['manager/outlets', 'Outlets'],
    ['outlet?id=out-e1', 'Punggol Central Minimart'],
    ['admin/price-rules', 'Price Rules'],
    ['admin/competitor-mapping', 'Competitor Mapping'],
    ['admin/image-review', 'Image Review'],
    ['admin/master-data', 'Admin / Master Data'],
  ];
  for (const [hash, expected] of routes) {
    await page.goto(`${BASE}/#/${hash}`, { waitUntil: 'load' });
    await wait(450);
    const h1 = (await page.locator('.topbar__title h1').first().textContent()).trim();
    const size = (await page.locator('.content').innerHTML()).length;
    check(h1 === expected && size > 1000, `${expected} renders (${size} bytes)`);
    await shot(`route-${hash.replace(/[/?=]/g, '-')}`);
  }

  /* ------------------------------------------------------ interactions */
  console.log('\nManager interactions');
  await page.goto(`${BASE}/#/manager/tower`, { waitUntil: 'load' });
  await wait(500);
  check((await page.locator('.matrix-cell').count()) === 9, 'price position matrix has 9 cells');
  await page.locator('.matrix-cell').nth(4).click();
  await wait(350);
  check((await page.locator('[data-action="close-drilldown"]').count()) > 0, 'matrix cell drills down to observations');
  await shot('10-matrix-drilldown');

  await page.selectOption('[data-filter="territory_id"]', 'ter-east');
  await wait(600);
  check((await page.locator('[data-action="clear-filters"]').count()) > 0, 'global filters apply and can be cleared');
  await page.click('[data-action="clear-filters"]');
  await wait(500);

  await page.goto(`${BASE}/#/manager/sku`, { waitUntil: 'load' });
  await wait(600);
  check((await page.locator('svg').count()) >= 3, 'SKU page renders distribution, box plot and trend charts');
  const skuText = await page.locator('.content').innerText();
  check(/P10/.test(skuText) && /P90/.test(skuText) && /Median/.test(skuText), 'percentiles are reported, not just an average');
  await shot('11-sku-intelligence');

  await page.goto(`${BASE}/#/manager/field-effectiveness`, { waitUntil: 'load' });
  await wait(500);
  const fxText = await page.locator('.content').innerText();
  check(/Observed price change after engagement/i.test(fxText), 'field effectiveness uses observed-sequence wording');
  check(/does not attribute/i.test(fxText), 'causal attribution is explicitly disclaimed');
  await shot('12-field-effectiveness');

  await page.goto(`${BASE}/#/admin/price-rules`, { waitUntil: 'load' });
  await wait(450);
  await page.click('[data-action="new-rule"]');
  await wait(300);
  check((await page.locator('#rule-form').count()) > 0, 'price rules can be created');
  await page.click('[data-action="close-modal"]');
  await wait(250);

  // Exports produce a real CSV download rather than throwing.
  await page.goto(`${BASE}/#/manager/opportunities`, { waitUntil: 'load' });
  await wait(600);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.click('[data-action="export"]'),
  ]);
  check(download.suggestedFilename() === 'pricing-opportunities.csv', 'filtered opportunities export to CSV');

  console.log('\n' + (errors.length ? `FAILED — ${errors.length} problem(s):\n  ${errors.join('\n  ')}` : 'PASSED — all smoke checks green'));
} catch (err) {
  fail(`exception: ${err.message}`);
  console.error(err);
} finally {
  await browser.close();
  server?.kill();
}

process.exit(errors.length ? 1 : 0);

/** Reads the observation count the Price Control Tower reports. */
async function observationCount(p) {
  await p.goto(`${BASE}/#/manager/tower`, { waitUntil: 'load' });
  await p.evaluate(() => new Promise((r) => setTimeout(r, 600)));
  const text = await p.locator('.card__sub', { hasText: 'JTI observations' }).first().textContent();
  // "855 JTI observations · 76 without a comparable competitor…" — take the leading count only.
  return Number.parseInt(text.match(/\d+/)[0], 10);
}
