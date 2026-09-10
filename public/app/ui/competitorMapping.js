/** §21 — Competitor Mapping admin. One JTI SKU may map to several competitor SKUs. */

import { dateLabel, esc, money } from '../lib/format.js';
import { dataTable, disclaimer, sortRows } from './dom.js';
import { downloadCsv, parseCsv } from '../lib/csv.js';
import { isEffectiveAt } from '../lib/dates.js';

let sort = { key: 'jti', dir: 'asc' };
let editing = null;

export const title = () => 'Competitor Mapping';
export const subtitle = () => 'Comparable SKU pairs and the desired competitive position for each';

const CSV_COLUMNS = [
  'id',
  'jti_sku_id',
  'competitor_sku_id',
  'market',
  'territory_id',
  'channel_id',
  'mapping_priority',
  'desired_gap_min',
  'desired_gap_max',
  'desired_price_index_min',
  'desired_price_index_max',
  'comparison_method',
  'effective_from',
  'effective_to',
  'active',
];

export function render(ctx) {
  const now = new Date().toISOString();
  const skus = new Map(ctx.data.skus.map((s) => [s.id, s]));
  const territories = new Map(ctx.data.territories.map((t) => [t.id, t]));
  const channels = new Map(ctx.data.channels.map((c) => [c.id, c]));

  const rows = ctx.data.competitor_mappings.map((m) => ({
    mapping: m,
    id: m.id,
    jti: skus.get(m.jti_sku_id)?.name ?? m.jti_sku_id,
    competitor: skus.get(m.competitor_sku_id)?.name ?? m.competitor_sku_id,
    competitor_brand: ctx.data.brands.find((b) => b.id === skus.get(m.competitor_sku_id)?.brand_id)?.name ?? '',
    scope: [territories.get(m.territory_id)?.name, channels.get(m.channel_id)?.name].filter(Boolean).join(' · ') || 'Market',
    state: m.active === false ? 'Inactive' : isEffectiveAt(m, now) ? 'Effective' : 'Not effective',
  }));

  const columns = [
    { key: 'jti', label: 'JTI SKU', render: (r) => esc(r.jti) },
    { key: 'competitor', label: 'Competitor SKU', render: (r) => `${esc(r.competitor)}<br /><span class="xsmall muted">${esc(r.competitor_brand)}</span>` },
    { key: 'scope', label: 'Scope', render: (r) => esc(r.scope) },
    { key: 'mapping_priority', label: 'Priority', align: 'right', render: (r) => r.mapping.mapping_priority, sortValue: (r) => r.mapping.mapping_priority },
    {
      key: 'gap',
      label: 'Desired price gap',
      align: 'right',
      render: (r) => `${money(r.mapping.desired_gap_min)} – ${money(r.mapping.desired_gap_max)}`,
      sortValue: (r) => r.mapping.desired_gap_min,
    },
    {
      key: 'index',
      label: 'Desired Price Index',
      align: 'right',
      render: (r) => `${r.mapping.desired_price_index_min} – ${r.mapping.desired_price_index_max}`,
      sortValue: (r) => r.mapping.desired_price_index_min,
    },
    { key: 'method', label: 'Comparison method', render: (r) => esc(r.mapping.comparison_method || `${ctx.config.comparison_method} (default)`) },
    { key: 'effective_from', label: 'Effective from', render: (r) => esc(dateLabel(r.mapping.effective_from)), sortValue: (r) => new Date(r.mapping.effective_from).getTime() },
    { key: 'effective_to', label: 'Effective to', render: (r) => (r.mapping.effective_to ? esc(dateLabel(r.mapping.effective_to)) : '<span class="muted">open</span>') },
    {
      key: 'state',
      label: 'Status',
      render: (r) => {
        const tone = r.state === 'Effective' ? 'good' : 'none';
        return `<span class="pill pill--${tone}">${tone === 'good' ? '✓' : '–'} ${esc(r.state)}</span>`;
      },
    },
    {
      key: 'actions',
      label: '',
      sortable: false,
      render: (r) => `<div class="toolbar">
        <button class="btn btn--sm" data-action="edit-mapping" data-id="${esc(r.id)}">Edit</button>
        <button class="btn btn--sm" data-action="toggle-mapping" data-id="${esc(r.id)}">${r.mapping.active === false ? 'Activate' : 'Deactivate'}</button>
      </div>`,
    },
  ];

  return `
    ${disclaimer('Dashboards compare against the <strong>active mapping with the highest priority</strong> unless a manager selects another competitor SKU on the SKU Intelligence page.')}
    <div class="card">
      <div class="card__head">
        <h2>${rows.length} mapping${rows.length === 1 ? '' : 's'}</h2>
        <div class="toolbar">
          <button class="btn btn--primary btn--sm" data-action="new-mapping">+ New mapping</button>
          <button class="btn btn--sm" data-action="export">⇩ Export CSV</button>
          <button class="btn btn--sm" data-action="import">⇧ Import CSV</button>
          <input type="file" id="mapping-import" accept=".csv,text/csv" class="hidden" />
        </div>
      </div>
      ${dataTable(columns, sortRows(rows, columns, sort.key, sort.dir), { sortKey: sort.key, sortDir: sort.dir })}
    </div>
    ${editing ? editModal(ctx) : ''}`;
}

