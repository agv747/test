/** §16, §17, §26, §27, §32 — Master data and tunable business configuration. */

import { esc, money, num, pct } from '../lib/format.js';
import { dataTable, disclaimer, inputField, selectField, strategicPill } from './dom.js';
import { downloadCsv, parseCsv } from '../lib/csv.js';
import { listProviders, getActiveProvider, setActiveProvider } from '../services/recognition/provider.js';

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
  return `<div class="card">
    <div class="card__head"><h2>Image recognition provider (§27)</h2></div>
    ${disclaimer('Recognition is an <strong>input mechanism</strong>; Price Intelligence is the product. The provider is behind an interface — swapping the MVP simulator for Trax, a Vision API or a multimodal model requires no UI change.')}
    <div class="filters">
      ${selectField({
        label: 'Active provider',
        name: 'provider',
        value: active.id,
        includeAll: false,
        options: providers.map((p) => ({ value: p.id, label: `${p.label} (${p.kind})` })),
      })}
    </div>
    <h3 class="mt">Interface contract</h3>
    <pre class="small mono" style="background:var(--surface-2);padding:12px;border-radius:var(--radius-sm);overflow-x:auto">analyzePriceImage(image, context) -&gt; detections[]

detection = {
  raw_text, brand_candidate, sku_candidate,
  price_candidate, confidence,
  bounding_box?, alternatives?
}</pre>
    <p class="small">Every detection is stored with both the <strong>original detected value</strong> and the <strong>confirmed value</strong>, plus a manual-correction flag — so corrections are available later as labelled training examples.</p>
    <p class="small">Manual corrections recorded so far:
      <strong>${ctx.data.price_observations.filter((o) => o.manual_correction).length}</strong>
      of ${ctx.data.price_observations.length} observations
      (${pct((ctx.data.price_observations.filter((o) => o.manual_correction).length / Math.max(1, ctx.data.price_observations.length)) * 100)}).</p>
  </div>`;
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
  if (d.filter === 'provider') {
    setActiveProvider(target.value);
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
