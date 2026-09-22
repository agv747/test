import { blankWorkspace, emptyReview, resolveReference, applyCommand, slotKey } from './domain.js';
export const DEMO_TIME = '2026-09-22T04:00:00.000Z';
export const DEMO_ACTOR = { id: 'tw-manager', name: 'Demo reviewer', role: 'admin', markets: ['SG', 'TW'] };
export const COLORS = { 'TW-A': '#39746b', 'TW-B': '#446a98', 'TW-C': '#b0894f', 'TW-D': '#8a6594', 'TW-E': '#b76961' };
export function cellBox(row, column, rows = 2, columns = 10) {
  return [0.04 + (column - 1) * .92 / columns, .1 + (row - 1) * .84 / rows, .86 / columns, .76 / rows];
}
export function demoSlots(fixtureId) {
  return Array.from({ length: 20 }, (_, i) => {
    const row = Math.floor(i / 10) + 1, column = i % 10 + 1;
    let sku = `TW-${'ABCDE'[Math.floor((column - 1) / 2)]}`, state = 'product';
    if (fixtureId === 'F2' && row === 1 && column === 1) sku = 'TW-B';
    if (fixtureId === 'F2' && row === 1 && column === 3) sku = 'TW-A';
    if (fixtureId === 'F2' && row === 2 && column >= 7) { sku = null; state = 'unknown'; }
    if (fixtureId === 'F3' && i === 0) { sku = null; state = 'empty'; }
    return { key: slotKey(row, column), row, column, sku, state };
  });
}
export function buildTaiwanDemo() {
  let w = { ...blankWorkspace(), demo: true, asOf: DEMO_TIME };
  let n = 0; const options = { now: '2026-09-21T04:30:00.000Z', id: () => `demo-${++n}` };
  w.catalogue = [...'ABCDE'].map(letter => ({ id: `TW-${letter}`, code: `TW-${letter}`, name: `Sample ${letter} · synthetic pack`, market: 'TW', artworks: letter === 'A' ? ['TW-A-artwork-1', 'TW-A-artwork-2'] : [`TW-${letter}-artwork-1`] }));
  w.fixtures = [1, 2, 3, 4, 5].map((n) => ({ id: `F${n}`, name: `Cabinet F${n}`, outletId: `tw-outlet-${n}`, outletName: ['Zhongshan · Sample 01', 'Xinyi · Sample 02', 'Da’an · Sample 03', 'Songshan · Sample 04', 'Wanhua · Sample 05'][n - 1], territory: n <= 3 ? 'Taipei Central' : 'Taipei West', ownerId: n <= 3 ? 'tw-field-1' : 'tw-field-2', type: 'regular_cabinet', rows: 2, columns: 10, active: true }));
  const plan = { id: 'tw-plan-v1', lineageId: 'tw-plan', market: 'TW', code: 'TW-DEMO-CABINET', version: 1, revision: 1, status: 'published', fixtureType: 'regular_cabinet', rows: 2, columns: 10, validFrom: '2026-08-23T04:00:00.000Z', validTo: null, changeNote: 'Synthetic regular cabinet for workflow demonstration.', updatedAt: '2026-08-23T04:00:00.000Z', updatedBy: 'tw-manager', sourceName: 'Prepared demonstration reference', slots: demoSlots('F1').map(s => ({ key: s.key, row: s.row, column: s.column, active: true, allowedSkuIds: [s.sku], preferredSkuId: s.sku, critical: true })), requiredSkuIds: w.catalogue.map(s => s.id), facingRules: w.catalogue.map(s => ({ skuId: s.id, min: 4, max: 4 })) };
  w.plans = [plan]; w.assignments = w.fixtures.slice(0, 4).map(f => ({ id: `assignment-${f.id}`, fixtureId: f.id, planId: plan.id, validFrom: plan.validFrom, validTo: null }));
  for (const fixtureId of ['F1', 'F2', 'F3', 'F5']) {
    const cap = { id: `capture-${fixtureId}`, fixtureId, outletId: w.fixtures.find(f => f.id === fixtureId).outletId, capturedAt: '2026-09-21T04:00:00.000Z', createdAt: '2026-09-21T04:00:00.000Z', createdBy: 'tw-field-1', mode: 'prepared_demo', source: 'prepared_demo', revision: 1, reference: resolveReference(w, fixtureId, '2026-09-21T04:00:00.000Z'), images: [{ id: `image-${fixtureId}`, name: `Synthetic ${fixtureId} cabinet`, url: `/demo/tw/${fixtureId === 'F5' ? 'F1' : fixtureId}.svg`, width: 1200, height: 440, range: 'Overview', synthetic: true }], reviews: [] };
    w.captures.push(cap);
    if (fixtureId === 'F5') continue;
    const slots = demoSlots(fixtureId).map(s => ({ key: s.key, state: s.state, confirmedSkuId: s.sku, unknownReason: s.state === 'unknown' ? 'obscured' : null, primaryEvidence: { imageId: `image-${fixtureId}`, bbox: cellBox(s.row, s.column) }, supportingEvidence: [] }));
    const saved = applyCommand(w, { type: 'review.save', payload: { captureId: cap.id, expectedRevision: 1, slots } }, DEMO_ACTOR, options); w = saved.workspace;
    w = applyCommand(w, { type: 'assessment.submit', payload: { captureId: cap.id, expectedRevision: 2, reviewId: saved.result.id, incompleteReason: fixtureId === 'F2' ? 'Four slots are obscured in the supplied overview.' : null, idempotencyKey: `seed-submit-${fixtureId}` } }, DEMO_ACTOR, options).workspace;
  }
  w.captures.push({ id: 'capture-F2-followup', fixtureId: 'F2', outletId: 'tw-outlet-2', capturedAt: DEMO_TIME, createdAt: DEMO_TIME, createdBy: 'tw-field-1', mode: 'prepared_demo', source: 'prepared_demo', revision: 1, reference: resolveReference(w, 'F2', DEMO_TIME), images: [{ id: 'image-F2-followup', name: 'Synthetic later evidence', url: '/demo/tw/F1.svg', width: 1200, height: 440, range: 'Overview', synthetic: true }], reviews: [] });
  return w;
}
export function preparedProposal(capture) {
  return emptyReview(capture.reference.plan).map(s => {
    const match = demoSlots(capture.id === 'capture-F2-followup' ? 'F1' : capture.fixtureId).find(x => x.key === s.key);
    return { ...s, state: match?.state ?? 'unknown', confirmedSkuId: match?.sku ?? null, primaryEvidence: match ? { imageId: capture.images[0]?.id, bbox: cellBox(match.row, match.column) } : null, proposed: true };
  });
}

