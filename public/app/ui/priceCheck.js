/**
 * §8.2 – §8.12 — the field price-check workflow.
 *
 * Mobile-first, target completion under one minute:
 *   Outlet → Take Photo / Choose from Gallery → Detect → Confirm → Compare → Act → Submit
 */

import {
  PROCESSING_STEPS,
  assessImageQuality,
  readImageDimensions,
} from '../services/imageService.js';
import {
  correctDraft,
  processVisitImages,
  recomputeDrafts,
  summariseVisit,
  toPersistableObservation,
} from '../services/visitService.js';
import { FIELD_ACTION_TYPES, FIELD_RECOMMENDATIONS, PRICE_POSITION_STATUS } from '../config.js';
import { COMPETITIVE_BUCKET, RANGE_BUCKET } from '../services/pricePositionService.js';
import {
  CONFIDENCE_NOTE,
  confidenceBar,
  confidenceMeter,
  esc,
  gapCell,
  indexCell,
  money,
  priceIndex,
  statusPill,
  statusTone,
  strategicPill,
  disclaimer,
  MARKET_CONTEXT_NOTE,
} from './dom.js';
import { dateTimeLabel } from '../lib/format.js';
import { DEMO_IMAGES, loadSampleImage } from '../demoImages.js';
import { shelfSchematic } from './shelfSchematic.js';

export const narrow = true;

/** Wizard state lives for the duration of the check; it is cleared on submit/cancel. */
const state = {
  step: 'outlet',
  outletId: null,
  visitId: null,
  search: '',
  territoryFilter: '',
  images: [],
  drafts: [],
  processingStep: 0,
  expanded: new Set(),
  /** Results view: the working list, or the shelf drawn as a schematic. */
  resultsView: 'list',
  /** Open correction dialog, used from the schematic where there is no card to expand. */
  editingDraftId: null,
  action: { action_type: 'No action', notes: '', follow_up_date: '', sku_ids: [] },
  error: null,
};

export function reset() {
  state.step = 'outlet';
  state.outletId = null;
  state.visitId = null;
  state.search = '';
  state.images = [];
  state.drafts = [];
  state.processingStep = 0;
  state.expanded = new Set();
  state.resultsView = 'list';
  state.editingDraftId = null;
  state.action = { action_type: 'No action', notes: '', follow_up_date: '', sku_ids: [] };
  state.error = null;
}

const STEPS = ['outlet', 'acquire', 'processing', 'results', 'action', 'summary'];

export const title = () => 'Price Check';
export const subtitle = (ctx) => {
  const outlet = ctx.data.outlets.find((o) => o.id === state.outletId);
  return outlet ? `${outlet.name} · ${outlet.outlet_code}` : 'Select an outlet to begin';
};

export function render(ctx) {
  const body =
    state.step === 'outlet'
      ? renderOutletStep(ctx)
      : state.step === 'acquire'
        ? renderAcquireStep(ctx)
        : state.step === 'processing'
          ? renderProcessingStep()
          : state.step === 'results'
            ? renderResultsStep(ctx)
            : state.step === 'action'
              ? renderActionStep(ctx)
              : renderSummaryStep(ctx);

  return `<div class="field-app">
    ${stepBar()}
    ${state.error ? `<div class="disclaimer" style="background:var(--risk-bg);border-color:var(--risk-border);color:var(--risk)"><strong>!</strong><span>${esc(state.error)}</span></div>` : ''}
    ${body}
  </div>`;
}

function stepBar() {
  const idx = STEPS.indexOf(state.step);
  const labels = {
    outlet: 'Step 1 of 5 · Select outlet',
    acquire: 'Step 2 of 5 · Capture or choose an image',
    processing: 'Processing…',
    results: 'Step 3 of 5 · Confirm detected prices',
    action: 'Step 4 of 5 · Record field action',
    summary: 'Step 5 of 5 · Review and submit',
  };
  return `<div class="step-label">${esc(labels[state.step])}</div>
    <div class="steps">${STEPS.map(
      (s, i) =>
        `<div class="step ${i < idx ? 'step--done' : i === idx ? 'step--current' : ''}"></div>`,
    ).join('')}</div>`;
}

/* ------------------------------------------------------- step 1: outlet */

