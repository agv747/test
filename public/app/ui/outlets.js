/** Outlet directory — shared by the field and manager navigations. */

import { dateTimeLabel, esc } from '../lib/format.js';
import { dataTable, freshnessLabelHtml, pct, selectField, sortRows } from './dom.js';
import { RANGE_BUCKET } from '../services/pricePositionService.js';
import { downloadCsv } from '../lib/csv.js';

let sort = { key: 'alignment', dir: 'asc' };
let search = '';

export const title = () => 'Outlets';
export const subtitle = (ctx) => `${ctx.data.outlets.length} outlets · Singapore`;

function buildRows(ctx) {
  const { data, analytics } = ctx;
  const byOutlet = new Map();
  for (const o of analytics.observations) {
    if (!byOutlet.has(o.outlet_id)) byOutlet.set(o.outlet_id, []);
    byOutlet.get(o.outlet_id).push(o);
  }

  return data.outlets.map((outlet) => {
    const obs = byOutlet.get(outlet.id) ?? [];
    const jti = obs.filter((o) => o.is_jti && o.evaluation?.rangeBucket !== RANGE_BUCKET.UNKNOWN);
    const within = jti.filter((o) => o.evaluation.rangeBucket === RANGE_BUCKET.WITHIN).length;
    const latest = obs.slice().sort((a, b) => new Date(b.observed_at) - new Date(a.observed_at))[0];
    const opps = analytics.opportunities.filter((o) => o.outlet_id === outlet.id);
    const lastAction = data.field_actions
      .filter((a) => a.outlet_id === outlet.id)
      .sort((a, b) => new Date(b.action_at) - new Date(a.action_at))[0];

    return {
      outlet,
      id: outlet.id,
      name: outlet.name,
      code: outlet.outlet_code,
      territory: data.territories.find((t) => t.id === outlet.territory_id)?.name ?? '',
      channel: data.channels.find((c) => c.id === outlet.channel_id)?.name ?? '',
      tme: data.users.find((u) => u.id === outlet.assigned_tme_id)?.name ?? '',
      observations: jti.length,
      alignment: jti.length ? (within / jti.length) * 100 : null,
      opportunities: opps.length,
      high: opps.filter((o) => o.priority_label === 'High').length,
      last_visit: latest?.observed_at ?? null,
      freshness: latest?.freshness ?? null,
      last_action: lastAction?.action_type ?? '—',
    };
  });
}

const COLUMNS = [
  { key: 'name', label: 'Outlet', render: (r) => `<strong>${esc(r.name)}</strong><br /><span class="xsmall muted">${esc(r.code)}</span>` },
  { key: 'territory', label: 'Territory', render: (r) => esc(r.territory) },
  { key: 'channel', label: 'Channel', render: (r) => esc(r.channel) },
  { key: 'tme', label: 'Assigned TME', render: (r) => esc(r.tme) },
  { key: 'observations', label: 'JTI observations', align: 'right', render: (r) => r.observations },
  {
    key: 'alignment',
    label: 'Recommended price alignment',
    align: 'right',
    render: (r) => (r.alignment === null ? '<span class="muted">—</span>' : pct(r.alignment)),
  },
  {
    key: 'opportunities',
    label: 'Open opportunities',
    align: 'right',
    render: (r) =>
      r.opportunities
        ? `${r.opportunities}${r.high ? ` <span class="pill pill--risk">▲ ${r.high} high</span>` : ''}`
        : '<span class="muted">0</span>',
  },
  {
    key: 'last_visit',
    label: 'Last observation',
    render: (r) => `${esc(dateTimeLabel(r.last_visit))}<br />${freshnessLabelHtml(r.freshness)}`,
    sortValue: (r) => (r.last_visit ? new Date(r.last_visit).getTime() : 0),
  },
  { key: 'last_action', label: 'Last field action', render: (r) => esc(r.last_action) },
];

export function render(ctx) {
  let rows = buildRows(ctx);
  const term = search.trim().toLowerCase();
  if (term) {
    rows = rows.filter(
      (r) => r.name.toLowerCase().includes(term) || r.code.toLowerCase().includes(term),
    );
  }
  if (ctx.filters.territory_id) rows = rows.filter((r) => r.outlet.territory_id === ctx.filters.territory_id);
  if (ctx.filters.channel_id) rows = rows.filter((r) => r.outlet.channel_id === ctx.filters.channel_id);
  rows = sortRows(rows, COLUMNS, sort.key, sort.dir);

  return `<div class="card">
    <div class="card__head">
      <h2>${rows.length} outlet${rows.length === 1 ? '' : 's'}</h2>
      <div class="toolbar">
        <input type="search" placeholder="Search name or outlet ID" value="${esc(search)}"
          data-input="outlet-search" style="width:220px" />
        <button class="btn btn--sm" data-action="export">⇩ Export CSV</button>
      </div>
    </div>
    <div class="filters mb">
      ${selectField({
        label: 'Territory',
        name: 'territory_id',
        value: ctx.filters.territory_id,
        options: ctx.data.territories.map((t) => ({ value: t.id, label: t.name })),
      })}
      ${selectField({
        label: 'Channel',
        name: 'channel_id',
        value: ctx.filters.channel_id,
        options: ctx.data.channels.map((c) => ({ value: c.id, label: c.name })),
      })}
    </div>
    ${dataTable(COLUMNS, rows, {
      sortKey: sort.key,
      sortDir: sort.dir,
      rowAttrs: (r) => `class="clickable" data-action="open-outlet" data-outlet="${esc(r.id)}"`,
    })}
  </div>`;
}

export function onAction(action, el, ctx) {
  if (action === 'open-outlet') {
    ctx.navigate('outlet', { id: el.dataset.outlet });
    return;
  }
  if (action === 'export') {
    const rows = buildRows(ctx).map((r) => ({
      outlet_code: r.code,
      outlet: r.name,
      territory: r.territory,
      channel: r.channel,
      assigned_tme: r.tme,
      jti_observations: r.observations,
      recommended_price_alignment_pct: r.alignment === null ? '' : r.alignment.toFixed(1),
      open_opportunities: r.opportunities,
      high_priority: r.high,
      last_observation: r.last_visit ?? '',
      last_field_action: r.last_action,
    }));
    downloadCsv('outlets.csv', Object.keys(rows[0] ?? { outlet: '' }), rows);
  }
}

export function onInput(target, ctx) {
  if (target.dataset.input === 'outlet-search') {
    search = target.value;
    ctx.render();
  }
}

export function mount(ctx, root) {
  root.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      sort = { key, dir: sort.key === key && sort.dir === 'desc' ? 'asc' : 'desc' };
      ctx.render();
    });
  });
  const box = root.querySelector('[data-input="outlet-search"]');
  if (box && search) {
    box.focus();
    box.setSelectionRange(search.length, search.length);
  }
}