/** Code-rendered, deliberately schematic evidence; never presented as a shop photo. */
export function cabinetSvg(fixtureId) {
  const packs = demoSlots(fixtureId).map(s => {
    const [x, y, w, h] = cellBox(s.row, s.column).map((n, i) => n * (i % 2 ? 440 : 1200));
    const color = COLORS[s.sku] ?? '#d4d9dd';
    return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${s.state === 'empty' ? '#e7eceb' : color}" stroke="${s.state === 'empty' ? '#8f9997' : '#ffffff'}" stroke-width="2" ${s.state === 'empty' ? 'stroke-dasharray="7 5"' : ''}/><text x="${x + w / 2}" y="${y + h * .47}" text-anchor="middle" fill="${s.sku ? '#ffffff' : '#53616b'}" font-family="Arial,sans-serif" font-size="${s.state === 'unknown' ? 13 : 22}" font-weight="700">${s.sku ?? (s.state === 'empty' ? 'EMPTY' : 'OBSCURED')}</text><text x="${x + w / 2}" y="${y + h * .75}" text-anchor="middle" fill="${s.sku ? '#ffffff' : '#53616b'}" font-family="Arial,sans-serif" font-size="12">${s.key}</text></g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 440" width="1200" height="440"><rect width="1200" height="440" rx="12" fill="#eef2f1"/><text x="48" y="27" fill="#405653" font-family="Arial,sans-serif" font-size="15" font-weight="700">SYNTHETIC CABINET · WORKFLOW EXAMPLE · ${fixtureId}</text>${packs}<text x="48" y="430" fill="#5f6f6c" font-family="Arial,sans-serif" font-size="12">One visible facing per physical slot. This is a schematic, not a retail photograph.</text></svg>`;
}