function renderOutletStep(ctx) {
  const { data, user } = ctx;
  const term = state.search.trim().toLowerCase();

  const recentIds = [...new Set(
    data.visits
      .filter((v) => v.user_id === user.id)
      .sort((a, b) => new Date(b.submitted_at ?? b.started_at) - new Date(a.submitted_at ?? a.started_at))
      .map((v) => v.outlet_id),
  )].slice(0, 4);

  let outlets = data.outlets.filter((o) => o.active !== false);
  if (state.territoryFilter) outlets = outlets.filter((o) => o.territory_id === state.territoryFilter);
  if (term) {
    outlets = outlets.filter(
      (o) => o.name.toLowerCase().includes(term) || o.outlet_code.toLowerCase().includes(term),
    );
  } else {
    // Default view: this TME's own outlets, recents first.
    outlets = outlets.filter((o) => o.assigned_tme_id === user.id || recentIds.includes(o.id));
    outlets.sort((a, b) => recentIds.indexOf(b.id) - recentIds.indexOf(a.id));
  }

  return `<div class="card">
      <div class="field mb">
        <label for="outlet-search">Search by outlet name or outlet ID</label>
        <input id="outlet-search" type="search" placeholder="e.g. Punggol or SG-E-1042"
          value="${esc(state.search)}" data-input="outlet-search" autocomplete="off" />
      </div>
      <div class="field">
        <label for="territory-filter">Territory</label>
        <select id="territory-filter" data-input="territory-filter">
          <option value="">All territories</option>
          ${ctx.data.territories
            .map(
              (t) =>
                `<option value="${esc(t.id)}"${t.id === state.territoryFilter ? ' selected' : ''}>${esc(t.name)}</option>`,
            )
            .join('')}
        </select>
      </div>
    </div>
    ${
      outlets.length
        ? outlets.slice(0, 25).map((o) => outletCard(o, ctx, recentIds)).join('')
        : '<div class="empty">No outlets match that search.</div>'
    }`;
}

function outletCard(outlet, ctx, recentIds) {
  const { data, config } = ctx;
  const territory = data.territories.find((t) => t.id === outlet.territory_id);
  const channel = data.channels.find((c) => c.id === outlet.channel_id);
  const visits = data.visits
    .filter((v) => v.outlet_id === outlet.id && v.submitted_at)
    .sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
  const lastVisit = visits[0];
  const lastAction = data.field_actions
    .filter((a) => a.outlet_id === outlet.id)
    .sort((a, b) => new Date(b.action_at) - new Date(a.action_at))[0];

  // Last observed price position summary — one line, no dense tables on mobile.
  const lastObs = lastVisit
    ? data.price_observations.filter((o) => o.visit_id === lastVisit.id && o.recommended_min_snapshot !== null)
    : [];
  const within = lastObs.filter(
    (o) => o.confirmed_price >= o.recommended_min_snapshot && o.confirmed_price <= o.recommended_max_snapshot,
  ).length;

  return `<div class="outlet-card" data-action="pick-outlet" data-outlet="${esc(outlet.id)}">
    <div class="outlet-card__body">
      <div class="outlet-card__name">${esc(outlet.name)}
        ${recentIds.includes(outlet.id) ? '<span class="tag">Recent</span>' : ''}</div>
      <div class="outlet-card__meta">${esc(outlet.outlet_code)} · ${esc(territory?.name ?? '')} · ${esc(channel?.name ?? '')}</div>
      <div class="outlet-card__meta">Last price check: ${esc(lastVisit ? dateTimeLabel(lastVisit.submitted_at) : 'never')}</div>
      ${lastAction ? `<div class="outlet-card__meta">Last field action: ${esc(lastAction.action_type)}</div>` : ''}
      ${lastObs.length ? `<div class="outlet-card__meta">Last position: ${within}/${lastObs.length} JTI observations within recommended range</div>` : ''}
    </div>
    <span class="btn btn--sm btn--primary">Start</span>
  </div>`;
}

/* ------------------------------------------------------ step 2: acquire */

function renderAcquireStep(ctx) {
  return `
    ${disclaimer('Capture or select an image where <strong>SKU / product description and price labels are clearly visible</strong>.')}
    <div class="card">
      <div class="acquire">
        <button class="acquire__btn" data-action="take-photo">
          <span class="icon">📷</span>
          Take Photo
          <small>Opens the device camera</small>
        </button>
        <button class="acquire__btn" data-action="choose-gallery">
          <span class="icon">🖼</span>
          Choose from Gallery
          <small>Select existing photos — JPG, PNG, HEIC</small>
        </button>
      </div>
      <input type="file" id="camera-input" accept="image/*" capture="environment" class="hidden" />
      <input type="file" id="gallery-input" accept="image/*,.heic,.heif" multiple class="hidden" />

      ${state.images.length ? renderThumbs() : '<p class="small muted mt">No images added yet. You can add more than one image to a visit.</p>'}
      <div class="mt">
        <span class="xsmall muted">No shelf photo on this device? Load a sample:</span>
        <div class="toolbar" style="margin-top:5px">
          ${DEMO_IMAGES.map(
            (s, i) =>
              `<button class="btn btn--sm" data-action="use-sample" data-sample="${i}">🖼 ${esc(s.label)}</button>`,
          ).join('')}
        </div>
      </div>
    </div>

    ${state.images.some((i) => !i.quality.usable) ? qualityWarning() : ''}

    <div class="toolbar">
      <button class="btn" data-action="back-to-outlet">‹ Change outlet</button>
      <div class="spacer"></div>
      <button class="btn btn--primary" data-action="process" ${state.images.length ? '' : 'disabled'}>
        Process ${state.images.length || ''} image${state.images.length === 1 ? '' : 's'} →
      </button>
    </div>`;
}

