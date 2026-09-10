/** §20 — Price Rules admin: create, edit, duplicate, deactivate, future-date, CSV import/export. */

import { dateLabel, esc, money } from '../lib/format.js';
import { dataTable, disclaimer, sortRows } from './dom.js';
import {
  findOverlappingRules,
  ruleScopeLabel,
} from '../services/priceRuleService.js';
import { downloadCsv, parseCsv, toCsv } from '../lib/csv.js';
import { isEffectiveAt } from '../lib/dates.js';

let sort = { key: 'sku', dir: 'asc' };
let editing = null;
let importReport = null;

export const title = () => 'Price Rules';
export const subtitle = () => 'JTI recommended prices and ranges, resolved by scope and effective date';

const CSV_COLUMNS = [
  'id',
  'market',
  'territory_id',
  'channel_id',
  'outlet_id',
  'sku_id',
  'recommended_price',
  'recommended_min',
  'recommended_max',
  'effective_from',
  'effective_to',
  'priority',
  'active',
  'notes',
];

export function render(ctx) {
  const now = new Date().toISOString();
  const skus = new Map(ctx.data.skus.map((s) => [s.id, s]));
  const territories = new Map(ctx.data.territories.map((t) => [t.id, t]));
  const channels = new Map(ctx.data.channels.map((c) => [c.id, c]));
  const outlets = new Map(ctx.data.outlets.map((o) => [o.id, o]));

  const conflicts = findOverlappingRules(ctx.data.price_rules);
  const conflictIds = new Set(conflicts.flatMap((c) => [c.rule_a, c.rule_b]));

  const rows = ctx.data.price_rules.map((r) => ({
    rule: r,
    id: r.id,
    sku: skus.get(r.sku_id)?.name ?? r.sku_id,
    scope: ruleScopeLabel(r),
    scope_detail: [
      territories.get(r.territory_id)?.name,
      channels.get(r.channel_id)?.name,
      outlets.get(r.outlet_id)?.name,
    ]
      .filter(Boolean)
      .join(' · ') || 'All',
    state: r.active === false ? 'Inactive' : isEffectiveAt(r, now) ? 'Effective' : new Date(r.effective_from) > new Date(now) ? 'Future' : 'Expired',
    conflict: conflictIds.has(r.id),
  }));

  const columns = [
    { key: 'sku', label: 'SKU', render: (r) => esc(r.sku) },
    { key: 'scope', label: 'Scope', render: (r) => `${esc(r.scope)}<br /><span class="xsmall muted">${esc(r.scope_detail)}</span>` },
    { key: 'recommended_price', label: 'Recommended', align: 'right', render: (r) => money(r.rule.recommended_price), sortValue: (r) => r.rule.recommended_price },
    { key: 'min', label: 'Minimum', align: 'right', render: (r) => money(r.rule.recommended_min), sortValue: (r) => r.rule.recommended_min },
    { key: 'max', label: 'Maximum', align: 'right', render: (r) => money(r.rule.recommended_max), sortValue: (r) => r.rule.recommended_max },
    { key: 'effective_from', label: 'Effective from', render: (r) => esc(dateLabel(r.rule.effective_from)), sortValue: (r) => new Date(r.rule.effective_from).getTime() },
    { key: 'effective_to', label: 'Effective to', render: (r) => (r.rule.effective_to ? esc(dateLabel(r.rule.effective_to)) : '<span class="muted">open</span>'), sortValue: (r) => (r.rule.effective_to ? new Date(r.rule.effective_to).getTime() : Infinity) },
    { key: 'priority', label: 'Priority', align: 'right', render: (r) => r.rule.priority ?? 0, sortValue: (r) => r.rule.priority ?? 0 },
    {
      key: 'state',
      label: 'Status',
      render: (r) => {
        const tone = r.state === 'Effective' ? 'good' : r.state === 'Future' ? 'info' : 'none';
        const icon = r.state === 'Effective' ? '✓' : r.state === 'Future' ? '◷' : '–';
        return `<span class="pill pill--${tone}">${icon} ${esc(r.state)}</span>${r.conflict ? ' <span class="pill pill--watch">! Overlap</span>' : ''}`;
      },
    },
    {
      key: 'actions',
      label: '',
      sortable: false,
      render: (r) => `<div class="toolbar">
        <button class="btn btn--sm" data-action="edit-rule" data-id="${esc(r.id)}">Edit</button>
        <button class="btn btn--sm" data-action="duplicate-rule" data-id="${esc(r.id)}">Duplicate</button>
        <button class="btn btn--sm" data-action="toggle-rule" data-id="${esc(r.id)}">${r.rule.active === false ? 'Activate' : 'Deactivate'}</button>
      </div>`,
    },
  ];

  return `
    ${disclaimer('These are <strong>recommended</strong> prices and ranges. Singapore outlets independently determine their final selling price; rules here define the desired position JTI benchmarks against.')}
    ${conflicts.length ? conflictPanel(conflicts) : ''}
    ${importReport ? importPanel() : ''}
    <div class="card">
      <div class="card__head">
        <h2>${rows.length} rule${rows.length === 1 ? '' : 's'}</h2>
        <div class="toolbar">
          <button class="btn btn--primary btn--sm" data-action="new-rule">+ New rule</button>
          <button class="btn btn--sm" data-action="export">⇩ Export CSV</button>
          <button class="btn btn--sm" data-action="import">⇧ Import CSV</button>
          <input type="file" id="rules-import" accept=".csv,text/csv" class="hidden" />
        </div>
      </div>
      <p class="xsmall muted">Resolution order (most specific wins): <strong>Outlet → Territory + Channel → Territory → Channel → Market</strong>. Ties break on priority, then the most recent effective-from date.</p>
      ${dataTable(columns, sortRows(rows, columns, sort.key, sort.dir), { sortKey: sort.key, sortDir: sort.dir })}
    </div>
    ${editing ? editModal(ctx) : ''}`;
}