function editModal(ctx) {
  const m = editing;
  const opt = (list, value) =>
    list.map((x) => `<option value="${esc(x.id)}"${x.id === value ? ' selected' : ''}>${esc(x.name)}</option>`).join('');

  return `<div class="modal-backdrop"><div class="modal">
    <div class="card__head"><h2>${m.id ? 'Edit' : 'New'} competitor mapping</h2>
      <button class="btn btn--sm" data-action="close-modal">Close</button></div>
    <form id="mapping-form">
      <div class="form-grid">
        <div class="field"><label for="m-jti">JTI SKU</label>
          <select id="m-jti" name="jti_sku_id" required>${opt(ctx.data.skus.filter((s) => s.is_jti), m.jti_sku_id)}</select></div>
        <div class="field"><label for="m-comp">Competitor SKU</label>
          <select id="m-comp" name="competitor_sku_id" required>${opt(ctx.data.skus.filter((s) => !s.is_jti), m.competitor_sku_id)}</select></div>
        <div class="field"><label for="m-market">Market</label>
          <input id="m-market" name="market" value="${esc(m.market ?? 'SG')}" /></div>
        <div class="field"><label for="m-territory">Territory (optional)</label>
          <select id="m-territory" name="territory_id"><option value="">All territories</option>${opt(ctx.data.territories, m.territory_id)}</select></div>
        <div class="field"><label for="m-channel">Channel (optional)</label>
          <select id="m-channel" name="channel_id"><option value="">All channels</option>${opt(ctx.data.channels, m.channel_id)}</select></div>
        <div class="field"><label for="m-priority">Mapping priority</label>
          <input id="m-priority" name="mapping_priority" type="number" step="1" value="${m.mapping_priority ?? 100}" /></div>
        <div class="field"><label for="m-gapmin">Desired price gap min (SGD)</label>
          <input id="m-gapmin" name="desired_gap_min" type="number" step="0.05" value="${m.desired_gap_min ?? 0}" /></div>
        <div class="field"><label for="m-gapmax">Desired price gap max (SGD)</label>
          <input id="m-gapmax" name="desired_gap_max" type="number" step="0.05" value="${m.desired_gap_max ?? 0.3}" /></div>
        <div class="field"><label for="m-idxmin">Desired Price Index min</label>
          <input id="m-idxmin" name="desired_price_index_min" type="number" step="0.1" value="${m.desired_price_index_min ?? 100}" /></div>
        <div class="field"><label for="m-idxmax">Desired Price Index max</label>
          <input id="m-idxmax" name="desired_price_index_max" type="number" step="0.1" value="${m.desired_price_index_max ?? 103}" /></div>
        <div class="field"><label for="m-method">Comparison method</label>
          <select id="m-method" name="comparison_method">
            <option value=""${!m.comparison_method ? ' selected' : ''}>Use global default</option>
            <option value="gap"${m.comparison_method === 'gap' ? ' selected' : ''}>Price gap only</option>
            <option value="price_index"${m.comparison_method === 'price_index' ? ' selected' : ''}>Price Index only</option>
            <option value="both"${m.comparison_method === 'both' ? ' selected' : ''}>Either measure (both)</option>
          </select></div>
        <div class="field"><label for="m-from">Effective from</label>
          <input id="m-from" name="effective_from" type="date" value="${esc((m.effective_from ?? new Date().toISOString()).slice(0, 10))}" required /></div>
        <div class="field"><label for="m-to">Effective to (optional)</label>
          <input id="m-to" name="effective_to" type="date" value="${esc((m.effective_to ?? '').slice(0, 10))}" /></div>
        <div class="field"><label for="m-active">Active</label>
          <select id="m-active" name="active"><option value="true"${m.active !== false ? ' selected' : ''}>Active</option><option value="false"${m.active === false ? ' selected' : ''}>Inactive</option></select></div>
      </div>
      <div class="toolbar mt">
        <button type="submit" class="btn btn--primary">Save mapping</button>
        ${m.id ? `<button type="button" class="btn btn--danger" data-action="delete-mapping" data-id="${esc(m.id)}">Delete</button>` : ''}
      </div>
    </form>
  </div></div>`;
}

