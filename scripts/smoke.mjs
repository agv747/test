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

  /* ---------------------------------------------------- shelf schematic */

  check((await page.locator('.schematic').count()) === 0, 'the working list is the default view');
  await page.click('[data-action="set-results-view"][data-view="schematic"]');
  await wait(400);

  const blocks = await page.locator('.block').count();
  check(blocks === detections, `every detection has a place on the shelf (${blocks})`);
  check((await page.locator('.rail').count()) >= 1, 'products are arranged on shelves');
  check(
    (await page.locator('.pack').count()) > blocks,
    'products with several facings are drawn as several packs',
  );

  const firstBlock = await page.locator('.block').first().innerText();
  check(/\d+\.\d\d/.test(firstBlock), 'a product shows the price on its ticket');
  check(/\d+%/.test(firstBlock), 'a product shows the recognition percentage');
  check(/JTI|Comp\./.test(firstBlock), 'a product says whose SKU it is');

  const railHeads = await page.locator('.rail__head').allInnerTexts();
  check(railHeads.every((h) => /SGD \d+\.\d\d/.test(h)), 'every rail is labelled with its price');
  check(railHeads.some((h) => /facing/.test(h)), 'every shelf says how many facings sit on it');

  // A shelf head must account for every price standing on it: one price, or the range.
  const railPrices = await page.locator('.rail').evaluateAll((rails) =>
    rails.map((r) => ({
      head: r.querySelector('.rail__price').textContent.trim(),
      tickets: [...r.querySelectorAll('.ticket__price')].map((t) => t.textContent.trim()),
    })),
  );
  check(
    railPrices.every(({ head, tickets }) => {
      const sorted = [...new Set(tickets)].sort((a, b) => Number(a) - Number(b));
      return head.includes(sorted[0]) && head.includes(sorted.at(-1));
    }),
    `every shelf head accounts for the prices on it (${JSON.stringify(railPrices)})`,
  );

  const note = await page.locator('.schematic p').first().innerText();
  check(/The shelf as read/.test(note), 'the schematic says what it is');
  check(
    (await page.locator('.schematic').innerText()).includes('generated these prices from the catalogue'),
    'the schematic says the simulator never read this photo',
  );
  await shot('05b-shelf-schematic');

  // A product on the shelf opens the correction form over the shelf, not below it.
  const productDraft = await page.locator('.block').first().getAttribute('data-draft');
  check((await page.locator('[data-modal]').count()) === 0, 'no dialog is open until a product is tapped');
  await page.locator('.block').first().click();
  await wait(400);

  check((await page.locator('[data-modal]').count()) === 1, 'tapping a product opens a dialog');
  const dialogText = await page.locator('.modal').innerText();
  check(/Confirmed price/i.test(dialogText), 'the dialog carries the correction form');
  check(/Detected price \(original\)/i.test(dialogText), 'and the detail the list card shows');
  check(
    (await page.locator('.modal select[data-edit="sku"]').getAttribute('data-draft')) === productDraft,
    'the dialog is editing the product that was tapped',
  );

  // Centred over the page, not appended under the shelf.
  const centred = await page.locator('.modal').evaluate((el) => {
    const box = el.getBoundingClientRect();
    return {
      inViewport: box.top >= 0 && box.bottom <= window.innerHeight,
      offCentre: Math.abs((box.top + box.bottom) / 2 - window.innerHeight / 2),
    };
  });
  check(centred.inViewport, 'the dialog is on screen without scrolling');
  check(centred.offCentre < 40, `the dialog is centred (${Math.round(centred.offCentre)}px off)`);
  await shot('05d-schematic-editor');

  // Correcting from the dialog changes the shelf behind it, and the dialog stays open.
  await page.fill('.modal input[data-edit="price"]', '19.95');
  await page.dispatchEvent('.modal input[data-edit="price"]', 'change');
  await wait(400);
  check((await page.locator('[data-modal]').count()) === 1, 'the dialog stays open after a correction');
  check(
    (await page.locator(`.block[data-draft="${productDraft}"] .ticket__price`).innerText()).includes('19.95'),
    'the corrected price shows on the shelf behind the dialog',
  );

  await page.keyboard.press('Escape');
  await wait(350);
  check((await page.locator('[data-modal]').count()) === 0, 'Escape closes the dialog');

  await page.locator('.block').first().click();
  await wait(350);
  await page.locator('[data-modal]').click({ position: { x: 5, y: 5 } });
  await wait(350);
  check((await page.locator('[data-modal]').count()) === 0, 'clicking away from the dialog closes it');

  await page.click('[data-action="set-results-view"][data-view="list"]');
  await wait(300);
  check((await page.locator('.schematic').count()) === 0, 'the schematic can be switched back off');

  /* ------------------------------- a vision model's answer, drawn as a shelf */
  //
  // The live model call cannot run from here (the egress proxy answers 403 to CONNECT for
  // api.openai.com), so /api/recognise is answered with what gpt-4o returns for a cabinet
  // photo. Everything after that hop is the real client: provider, draft builder, schematic.
  console.log('\nVision-model answer drawn as a shelf (414×896)');

  await page.route('**/api/recognise', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        model: 'openai:gpt-4o',
        detections: [
          { raw_text: 'MEVIUS Original $18.30', brand_candidate: 'Mevius', sku_candidate: 'sku-jti-mevius-original', price_candidate: 18.3, confidence: 0.95, bounding_box: null, alternatives: [], detected_is_jti: true, shelf: 1, facings: 3 },
          { raw_text: 'MEVIUS Sky Blue $18.30', brand_candidate: 'Mevius', sku_candidate: 'sku-jti-mevius-sky', price_candidate: 18.3, confidence: 0.94, bounding_box: null, alternatives: [], detected_is_jti: true, shelf: 1, facings: 2 },
          { raw_text: 'CAMEL Blue $16.00', brand_candidate: 'Camel', sku_candidate: 'sku-jti-camel-blue', price_candidate: 16, confidence: 0.93, bounding_box: null, alternatives: [], detected_is_jti: true, shelf: 2, facings: 3 },
          { raw_text: 'PALL MALL Red $16.00', brand_candidate: 'Pall Mall', sku_candidate: 'sku-bat-pallmall-red', price_candidate: 16, confidence: 0.91, bounding_box: null, alternatives: [], detected_is_jti: false, shelf: 2, facings: 2 },
        ],
        unmatched: 0,
        duration_ms: 1200,
        raw_response: '{"detections":[…]}',
      }),
    }),
  );

  // Switch the active provider to a vision model, the way an operator would.
  await page.goto(`${BASE}#/admin/master-data`, { waitUntil: 'load' });
  await wait(500);
  await page.click('[data-action="tab"][data-tab="recognition"]');
  await wait(400);
  await page.click('[data-action="pick-model"][data-model="openai:gpt-4o"]');
  await wait(400);

  // A reload clears the wizard, which is module state: a hash change alone would land on
  // the results step of the visit just finished. The chosen model is in localStorage and
  // survives, which is the point of the reload.
  await page.goto(`${BASE}#/field/check`, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await wait(700);
  await page.fill('#outlet-search', 'SG-E-1042');
  await wait();
  await page.locator('.outlet-card').first().click();
  await wait();
  await page.setInputFiles('#gallery-input', ['public/demo-images/shelf-punggol-central.jpg']);
  await wait(700);
  await page.click('[data-action="process"]');
  await wait(2200);

  check((await page.locator('.detection').count()) === 4, 'the model answer became four detections');
  await page.click('[data-action="set-results-view"][data-view="schematic"]');
  await wait(400);

  const drawnPacks = await page.locator('.pack').count();
  check(drawnPacks === 10, `a row of packs is drawn per facing count, not one per product (${drawnPacks} of 10)`);
  const shelves = await page.locator('.rail__name').allInnerTexts();
  check(shelves.length === 2, `the two shelves the model counted became two shelves (${shelves.join(', ')})`);

  const blockCounts = await page.locator('.block').evaluateAll((blocks) =>
    blocks.map((b) => [Number(b.dataset.facings), b.querySelectorAll('.pack').length]),
  );
  check(
    blockCounts.every(([counted, drawn]) => counted === drawn),
    `each product draws exactly the packs it was counted for (${JSON.stringify(blockCounts)})`,
  );
  check(
    (await page.locator('.schematic').innerText()).includes('the model counted them on'),
    'the schematic says the shelves were counted, not guessed',
  );
  check(
    !(await page.locator('.schematic').innerText()).includes('generated these prices'),
    'a real model is not described as the simulator',
  );
  await shot('05c-vision-model-shelf');

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

  /* ------------------------------------------ manager navigation on a phone */
  console.log('\nManager navigation (414×896)');
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.selectOption('[data-action="switch-user"]', 'usr-mgr-1');
  await wait(500);
  await page.setViewportSize({ width: 414, height: 896 });
  await wait(400);

  check((await page.locator('.sidebar:visible').count()) === 0, 'the desktop sidebar is hidden on a phone');
  const barLinks = await page.locator('.mobile-nav [data-nav]').evaluateAll((e) => e.map((x) => x.dataset.nav));
  check(barLinks.length >= 3, `the bottom bar holds ${barLinks.length} destinations`);
  check(
    (await page.locator('.mobile-nav [data-action="toggle-more-nav"]').count()) === 1,
    'the destinations the bar cannot hold are reachable through More',
  );

  await page.click('[data-action="toggle-more-nav"]');
  await wait(350);
  const sheetLinks = await page.locator('.more-nav__link').evaluateAll((e) => e.map((x) => x.dataset.nav));
  check(sheetLinks.length === 12, `every manager destination is listed (${sheetLinks.length})`);
  for (const route of ['manager/field-effectiveness', 'manager/territories', 'admin/price-rules', 'admin/image-review', 'admin/master-data']) {
    check(sheetLinks.includes(route), `${route} is reachable on a phone`);
  }
  check((await page.locator('.more-nav__section').count()) === 3, 'the sheet keeps the sidebar grouping');
  await shot('13-mobile-more-nav');

  await page.click('.more-nav__link[data-nav="admin/image-review"]');
  await wait(500);
  check(/Image Review/.test(await page.locator('.topbar__title h1').textContent()), 'a sheet link navigates');
  check((await page.locator('.more-nav').count()) === 0, 'the sheet closes once a destination is chosen');

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
