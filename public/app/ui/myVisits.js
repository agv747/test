/** §6.1 — a TME's own visit history. */

import { dateTimeLabel, esc } from '../lib/format.js';
import { dataTable, statusPill } from './dom.js';
import { RANGE_BUCKET } from '../services/pricePositionService.js';
import { enrichObservations } from '../services/analyticsService.js';

export const title = () => 'My Visits';
export const subtitle = (ctx) => `${ctx.user.name} · submitted and draft price checks`;

export function render(ctx) {
  const { data, user, config } = ctx;
  const enriched = enrichObservations(data, config);

  const rows = data.visits
    .filter((v) => v.user_id === user.id)
    .sort((a, b) => new Date(b.submitted_at ?? b.started_at) - new Date(a.submitted_at ?? a.started_at))
    .map((visit) => {
      const outlet = data.outlets.find((o) => o.id === visit.outlet_id);
      const obs = enriched.filter((o) => o.visit_id === visit.id);
      const jti = obs.filter((o) => o.is_jti);
      const within = jti.filter((o) => o.evaluation?.rangeBucket === RANGE_BUCKET.WITHIN).length;
      const action = data.field_actions.find((a) => a.visit_id === visit.id);
      return {
        visit,
        outlet_name: outlet?.name ?? visit.outlet_id,
        outlet_id: visit.outlet_id,
        when: visit.submitted_at ?? visit.started_at,
        status: visit.status,
        jti: jti.length,
        competitor: obs.length - jti.length,
        within,
        action: action?.action_type ?? '—',
      };
    });

  const columns = [
    { key: 'when', label: 'Date', render: (r) => esc(dateTimeLabel(r.when)), sortValue: (r) => new Date(r.when).getTime() },
    { key: 'outlet_name', label: 'Outlet', render: (r) => esc(r.outlet_name) },
    {
      key: 'status',
      label: 'Status',
      render: (r) =>
        `<span class="pill pill--${r.status === 'submitted' ? 'good' : 'watch'}">${r.status === 'submitted' ? '✓ Submitted' : '● Draft'}</span>`,
    },
    { key: 'jti', label: 'JTI observations', align: 'right', render: (r) => r.jti },
    { key: 'competitor', label: 'Competitor observations', align: 'right', render: (r) => r.competitor },
    {
      key: 'within',
      label: 'Within recommended range',
      align: 'right',
      render: (r) => (r.jti ? `${r.within} / ${r.jti}` : '—'),
      sortValue: (r) => (r.jti ? r.within / r.jti : -1),
    },
    { key: 'action', label: 'Field action', render: (r) => esc(r.action) },
  ];

  return `<div class="card">
    <div class="card__head">
      <h2>${rows.length} visit${rows.length === 1 ? '' : 's'}</h2>
      <button class="btn btn--primary btn--sm" data-nav="field/check">◉ Start Price Check</button>
    </div>
    ${dataTable(columns, rows, {
      rowAttrs: (r) => `class="clickable" data-action="open-outlet" data-outlet="${esc(r.outlet_id)}"`,
      emptyMessage: 'No visits recorded yet.',
    })}
  </div>`;
}

export function onAction(action, el, ctx) {
  if (action === 'open-outlet') ctx.navigate('outlet', { id: el.dataset.outlet });
}