export function onAction(action, el, ctx) {
  switch (action) {
    case 'new-mapping':
      editing = {
        market: 'SG',
        jti_sku_id: ctx.data.skus.find((s) => s.is_jti)?.id,
        competitor_sku_id: ctx.data.skus.find((s) => !s.is_jti)?.id,
        mapping_priority: 100,
        effective_from: new Date().toISOString(),
        active: true,
      };
      ctx.render();
      break;
    case 'edit-mapping':
      editing = { ...ctx.data.competitor_mappings.find((m) => m.id === el.dataset.id) };
      ctx.render();
      break;
    case 'toggle-mapping': {
      const m = ctx.data.competitor_mappings.find((x) => x.id === el.dataset.id);
      ctx.store.upsertCompetitorMapping({ ...m, active: m.active === false });
      ctx.render();
      break;
    }
    case 'delete-mapping':
      if (confirm('Delete this mapping? Existing observations keep their stored snapshot.')) {
        ctx.store.deleteCompetitorMapping(el.dataset.id);
        editing = null;
        ctx.render();
      }
      break;
    case 'close-modal':
      editing = null;
      ctx.render();
      break;
    case 'export':
      downloadCsv('competitor-mappings.csv', CSV_COLUMNS, ctx.data.competitor_mappings);
      break;
    case 'import':
      document.querySelector('#mapping-import')?.click();
      break;
    default:
      break;
  }
}

export function onSubmit(form, ctx) {
  if (form.id !== 'mapping-form') return;
  const fd = new FormData(form);
  ctx.store.upsertCompetitorMapping({
    id: editing.id,
    jti_sku_id: fd.get('jti_sku_id'),
    competitor_sku_id: fd.get('competitor_sku_id'),
    market: fd.get('market') || 'SG',
    territory_id: fd.get('territory_id') || null,
    channel_id: fd.get('channel_id') || null,
    mapping_priority: Number.parseInt(fd.get('mapping_priority'), 10) || 0,
    desired_gap_min: Number.parseFloat(fd.get('desired_gap_min')),
    desired_gap_max: Number.parseFloat(fd.get('desired_gap_max')),
    desired_price_index_min: Number.parseFloat(fd.get('desired_price_index_min')),
    desired_price_index_max: Number.parseFloat(fd.get('desired_price_index_max')),
    comparison_method: fd.get('comparison_method') || null,
    effective_from: new Date(`${fd.get('effective_from')}T00:00:00.000Z`).toISOString(),
    effective_to: fd.get('effective_to') ? new Date(`${fd.get('effective_to')}T23:59:59.000Z`).toISOString() : null,
    active: fd.get('active') === 'true',
  });
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

  const input = root.querySelector('#mapping-import');
  if (input) {
    input.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      for (const row of parseCsv(await file.text())) {
        if (!row.jti_sku_id || !row.competitor_sku_id) continue;
        ctx.store.upsertCompetitorMapping({
          ...row,
          id: row.id || undefined,
          mapping_priority: Number.parseInt(row.mapping_priority, 10) || 0,
          desired_gap_min: Number.parseFloat(row.desired_gap_min),
          desired_gap_max: Number.parseFloat(row.desired_gap_max),
          desired_price_index_min: Number.parseFloat(row.desired_price_index_min),
          desired_price_index_max: Number.parseFloat(row.desired_price_index_max),
          territory_id: row.territory_id || null,
          channel_id: row.channel_id || null,
          comparison_method: row.comparison_method || null,
          effective_to: row.effective_to || null,
          active: row.active !== 'false',
        });
      }
      ctx.render();
    });
  }
}
