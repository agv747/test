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

const browser = await chromium.launch({ executablePath: CHROMIUM, args: process.env.CHROMIUM_ARGS ? JSON.parse(process.env.CHROMIUM_ARGS) : [] });
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

  // Baseline, read before the field flow starts so that reading it never navigates away
  // from the wizard: the whole history, and what the outlet's own page last saw.
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.selectOption('[data-action="switch-user"]', 'usr-mgr-1');
  await wait(450);
  const beforeVisit = await outletHeader(page);
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

  // What is about to read the photo, said BEFORE anything is processed. Simulated and
  // model-read detections are indistinguishable once they reach the results screen.
  check((await page.locator('[data-recognition-mode]').count()) === 1, 'the recognition mode is named before processing');
  const modeBefore = await page.locator('[data-recognition-mode]').innerText();
  check(/Demo recognition — simulated/.test(modeBefore), 'the simulator is named as simulated');
  check(/agreed demo content/.test(modeBefore), 'a built-in sample says it returns agreed demo content');
  check(
    (await page.getAttribute('[data-recognition-mode]', 'data-recognition-mode')) === 'fixture',
    'the built-in sample is flagged as fixture content',
  );

  await page.click('[data-action="process"]');
  await wait(250);
  check((await page.locator('.processing__step').count()) > 0, 'staged processing feedback is shown');
  await shot('04-processing');
  await wait(1800);

  const detections = await page.locator('.detection').count();
  check(detections >= 4, `recognition returned ${detections} detections`);

  // The defect the fixture exists for: the Punggol sample used to come back with Winston Red
  // but not Pall Mall Red, its own primary mapping, so the comparison screen was blank.
  const resultsText = await page.locator('.field-app').innerText();
  check(/Winston Red/.test(resultsText), 'the sample contains its strategic SKU');
  check(/Pall Mall Red/.test(resultsText), 'and the competitor it is mapped to');
  check(/14\.20/.test(resultsText) && /13\.50/.test(resultsText), 'at the agreed demo prices');
  check(/Demo recognition — simulated/.test(resultsText), 'the results still say what read the photo');
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

  // The shelf opens first: it is the shape the TME is standing in front of.
  check((await page.locator('.schematic').count()) === 1, 'the shelf schematic is the default view');
  check(
    (await page.locator('.schematic').innerText()).includes('Review Required'),
    'a detection needing review is visible on the shelf, not only in the list',
  );

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

  // Plain packs are told apart by their price ticket, so the shelf shows the colour read.
  const swatches = await page.locator('.ticket .swatch').count();
  check(swatches > 0, `price ticket colours are drawn on the shelf (${swatches})`);
  check(
    (await page.locator('.ticket .swatch').first().getAttribute('title')).includes('price ticket'),
    'a ticket colour is named, not shown as colour alone',
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

  // A price is not a price until you know what it buys: every figure carries its pack.
  check(/SGD \/ pack of 20/.test(dialogText), 'the price says which pack it is for');
  check(/not compared/.test(dialogText), 'and that pack configurations are not mixed');

  // Two timestamps, kept apart: when the shelf was seen, and when the reading arrived.
  check(/Observed at \(shelf\)/.test(dialogText), 'the dialog dates the shelf');
  check(/Recorded at \(upload\)/.test(dialogText), 'and separately dates the upload');

  // A TME who looks at the shelf and finds the model right must have something to press that
  // is not "type the same number back in" — that files a verification as a correction.
  check(
    (await page.locator('.modal [data-action="confirm-draft"]').count()) === 1,
    'a reading can be confirmed without being changed',
  );
  await page.locator('.modal [data-action="confirm-draft"]').click();
  await wait(350);
  const confirmedText = await page.locator('.modal').innerText();
  check(/Confirmed as read/.test(confirmedText), 'confirming is recorded on the reading');
  check(!/\bcorrected\b/.test(confirmedText), 'and is not filed as a correction');

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
  await page.click('[data-action="set-results-view"][data-view="schematic"]');
  await wait(300);

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
          { raw_text: 'MEVIUS Original $18.30', brand_candidate: 'Mevius', sku_candidate: 'sku-jti-mevius-original', price_candidate: 18.3, confidence: 0.95, bounding_box: null, alternatives: [], detected_is_jti: true, shelf: 1, facings: 3, ticket_colour: 'red' },
          { raw_text: 'MEVIUS Sky Blue $18.30', brand_candidate: 'Mevius', sku_candidate: 'sku-jti-mevius-sky', price_candidate: 18.3, confidence: 0.94, bounding_box: null, alternatives: [], detected_is_jti: true, shelf: 1, facings: 2, ticket_colour: 'dark blue' },
          { raw_text: 'CAMEL Blue $16.00', brand_candidate: 'Camel', sku_candidate: 'sku-jti-camel-blue', price_candidate: 16, confidence: 0.93, bounding_box: null, alternatives: [], detected_is_jti: true, shelf: 2, facings: 3, ticket_colour: 'orange' },
          { raw_text: 'PALL MALL Red $16.00', brand_candidate: 'Pall Mall', sku_candidate: 'sku-bat-pallmall-red', price_candidate: 16, confidence: 0.91, bounding_box: null, alternatives: [], detected_is_jti: false, shelf: 2, facings: 2, ticket_colour: 'green' },
          // The reported failure, reproduced: same SKU twice on one shelf, different tickets.
          { raw_text: 'MEVIUS $18.30', brand_candidate: 'Mevius', sku_candidate: 'sku-jti-mevius-original', price_candidate: 18.3, confidence: 0.44, bounding_box: null, detected_is_jti: true, shelf: 1, facings: 2, ticket_colour: 'blue',
            alternatives: [{ sku_id: 'sku-jti-mevius-sky', label: 'Mevius Sky Blue', confidence: 0.55 }] },
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

  check((await page.locator('.detection').count()) === 5, 'the model answer became five detections');
  await page.click('[data-action="set-results-view"][data-view="schematic"]');
  await wait(400);

  const drawnPacks = await page.locator('.pack').count();
  check(drawnPacks === 12, `a row of packs is drawn per facing count, not one per product (${drawnPacks} of 12)`);

  // Two facings read as the same product but carrying different price tickets — the failure
  // a TME would otherwise never notice, because the answer looks entirely reasonable.
  check((await page.locator('.block--conflict').count()) === 2, 'the merged variant is flagged on both facings');
  check(
    (await page.locator('.block__flag').first().innerText()).includes('check variant'),
    'and says what to check',
  );

  // Both facings carry the flag; the second is the one the model could not read, and the
  // one carrying its alternative.
  await page.locator('.block--conflict').last().click();
  await wait(400);
  const conflictDialog = await page.locator('.modal').innerText();
  check(/Check variant/.test(conflictDialog), 'the dialog repeats the warning');
  check(/different price tickets/.test(conflictDialog), 'and explains why');
  check(/Mevius Sky Blue/.test(conflictDialog), "and offers the model's own second guess");
  check(/55%/.test(conflictDialog), 'with its probability on it');
  await shot('05e-variant-conflict');

  // One tap applies the alternative, and the shelf behind the dialog follows.
  await page.locator('.modal [data-action="use-alternative"]').first().click();
  await wait(450);
  check(
    (await page.locator('.block--conflict').count()) === 0,
    'applying the alternative resolves the conflict',
  );
  await page.keyboard.press('Escape');
  await wait(350);
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
  check(sheetLinks.length === 14, `every manager destination is listed (${sheetLinks.length})`);
  for (const route of ['manager/field-effectiveness', 'manager/territories', 'admin/price-rules', 'admin/image-review', 'admin/master-data', 'admin/ai']) {
    check(sheetLinks.includes(route), `${route} is reachable on a phone`);
  }
  check((await page.locator('.more-nav__section').count()) === 3, 'the sheet keeps the sidebar grouping');
  await shot('13-mobile-more-nav');

  await page.click('.more-nav__link[data-nav="admin/image-review"]');
  await wait(500);
  check(/Image Review/.test(await page.locator('.topbar__title h1').textContent()), 'a sheet link navigates');
  check((await page.locator('.more-nav').count()) === 0, 'the sheet closes once a destination is chosen');

  /* ------------------------------------------ a second vendor: Gemini */
  //
  // Gemini is a separate account, a separate key and a separate set of failure shapes. What
  // matters at this level is that choosing it changes what the field screen SAYS is reading
  // the photo — an audience cannot tell a simulated shelf from a real one by the numbers.
  console.log('\nGemini as the active model (414×896)');

  await page.goto(`${BASE}#/admin/master-data`, { waitUntil: 'load' });
  await wait(500);
  await page.click('[data-action="tab"][data-tab="recognition"]');
  await wait(400);

  const geminiCard = page.locator('[data-action="pick-model"][data-model="gemini:gemini-3.8-flash"]');
  check((await geminiCard.count()) === 1, 'Gemini is offered in Admin');
  const geminiText = await geminiCard.innerText();
  check(/GEMINI_API_KEY/.test(geminiText), 'and names the Worker secret it needs');
  // Without a key configured the card must say so — against ITS key, not another vendor's.
  check(
    /GEMINI_API_KEY not configured|Your own Google key/.test(geminiText),
    'and reports on its own key rather than OpenAI\u2019s',
  );

  await geminiCard.click();
  await wait(400);

  await page.goto(`${BASE}#/field/check`, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await wait(700);
  await page.fill('#outlet-search', 'SG-E-1042');
  await wait();
  await page.locator('.outlet-card').first().click();
  await wait();
  await page.setInputFiles('#gallery-input', ['public/demo-images/shelf-punggol-central.jpg']);
  await wait(700);

  const geminiMode = await page.locator('[data-recognition-mode]').innerText();
  check(/Real recognition — Google Gemini/.test(geminiMode), 'the field screen names Gemini before processing');
  // The card does contain the word "simulated" — in the promise NOT to fall back to it — so
  // the mode is read from the attribute rather than from the prose.
  check(
    (await page.getAttribute('[data-recognition-mode]', 'data-recognition-mode')) === 'real',
    'and flags the mode as real rather than demo content',
  );
  check(
    /rather than falling back/.test(geminiMode),
    'and says a failure stops the visit rather than substituting invented prices',
  );

  await page.click('[data-action="process"]');
  await wait(2200);
  check((await page.locator('.detection').count()) === 5, 'the Gemini answer reaches the same detection shape');
  check(
    !(await page.locator('.field-app').innerText()).includes('Demo recognition'),
    'and the results are not labelled as demo content',
  );
  await shot('17-gemini-active');

  /* --------------------------------------------- manager routes (desktop) */
  console.log('\nManager and admin routes (1440×950)');
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.selectOption('[data-action="switch-user"]', 'usr-mgr-1');
  await wait(500);

  // The Control Tower now shows the CURRENT picture — one eligible observation per outlet,
  // SKU and pack — so a fresh visit to an outlet already in it supersedes rather than adds,
  // and a growing total would mean the repeat-visit weighting is back. The outlet's own page
  // reads the full history, which is where a new visit must show up.
  const afterVisit = await outletHeader(page);
  check(afterVisit !== beforeVisit, 'submitted visit reached manager analytics');
  check(/shelf-punggol-central\.jpg/.test(afterVisit), 'the outlet page names the image just submitted');

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

  /* ------------------------------------------------ GM Overview (§E) */
  //
  // The acceptance test in the brief is physical: at 1366×768 the message, the metrics and the
  // priorities must be visible without scrolling through a large filter form.
  console.log('\nGM Overview (1366×768)');
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(`${BASE}/#/manager/overview`, { waitUntil: 'load' });
  await wait(800);

  check(/GM Overview/.test(await page.locator('.topbar__title h1').textContent()), 'GM Overview has its own route');
  const scopeText = await page.locator('[data-gm-scope]').innerText();
  check(/Singapore/.test(scopeText), 'the scope line names the market');
  check(/pack of 20/.test(scopeText), 'and the price unit');
  check(/As of /.test(scopeText), 'and the as-of time');
  check(/Demo data/i.test(scopeText), 'and marks the data as synthetic');

  // A destructive presentation control must not sit beside the numbers a manager is reading.
  const topbar = await page.locator('.topbar').innerText();
  check(!/Reset demo/i.test(topbar), 'the reset control is not in the business view');
  check(/Demo data/i.test(topbar), 'but the top bar still says the dataset is synthetic');

  const metrics = await page.locator('[data-gm-metrics] .kpi').count();
  check(metrics <= 4, `at most four primary metrics (${metrics})`);
  const metricText = await page.locator('[data-gm-metrics]').innerText();
  check(/\d+ of \d+|of \d+ outlets? in scope/.test(metricText), 'every metric carries an interpretable denominator');

  const signalCount = await page.locator('[data-gm-signals] .signal').count();
  check(signalCount <= 3, `at most three signals (${signalCount})`);
  const signalText = await page.locator('[data-gm-signals]').innerText();
  check(/Owner:/.test(signalText), 'each signal names an owner');
  check(/Next step:/.test(signalText), 'and a next step');
  check(/Evidence \d+ day|Observed today/.test(signalText), 'and how old the evidence is');
  check(/\d+ outlets?/.test(signalText), 'and how many outlets it covers');

  // The headline is the group; the outlets live inside it. A single outlet card must never be
  // captioned with the group's count.
  check((await page.locator('.signal__outlets').count()) === 0, 'outlets are not listed until asked for');
  await page.locator('.signal__head').first().click();
  await wait(400);
  check((await page.locator('.signal__outlets').count()) === 1, 'a signal opens its outlet list');
  const listedOutlets = await page.locator('.signal__outlets tbody tr').count();
  const claimed = Number(
    (await page.locator('.signal').first().innerText()).match(/(\d+) outlets?/)[1],
  );
  check(
    listedOutlets === claimed,
    `the outlet count is the outlets listed (${listedOutlets} listed, ${claimed} claimed)`,
  );

  // Nothing that matters may sit below the fold on a laptop screen. Measured with the drill-down
  // closed, which is how the page opens: an expanded outlet table is the reader's own choice.
  await page.locator('.signal__head').first().click();
  await wait(400);
  check((await page.locator('.signal__outlets').count()) === 0, 'the outlet list closes again');

  const fold = await page.evaluate(() => {
    const box = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
    return {
      viewport: window.innerHeight,
      metricsBottom: box('[data-gm-metrics]')?.bottom ?? null,
      firstSignalBottom: document.querySelector('.signal')?.getBoundingClientRect().bottom ?? null,
      filterForms: document.querySelectorAll('.filters').length,
    };
  });
  check(fold.metricsBottom !== null && fold.metricsBottom <= fold.viewport,
    `the metrics are above the fold (${Math.round(fold.metricsBottom)} of ${fold.viewport}px)`);
  check(fold.firstSignalBottom !== null && fold.firstSignalBottom <= fold.viewport,
    `the top priority is above the fold (${Math.round(fold.firstSignalBottom)} of ${fold.viewport}px)`);
  check(fold.filterForms === 0, 'no large filter form stands between the reader and the message');
  await shot('16-gm-overview');

  await page.setViewportSize({ width: 1440, height: 950 });
  await wait(200);

  /* ------------------------- which picture, and whose denominator */

  await page.goto(`${BASE}/#/manager/tower`, { waitUntil: 'load' });
  await wait(700);
  check((await page.locator('[data-snapshot-mode]').count()) === 1, 'the Control Tower says which picture it is showing');
  const snapText = await page.locator('[data-snapshot-mode]').innerText();
  check(/Current picture/.test(snapText), 'and opens on the current picture');
  check(/As of /.test(snapText), 'and dates it');
  check(/freshness window \d+ days/.test(snapText), 'and states the freshness window');
  check(/Held out|Nothing was held out/.test(snapText), 'and says what it held out');

  // Four coverage questions, each printing the denominator it is a share of. The old single
  // figure reported 25% for a territory whose every outlet had been visited.
  const coverageCards = await page.locator('[data-coverage-metric]').count();
  check(coverageCards === 4, `coverage is reported as four questions, not one (${coverageCards})`);
  const coverageText = await page.locator('[data-coverage]').innerText();
  check(/\d+ of \d+/.test(coverageText), 'every coverage figure shows its numerator and denominator');
  // The card labels are upper-cased by the stylesheet, so match without regard to case.
  check(/Outlet visit coverage/i.test(coverageText), 'outlet visit coverage is its own metric');
  check(/Comparable-pair availability/i.test(coverageText), 'so is comparable-pair availability');

  // A pair is two readings of the same shelf, close enough in time. A median of other outlets
  // in the territory used to be substituted silently and fed straight into the verdict, so an
  // outlet nobody had read a competitor price in still produced an index and an alignment.
  await page.locator('.matrix-cell').first().click();
  await wait(600);
  const drilldown = await page.locator('.table-wrap').last().innerText();
  check(/Comparable pair/i.test(drilldown), 'the drill-down says whether a real pair exists');
  check(
    /read in the same visit|read in the same outlet|median of/.test(drilldown),
    'and on what basis the competitor price was paired',
  );
  await page.click('[data-action="close-drilldown"]');
  await wait(400);

  // Filtering to one territory must ask about that territory's own completeness.
  const networkDenominator = Number(coverageText.match(/(\d+) of (\d+)/)[2]);
  await page.selectOption('[data-filter="territory_id"]', 'ter-east');
  await wait(700);
  const eastText = await page.locator('[data-coverage]').innerText();
  const eastDenominator = Number(eastText.match(/(\d+) of (\d+)/)[2]);
  check(
    eastDenominator < networkDenominator,
    `a territory's coverage counts that territory's outlets (${eastDenominator} of a network ${networkDenominator})`,
  );
  await page.click('[data-action="clear-filters"]');
  await wait(600);

  // Historical mode returns every reading, and says so.
  await page.click('[data-action="set-snapshot-mode"][data-mode="historical"]');
  await wait(700);
  const histText = await page.locator('[data-snapshot-mode]').innerText();
  check(/Full history/.test(histText), 'the mode can be switched to the full history');
  check(/not as a picture of the shelves today/.test(histText), 'and says what it must not be read as');
  const histTotal = await page.locator('.card__sub', { hasText: 'JTI observations' }).first().innerText();
  await page.click('[data-action="set-snapshot-mode"][data-mode="current"]');
  await wait(700);
  const currentTotal = await page.locator('.card__sub', { hasText: 'JTI observations' }).first().innerText();
  check(
    Number.parseInt(histTotal, 10) > Number.parseInt(currentTotal, 10),
    `the current picture is narrower than the record (${currentTotal.split(' ')[0]} vs ${histTotal.split(' ')[0]})`,
  );
  await shot('14-snapshot-and-coverage');

  await page.goto(`${BASE}/#/manager/field-effectiveness`, { waitUntil: 'load' });
  await wait(500);
  const fxText = await page.locator('.content').innerText();
  check(/Observed sequence after engagement/i.test(fxText), 'field effectiveness uses observed-sequence wording');

  // The 80% headline was four price changes out of five — one of them a price that moved
  // further from where it was meant to be. Outcomes are now classified, not counted.
  check((await page.locator('[data-outcomes]').count()) === 1, 'outcomes are classified, not counted');
  const outcomeText = await page.locator('[data-outcomes]').innerText();
  for (const outcome of ['Position improved', 'Position unchanged', 'Position worsened']) {
    check(new RegExp(outcome, 'i').test(outcomeText), `${outcome} is reported separately`);
  }
  check(/\d+ of \d+ engagements with a later observation/.test(outcomeText), 'each outcome prints its denominator');
  check(/not a success rate/.test(outcomeText), 'any observed price change is not presented as a success rate');
  check(/awaiting one/.test(outcomeText), 'engagements with nothing observed since are counted');
  check(
    (await page.locator('[data-awaiting]').count()) === 1,
    'and are listed rather than dropped from the denominator',
  );
  await shot('15-field-outcomes');
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

/**
 * The Punggol outlet page's header: last visit, and the image that visit carried.
 *
 * The Control Tower now shows the CURRENT picture — one eligible observation per outlet, SKU
 * and pack — so a fresh visit to an outlet already in it supersedes rather than adds, and its
 * total is deliberately unchanged. The outlet's own page reads the full history, which is
 * where a newly submitted visit has to appear.
 */
async function outletHeader(p) {
  await p.goto(`${BASE}/#/outlet?id=out-e1`, { waitUntil: 'load' });
  await p.evaluate(() => new Promise((r) => setTimeout(r, 700)));
  return p.locator('.grid--kpi').first().innerText();
}
