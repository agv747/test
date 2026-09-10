/** §16, §17, §26, §27, §32 — Master data and tunable business configuration. */

import { esc, money, num, pct } from '../lib/format.js';
import { dataTable, disclaimer, inputField, selectField, strategicPill } from './dom.js';
import { downloadCsv, parseCsv } from '../lib/csv.js';
import { listProviders, getActiveProvider, setActiveProvider } from '../services/recognition/provider.js';
import { RECOGNITION_MODELS } from '../config.js';
import { DEMO_IMAGES } from '../demoImages.js';

let tab = 'skus';

export const title = () => 'Admin / Master Data';
export const subtitle = () => 'SKU master, strategic flags, scoring weights and thresholds';

const TABS = [
  ['skus', 'SKU master'],
  ['scoring', 'Priority scoring'],
  ['thresholds', 'Thresholds'],
  ['recognition', 'Recognition provider'],
  ['database', 'Database'],
  ['exports', 'Exports'],
];

/** Populated asynchronously by mount(); null until the health probe answers. */
let dbHealth = null;
let dbMessage = null;

/** Recognition tab state: binding introspection, the last test call, and licence progress. */
let workerCfg = null;
let testLog = [];
let testing = false;
let licenceModel = null;
let licenceConfirmed = false;
let licenceMessage = null;

function log(line) {
  testLog = [...testLog, `${new Date().toISOString().slice(11, 19)}  ${line}`].slice(-40);
}

export function render(ctx) {
  return `
    <div class="card">
      <div class="toolbar">
        ${TABS.map(
          ([id, label]) =>
            `<button class="btn btn--sm ${tab === id ? 'btn--primary' : ''}" data-action="tab" data-tab="${esc(id)}">${esc(label)}</button>`,
        ).join('')}
      </div>
    </div>
    ${
      tab === 'skus'
        ? skuTab(ctx)
        : tab === 'scoring'
          ? scoringTab(ctx)
          : tab === 'thresholds'
            ? thresholdsTab(ctx)
            : tab === 'recognition'
              ? recognitionTab(ctx)
              : tab === 'database'
                ? databaseTab(ctx)
                : exportsTab(ctx)
    }`;
}

/* -------------------------------------------------------------- database */

