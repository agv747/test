/**
 * §14 — Field Effectiveness.
 *
 * Because JTI does not set retailer price, every metric here is phrased as an OBSERVED
 * SEQUENCE. Nothing on this page claims that field engagement caused a price change.
 */

import { dateLabel, esc, money, num, pct, signedMoney } from '../lib/format.js';
import { dataTable, disclaimer, kpiCard, statusPill, strategicPill } from './dom.js';
import { filterBar, handleFilterAction, handleFilterChange } from './filters.js';
import { downloadCsv } from '../lib/csv.js';
import { OUTCOME, OUTCOME_LABEL } from '../services/fieldOutcomeService.js';

export const title = () => 'Field Effectiveness';
export const subtitle = () => 'Observed price change after engagement — sequence, not causation';

export function render(ctx) {
  const fx = ctx.analytics.fieldEffectiveness;

  return `
    ${disclaimer(`<strong>${esc(fx.label)}.</strong> ${esc(fx.disclaimer)}`)}
    ${filterBar(ctx, { show: ['date', 'territory', 'channel', 'user'] })}
    ${outcomeCard(fx)}
    ${awaitingCard(fx)}

    <div class="card">
      <div class="card__head">
        <h2>Activity</h2>
        <span class="card__sub">What the field did. None of these is a rate of what it achieved — that is the card above.</span>
      </div>
      <div class="grid grid--kpi">
      ${kpiCard({ label: 'Pricing Opportunities identified', value: String(fx.opportunities_identified) })}
      ${kpiCard({ label: 'Opportunities engaged by TME', value: String(fx.opportunities_engaged) })}
      ${kpiCard({ label: 'Outlet agreed to review price', value: String(fx.outlet_agreed_to_review) })}
      ${kpiCard({ label: 'Opportunity Resolution Rate', value: pct(fx.opportunity_resolution_rate), meta: `${fx.opportunities_resolved} moved into the recommended range` })}
      ${kpiCard({ label: 'Median detection-to-action', value: fx.median_detection_to_action_days === null ? '—' : `${num(fx.median_detection_to_action_days, 1)} d`, meta: 'Days from the opportunity appearing to a TME acting' })}
      ${kpiCard({ label: 'Median action-to-next-observation', value: fx.median_action_to_next_observation_days === null ? '—' : `${num(fx.median_action_to_next_observation_days, 1)} d`, meta: 'Days before anybody went back to look' })}
      </div>
    </div>

    <div class="card">
      <div class="card__head">
        <h2>Before / after engagement</h2>
        <div class="toolbar">
          <span class="card__sub">Observed sequence only</span>
          <button class="btn btn--sm" data-action="export">⇩ Export CSV</button>
        </div>
      </div>
      ${fx.timeline.length ? fx.timeline.slice(0, 12).map(beforeAfter).join('') : '<div class="empty">No engagements with a subsequent observation in this period.</div>'}
    </div>

    <div class="card">
      <div class="card__head"><h2>All engagements</h2></div>
      ${table(fx.timeline)}
    </div>`;
}

/**
 * What happened after an engagement, classified rather than counted.
 *
 * The headline on this page used to be 80%: four price changes among five engagements that
 * had a subsequent observation. Beside the word "effectiveness" that reads as four successes
 * out of five — but one of the four was a price that moved further from where it was meant to
 * be, and a price change is not a success. Nor is any of it caused by the visit.
 *
 * So the sequence is classified by whether the price moved closer to or away from its intended
 * position, each outcome carrying the denominator it is a share of. "Any observed price
 * change" survives underneath as a plain fact about the shelf, because it is one — it simply
 * answers a different question.
 */
