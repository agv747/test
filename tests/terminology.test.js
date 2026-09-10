/**
 * §3 — mandatory terminology guard.
 *
 * Scans every user-facing source file for compliance framing. This is an acceptance
 * criterion, not a style preference: the product must never imply that an outlet has
 * committed an offence because its retail price sits outside a JTI recommended range.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const APP_DIR = new URL('../public/app/', import.meta.url).pathname;
const ROOT_FILES = [new URL('../public/index.html', import.meta.url).pathname];

/** Words that must not appear in user-facing product language. */
const BANNED = [
  { pattern: /\bcompliance\b/i, term: 'compliance' },
  { pattern: /\bcompliant\b/i, term: 'compliant' },
  { pattern: /\bnon-?compliance\b/i, term: 'non-compliance' },
  { pattern: /\bviolations?\b/i, term: 'violation' },
  { pattern: /\billegal\b/i, term: 'illegal' },
  { pattern: /\bcorrective action\b/i, term: 'corrective action' },
  { pattern: /\btarget price\b/i, term: 'target price' },
  { pattern: /\bcorrect price\b/i, term: 'correct price' },
  { pattern: /\bcompliance rate\b/i, term: 'compliance rate' },
];

/**
 * The guard targets text that reaches a user, so two kinds of line are skipped:
 *
 *  1. Comment lines — documentation frequently has to NAME a banned term in order to
 *     forbid it ("this module never classifies an outlet as non-compliant"). Comments
 *     are never rendered, and banning the words there would push that reasoning out of
 *     the code, which is the opposite of what §3 wants.
 *  2. Lines that explicitly negate the term in user-facing copy ("not a violation"),
 *     which is exactly the framing the spec asks the product to state.
 */
function isPermitted(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return true;
  return /not a violation/i.test(line);
}

async function collectFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectFiles(path)));
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

test('no compliance framing appears in application source', async () => {
  const files = [...(await collectFiles(APP_DIR)), ...ROOT_FILES];
  assert.ok(files.length > 20, 'the scan actually found the source tree');

  const offences = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (isPermitted(line)) return;
      for (const { pattern, term } of BANNED) {
        if (pattern.test(line)) {
          offences.push(`${file.replace(APP_DIR, '')}:${i + 1} — "${term}" in: ${line.trim().slice(0, 110)}`);
        }
      }
    });
  }
  assert.deepEqual(offences, [], `Banned terminology found:\n${offences.join('\n')}`);
});

test('the approved commercial statuses are the ones the app uses', async () => {
  const { PRICE_POSITION_STATUS } = await import('../public/app/config.js');
  const allowed = [
    'Within Recommended Range',
    'Below Recommended Range',
    'Above Recommended Range',
    'Competitive Position At Risk',
    'Strong Competitive Position',
    'Review Required',
    'No Recommendation Available',
  ];
  assert.deepEqual(Object.values(PRICE_POSITION_STATUS).sort(), allowed.slice().sort());
});

test('the market-context note states that outlets set their own price', async () => {
  const { MARKET_CONTEXT_NOTE } = await import('../public/app/ui/dom.js');
  assert.match(MARKET_CONTEXT_NOTE, /independently determine their final selling price/i);
  assert.match(MARKET_CONTEXT_NOTE, /does not enforce/i);
});

test('field recommendations never name a trade-investment amount', async () => {
  const { FIELD_RECOMMENDATIONS } = await import('../public/app/config.js');
  for (const value of Object.values(FIELD_RECOMMENDATIONS)) {
    assert.doesNotMatch(value, /\d/, `"${value}" must not contain a number`);
    assert.doesNotMatch(value, /approve|SGD|\$/i);
  }
});

test('opportunity categories use commercial language', async () => {
  const { OPPORTUNITY_CATEGORIES, OPPORTUNITY_STATUSES } = await import('../public/app/config.js');
  for (const value of [...Object.values(OPPORTUNITY_CATEGORIES), ...OPPORTUNITY_STATUSES]) {
    assert.doesNotMatch(value, /violation|non-compliant|illegal/i);
  }
});