function conflictPanel(conflicts) {
  return `<div class="card" style="border-color:var(--watch-border);background:var(--watch-bg)">
    <h3>⚠ ${conflicts.length} overlapping rule${conflicts.length === 1 ? '' : 's'} detected</h3>
    <p class="small">These rules target the same SKU and scope with equal priority over overlapping dates, so resolution is ambiguous. Adjust the effective dates or the priority.</p>
    <ul class="small">${conflicts.map((c) => `<li><span class="mono">${esc(c.rule_a)}</span> ↔ <span class="mono">${esc(c.rule_b)}</span> — ${esc(c.reason)}</li>`).join('')}</ul>
  </div>`;
}

function importPanel() {
  const r = importReport;
  return `<div class="card" style="border-color:var(--info-border);background:var(--info-bg)">
    <h3>CSV import result</h3>
    <p class="small">${r.imported} rule${r.imported === 1 ? '' : 's'} imported, ${r.skipped} row${r.skipped === 1 ? '' : 's'} skipped.</p>
    ${r.errors.length ? `<ul class="small">${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
    <button class="btn btn--sm" data-action="dismiss-import">Dismiss</button>
  </div>`;
}

function editModal(ctx) {
  const r = editing;
  const opt = (list, value, labelKey = 'name') =>
    list.map((x) => `<option value="${esc(x.id)}"${x.id === value ? ' selected' : ''}>${esc(x[labelKey])}</option>`).join('');

  return `<div class="modal-backdrop" data-action="close-modal-backdrop"><div class="modal">
    <div class="card__head"><h2>${r.id ? 'Edit' : 'New'} price rule</h2>
      <button class="btn btn--sm" data-action="close-modal">Close</button></div>
    <form id="rule-form">
      <div class="form-grid">
        <div class="field"><label for="r-sku">SKU</label>
          <select id="r-sku" name="sku_id" required>${opt(ctx.data.skus.filter((s) => s.is_jti), r.sku_id)}</select></div>
        <div class="field"><label for="r-market">Market</label>
          <input id="r-market" name="market" value="${esc(r.market ?? 'SG')}" /></div>
        <div class="field"><label for="r-territory">Territory (optional)</label>
          <select id="r-territory" name="territory_id"><option value="">All territories</option>${opt(ctx.data.territories, r.territory_id)}</select></div>
        <div class="field"><label for="r-channel">Channel (optional)</label>
          <select id="r-channel" name="channel_id"><option value="">All channels</option>${opt(ctx.data.channels, r.channel_id)}</select></div>
        <div class="field"><label for="r-outlet">Outlet (optional)</label>
          <select id="r-outlet" name="outlet_id"><option value="">All outlets</option>${opt(ctx.data.outlets, r.outlet_id)}</select></div>
        <div class="field"><label for="r-price">Recommended price</label>
          <input id="r-price" name="recommended_price" type="number" step="0.05" min="0" value="${r.recommended_price ?? ''}" required /></div>
        <div class="field"><label for="r-min">Recommended minimum</label>
          <input id="r-min" name="recommended_min" type="number" step="0.05" min="0" value="${r.recommended_min ?? ''}" required /></div>
        <div class="field"><label for="r-max">Recommended maximum</label>
          <input id="r-max" name="recommended_max" type="number" step="0.05" min="0" value="${r.recommended_max ?? ''}" required /></div>
        <div class="field"><label for="r-from">Effective from</label>
          <input id="r-from" name="effective_from" type="date" value="${esc((r.effective_from ?? '').slice(0, 10))}" required /></div>
        <div class="field"><label for="r-to">Effective to (optional)</label>
          <input id="r-to" name="effective_to" type="date" value="${esc((r.effective_to ?? '').slice(0, 10))}" /></div>
        <div class="field"><label for="r-priority">Priority</label>
          <input id="r-priority" name="priority" type="number" step="1" value="${r.priority ?? 0}" /></div>
        <div class="field"><label for="r-active">Active</label>
          <select id="r-active" name="active"><option value="true"${r.active !== false ? ' selected' : ''}>Active</option><option value="false"${r.active === false ? ' selected' : ''}>Inactive</option></select></div>
      </div>
      <div class="field mt"><label for="r-notes">Notes</label>
        <textarea id="r-notes" name="notes">${esc(r.notes ?? '')}</textarea></div>
      <div class="toolbar mt">
        <button type="submit" class="btn btn--primary">Save rule</button>
        ${r.id ? `<button type="button" class="btn btn--danger" data-action="delete-rule" data-id="${esc(r.id)}">Delete</button>` : ''}
      </div>
    </form>
  </div></div>`;
}

export function onAction(action, el, ctx) {
  switch (action) {
    case 'new-rule':
      editing = {
        market: 'SG',
        sku_id: ctx.data.skus.find((s) => s.is_jti)?.id,
        effective_from: new Date().toISOString().slice(0, 10),
        priority: 0,
        active: true,
      };
      ctx.render();
      break;
    case 'edit-rule':
      editing = { ...ctx.data.price_rules.find((r) => r.id === el.dataset.id) };
      ctx.render();
      break;
    case 'duplicate-rule': {
      const source = ctx.data.price_rules.find((r) => r.id === el.dataset.id);
      editing = { ...source, id: undefined, notes: `${source.notes ?? ''} (copy)`.trim() };
      ctx.render();
      break;
    }
    case 'toggle-rule': {
      const rule = ctx.data.price_rules.find((r) => r.id === el.dataset.id);
      ctx.store.upsertPriceRule({ ...rule, active: rule.active === false });
      ctx.render();
      break;
    }
    case 'delete-rule':
      if (confirm('Delete this rule? Existing observations keep their stored snapshot.')) {
        ctx.store.deletePriceRule(el.dataset.id);
        editing = null;
        ctx.render();
      }
      break;
    case 'close-modal':
    case 'close-modal-backdrop':
      if (action === 'close-modal-backdrop' && el !== document.querySelector('.modal-backdrop')) break;
      editing = null;
      ctx.render();
      break;
    case 'dismiss-import':
      importReport = null;
      ctx.render();
      break;
    case 'export':
      downloadCsv('price-rules.csv', CSV_COLUMNS, ctx.data.price_rules);
      break;
    case 'import':
      document.querySelector('#rules-import')?.click();
      break;
    default:
      break;
  }
}

export function onSubmit(form, ctx) {
  if (form.id !== 'rule-form') return;
  const fd = new FormData(form);
  const rule = {
    id: editing.id,
    market: fd.get('market') || 'SG',
    sku_id: fd.get('sku_id'),
    brand_id: ctx.data.skus.find((s) => s.id === fd.get('sku_id'))?.brand_id ?? null,
    territory_id: fd.get('territory_id') || null,
    channel_id: fd.get('channel_id') || null,
    outlet_id: fd.get('outlet_id') || null,
    recommended_price: Number.parseFloat(fd.get('recommended_price')),
    recommended_min: Number.parseFloat(fd.get('recommended_min')),
    recommended_max: Number.parseFloat(fd.get('recommended_max')),
    effective_from: new Date(`${fd.get('effective_from')}T00:00:00.000Z`).toISOString(),
    effective_to: fd.get('effective_to') ? new Date(`${fd.get('effective_to')}T23:59:59.000Z`).toISOString() : null,
    priority: Number.parseInt(fd.get('priority'), 10) || 0,
    active: fd.get('active') === 'true',
    notes: fd.get('notes') ?? '',
  };
  if (rule.recommended_min > rule.recommended_max) {
    alert('Recommended minimum cannot be greater than the maximum.');
    return;
  }
  ctx.store.upsertPriceRule(rule);
  editing = null;
  ctx.render();
}

export function mount(ctx, root) {
  root.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      sort = { key, dir: sort.key === key && sort.dir === 'desc' ? 'asc' : 'desc' };
      ctx.render();
    });
  });

  const input = root.querySelector('#rules-import');
  if (input) {
    input.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const rows = parseCsv(await file.text());
      const errors = [];
      let imported = 0;
      for (const [i, row] of rows.entries()) {
        if (!row.sku_id || !ctx.data.skus.some((s) => s.id === row.sku_id)) {
          errors.push(`Row ${i + 2}: unknown sku_id "${row.sku_id}"`);
          continue;
        }
        const price = Number.parseFloat(row.recommended_price);
        if (!Number.isFinite(price)) {
          errors.push(`Row ${i + 2}: recommended_price is not a number`);
          continue;
        }
        ctx.store.upsertPriceRule({
          id: row.id || undefined,
          market: row.market || 'SG',
          sku_id: row.sku_id,
          territory_id: row.territory_id || null,
          channel_id: row.channel_id || null,
          outlet_id: row.outlet_id || null,
          recommended_price: price,
          recommended_min: Number.parseFloat(row.recommended_min),
          recommended_max: Number.parseFloat(row.recommended_max),
          effective_from: row.effective_from,
          effective_to: row.effective_to || null,
          priority: Number.parseInt(row.priority, 10) || 0,
          active: row.active !== 'false',
          notes: row.notes ?? '',
        });
        imported += 1;
      }
      importReport = { imported, skipped: rows.length - imported, errors: errors.slice(0, 10) };
      ctx.render();
    });
  }
}

/** Exposed for tests. */
export { CSV_COLUMNS, toCsv };