function outcomeCard(fx) {
  const o = fx.outcomes;
  if (!o || !o.engagements) return '';

  const row = (key, tone) => {
    const metric = o[key];
    return `<div class="kpi kpi--${tone}" data-outcome="${esc(key)}">
      <div class="kpi__label">${esc(OUTCOME_LABEL[key] ?? key)}</div>
      <div class="kpi__value">${metric.pct === null ? '—' : `${metric.pct}%`}</div>
      <div class="kpi__meta"><strong>${metric.numerator} of ${metric.denominator}</strong> engagements with a later observation</div>
    </div>`;
  };

  return `<div class="card" data-outcomes>
    <div class="card__head">
      <h2>What was observed after the engagement</h2>
      <span class="card__sub">${o.engagements} engagement${o.engagements === 1 ? '' : 's'} ·
        ${o.with_subsequent_observation} with a later observation ·
        ${o.awaiting_observation} awaiting one</span>
    </div>
    <div class="grid grid--kpi">
      ${row(OUTCOME.IMPROVED, 'good')}
      ${row(OUTCOME.UNCHANGED, 'neutral')}
      ${row(OUTCOME.WORSENED, 'risk')}
      <div class="kpi">
        <div class="kpi__label">Any observed price change</div>
        <div class="kpi__value">${o.any_price_change.pct === null ? '—' : `${o.any_price_change.pct}%`}</div>
        <div class="kpi__meta"><strong>${o.any_price_change.numerator} of ${o.any_price_change.denominator}</strong> — a description of the shelf, not a success rate</div>
      </div>
    </div>
    <p class="xsmall muted mt">Improvement means the price moved closer to its intended position, not
      that the gap got smaller: a gap narrowing toward zero can be a price leaving the corridor it was
      meant to sit in. ${esc(fx.timeline[0]?.outcome_policy_note ?? '')}
      Engagements still awaiting an observation are counted separately rather than dropped.</p>
  </div>`;
}

/**
 * Engagements nothing has been observed since.
 *
 * Previously these simply vanished from the denominator, which flatters every rate on the
 * page: an engagement with no follow-up visit is not evidence of anything, and silently
 * excluding it turns "we have not been back" into "it worked".
 */
function awaitingCard(fx) {
  if (!fx.awaiting?.length) return '';
  const columns = [
    { key: 'action_at', label: 'Engagement date', render: (t) => esc(dateLabel(t.action_at)), sortValue: (t) => new Date(t.action_at).getTime() },
    { key: 'outlet_name', label: 'Outlet', render: (t) => esc(t.outlet_name) },
    { key: 'territory_name', label: 'Territory', render: (t) => esc(t.territory_name) },
    { key: 'sku_name', label: 'SKU', render: (t) => `${esc(t.sku_name)} ${strategicPill({ is_strategic: t.is_strategic })}` },
    { key: 'action_type', label: 'Action', render: (t) => esc(t.action_type) },
    { key: 'before_price', label: 'Price at engagement', align: 'right', render: (t) => money(t.before?.jti_price), sortValue: (t) => t.before?.jti_price ?? 0 },
  ];
  return `<div class="card" data-awaiting>
    <div class="card__head">
      <h2>Awaiting a subsequent observation</h2>
      <span class="card__sub">${fx.awaiting.length} engagement${fx.awaiting.length === 1 ? '' : 's'} with nothing observed since — counted, not dropped</span>
    </div>
    ${dataTable(columns, fx.awaiting.slice(0, 25), { emptyMessage: 'None.' })}
  </div>`;
}

function beforeAfter(t) {
  const improved = t.observed_gap_improvement !== null && t.observed_gap_improvement > 0;
  return `<div class="card" style="box-shadow:none;margin-bottom:10px">
    <div class="row mb">
      <strong>${esc(t.sku_name)}</strong>
      ${strategicPill({ is_strategic: t.is_strategic })}
      <span class="muted small">${esc(t.outlet_name)} · ${esc(t.territory_name)}</span>
    </div>
    <div class="beforeafter">
      <div class="beforeafter__box">
        <div class="xsmall muted">Before — observed ${esc(dateLabel(t.before.observed_at))}</div>
        <div class="small">JTI price: <strong>${money(t.before.jti_price)}</strong></div>
        <div class="small">Competitor: <strong>${money(t.before.competitor_price)}</strong></div>
        <div class="small">Gap: <strong>${signedMoney(t.before.gap)}</strong></div>
        <div class="mt">${statusPill(t.before.status)}</div>
      </div>
      <div class="beforeafter__arrow" title="TME engagement">
        →
        <div class="xsmall muted nowrap">${esc(t.action_type)}<br />${esc(dateLabel(t.action_at))}</div>
      </div>
      <div class="beforeafter__box">
        <div class="xsmall muted">Next observed — ${esc(dateLabel(t.after.observed_at))}</div>
        <div class="small">JTI price: <strong>${money(t.after.jti_price)}</strong></div>
        <div class="small">Competitor: <strong>${money(t.after.competitor_price)}</strong></div>
        <div class="small">Gap: <strong>${signedMoney(t.after.gap)}</strong></div>
        <div class="mt">${statusPill(t.after.status)}</div>
      </div>
    </div>
    <p class="small mt" style="margin-bottom:0">
      <strong>${esc(OUTCOME_LABEL[t.outcome] ?? 'Cannot be classified')}</strong>
      — ${esc(t.moved)}.
      ${t.observed_gap_improvement === null ? 'No comparable competitor observation.' : `Gap ${improved ? 'narrowed' : 'widened'} by ${money(Math.abs(t.observed_gap_improvement))}.`}
      <span class="muted">Observed sequence, not attributed to the engagement.</span>
    </p>
    ${componentLines(t)}
  </div>`;
}