function renderThumbs() {
  return `<div class="thumbs">
    ${state.images
      .map(
        (img) => `<div class="thumb">
          <span class="thumb__source">${esc(img.image_source === 'camera' ? 'Camera' : 'Gallery')}</span>
          <button class="thumb__remove" data-action="remove-image" data-image="${esc(img.id)}" title="Remove image">✕</button>
          ${img.previewUrl ? `<img src="${esc(img.previewUrl)}" alt="${esc(img.name)}" />` : '<div style="height:78px"></div>'}
          <div class="thumb__meta">${esc(img.quality.status)}</div>
        </div>`,
      )
      .join('')}
  </div>`;
}

function qualityWarning() {
  const bad = state.images.filter((i) => !i.quality.usable);
  return `<div class="card" style="border-color:var(--watch-border);background:var(--watch-bg)">
    <h3>⚠ Image quality issue detected</h3>
    ${bad
      .map(
        (i) => `<p class="small"><strong>${esc(i.name)}</strong> — ${esc(i.quality.status)}<br />
          ${i.quality.reasons.map((r) => esc(r)).join('<br />')}</p>`,
      )
      .join('')}
    <div class="toolbar">
      <button class="btn" data-action="take-photo">📷 Retake Photo</button>
      <button class="btn" data-action="choose-gallery">🖼 Choose Another from Gallery</button>
      ${bad.every((i) => i.quality.canContinue) ? '<button class="btn btn--sm" data-action="process">Continue Anyway</button>' : ''}
    </div>
  </div>`;
}

/* --------------------------------------------------- step 3: processing */

function renderProcessingStep() {
  return `<div class="card processing">
    ${PROCESSING_STEPS.map((label, i) => {
      const cls =
        i < state.processingStep ? 'processing__step--done' : i === state.processingStep ? 'processing__step--active' : '';
      const mark = i < state.processingStep ? '✓' : '';
      return `<div class="processing__step ${cls}"><span class="processing__dot">${mark}</span>${esc(label)}</div>`;
    }).join('')}
  </div>`;
}

/* ------------------------------------------------------ step 4: results */

function renderResultsStep(ctx) {
  const jti = state.drafts.filter((d) => d.is_jti);
  const competitor = state.drafts.filter((d) => !d.is_jti);

  return `
    ${decisionCard(jti)}
    ${viewSwitch()}
    ${state.resultsView === 'schematic' ? renderSchematicCard(ctx) : ''}
    <div class="card">
      <div class="card__head">
        <h2>Detected JTI SKUs</h2>
        <span class="card__sub">${jti.length} detection${jti.length === 1 ? '' : 's'} · tap a card to correct</span>
      </div>
      <p class="xsmall muted" style="margin:0 0 8px">${esc(CONFIDENCE_NOTE)}
        Below ${Math.round(ctx.config.confidence_review_threshold * 100)}% a detection is marked
        <strong>Review Required</strong> and never drives a price-position judgement until it is confirmed.</p>
      ${jti.map((d) => detectionCard(d, ctx)).join('') || '<div class="empty">No JTI SKUs detected.</div>'}
    </div>
    <div class="card">
      <div class="card__head">
        <h2>Detected competitor SKUs</h2>
        <span class="card__sub">${competitor.length} detection${competitor.length === 1 ? '' : 's'}</span>
      </div>
      ${competitor.map((d) => detectionCard(d, ctx)).join('') || '<div class="empty">No competitor SKUs detected.</div>'}
    </div>
    <div class="toolbar">
      <button class="btn" data-action="back-to-acquire">‹ Add another image</button>
      <div class="spacer"></div>
      <button class="btn btn--primary" data-action="to-action">Record field action →</button>
    </div>
    ${editorDialog(ctx)}`;
}

/**
 * The correction form as a dialog over the shelf.
 *
 * On the schematic there is nothing to expand in place: the packs are laid out as a shelf,
 * and pushing a form in among them would break the very shape the view exists to show — and
 * on a phone it would open below the fold, out of sight of the pack just tapped. So the same
 * form opens centred, over the shelf, with the pack still visible behind it.
 *
 * It is the same `detectionDetail` the list uses. One form, one set of fields, one place to
 * change them.
 */
