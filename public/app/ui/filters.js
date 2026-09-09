/** §9 — the global manager filter bar, shared by every manager page. */

import { inputField, selectField, esc } from './dom.js';

export function filterBar(ctx, options = {}) {
  const { show = ['date', 'territory', 'channel', 'user', 'brand', 'sku', 'strategic', 'ownership', 'confidence'] } = options;
  const f = ctx.filters;
  const parts = [];

  if (show.includes('date')) {
    parts.push(inputField({ label: 'From', name: 'from', type: 'date', value: (f.from ?? '').slice(0, 10), attrs: 'data-filter="from"' }));
    parts.push(inputField({ label: 'To', name: 'to', type: 'date', value: (f.to ?? '').slice(0, 10), attrs: 'data-filter="to"' }));
  }
  if (show.includes('territory')) {
    parts.push(selectField({
      label: 'Territory',
      name: 'territory_id',
      value: f.territory_id,
      options: ctx.data.territories.map((t) => ({ value: t.id, label: t.name })),
    }));
  }
  if (show.includes('channel')) {
    parts.push(selectField({
      label: 'Channel',
      name: 'channel_id',
      value: f.channel_id,
      options: ctx.data.channels.map((c) => ({ value: c.id, label: c.name })),
    }));
  }
  if (show.includes('user')) {
    parts.push(selectField({
      label: 'TME',
      name: 'user_id',
      value: f.user_id,
      options: ctx.data.users.filter((u) => u.role === 'field').map((u) => ({ value: u.id, label: u.name })),
    }));
  }
  if (show.includes('outlet')) {
    parts.push(selectField({
      label: 'Outlet',
      name: 'outlet_id',
      value: f.outlet_id,
      options: ctx.data.outlets.map((o) => ({ value: o.id, label: o.name })),
    }));
  }
  if (show.includes('brand')) {
    parts.push(selectField({
      label: 'Brand',
      name: 'brand_id',
      value: f.brand_id,
      options: ctx.data.brands.map((b) => ({ value: b.id, label: b.name })),
    }));
  }
  if (show.includes('sku')) {
    parts.push(selectField({
      label: 'SKU',
      name: 'sku_id',
      value: f.sku_id,
      options: ctx.data.skus.map((s) => ({ value: s.id, label: s.name })),
    }));
  }
  if (show.includes('ownership')) {
    parts.push(selectField({
      label: 'JTI / Competitor',
      name: 'ownership',
      value: f.ownership,
      includeAll: true,
      allLabel: 'Both',
      options: [
        { value: 'jti', label: 'JTI only' },
        { value: 'competitor', label: 'Competitor only' },
      ],
    }));
  }
  if (show.includes('confidence')) {
    parts.push(selectField({
      label: 'Data confidence',
      name: 'min_confidence',
      value: f.min_confidence,
      includeAll: true,
      allLabel: 'All observations',
      options: [
        { value: '0.75', label: '≥ 75%' },
        { value: '0.9', label: '≥ 90%' },
      ],
    }));
  }

  const strategic = show.includes('strategic')
    ? `<label class="checkbox" style="margin-top:18px"><input type="checkbox" data-filter="strategic_only"
        value="1" ${f.strategic_only ? 'checked' : ''} /> Strategic SKUs only</label>`
    : '';

  const active = Object.keys(f).filter((k) => f[k]).length;

  return `<div class="card">
    <div class="card__head">
      <h3>Filters</h3>
      ${active ? `<button class="btn btn--sm" data-action="clear-filters">Clear ${active} filter${active === 1 ? '' : 's'}</button>` : '<span class="card__sub">Showing all observations</span>'}
    </div>
    <div class="filters">${parts.join('')}${strategic}</div>
  </div>`;
}

/** Shared handler — pages delegate `clear-filters` here. */
export function handleFilterAction(action, el, ctx) {
  if (action === 'clear-filters') {
    ctx.store.setSession({ filters: {} });
    ctx.render();
    return true;
  }
  return false;
}

/** Checkbox filters need explicit handling because their value is not the checked state. */
export function handleFilterChange(target, ctx) {
  if (target.dataset.filter === 'strategic_only') {
    ctx.setFilters({ strategic_only: target.checked ? '1' : '' });
    ctx.render();
    return true;
  }
  if (target.dataset.filter === 'min_confidence') {
    ctx.setFilters({ min_confidence: target.value ? Number(target.value) : '' });
    ctx.render();
    return true;
  }
  return false;
}

export function filterSummary(ctx) {
  const f = ctx.filters;
  const parts = [];
  if (f.from || f.to) parts.push(`${f.from || 'start'} → ${f.to || 'today'}`);
  if (f.territory_id) parts.push(esc(ctx.data.territories.find((t) => t.id === f.territory_id)?.name ?? ''));
  if (f.channel_id) parts.push(esc(ctx.data.channels.find((c) => c.id === f.channel_id)?.name ?? ''));
  if (f.strategic_only) parts.push('Strategic SKUs only');
  return parts.join(' · ');
}
