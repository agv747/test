/** §8.1 — Field home. Deliberately light on analytics; the CTA dominates. */

import { esc, dateLabel, dateTimeLabel } from '../lib/format.js';
import { daysBetween, isoDate } from '../lib/dates.js';
import { MARKET_CONTEXT_NOTE, disclaimer } from './dom.js';

export const narrow = true;

export const title = (ctx) => `Hello, ${ctx.user.name.split(' ')[0]}`;
export const subtitle = () => 'Field price capture · Singapore';

export function render(ctx) {
  const { data, user } = ctx;
  const today = isoDate(new Date());

  const myVisits = data.visits.filter((v) => v.user_id === user.id);
  const todayVisits = myVisits.filter((v) => isoDate(v.submitted_at ?? v.started_at) === today);
  const followUps = data.field_actions.filter(
    (a) =>
      a.user_id === user.id &&
      a.follow_up_date &&
      new Date(a.follow_up_date) <= new Date() &&
      a.action_type !== 'No action',
  );
  const lowConfidence = data.price_observations.filter((o) => {
    const visit = data.visits.find((v) => v.id === o.visit_id);
    return (
      visit?.user_id === user.id &&
      o.recognition_confidence !== null &&
      o.recognition_confidence < ctx.config.confidence_review_threshold &&
      !o.excluded
    );
  });

  const recentOutletIds = [...new Set(
    myVisits
      .slice()
      .sort((a, b) => new Date(b.submitted_at ?? b.started_at) - new Date(a.submitted_at ?? a.started_at))
      .map((v) => v.outlet_id),
  )].slice(0, 5);

  return `
    <div class="field-app">
      <button class="btn btn--primary btn--lg btn--block mb" data-nav="field/check">
        ◉ Start Price Check
      </button>

      <div class="grid grid--3 mb">
        ${quickCard('Visits Today', todayVisits.length, 'submitted today')}
        ${quickCard('Follow-ups Due', followUps.length, 'scheduled or overdue')}
        ${quickCard('Pending Reviews', lowConfidence.length, 'low-confidence detections')}
      </div>

      ${followUps.length ? followUpCard(followUps, data) : ''}

      <div class="card">
        <div class="card__head"><h2>Recently visited outlets</h2></div>
        ${
          recentOutletIds.length
            ? recentOutletIds
                .map((id) => outletCard(id, ctx))
                .join('')
            : '<div class="empty">No visits recorded yet. Start a price check to begin.</div>'
        }
      </div>

      ${disclaimer(esc(MARKET_CONTEXT_NOTE))}
    </div>`;
}

function quickCard(label, value, meta) {
  return `<div class="kpi">
    <div class="kpi__label">${esc(label)}</div>
    <div class="kpi__value">${value}</div>
    <div class="kpi__meta">${esc(meta)}</div>
  </div>`;
}

function followUpCard(followUps, data) {
  return `<div class="card">
    <div class="card__head"><h2>Pending follow-ups</h2>
      <span class="card__sub">Previously identified issues awaiting a next step</span></div>
    ${followUps
      .map((a) => {
        const outlet = data.outlets.find((o) => o.id === a.outlet_id);
        const overdue = daysBetween(a.follow_up_date, new Date());
        return `<div class="outlet-card" data-nav="outlet" data-outlet="${esc(a.outlet_id)}">
          <div class="outlet-card__body">
            <div class="outlet-card__name">${esc(outlet?.name ?? a.outlet_id)}</div>
            <div class="outlet-card__meta">${esc(a.action_type)} · due ${esc(dateLabel(a.follow_up_date))}
              ${overdue > 0 ? `<span class="pill pill--watch">! ${overdue}d overdue</span>` : ''}</div>
          </div>
          <span class="muted">›</span>
        </div>`;
      })
      .join('')}
  </div>`;
}

function outletCard(outletId, ctx) {
  const { data } = ctx;
  const outlet = data.outlets.find((o) => o.id === outletId);
  if (!outlet) return '';
  const visits = data.visits
    .filter((v) => v.outlet_id === outletId)
    .sort((a, b) => new Date(b.submitted_at ?? b.started_at) - new Date(a.submitted_at ?? a.started_at));
  const last = visits[0];
  const lastAction = data.field_actions
    .filter((a) => a.outlet_id === outletId)
    .sort((a, b) => new Date(b.action_at) - new Date(a.action_at))[0];
  const territory = data.territories.find((t) => t.id === outlet.territory_id);
  const channel = data.channels.find((c) => c.id === outlet.channel_id);

  return `<div class="outlet-card" data-action="open-outlet" data-outlet="${esc(outlet.id)}">
    <div class="outlet-card__body">
      <div class="outlet-card__name">${esc(outlet.name)}</div>
      <div class="outlet-card__meta">${esc(outlet.outlet_code)} · ${esc(territory?.name ?? '')} · ${esc(channel?.name ?? '')}</div>
      <div class="outlet-card__meta">Last price check: ${esc(dateTimeLabel(last?.submitted_at))}${
        lastAction ? ` · Last field action: ${esc(lastAction.action_type)}` : ''
      }</div>
    </div>
    <span class="muted">›</span>
  </div>`;
}

export function onAction(action, el, ctx) {
  if (action === 'open-outlet') {
    ctx.navigate('outlet', { id: el.dataset.outlet });
  }
}