function editorDialog(ctx) {
  const draft = state.drafts.find((d) => d.draft_id === state.editingDraftId);
  if (!draft) return '';

  const skuOptions = ctx.data.skus
    .filter((s) => s.active !== false)
    .map(
      (s) =>
        `<option value="${esc(s.id)}"${s.id === draft.sku_id ? ' selected' : ''}>${esc(s.name)}${s.is_jti ? ' (JTI)' : ' (Competitor)'}</option>`,
    )
    .join('');

  // The app's existing dialog convention: a fixed backdrop wrapping a centred panel, as
  // used by Price Rules and Admin.
  return `<div class="modal-backdrop" data-modal>
    <div class="modal" role="dialog" aria-modal="true" tabindex="-1"
      aria-label="${esc(`Correct ${draft.sku?.name ?? 'unrecognised item'}`)}">
      <div class="modal__head">
        <div>
          <div class="modal__title">${esc(draft.sku?.name ?? 'Unrecognised item')}
            ${strategicPill(draft.sku)}
            ${draft.manual_correction ? '<span class="tag">corrected</span>' : ''}</div>
          <div class="detection__meta">${esc(draft.sku?.is_jti ? 'JTI' : draft.brand_candidate ?? 'Competitor')}
            · ${esc(draft.raw_text ?? '')}</div>
        </div>
        <button class="modal__close" data-action="close-editor" aria-label="Close">✕</button>
      </div>
      <div class="modal__summary">
        ${draft.is_jti ? statusPill(draft.evaluation?.status) : '<span class="pill pill--none">Competitor observation</span>'}
        ${confidenceMeter(draft.recognition_confidence, ctx.config.confidence_review_threshold)}
        <span class="modal__price">${money(draft.confirmed_price)}</span>
      </div>
      ${detectionDetail(draft, skuOptions)}
      <div class="toolbar modal__foot">
        <div class="spacer"></div>
        <button class="btn btn--primary" data-action="close-editor">Done</button>
      </div>
    </div>
  </div>`;
}

/**
 * The results read as a working list or as the shape of the shelf. The list stays the
 * default: it is what the TME confirms and submits, and it carries every number.
 */
function viewSwitch() {
  const btn = (view, label) =>
    `<button class="btn btn--sm${state.resultsView === view ? ' btn--primary' : ''}"
      data-action="set-results-view" data-view="${view}"
      aria-pressed="${state.resultsView === view}">${label}</button>`;
  return `<div class="toolbar" style="margin-bottom:10px">
    ${btn('list', '☰ List')}
    ${btn('schematic', '▤ Shelf schematic')}
    <span class="xsmall muted">See the whole shelf at a glance</span>
  </div>`;
}

/** One schematic per image, since a visit can carry several photos of different shelves. */
function renderSchematicCard(ctx) {
  const images = state.images.filter((image) => state.drafts.some((d) => d.image_id === image.id));
  if (!images.length) return '';

  return `<div class="card">
    <div class="card__head">
      <h2>Shelf schematic</h2>
      <span class="card__sub">${state.drafts.length} product${state.drafts.length === 1 ? '' : 's'}
        · ${state.drafts.reduce((total, d) => total + Math.max(1, d.facings ?? 1), 0)} facings · tap one to correct it</span>
    </div>
    ${images
      .map((image) => {
        const drafts = state.drafts.filter((d) => d.image_id === image.id);
        return shelfSchematic(drafts, {
          threshold: ctx.config.confidence_review_threshold,
          imageName: images.length > 1 ? image.name : null,
          simulatedPrices: drafts.some((d) => d.recognition_provider === 'mock-simulator'),
        });
      })
      .join('')}
  </div>`;
}

/** §8.10 — the single decision card the TME acts on. */
function decisionCard(jtiDrafts) {
  const priority = [
    FIELD_RECOMMENDATIONS.FOLLOW_UP,
    FIELD_RECOMMENDATIONS.ENGAGE,
    FIELD_RECOMMENDATIONS.REVIEW_COMPETITIVE,
    FIELD_RECOMMENDATIONS.REVIEW_INVESTMENT,
    FIELD_RECOMMENDATIONS.MONITOR,
    FIELD_RECOMMENDATIONS.NONE,
  ];
  const found = priority.find((p) => jtiDrafts.some((d) => d.recommendation === p));
  const recommendation = found ?? FIELD_RECOMMENDATIONS.NONE;
  const driver = jtiDrafts.find((d) => d.recommendation === recommendation);

  const tone =
    recommendation === FIELD_RECOMMENDATIONS.NONE
      ? 'good'
      : recommendation === FIELD_RECOMMENDATIONS.MONITOR
        ? 'watch'
        : 'risk';

  const notes = [];
  if (driver) {
    if (driver.evaluation?.rangeBucket === RANGE_BUCKET.ABOVE) {
      notes.push(`${driver.sku?.name} is above the recommended range.`);
    } else if (driver.evaluation?.rangeBucket === RANGE_BUCKET.BELOW) {
      notes.push(`${driver.sku?.name} is below the recommended range.`);
    }
    if (driver.evaluation?.competitive.bucket === COMPETITIVE_BUCKET.JTI_EXPENSIVE) {
      notes.push(`Mapped competitor is cheaper (Price Index ${priceIndex(driver.price_index)}).`);
    }
  }

  return `<div class="decision decision--${tone}">
    <div class="decision__label">Suggested next step</div>
    <div class="decision__value">${esc(recommendation)}</div>
    <div class="decision__note">${notes.map((n) => esc(n)).join(' ') || 'Observed prices sit within the desired commercial position.'}</div>
    <div class="decision__note xsmall muted">Advisory only. Trade investment amounts are never calculated or approved here.</div>
  </div>`;
}