/**
 * The two comparison bases side by side, so a combined verdict can be checked rather than
 * trusted — particularly where they disagree and the less favourable one was reported.
 */
function componentLines(t) {
  const entries = Object.entries(t.outcome_components ?? {});
  if (!entries.length) return '';
  const label = { gap: 'Price gap', price_index: 'Price Index' };
  return `<p class="xsmall muted" style="margin:4px 0 0">${entries
    .map(([key, c]) =>
      `${esc(label[key] ?? key)}: distance outside the intended position
       ${c.before === null ? '—' : num(c.before, 2)} → ${c.after === null ? '—' : num(c.after, 2)}
       (${esc(OUTCOME_LABEL[c.outcome] ?? c.outcome)})`,
    )
    .join(' · ')}</p>`;
}

function table(timeline) {
  const columns = [
    { key: 'action_at', label: 'Engagement date', render: (t) => esc(dateLabel(t.action_at)), sortValue: (t) => new Date(t.action_at).getTime() },
    { key: 'outlet_name', label: 'Outlet', render: (t) => esc(t.outlet_name) },
    { key: 'territory_name', label: 'Territory', render: (t) => esc(t.territory_name) },
    { key: 'sku_name', label: 'SKU', render: (t) => `${esc(t.sku_name)} ${strategicPill({ is_strategic: t.is_strategic })}` },
    { key: 'action_type', label: 'Action', render: (t) => esc(t.action_type) },
    { key: 'before_price', label: 'Price before', align: 'right', render: (t) => money(t.before.jti_price), sortValue: (t) => t.before.jti_price },
    { key: 'after_price', label: 'Price after', align: 'right', render: (t) => money(t.after.jti_price), sortValue: (t) => t.after.jti_price },
    { key: 'observed_price_change', label: 'Observed change', align: 'right', render: (t) => signedMoney(t.observed_price_change) },
    { key: 'before_gap', label: 'Gap before', align: 'right', render: (t) => signedMoney(t.before.gap), sortValue: (t) => t.before.gap ?? 0 },
    { key: 'after_gap', label: 'Gap after', align: 'right', render: (t) => signedMoney(t.after.gap), sortValue: (t) => t.after.gap ?? 0 },
    { key: 'status_after', label: 'Status after', render: (t) => statusPill(t.after.status) },
    { key: 'outcome', label: 'Outcome', render: (t) => esc(OUTCOME_LABEL[t.outcome] ?? '—') },
    { key: 'moved', label: 'Which side moved', render: (t) => esc(t.moved ?? '—') },
  ];
  return dataTable(columns, timeline, { emptyMessage: 'No engagements recorded in this period.' });
}

export function onAction(action, el, ctx) {
  if (handleFilterAction(action, el, ctx)) return;
  if (action === 'export') {
    const rows = ctx.analytics.fieldEffectiveness.timeline.map((t) => ({
      engagement_date: t.action_at,
      action_type: t.action_type,
      outlet: t.outlet_name,
      territory: t.territory_name,
      sku: t.sku_name,
      strategic_sku: t.is_strategic ? 'Yes' : 'No',
      observed_before_at: t.before.observed_at,
      jti_price_before: t.before.jti_price,
      competitor_price_before: t.before.competitor_price ?? '',
      gap_before: t.before.gap ?? '',
      observed_after_at: t.after.observed_at,
      jti_price_after: t.after.jti_price,
      competitor_price_after: t.after.competitor_price ?? '',
      gap_after: t.after.gap ?? '',
      observed_price_change: t.observed_price_change,
      observed_gap_improvement: t.observed_gap_improvement ?? '',
      outcome: OUTCOME_LABEL[t.outcome] ?? '',
      which_side_moved: t.moved ?? '',
      note: 'Observed sequence — not a causal attribution',
    }));
    downloadCsv('field-actions.csv', Object.keys(rows[0] ?? { outlet: '' }), rows);
  }
}

export function onChange(target, ctx) {
  return handleFilterChange(target, ctx);
}