function databaseTab(ctx) {
  const { source, error } = ctx.store.dataSource();
  const rows = dbHealth?.counts
    ? Object.entries(dbHealth.counts).map(([table, n]) => `<tr><td>${esc(table)}</td><td class="num">${n}</td></tr>`).join('')
    : '';
  const empty = dbHealth && dbHealth.seeded === false;

  return `<div class="card">
    <div class="card__head"><h2>Data source</h2></div>
    ${
      source === 'database'
        ? disclaimer('Observations are read from and written to the <strong>shared database</strong>. A visit submitted on a phone is visible to a manager on another device.')
        : `<div class="disclaimer" style="background:var(--watch-bg);border-color:var(--watch-border);color:var(--watch)">
             <strong>!</strong><span>Running on <strong>bundled demo data</strong> in this browser only. Changes are not shared with anyone else.
             ${error ? `<br />Reason: ${esc(error)}` : ''}</span></div>`
    }

    ${
      empty
        ? `<div class="card" style="border-color:var(--info-border);background:var(--info-bg);box-shadow:none">
             <h3>The database is reachable but empty</h3>
             <p class="small">Load the demo dataset into it once. Afterwards every device reads the same observations.</p>
             <button class="btn btn--primary btn--sm" data-action="seed-db">Load demo data into the database</button>
           </div>`
        : ''
    }
    ${dbMessage ? `<p class="small">${esc(dbMessage)}</p>` : ''}

    ${
      rows
        ? `<h3 class="mt">Rows in the database</h3>
           <div class="table-wrap"><table><thead><tr><th class="no-sort">Table</th><th class="no-sort right">Rows</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<p class="small muted mt">No database reachable from this build.</p>'
    }

    <h3 class="mt">What lives where</h3>
    <ul class="small">
      <li><strong>Database</strong> — outlets, SKUs, price rules, competitor mappings, visits, images, observations, field actions and opportunity status. Shared by everyone.</li>
      <li><strong>This browser</strong> — the selected user, manager filter state and the tuning values on the other tabs. Personal preferences, not observations.</li>
    </ul>
    <button class="btn btn--sm mt" data-action="refresh-health">Refresh</button>
  </div>`;
}

/* ------------------------------------------------------------- SKU master */

function skuTab(ctx) {
  const brands = new Map(ctx.data.brands.map((b) => [b.id, b]));
  const columns = [
    { key: 'name', label: 'SKU', render: (s) => `${esc(s.name)} ${strategicPill(s)}` },
    { key: 'sku_code', label: 'Code', render: (s) => `<span class="mono xsmall">${esc(s.sku_code)}</span>` },
    { key: 'brand', label: 'Brand', render: (s) => esc(brands.get(s.brand_id)?.name ?? ''), sortValue: (s) => brands.get(s.brand_id)?.name ?? '' },
    { key: 'owner', label: 'Owner', render: (s) => esc(s.is_jti ? 'JTI' : brands.get(s.brand_id)?.company ?? 'Competitor'), sortValue: (s) => (s.is_jti ? 0 : 1) },
    { key: 'tier', label: 'Tier', render: (s) => esc(s.tier ?? '—') },
    {
      key: 'is_strategic',
      label: 'Strategic SKU',
      sortable: false,
      render: (s) =>
        s.is_jti
          ? `<label class="checkbox"><input type="checkbox" data-filter="sku-strategic" data-sku="${esc(s.id)}" ${s.is_strategic ? 'checked' : ''} /> Strategic</label>`
          : '<span class="muted">—</span>',
    },
    {
      key: 'strategic_priority',
      label: 'Strategic priority',
      sortable: false,
      render: (s) =>
        s.is_jti && s.is_strategic
          ? `<select data-filter="sku-priority" data-sku="${esc(s.id)}" style="width:auto">
              ${['High', 'Medium', 'Low']
                .map((p) => `<option value="${p}"${s.strategic_priority === p ? ' selected' : ''}>${p}</option>`)
                .join('')}
            </select>`
          : '<span class="muted">—</span>',
    },
    {
      key: 'active',
      label: 'Active',
      sortable: false,
      render: (s) => `<label class="checkbox"><input type="checkbox" data-filter="sku-active" data-sku="${esc(s.id)}" ${s.active !== false ? 'checked' : ''} /> Active</label>`,
    },
  ];

  return `<div class="card">
    <div class="card__head">
      <h2>SKU master</h2>
      <div class="toolbar">
        <button class="btn btn--sm" data-action="export-skus">⇩ Export CSV</button>
        <button class="btn btn--sm" data-action="import-skus">⇧ Import CSV</button>
        <input type="file" id="sku-import" accept=".csv,text/csv" class="hidden" />
      </div>
    </div>
    <p class="xsmall muted">Strategic SKUs receive additional weight in the opportunity priority score and are reported separately on the Price Control Tower.</p>
    ${dataTable(columns, ctx.data.skus)}
  </div>`;
}

/* -------------------------------------------------------- priority scoring */

function scoringTab(ctx) {
  const w = ctx.config.priority_scoring;
  const numeric = [
    ['recommended_range_severity_per_pct', 'Recommended-range severity per 1% deviation'],
    ['recommended_range_severity_cap', 'Recommended-range severity cap'],
    ['competitive_gap_severity_per_index_point', 'Competitive severity per Price Index point'],
    ['competitive_gap_severity_cap', 'Competitive severity cap'],
    ['outlet_scale_per_outlet', 'Weight per additional affected outlet'],
    ['outlet_scale_cap', 'Outlet-scale cap'],
    ['persistence_per_day', 'Weight per day open'],
    ['persistence_cap', 'Persistence cap'],
    ['competitor_move_weight', 'Recent competitor move weight'],
    ['unresolved_action_weight', 'Unresolved field action weight'],
    ['low_confidence_penalty', 'Low data-confidence penalty'],
  ];

  return `<div class="card">
    <div class="card__head"><h2>Opportunity priority scoring</h2>
      <span class="card__sub">No scoring value is hard-coded in the UI — every weight is read from here</span></div>
    <p class="small mono" style="background:var(--surface-2);padding:9px;border-radius:var(--radius-sm)">
      Priority Score = Strategic Weight + Competitive Gap Severity + Recommended Range Severity + Persistence + Outlet Scale + Competitor Move Weight + Unresolved Action − Low Confidence Penalty
    </p>
    <h3 class="mt">Strategic weights</h3>
    <div class="filters">
      ${['High', 'Medium', 'Low']
        .map((p) =>
          inputField({
            label: `Strategic priority: ${p}`,
            name: `sw-${p}`,
            type: 'number',
            value: w.strategic_weight[p],
            attrs: `step="1" min="0" data-scoring="strategic_weight.${p}"`,
          }),
        )
        .join('')}
    </div>
    <h3 class="mt">Component weights</h3>
    <div class="filters">
      ${numeric
        .map(([key, label]) =>
          inputField({ label, name: key, type: 'number', value: w[key], attrs: `step="0.1" min="0" data-scoring="${key}"` }),
        )
        .join('')}
    </div>
    <h3 class="mt">Classification thresholds</h3>
    <div class="filters">
      ${inputField({ label: 'High priority at score ≥', name: 'th-high', type: 'number', value: w.thresholds.high, attrs: 'step="1" data-scoring="thresholds.high"' })}
      ${inputField({ label: 'Medium priority at score ≥', name: 'th-medium', type: 'number', value: w.thresholds.medium, attrs: 'step="1" data-scoring="thresholds.medium"' })}
    </div>
    <p class="small mt">Current distribution with these settings:
      ${['High', 'Medium', 'Low']
        .map((label) => `<span class="tag">${label}: ${ctx.analytics.opportunities.filter((o) => o.priority_label === label).length}</span>`)
        .join(' ')}
    </p>
  </div>`;
}

/* --------------------------------------------------------------- thresholds */

function thresholdsTab(ctx) {
  const c = ctx.config;
  return `<div class="card">
      <div class="card__head"><h2>Recognition confidence</h2></div>
      <div class="filters">
        ${inputField({ label: 'Review threshold (0–1)', name: 'conf-review', type: 'number', value: c.confidence_review_threshold, attrs: 'step="0.05" min="0" max="1" data-config="confidence_review_threshold"' })}
        ${inputField({ label: 'Analytics threshold (0–1)', name: 'conf-analytics', type: 'number', value: c.confidence_analytics_threshold, attrs: 'step="0.05" min="0" max="1" data-config="confidence_analytics_threshold"' })}
      </div>
    </div>
    <div class="card">
      <div class="card__head"><h2>Data freshness (§26)</h2></div>
      <div class="filters">
        ${inputField({ label: 'Fresh up to (days)', name: 'fresh', type: 'number', value: c.freshness.fresh_max_days, attrs: 'step="1" min="1" data-nested="freshness.fresh_max_days"' })}
        ${inputField({ label: 'Aging up to (days)', name: 'aging', type: 'number', value: c.freshness.aging_max_days, attrs: 'step="1" min="1" data-nested="freshness.aging_max_days"' })}
      </div>
      <p class="xsmall muted">Anything older than the aging threshold is labelled Stale and visually distinguished in every comparison.</p>
    </div>
    <div class="card">
      <div class="card__head"><h2>Price dispersion (§15)</h2></div>
      <div class="filters">
        ${inputField({ label: 'High dispersion at P90−P10 ≥ (SGD)', name: 'disp-abs', type: 'number', value: c.dispersion.high_dispersion_abs, attrs: 'step="0.05" min="0" data-nested="dispersion.high_dispersion_abs"' })}
        ${inputField({ label: 'High dispersion at spread ≥ (%)', name: 'disp-pct', type: 'number', value: c.dispersion.high_dispersion_pct, attrs: 'step="0.1" min="0" data-nested="dispersion.high_dispersion_pct"' })}
        ${inputField({ label: 'Minimum observations', name: 'disp-min', type: 'number', value: c.dispersion.min_observations, attrs: 'step="1" min="1" data-nested="dispersion.min_observations"' })}
      </div>
    </div>
    <div class="card">
      <div class="card__head"><h2>Persistent deviation (§24)</h2></div>
      <div class="filters">
        ${inputField({ label: 'Consecutive visits', name: 'pers-visits', type: 'number', value: c.persistence.min_consecutive_visits, attrs: 'step="1" min="1" data-nested="persistence.min_consecutive_visits"' })}
        ${inputField({ label: 'Or open for at least (days)', name: 'pers-days', type: 'number', value: c.persistence.min_days_open, attrs: 'step="1" min="1" data-nested="persistence.min_days_open"' })}
      </div>
    </div>
    <div class="card">
      <div class="card__head"><h2>Competitive comparison method (§24)</h2></div>
      <div class="filters">
        ${selectField({
          label: 'Default comparison method',
          name: 'comparison_method',
          value: c.comparison_method,
          includeAll: false,
          options: [
            { value: 'both', label: 'Either measure (gap OR Price Index)' },
            { value: 'gap', label: 'Price gap only' },
            { value: 'price_index', label: 'Price Index only' },
          ],
        })}
      </div>
      <p class="xsmall muted">Individual competitor mappings may override this.</p>
    </div>`;
}

/* -------------------------------------------------------------- recognition */

function recognitionTab(ctx) {
  const providers = listProviders();
  const active = getActiveProvider();
  const corrections = ctx.data.price_observations.filter((o) => o.manual_correction).length;
  const total = Math.max(1, ctx.data.price_observations.length);

  const card = (p) => {
    const selected = p.id === active.id;
    const simulated = p.reads_image === false;
    const paid = p.tier === 'paid';
    const byoKey = p.tier === 'byo-key';
    const keyMissing = byoKey && workerCfg && !workerCfg.openai_key_configured;
    return `<div class="detection detection--${selected ? 'good' : paid ? 'watch' : 'none'}" style="cursor:pointer"
        data-action="pick-model" data-model="${esc(p.id)}">
      <div class="detection__head">
        <div class="detection__body">
          <div class="detection__name">${esc(p.label)}
            ${selected ? '<span class="pill pill--good">✓ Active</span>' : ''}
            ${p.recommended && !selected ? '<span class="pill pill--info">Recommended</span>' : ''}
            ${simulated
              ? '<span class="pill pill--watch">! Does not read the image</span>'
              : byoKey
                ? (keyMissing
                    ? '<span class="pill pill--risk">▲ API key not configured</span>'
                    : '<span class="pill pill--good">✓ Your OpenAI key</span>')
                : paid
                  ? '<span class="pill pill--risk">$ Needs paid plan or credits</span>'
                  : '<span class="pill pill--good">✓ Free allocation</span>'}
          </div>
          <div class="detection__meta mono xsmall">${esc(p.id)}</div>
          <div class="detection__meta">${esc(p.description ?? '')}</div>
          <div class="detection__meta"><strong>Cost:</strong> ${esc(p.cost ?? '—')}</div>
          ${p.licence ? `<div class="detection__meta"><strong>Licence:</strong> ${esc(p.licence.name)} — one-time acceptance required</div>` : ''}
          ${p.requires_secret ? `<div class="detection__meta"><strong>Requires secret:</strong> <span class="mono">${esc(p.requires_secret)}</span> on the Worker</div>` : ''}
          ${
            p.reads_image
              ? `<div class="toolbar" style="margin-top:7px">
                   <button class="btn btn--sm" data-action="test-model" data-model="${esc(p.id)}" ${testing ? 'disabled' : ''}>▷ Test on a sample image</button>
                   ${p.licence ? `<button class="btn btn--sm" data-action="show-licence" data-model="${esc(p.id)}">Accept licence…</button>` : ''}
                 </div>`
              : ''
          }
        </div>
      </div>
    </div>`;
  };

  // Free options first, so the cheapest working choice is the one in front of the reader.
  const ordered = [...providers].sort((a, b) => {
    const rank = (p) =>
      p.reads_image === false ? 0 : p.tier === 'free' ? 1 : p.tier === 'byo-key' ? 2 : 3;
    return rank(a) - rank(b);
  });

  return `<div class="card">
    <div class="card__head"><h2>How recognition works</h2></div>
    ${disclaimer(
      'Recognition is an <strong>input mechanism</strong>; Price Intelligence is the product. Every model below returns the same detection shape, so switching one for another changes no other part of the app.',
    )}

    <div class="decision decision--${active.reads_image === false ? 'watch' : 'good'}">
      <div class="decision__label">Active model</div>
      <div class="decision__value">${esc(active.label)}</div>
      <div class="decision__note">${
        active.reads_image === false
          ? '<strong>This model does not look at the photograph.</strong> It generates plausible detections from the SKU catalogue and the effective price rules, seeded from the image file identity so the same photo always gives the same answer. Useful for demos and offline work; the prices it reports are invented.'
          : 'Runs server-side through the Worker\u2019s AI binding. The image is downscaled in the browser, sent to the Worker, and the model reads the price list. No credential reaches the device.'
      }</div>
    </div>

    <h3 class="mt">Available models</h3>
    ${ordered.map(card).join('')}
    ${disclaimer('Workers AI includes <strong>10,000 Neurons per day at no charge</strong> on both the Free and Paid plans. Models marked <em>Free allocation</em> run inside it. Models marked <em>Needs paid plan or credits</em> are frontier or third-party models and will fail with a credits error until billing is arranged.')}
    <p class="xsmall muted">Cloudflare-hosted models need only the <span class="mono">[ai]</span> binding. Models routed through AI Gateway additionally need a gateway with Unified Billing, where Cloudflare holds the provider credentials — no API key is stored in this application.</p>
  </div>

  <div class="card">
    <div class="card__head"><h2>Provider interface (§27)</h2></div>
    <pre class="small mono" style="background:var(--surface-2);padding:12px;border-radius:var(--radius-sm);overflow-x:auto">analyzePriceImage(image, context) -&gt; detections[]