function detectionCard(draft, ctx) {
  const expanded = state.expanded.has(draft.draft_id);
  const tone = draft.is_jti ? statusTone(draft.evaluation?.status) : 'none';
  const skuOptions = ctx.data.skus
    .filter((s) => s.active !== false)
    .map(
      (s) =>
        `<option value="${esc(s.id)}"${s.id === draft.sku_id ? ' selected' : ''}>${esc(s.name)}${s.is_jti ? ' (JTI)' : ' (Competitor)'}</option>`,
    )
    .join('');

  return `<div class="detection detection--${tone}" id="draft-${esc(draft.draft_id)}">
    <div class="detection__head" data-action="toggle-detection" data-draft="${esc(draft.draft_id)}">
      <div class="detection__body">
        <div class="detection__name">${esc(draft.sku?.name ?? 'Unrecognised item')}
          ${strategicPill(draft.sku)}
          ${draft.manual_correction ? '<span class="tag">corrected</span>' : ''}</div>
        <div class="detection__meta">${esc(draft.sku?.is_jti ? 'JTI' : draft.brand_candidate ?? 'Competitor')}
          · ${esc(draft.raw_text ?? '')}</div>
        <div class="row" style="margin-top:4px">
          ${draft.is_jti ? statusPill(draft.evaluation?.status) : '<span class="pill pill--none">Competitor observation</span>'}
        </div>
        <div class="row" style="margin-top:4px">
          ${confidenceMeter(draft.recognition_confidence, ctx.config.confidence_review_threshold)}
        </div>
      </div>
      <div style="text-align:right">
        <div class="detection__price">${money(draft.confirmed_price)}</div>
        <div class="xsmall muted">${expanded ? 'Hide' : 'Edit'} ▾</div>
      </div>
    </div>
    ${expanded ? detectionDetail(draft, skuOptions) : ''}
  </div>`;
}