detection = {
  raw_text, brand_candidate, sku_candidate,
  price_candidate, confidence,
  bounding_box?, alternatives?
}</pre>
    <p class="small">A real model returns free text, so the Worker matches what it read back to catalogue SKUs by brand and variant tokens. A line it cannot match is still shown to the TME with its price, flagged low confidence, rather than being dropped.</p>
    <p class="small">Every detection is stored with both the <strong>original detected value</strong> and the <strong>confirmed value</strong>, plus a manual-correction flag — so corrections accumulate as labelled examples for evaluating or fine-tuning a model later.</p>
    <p class="small">Manual corrections recorded so far:
      <strong>${corrections}</strong> of ${ctx.data.price_observations.length} observations
      (${pct((corrections / total) * 100)}).</p>
  </div>

  ${licenceModel ? licencePanel() : ''}

  <div class="card">
    <div class="card__head">
      <h2>Deployment configuration</h2>
      <button class="btn btn--sm" data-action="refresh-config">Refresh</button>
    </div>
    ${
      workerCfg
        ? `<dl style="margin:0">
             ${bindingRow('AI binding (env.AI)', workerCfg.ai_binding)}
             ${bindingRow('Database binding (env.DB)', workerCfg.db_binding)}
             <div class="detection__row"><dt>AI Gateway id</dt><dd class="mono">${esc(workerCfg.ai_gateway_id)}</dd></div>
             ${bindingRow('Re-seed token configured', workerCfg.seed_token_configured)}
             ${bindingRow('OpenAI API key (OPENAI_API_KEY)', workerCfg.openai_key_configured)}
           </dl>
           ${workerCfg.openai_key_configured ? '' : openAiSetup()}
           <p class="xsmall muted mt">Without the AI binding only the simulator works. Without the database binding the app falls back to bundled data in each browser.</p>`
        : '<p class="small muted">No API reachable from this build — recognition models and the database are unavailable, and the simulator is used.</p>'
    }
  </div>

  <div class="card">
    <div class="card__head">
      <h2>Call log</h2>
      <div class="toolbar">
        <span class="card__sub">Raw request and response from the last test</span>
        <button class="btn btn--sm" data-action="clear-log" ${testLog.length ? '' : 'disabled'}>Clear</button>
      </div>
    </div>
    <pre class="small mono" style="background:#14181f;color:#cfe0d9;padding:12px;border-radius:var(--radius-sm);overflow-x:auto;max-height:420px;white-space:pre-wrap">${
      testLog.length ? esc(testLog.join('\n')) : 'No calls yet. Press “Test on a sample image” above to run one model against a demo price list and see exactly what it returns.'
    }</pre>
  </div>`;
}

/**
 * The key is set as a Worker secret, not entered here.
 *
 * This application has no authentication: anyone with the URL can use it. A key stored in
 * the database, or accepted through a form and echoed back, would be a key anyone with the
 * URL could take or spend. As a Worker secret it is readable only by the Worker itself.
 */
function openAiSetup() {
  return `<div class="card" style="border-color:var(--info-border);background:var(--info-bg);box-shadow:none;margin-top:12px">
    <h3>Using your own OpenAI key</h3>
    <p class="small">The key is stored as a <strong>Worker secret</strong> — never in this application's database, and never returned to a browser. Set it once:</p>
    <ol class="small">
      <li>Create a key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">platform.openai.com/api-keys</a>.</li>
      <li>Cloudflare dashboard → <strong>Workers &amp; Pages</strong> → this Worker → <strong>Settings</strong> → <strong>Variables and Secrets</strong>.</li>
      <li><strong>Add</strong> → type <strong>Secret</strong> → name <span class="mono">OPENAI_API_KEY</span> → paste the key → <strong>Deploy</strong>.</li>
      <li>Come back here, press <strong>Refresh</strong>, then <strong>Test on a sample image</strong>.</li>
    </ol>
    <p class="xsmall muted">From a terminal instead: <span class="mono">npx wrangler secret put OPENAI_API_KEY</span></p>
    <p class="xsmall muted">Anyone who can open this application can spend against that key, because there is no sign-in. Use a key with a spending limit set on the OpenAI side.</p>
  </div>`;
}

function bindingRow(label, present) {
  return `<div class="detection__row"><dt>${esc(label)}</dt><dd>${
    present
      ? '<span class="pill pill--good">✓ Present</span>'
      : '<span class="pill pill--risk">▲ Missing</span>'
  }</dd></div>`;
}

/**
 * Licence acceptance is a legal act — Meta's terms carry a representation about where the
 * accepting party is domiciled — so the terms are shown and a box must be ticked. Nothing
 * is sent on the user's behalf without that.
 */
function licencePanel() {
  const model = RECOGNITION_MODELS.find((m) => m.id === licenceModel);
  if (!model?.licence) return '';
  const l = model.licence;

  return `<div class="modal-backdrop"><div class="modal">
    <div class="card__head"><h2>${esc(l.name)}</h2>
      <button class="btn btn--sm" data-action="close-licence">Close</button></div>

    <p class="small">Before <strong>${esc(model.label)}</strong> can be used, the provider requires a one-time acceptance recorded against this Cloudflare account. Read both documents before accepting:</p>
    <ul class="small">
      <li><a href="${esc(l.terms)}" target="_blank" rel="noopener noreferrer">${esc(l.name)}</a></li>
      <li><a href="${esc(l.policy)}" target="_blank" rel="noopener noreferrer">Acceptable Use Policy</a></li>
    </ul>

    ${
      l.eu_excluded
        ? `<div class="disclaimer" style="background:var(--watch-bg);border-color:var(--watch-border);color:var(--watch)">
             <strong>!</strong><span>Accepting also represents that you are <strong>not an individual domiciled in, or a company with a principal place of business in, the European Union</strong>. If that is not true of your organisation, do not accept — use LLaVA 1.5 7B instead, which carries no such restriction.</span></div>`
        : ''
    }

    <label class="checkbox mt"><input type="checkbox" data-filter="licence-confirm" ${licenceConfirmed ? 'checked' : ''} />
      I have read both documents and accept them on behalf of this account.</label>

    ${licenceMessage ? `<p class="small mt">${esc(licenceMessage)}</p>` : ''}

    <div class="toolbar mt">
      <button class="btn btn--primary" data-action="accept-licence" data-model="${esc(model.id)}" ${licenceConfirmed ? '' : 'disabled'}>Accept licence</button>
      <button class="btn" data-action="close-licence">Cancel</button>
    </div>
  </div></div>`;
}

/* ------------------------------------------------------------------ exports */

const EXPORTS = [
  ['observations', 'Price observations'],
  ['opportunities', 'Pricing opportunities'],
  ['competitor-moves', 'Competitor moves'],
  ['field-actions', 'Field actions'],
  ['price-rules', 'Price rules'],
  ['competitor-mappings', 'Competitor mappings'],
  ['dispersion', 'SKU dispersion analysis'],
];

function exportsTab(ctx) {
  return `<div class="card">
    <div class="card__head"><h2>Exports (§32)</h2>
      <span class="card__sub">Exports respect the currently selected manager filters</span></div>
    <div class="grid grid--3">
      ${EXPORTS.map(
        ([id, label]) => `<button class="btn" data-action="export" data-export="${esc(id)}">⇩ ${esc(label)}</button>`,
      ).join('')}
    </div>
    <p class="small mt">Observations in scope: <strong>${ctx.analytics.observations.length}</strong> ·
      Opportunities: <strong>${ctx.analytics.opportunities.length}</strong></p>
    <h3 class="mt">Demo data</h3>
    <button class="btn btn--danger" data-action="reset-demo">Reset demo dataset</button>
  </div>`;
}

/* -------------------------------------------------------------- interaction */

export function onAction(action, el, ctx) {
  switch (action) {
    case 'tab':
      tab = el.dataset.tab;
      dbMessage = null;
      ctx.render();
      break;
    case 'pick-model': {
      const id = el.dataset.model;
      try {
        setActiveProvider(id);
        ctx.store.updateConfig({ recognition_model: id });
      } catch (err) {
        console.error(err);
      }
      ctx.render();
      break;
    }
    case 'test-model': {
      const model = el.dataset.model;
      testing = true;
      log(`POST /api/recognise  model=${model}`);
      ctx.render();

      const skus = ctx.data.skus.map((sku) => ({
        id: sku.id,
        name: sku.name,
        brand_name: ctx.data.brands.find((b) => b.id === sku.brand_id)?.name ?? '',
        sku_code: sku.sku_code,
        is_jti: sku.is_jti,
      }));

      ctx.store
        .testRecognitionModel(model, DEMO_IMAGES[0].url, skus, ctx.config.currency)
        .then((result) => {
          log(`image: ${DEMO_IMAGES[0].file} (${Math.round(result.image_bytes / 1024)} KB)`);
          log(`HTTP ${result.status} in ${result.elapsed_ms} ms`);
          if (result.error) {
            log(`ERROR  ${result.error}`);
            if (result.raw_error) log(`raw    ${result.raw_error}`);
          } else {
            log(`detections: ${result.detections?.length ?? 0}, unmatched: ${result.unmatched ?? 0}`);
            for (const d of result.detections ?? []) {
              log(`  ${(d.sku_candidate ?? 'UNMATCHED').padEnd(32)} ${String(d.price_candidate).padStart(7)}  conf ${d.confidence}`);
            }
            log('--- raw model response ---');
            log(result.raw_response ?? '(empty)');
          }
        })
        .catch((err) => log(`ERROR  ${err.message}`))
        .finally(() => {
          testing = false;
          ctx.render();
        });
      break;
    }
    case 'clear-log':
      testLog = [];
      ctx.render();
      break;
    case 'refresh-config':
      workerCfg = null;
      ctx.render();
      break;
    case 'show-licence':
      licenceModel = el.dataset.model;
      licenceConfirmed = false;
      licenceMessage = null;
      ctx.render();
      break;
    case 'close-licence':
      licenceModel = null;
      licenceConfirmed = false;
      ctx.render();
      break;
    case 'accept-licence': {
      const model = el.dataset.model;
      el.disabled = true;
      licenceMessage = 'Sending acceptance…';
      log(`POST /api/model-licence  model=${model}`);
      ctx.render();
      ctx.store
        .acceptModelLicence(model)
        .then(() => {
          licenceMessage = 'Accepted. The model can now be used — run a test to confirm.';
          log('licence accepted');
          licenceModel = null;
          ctx.render();
        })
        .catch((err) => {
          licenceMessage = err.message;
          log(`ERROR  ${err.message}`);
          ctx.render();
        });
      break;
    }
    case 'refresh-health':
      dbHealth = null;
      dbMessage = null;
      ctx.render();
      break;
    case 'seed-db':
      el.disabled = true;
      dbMessage = 'Loading the demo dataset into the database…';
      ctx.store
        .seedDatabase()
        .then((result) => {
          dbHealth = null;
          dbMessage = `Loaded ${result.rows} rows. Every device now reads the same data.`;
          ctx.render();
        })
        .catch((err) => {
          dbMessage = `Could not load the dataset: ${err.message}`;
          ctx.render();
        });
      break;
    case 'export-skus':
      downloadCsv(
        'skus.csv',
        ['id', 'sku_code', 'name', 'brand_id', 'is_jti', 'is_strategic', 'strategic_priority', 'tier', 'active'],
        ctx.data.skus,
      );
      break;
    case 'import-skus':
      document.querySelector('#sku-import')?.click();
      break;
    case 'export':
      runExport(el.dataset.export, ctx);
      break;
    default:
      break;
  }
}

function runExport(kind, ctx) {
  const a = ctx.analytics;
  if (kind === 'observations') {
    const rows = a.observations.map((o) => ({
      observed_at: o.observed_at,
      outlet_code: o.outlet_code,
      outlet: o.outlet_name,
      territory: o.territory_name,
      channel: o.channel_name,
      tme: o.user_name,
      sku: o.sku_name,
      owner: o.is_jti ? 'JTI' : o.company,
      strategic_sku: o.is_strategic ? 'Yes' : 'No',
      detected_price: o.detected_price,
      confirmed_price: o.confirmed_price,
      currency: o.currency,
      manual_correction: o.manual_correction ? 'Yes' : 'No',
      recognition_confidence: o.recognition_confidence,
      image_source: o.image_source ?? '',
      recommended_price_snapshot: o.recommended_price_snapshot ?? '',
      recommended_min_snapshot: o.recommended_min_snapshot ?? '',
      recommended_max_snapshot: o.recommended_max_snapshot ?? '',
      competitor_sku: o.competitor_sku_name ?? '',
      competitor_price: o.competitor_price ?? '',
      price_gap: o.evaluation?.gap ?? '',
      price_index: o.evaluation?.priceIndex ?? '',
      status: o.evaluation?.status ?? '',
      data_freshness: o.freshness?.label ?? '',
    }));
    downloadCsv('price-observations.csv', Object.keys(rows[0] ?? { sku: '' }), rows);
    return;
  }
  if (kind === 'opportunities') {
    const rows = a.opportunities.map((o) => ({
      priority: o.priority_label,
      priority_score: o.priority_score,
      category: o.category,
      territory: o.territory_name,
      outlet: o.outlet_name,
      jti_sku: o.jti_sku_name,
      strategic_sku: o.is_strategic ? 'Yes' : 'No',
      jti_price: o.jti_price,
      competitor_sku: o.competitor_sku_name ?? '',
      competitor_price: o.competitor_price ?? '',
      price_gap: o.price_gap ?? '',
      price_index: o.price_index ?? '',
      first_detected: o.first_detected_at,
      last_detected: o.last_detected_at,
      days_open: o.days_open,
      status: o.status,
    }));
    downloadCsv('pricing-opportunities.csv', Object.keys(rows[0] ?? { outlet: '' }), rows);
    return;
  }
  if (kind === 'competitor-moves') {
    downloadCsv(
      'competitor-moves.csv',
      ['competitor_company', 'competitor_sku_name', 'previous_price', 'current_price', 'change', 'pct_change', 'affected_outlets', 'new_gap', 'new_price_index', 'priority'],
      a.competitorMoves,
    );
    return;
  }
  if (kind === 'field-actions') {
    const rows = ctx.data.field_actions.map((f) => ({
      action_at: f.action_at,
      outlet: ctx.data.outlets.find((o) => o.id === f.outlet_id)?.name ?? f.outlet_id,
      tme: ctx.data.users.find((u) => u.id === f.user_id)?.name ?? f.user_id,
      action_type: f.action_type,
      follow_up_date: f.follow_up_date ?? '',
      sku_ids: (f.sku_ids ?? []).join('; '),
      notes: f.notes ?? '',
    }));
    downloadCsv('field-actions.csv', Object.keys(rows[0] ?? { outlet: '' }), rows);
    return;
  }
  if (kind === 'price-rules') {
    downloadCsv(
      'price-rules.csv',
      ['id', 'market', 'territory_id', 'channel_id', 'outlet_id', 'sku_id', 'recommended_price', 'recommended_min', 'recommended_max', 'effective_from', 'effective_to', 'priority', 'active', 'notes'],
      ctx.data.price_rules,
    );
    return;
  }
  if (kind === 'competitor-mappings') {
    downloadCsv(
      'competitor-mappings.csv',
      ['id', 'jti_sku_id', 'competitor_sku_id', 'market', 'territory_id', 'channel_id', 'mapping_priority', 'desired_gap_min', 'desired_gap_max', 'desired_price_index_min', 'desired_price_index_max', 'effective_from', 'effective_to', 'active'],
      ctx.data.competitor_mappings,
    );
    return;
  }
  if (kind === 'dispersion') {
    const rows = a.dispersion.map((d) => ({
      sku: d.sku_name,
      strategic_sku: d.is_strategic ? 'Yes' : 'No',
      observations: d.stats.count,
      outlets: d.outlets,
      min: d.stats.min,
      p10: num(d.stats.p10, 2),
      p25: num(d.stats.p25, 2),
      median: num(d.stats.median, 2),
      p75: num(d.stats.p75, 2),
      p90: num(d.stats.p90, 2),
      max: d.stats.max,
      iqr: num(d.stats.iqr, 2),
      p90_minus_p10: num(d.stats.p90_minus_p10, 2),
      spread_pct: d.spread_pct,
      high_dispersion: d.high_dispersion ? 'Yes' : 'No',
    }));
    downloadCsv('sku-dispersion.csv', Object.keys(rows[0] ?? { sku: '' }), rows);
  }
}

export function onChange(target, ctx) {
  const d = target.dataset;

  if (d.filter === 'licence-confirm') {
    licenceConfirmed = target.checked;
    ctx.render();
    return true;
  }
  if (d.filter === 'sku-strategic') {
    ctx.store.updateSku(d.sku, {
      is_strategic: target.checked,
      strategic_priority: target.checked ? (ctx.data.skus.find((s) => s.id === d.sku)?.strategic_priority ?? 'Medium') : null,
    });
    ctx.render();
    return true;
  }
  if (d.filter === 'sku-priority') {
    ctx.store.updateSku(d.sku, { strategic_priority: target.value });
    ctx.render();
    return true;
  }
  if (d.filter === 'sku-active') {
    ctx.store.updateSku(d.sku, { active: target.checked });
    ctx.render();
    return true;
  }
  if (d.filter === 'comparison_method') {
    ctx.store.updateConfig({ comparison_method: target.value });
    ctx.render();
    return true;
  }
  if (d.config) {
    const value = Number.parseFloat(target.value);
    if (Number.isFinite(value)) {
      ctx.store.updateConfig({ [d.config]: value });
      ctx.render();
    }
    return true;
  }
  if (d.nested) {
    const [group, key] = d.nested.split('.');
    const value = Number.parseFloat(target.value);
    if (Number.isFinite(value)) {
      ctx.store.updateConfig({ [group]: { ...ctx.config[group], [key]: value } });
      ctx.render();
    }
    return true;
  }
  if (d.scoring) {
    const value = Number.parseFloat(target.value);
    if (!Number.isFinite(value)) return true;
    const scoring = structuredClone(ctx.config.priority_scoring);
    if (d.scoring.startsWith('strategic_weight.')) {
      scoring.strategic_weight[d.scoring.split('.')[1]] = value;
    } else if (d.scoring.startsWith('thresholds.')) {
      scoring.thresholds[d.scoring.split('.')[1]] = value;
    } else {
      scoring[d.scoring] = value;
    }
    ctx.store.updateConfig({ priority_scoring: scoring });
    ctx.render();
    return true;
  }
  return false;
}

export function mount(ctx, root) {
  if (tab === 'recognition' && workerCfg === null) {
    ctx.store.workerConfig().then((cfg) => {
      workerCfg = cfg ?? { ai_binding: false, db_binding: false, ai_gateway_id: '—', models: [] };
      ctx.render();
    });
  }
  if (tab === 'database' && dbHealth === null) {
    ctx.store.databaseHealth().then((health) => {
      dbHealth = health ?? { ok: false, seeded: false, counts: {} };
      ctx.render();
    });
  }

  const input = root.querySelector('#sku-import');
  if (!input) return;
  input.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    for (const row of parseCsv(await file.text())) {
      if (!row.id) continue;
      ctx.store.updateSku(row.id, {
        name: row.name || undefined,
        is_strategic: row.is_strategic === 'true' || row.is_strategic === 'Yes',
        strategic_priority: row.strategic_priority || null,
        active: row.active !== 'false',
      });
    }
    ctx.render();
  });
}