function detectionDetail(draft, skuOptions) {
  const e = draft.evaluation;
  const rows = [];
  if (draft.is_jti) {
    rows.push(['Recommended price', money(draft.recommended_price_snapshot)]);
    rows.push([
      'Recommended range',
      draft.recommended_min_snapshot !== null
        ? `${money(draft.recommended_min_snapshot)} – ${money(draft.recommended_max_snapshot)}`
        : '<span class="muted">No recommendation available</span>',
    ]);
    if (draft.competitor_sku_id_snapshot) {
      rows.push(['Mapped competitor SKU', esc(competitorName(draft))]);
      rows.push([
        'Competitor observed price',
        draft.competitor_price !== null ? money(draft.competitor_price) : '<span class="muted">not observed in this visit</span>',
      ]);
      rows.push(['Price gap', gapCell(draft.price_gap)]);
      rows.push([
        'Price Index',
        indexCell(
          draft.price_index,
          draft.desired_price_index_min_snapshot,
          draft.desired_price_index_max_snapshot,
        ),
      ]);
      rows.push([
        'Desired Price Index',
        draft.desired_price_index_min_snapshot !== null
          ? `${draft.desired_price_index_min_snapshot} – ${draft.desired_price_index_max_snapshot}`
          : '—',
      ]);
    }
    rows.push(['Position status', statusPill(e?.status)]);
    rows.push(['Suggested next step', esc(draft.recommendation ?? '—')]);
  }
  rows.push(['Detected price (original)', money(draft.detected_price)]);
  rows.push(['Recognition confidence', confidenceBar(draft.recognition_confidence)]);
  rows.push(['Image source', esc(draft.image_source === 'camera' ? 'Camera' : 'Gallery')]);
  rows.push(['Recognition provider', esc(draft.recognition_provider ?? '—')]);

  return `<div class="detection__detail">
    <div class="form-grid mb">
      <div class="field">
        <label for="sku-${esc(draft.draft_id)}">SKU</label>
        <select id="sku-${esc(draft.draft_id)}" data-edit="sku" data-draft="${esc(draft.draft_id)}">${skuOptions}</select>
      </div>
      <div class="field">
        <label for="price-${esc(draft.draft_id)}">Confirmed price (SGD)</label>
        <input id="price-${esc(draft.draft_id)}" type="number" step="0.05" min="0"
          value="${draft.confirmed_price ?? ''}" data-edit="price" data-draft="${esc(draft.draft_id)}" />
      </div>
    </div>
    ${
      draft.alternatives?.length
        ? `<div class="mb"><span class="xsmall muted">Alternative candidates: </span>${draft.alternatives
            .map(
              (a) =>
                `<button class="btn btn--sm" data-action="use-alternative" data-draft="${esc(draft.draft_id)}" data-sku="${esc(a.sku_id)}">${esc(a.label)}</button>`,
            )
            .join(' ')}</div>`
        : ''
    }
    <dl style="margin:0">
      ${rows.map(([k, v]) => `<div class="detection__row"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}
    </dl>
    <div class="toolbar mt">
      <button class="btn btn--sm btn--danger" data-action="exclude-draft" data-draft="${esc(draft.draft_id)}">
        ${draft.excluded ? 'Include observation' : 'Exclude observation'}
      </button>
    </div>
  </div>`;
}

function competitorName(draft) {
  return draft.competitor_sku_name ?? draft.competitor_sku_id_snapshot ?? '—';
}

/* ------------------------------------------------------- step 5: action */

function renderActionStep(ctx) {
  const jtiSkus = [...new Set(state.drafts.filter((d) => d.is_jti).map((d) => d.sku_id))]
    .map((id) => ctx.data.skus.find((s) => s.id === id))
    .filter(Boolean);

  return `<div class="card">
      <div class="card__head"><h2>Field action</h2>
        <span class="card__sub">What happened at the outlet?</span></div>
      <div class="field mb">
        <label for="action-type">Action</label>
        <select id="action-type" data-input="action-type">
          ${FIELD_ACTION_TYPES.map(
            (t) => `<option value="${esc(t)}"${t === state.action.action_type ? ' selected' : ''}>${esc(t)}</option>`,
          ).join('')}
        </select>
      </div>
      <div class="field mb">
        <label>Related SKUs</label>
        <div class="row">
          ${jtiSkus
            .map(
              (s) => `<label class="checkbox"><input type="checkbox" data-input="action-sku" value="${esc(s.id)}"
                ${state.action.sku_ids.includes(s.id) ? 'checked' : ''} /> ${esc(s.name)}</label>`,
            )
            .join('')}
        </div>
      </div>
      <div class="field mb">
        <label for="action-followup">Follow-up date (optional)</label>
        <input id="action-followup" type="date" value="${esc(state.action.follow_up_date)}" data-input="action-followup" />
      </div>
      <div class="field">
        <label for="action-notes">Notes</label>
        <textarea id="action-notes" data-input="action-notes" placeholder="What was discussed?">${esc(state.action.notes)}</textarea>
      </div>
    </div>
    <div class="toolbar">
      <button class="btn" data-action="back-to-results">‹ Back to results</button>
      <div class="spacer"></div>
      <button class="btn btn--primary" data-action="to-summary">Review visit →</button>
    </div>`;
}

/* ------------------------------------------------------ step 6: summary */

function renderSummaryStep(ctx) {
  const outlet = ctx.data.outlets.find((o) => o.id === state.outletId);
  const summary = summariseVisit(state.drafts, state.images);

  const cell = (label, value) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;

  return `<div class="card">
      <div class="card__head">
        <h2>${esc(outlet?.name ?? '')}</h2>
        <span class="card__sub">${esc(dateTimeLabel(new Date().toISOString()))}</span>
      </div>
      <dl class="summary-grid">
        ${cell('Images processed', summary.images_processed)}
        ${cell('JTI SKUs observed', summary.jti_observations)}
        ${cell('Competitor SKUs', summary.competitor_observations)}
        ${cell('Within recommended range', summary.within_range)}
        ${cell('Above recommended range', summary.above_range)}
        ${cell('Below recommended range', summary.below_range)}
        ${cell('Competitive position at risk', summary.at_risk)}
        ${cell('Review required', summary.review_required)}
        ${cell('Manual corrections', summary.manual_corrections)}
      </dl>
      <p class="small mt"><strong>Field action:</strong> ${esc(state.action.action_type)}
        ${state.action.follow_up_date ? ` · follow-up ${esc(state.action.follow_up_date)}` : ''}</p>
      ${state.action.notes ? `<p class="small muted">${esc(state.action.notes)}</p>` : ''}
    </div>
    ${disclaimer(esc(MARKET_CONTEXT_NOTE))}
    <div class="toolbar">
      <button class="btn" data-action="back-to-results">Review Results</button>
      <button class="btn" data-action="save-draft">Save Draft</button>
      <div class="spacer"></div>
      <button class="btn btn--primary" data-action="submit-visit">Submit Visit</button>
    </div>`;
}

/* -------------------------------------------------------------- events */

export function mount(ctx, root) {
  const camera = root.querySelector('#camera-input');
  const gallery = root.querySelector('#gallery-input');
  if (camera) camera.addEventListener('change', (e) => handleFiles(e.target.files, 'camera', ctx));
  if (gallery) gallery.addEventListener('change', (e) => handleFiles(e.target.files, 'gallery', ctx));

  const search = root.querySelector('#outlet-search');
  if (search) {
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  }

  mountEditorDialog(ctx, root);
}

/**
 * Closing the correction dialog by clicking away from it or pressing Escape.
 *
 * Both are bound to the dialog's own elements, which the render replaces every time, so
 * there is nothing to remove and no listener can accumulate. The backdrop compares the event
 * target to itself rather than relying on the delegated handler, which would treat any click
 * inside the dialog as a click on the backdrop.
 */
function mountEditorDialog(ctx, root) {
  const modal = root.querySelector('[data-modal]');
  if (!modal) return;

  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeEditor(ctx);
  });
  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeEditor(ctx);
  });

  // Focus moves into the dialog so Escape reaches it and a screen reader announces it.
  // Every correction re-renders the page and replaces the dialog, which leaves focus on
  // <body> and Escape going nowhere — so focus is restored whenever it has fallen outside.
  // Nothing is stolen mid-edit: corrections are committed on `change`, after the field has
  // already been left.
  const dialog = modal.querySelector('.modal');
  if (dialog && !modal.contains(document.activeElement)) dialog.focus();
}


export function onAction(action, el, ctx) {
  switch (action) {
    case 'pick-outlet':
      state.outletId = el.dataset.outlet;
      state.step = 'acquire';
      state.error = null;
      ctx.render();
      break;
    case 'back-to-outlet':
      state.step = 'outlet';
      ctx.render();
      break;
    case 'take-photo':
      document.querySelector('#camera-input')?.click();
      break;
    case 'choose-gallery':
      document.querySelector('#gallery-input')?.click();
      break;
    case 'use-sample':
      loadSampleImage(Number(el.dataset.sample))
        .then((file) => handleFiles([file], 'gallery', ctx))
        .catch((err) => {
          state.error = `Could not load the sample image: ${err.message}`;
          ctx.render();
        });
      break;
    case 'remove-image':
      state.images = state.images.filter((i) => i.id !== el.dataset.image);
      ctx.render();
      break;
    case 'process':
      runProcessing(ctx);
      break;
    case 'back-to-acquire':
      state.step = 'acquire';
      ctx.render();
      break;
    case 'toggle-detection': {
      const id = el.dataset.draft;
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      ctx.render();
      break;
    }
    case 'set-results-view':
      state.resultsView = el.dataset.view;
      ctx.render();
      break;
    case 'focus-detection':
      // A pack on the schematic opens the correction form over the shelf, rather than
      // expanding a card somewhere below the fold.
      state.editingDraftId = el.dataset.draft;
      ctx.render();
      break;
    case 'close-editor':
      closeEditor(ctx);
      break;
    case 'use-alternative': {
      applyEdit(el.dataset.draft, { sku_id: el.dataset.sku }, ctx);
      break;
    }
    case 'exclude-draft': {
      const draft = state.drafts.find((d) => d.draft_id === el.dataset.draft);
      applyEdit(el.dataset.draft, { excluded: !draft.excluded }, ctx);
      break;
    }
    case 'to-action':
      state.action.sku_ids = [...new Set(state.drafts.filter((d) => d.is_jti && !d.excluded).map((d) => d.sku_id))];
      state.step = 'action';
      ctx.render();
      break;
    case 'back-to-results':
      state.step = 'results';
      ctx.render();
      break;
    case 'to-summary':
      state.step = 'summary';
      ctx.render();
      break;
    case 'save-draft':
      persistVisit(ctx, 'draft');
      break;
    case 'submit-visit':
      persistVisit(ctx, 'submitted');
      break;
    default:
      break;
  }
}

export function onChange(target, ctx) {
  if (target.dataset.input === 'territory-filter') {
    state.territoryFilter = target.value;
    ctx.render();
    return;
  }
  if (target.dataset.input === 'action-type') {
    state.action.action_type = target.value;
    return;
  }
  if (target.dataset.input === 'action-followup') {
    state.action.follow_up_date = target.value;
    return;
  }
  if (target.dataset.input === 'action-sku') {
    const id = target.value;
    state.action.sku_ids = target.checked
      ? [...new Set([...state.action.sku_ids, id])]
      : state.action.sku_ids.filter((s) => s !== id);
    return;
  }
  if (target.dataset.edit === 'sku') {
    applyEdit(target.dataset.draft, { sku_id: target.value }, ctx);
    return;
  }
  if (target.dataset.edit === 'price') {
    const value = Number.parseFloat(target.value);
    if (Number.isFinite(value)) applyEdit(target.dataset.draft, { confirmed_price: value }, ctx);
  }
}

export function onInput(target, ctx) {
  if (target.dataset.input === 'outlet-search') {
    state.search = target.value;
    ctx.render();
  }
  if (target.dataset.input === 'action-notes') {
    state.action.notes = target.value;
  }
}

/* ------------------------------------------------------------- helpers */

async function handleFiles(fileList, source, ctx) {
  const files = [...fileList];
  for (const file of files) {
    const dims = await readImageDimensions(file);
    const quality = assessImageQuality(
      { name: file.name, size: file.size, type: file.type, width: dims.width, height: dims.height },
      ctx.config.image_quality,
    );
    state.images.push({
      id: `img-local-${Date.now()}-${state.images.length}`,
      name: file.name,
      size: file.size,
      type: file.type,
      width: dims.width,
      height: dims.height,
      previewUrl: dims.dataUrl,
      image_source: source,
      quality,
      quality_status: quality.status,
      file,
    });
  }
  ctx.render();
}

async function runProcessing(ctx) {
  state.step = 'processing';
  state.processingStep = 0;
  state.error = null;
  ctx.render();

  const outlet = ctx.data.outlets.find((o) => o.id === state.outletId);
  const tick = setInterval(() => {
    state.processingStep = Math.min(state.processingStep + 1, PROCESSING_STEPS.length - 1);
    if (state.step === 'processing') ctx.render();
  }, 170);

  try {
    const drafts = await processVisitImages({
      visit: { id: state.visitId ?? 'draft' },
      outlet,
      images: state.images,
      data: ctx.data,
      config: ctx.config,
      observedAt: new Date().toISOString(),
    });
    state.drafts = attachCompetitorNames(drafts, ctx.data);
    await new Promise((r) => setTimeout(r, 380));
    clearInterval(tick);
    state.step = 'results';
    // Auto-expand anything the TME must look at.
    state.expanded = new Set(
      state.drafts
        .filter((d) => d.evaluation?.status === PRICE_POSITION_STATUS.REVIEW)
        .map((d) => d.draft_id),
    );
  } catch (err) {
    clearInterval(tick);
    console.error(err);
    state.error = `Recognition failed: ${err.message}`;
    state.step = 'acquire';
  }
  ctx.render();
}

function attachCompetitorNames(drafts, data) {
  return drafts.map((d) => ({
    ...d,
    competitor_sku_name: d.competitor_sku_id_snapshot
      ? (data.skus.find((s) => s.id === d.competitor_sku_id_snapshot)?.name ?? null)
      : null,
  }));
}

function closeEditor(ctx) {
  if (!state.editingDraftId) return;
  state.editingDraftId = null;
  ctx.render();
}

function applyEdit(draftId, patch, ctx) {
  const idx = state.drafts.findIndex((d) => d.draft_id === draftId);
  if (idx === -1) return;
  const corrected = correctDraft(state.drafts[idx], patch, ctx.data, ctx.config, state.drafts[idx].observed_at);
  const next = state.drafts.slice();
  next[idx] = corrected;
  state.drafts = attachCompetitorNames(recomputeDrafts(next, ctx.config), ctx.data);
  ctx.render();
}

function persistVisit(ctx, status) {
  const { store } = ctx;
  const visit = store.createVisit({ outlet_id: state.outletId, user_id: ctx.user.id });
  const imageRecords = state.images.map((img) =>
    store.addImage({
      visit_id: visit.id,
      storage_url: null,
      file_name: img.name,
      image_source: img.image_source,
      quality_status: img.quality_status,
    }),
  );
  const imageIdByLocal = new Map(state.images.map((img, i) => [img.id, imageRecords[i].id]));

  const observations = state.drafts
    .filter((d) => !d.excluded)
    .map((d) =>
      toPersistableObservation({
        ...d,
        visit_id: visit.id,
        image_id: imageIdByLocal.get(d.image_id) ?? null,
      }),
    );
  store.addObservations(observations);

  if (state.action.action_type && state.action.action_type !== 'No action') {
    store.addFieldAction({
      visit_id: visit.id,
      outlet_id: state.outletId,
      opportunity_id: null,
      user_id: ctx.user.id,
      action_type: state.action.action_type,
      follow_up_date: state.action.follow_up_date || null,
      notes: state.action.notes,
      sku_ids: state.action.sku_ids,
    });
  }

  store.updateVisit(visit.id, {
    status,
    submitted_at: status === 'submitted' ? new Date().toISOString() : null,
  });

  const outletId = state.outletId;
  reset();
  ctx.navigate('outlet', { id: outletId, submitted: status === 'submitted' ? '1' : '' });
}
