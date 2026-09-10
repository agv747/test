/**
 * Demo / seed data (§29).
 *
 * Everything is generated deterministically from a fixed reference date so screenshots,
 * tests and demos are reproducible. The dataset is engineered to demonstrate:
 *   - the same JTI SKU sold at different prices across outlets (dispersion);
 *   - observations below / within / above the recommended range;
 *   - one material competitor price drop;
 *   - Strategic SKUs;
 *   - one persistent opportunity;
 *   - low-confidence recognition cases for the Image Review queue;
 *   - one TME action followed by a later observed price improvement;
 *   - a superseded price rule, so historical integrity is visible (§25).
 */

import { rngFor } from './lib/rng.js';
import { round } from './lib/stats.js';
import { resolveEffectivePriceRule, snapshotPriceRule } from './services/priceRuleService.js';
import {
  resolveCompetitorMapping,
  snapshotCompetitorMapping,
} from './services/competitorMappingService.js';

const DAY = 86400000;

function iso(now, dayOffset, hour = 10, minute = 0) {
  const d = new Date(new Date(now).getTime() + dayOffset * DAY);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

const TERRITORIES = [
  { id: 'ter-central', name: 'Central', market: 'SG' },
  { id: 'ter-north', name: 'North', market: 'SG' },
  { id: 'ter-east', name: 'East', market: 'SG' },
  { id: 'ter-west', name: 'West', market: 'SG' },
];

const CHANNELS = [
  { id: 'ch-indep', name: 'Independent Convenience' },
  { id: 'ch-chain', name: 'Convenience Chain' },
  { id: 'ch-grocery', name: 'Grocery / Mini Market' },
  { id: 'ch-other', name: 'Other' },
];

const USERS = [
  { id: 'usr-tme-1', name: 'Wei Ling Tan', role: 'field', territory_id: 'ter-east', active: true },
  { id: 'usr-tme-2', name: 'Arun Kumar', role: 'field', territory_id: 'ter-north', active: true },
  { id: 'usr-tme-3', name: 'Siti Rahman', role: 'field', territory_id: 'ter-west', active: true },
  { id: 'usr-tme-4', name: 'Jason Ong', role: 'field', territory_id: 'ter-central', active: true },
  { id: 'usr-mgr-1', name: 'Priya Nair', role: 'manager', territory_id: null, active: true },
  { id: 'usr-adm-1', name: 'Daniel Lim', role: 'admin', territory_id: null, active: true },
];

const BRANDS = [
  { id: 'brd-lm', name: 'L&M', company: 'JTI', is_jti: true },
  { id: 'brd-compa', name: 'Competitor A', company: 'Competitor A Holdings', is_jti: false },
  { id: 'brd-compb', name: 'Competitor B', company: 'Competitor B Group', is_jti: false },
];

/** JTI SKUs with their demo recommended price (§29). */
const JTI_SKUS = [
  { id: 'sku-lm-rlxl', sku_code: 'LM-RL-XL', name: 'L&M Red Line XL', recommended: 13.7, is_strategic: true, strategic_priority: 'High', tier: 'Value' },
  { id: 'sku-lm-blxl', sku_code: 'LM-BL-XL', name: 'L&M Blue Line XL', recommended: 13.7, is_strategic: false, strategic_priority: null, tier: 'Value' },
  { id: 'sku-lm-glxl', sku_code: 'LM-GL-XL', name: 'L&M Green Line XL Fresh', recommended: 13.7, is_strategic: false, strategic_priority: null, tier: 'Value' },
  { id: 'sku-lm-dfxl', sku_code: 'LM-DF-XL', name: 'L&M Double Forward XL Fresh', recommended: 14.3, is_strategic: true, strategic_priority: 'Medium', tier: 'Mid Tier' },
  { id: 'sku-lm-rl', sku_code: 'LM-RL', name: 'L&M Red Line', recommended: 14.3, is_strategic: false, strategic_priority: null, tier: 'Mid Tier' },
  { id: 'sku-lm-bl', sku_code: 'LM-BL', name: 'L&M Blue Line', recommended: 14.3, is_strategic: false, strategic_priority: null, tier: 'Mid Tier' },
];

/** Illustrative competitor SKUs — demo names only, not a business assumption (§29). */
const COMPETITOR_SKUS = [
  { id: 'sku-ca-value', brand_id: 'brd-compa', sku_code: 'CA-VAL', name: 'Competitor A Value', base: 13.5, tier: 'Value' },
  { id: 'sku-ca-core', brand_id: 'brd-compa', sku_code: 'CA-COR', name: 'Competitor A Core', base: 14.1, tier: 'Core' },
  { id: 'sku-ca-prem', brand_id: 'brd-compa', sku_code: 'CA-PRM', name: 'Competitor A Premium', base: 15.8, tier: 'Premium' },
  { id: 'sku-cb-value', brand_id: 'brd-compb', sku_code: 'CB-VAL', name: 'Competitor B Value', base: 13.4, tier: 'Value' },
  { id: 'sku-cb-core', brand_id: 'brd-compb', sku_code: 'CB-COR', name: 'Competitor B Core', base: 14.0, tier: 'Core' },
  { id: 'sku-cb-prem', brand_id: 'brd-compb', sku_code: 'CB-PRM', name: 'Competitor B Premium', base: 16.1, tier: 'Premium' },
];

const OUTLET_DEFS = [
  // East — includes the Punggol outlet used by the demo script (§30).
  ['out-e1', 'SG-E-1042', 'Punggol Central Minimart', 'ter-east', 'ch-indep', 'usr-tme-1'],
  ['out-e2', 'SG-E-1043', 'Punggol Waterway Store', 'ter-east', 'ch-grocery', 'usr-tme-1'],
  ['out-e3', 'SG-E-1051', 'Tampines Hub Convenience', 'ter-east', 'ch-chain', 'usr-tme-1'],
  ['out-e4', 'SG-E-1058', 'Bedok North Provision', 'ter-east', 'ch-indep', 'usr-tme-1'],
  ['out-e5', 'SG-E-1063', 'Pasir Ris Mini Mart', 'ter-east', 'ch-grocery', 'usr-tme-1'],
  ['out-e6', 'SG-E-1070', 'Simei Corner Shop', 'ter-east', 'ch-indep', 'usr-tme-1'],
  // North
  ['out-n1', 'SG-N-2011', 'Yishun Mini Mart', 'ter-north', 'ch-indep', 'usr-tme-2'],
  ['out-n2', 'SG-N-2018', 'Woodlands Causeway Store', 'ter-north', 'ch-chain', 'usr-tme-2'],
  ['out-n3', 'SG-N-2024', 'Sembawang Provision', 'ter-north', 'ch-indep', 'usr-tme-2'],
  ['out-n4', 'SG-N-2031', 'Ang Mo Kio Ave 6 Store', 'ter-north', 'ch-grocery', 'usr-tme-2'],
  ['out-n5', 'SG-N-2039', 'Khatib Corner Mart', 'ter-north', 'ch-indep', 'usr-tme-2'],
  ['out-n6', 'SG-N-2044', 'Canberra Plaza Convenience', 'ter-north', 'ch-chain', 'usr-tme-2'],
  // West
  ['out-w1', 'SG-W-3007', 'Jurong West Mini Mart', 'ter-west', 'ch-indep', 'usr-tme-3'],
  ['out-w2', 'SG-W-3013', 'Boon Lay Provision', 'ter-west', 'ch-grocery', 'usr-tme-3'],
  ['out-w3', 'SG-W-3021', 'Clementi Block 441 Store', 'ter-west', 'ch-indep', 'usr-tme-3'],
  ['out-w4', 'SG-W-3028', 'Bukit Batok Convenience', 'ter-west', 'ch-chain', 'usr-tme-3'],
  ['out-w5', 'SG-W-3034', 'Choa Chu Kang Mart', 'ter-west', 'ch-grocery', 'usr-tme-3'],
  ['out-w6', 'SG-W-3040', 'Pioneer Junction Shop', 'ter-west', 'ch-other', 'usr-tme-3'],
  // Central
  ['out-c1', 'SG-C-4005', 'Tiong Bahru Provision', 'ter-central', 'ch-indep', 'usr-tme-4'],
  ['out-c2', 'SG-C-4012', 'Bugis Street Convenience', 'ter-central', 'ch-chain', 'usr-tme-4'],
  ['out-c3', 'SG-C-4019', 'Toa Payoh Central Mart', 'ter-central', 'ch-grocery', 'usr-tme-4'],
  ['out-c4', 'SG-C-4026', 'Novena Square Store', 'ter-central', 'ch-chain', 'usr-tme-4'],
  ['out-c5', 'SG-C-4033', 'Geylang Bahru Shop', 'ter-central', 'ch-indep', 'usr-tme-4'],
  ['out-c6', 'SG-C-4041', 'Kallang Provision Store', 'ter-central', 'ch-other', 'usr-tme-4'],
];

/** Outlets whose pricing behaviour is scripted for the demo narrative. */
const SCRIPTED = {
  /** Persistent, strategic, above-range opportunity in the East. */
  'out-e1': { skuOverrides: { 'sku-lm-rlxl': 14.4 }, note: 'persistent-strategic' },
  /**
   * TME engagement in the North followed by an observed price improvement (§14).
   * The engagement is anchored to a VISIT INDEX rather than a calendar day so the
   * before/after pair is always the observation immediately either side of the action,
   * whatever the outlet's visit stagger.
   */
  'out-n1': {
    engagement: {
      sku_id: 'sku-lm-rlxl',
      before: 14.5,
      after: 14.0,
      competitor: 13.7,
      /** Visits 0..3 observe the "before" price; the action lands on visit 3. */
      action_visit_index: 3,
      action_type: 'Outlet agreed to adjust price',
    },
  },
  /** Deep discounter — drives "below recommended range" cases. */
  'out-w2': { offset: -0.45 },
  /** Premium-positioned independent — drives "above recommended range" cases. */
  'out-c5': { offset: 0.55 },
};

/** Competitor A Core drops SGD 0.50 twenty days ago — the material competitor move (§13). */
const COMPETITOR_MOVE = { sku_id: 'sku-ca-core', from_day: -20, delta: -0.5 };

function buildSkus() {
  const jti = JTI_SKUS.map((s) => ({
    id: s.id,
    brand_id: 'brd-lm',
    sku_code: s.sku_code,
    name: s.name,
    is_jti: true,
    is_strategic: s.is_strategic,
    strategic_priority: s.strategic_priority,
    tier: s.tier,
    active: true,
  }));
  const competitor = COMPETITOR_SKUS.map((s) => ({
    id: s.id,
    brand_id: s.brand_id,
    sku_code: s.sku_code,
    name: s.name,
    is_jti: false,
    is_strategic: false,
    strategic_priority: null,
    tier: s.tier,
    active: true,
  }));
  return [...jti, ...competitor];
}

function buildPriceRules(now) {
  const rules = [];
  JTI_SKUS.forEach((sku, i) => {
    rules.push({
      id: `pr-${sku.sku_code}-mkt`,
      market: 'SG',
      territory_id: null,
      channel_id: null,
      outlet_id: null,
      brand_id: 'brd-lm',
      sku_id: sku.id,
      recommended_price: sku.recommended,
      recommended_min: round(sku.recommended - 0.2, 2),
      recommended_max: round(sku.recommended + 0.2, 2),
      effective_from: iso(now, -365),
      effective_to: null,
      priority: 0,
      notes: 'Market-level recommendation',
      active: true,
    });
  });

  // Superseded historical rule for the Strategic SKU — proves historical integrity (§25).
  const rlxl = rules.find((r) => r.sku_id === 'sku-lm-rlxl');
  rlxl.effective_from = iso(now, -45);
  rlxl.notes = 'Market-level recommendation (uplift effective from 45 days ago)';
  rules.push({
    id: 'pr-LM-RL-XL-mkt-prev',
    market: 'SG',
    territory_id: null,
    channel_id: null,
    outlet_id: null,
    brand_id: 'brd-lm',
    sku_id: 'sku-lm-rlxl',
    recommended_price: 13.5,
    recommended_min: 13.3,
    recommended_max: 13.7,
    effective_from: iso(now, -365),
    effective_to: iso(now, -46),
    priority: 0,
    notes: 'Superseded — retained for historical evaluation',
    active: true,
  });

  // Territory override (more specific than market level).
  rules.push({
    id: 'pr-LM-DF-XL-east',
    market: 'SG',
    territory_id: 'ter-east',
    channel_id: null,
    outlet_id: null,
    brand_id: 'brd-lm',
    sku_id: 'sku-lm-dfxl',
    recommended_price: 14.4,
    recommended_min: 14.2,
    recommended_max: 14.6,
    effective_from: iso(now, -120),
    effective_to: null,
    priority: 10,
    notes: 'East territory positioning',
    active: true,
  });

  // Future-dated rule — visible in admin, not yet effective for observations.
  rules.push({
    id: 'pr-LM-BL-mkt-future',
    market: 'SG',
    territory_id: null,
    channel_id: null,
    outlet_id: null,
    brand_id: 'brd-lm',
    sku_id: 'sku-lm-bl',
    recommended_price: 14.5,
    recommended_min: 14.3,
    recommended_max: 14.7,
    effective_from: iso(now, 30),
    effective_to: null,
    priority: 5,
    notes: 'Planned uplift — effective in 30 days',
    active: true,
  });

  return rules;
}

function buildCompetitorMappings(now) {
  const defs = [
    ['cm-1', 'sku-lm-rlxl', 'sku-ca-value', 100, 0.0, 0.3, 100, 103],
    ['cm-2', 'sku-lm-rlxl', 'sku-cb-value', 60, 0.1, 0.45, 100.5, 103.5],
    ['cm-3', 'sku-lm-blxl', 'sku-cb-value', 100, 0.1, 0.45, 100.5, 103.5],
    ['cm-4', 'sku-lm-glxl', 'sku-ca-value', 100, 0.0, 0.3, 100, 103],
    ['cm-5', 'sku-lm-dfxl', 'sku-ca-core', 100, 0.0, 0.35, 100, 102.5],
    ['cm-6', 'sku-lm-rl', 'sku-cb-core', 100, 0.1, 0.45, 100.5, 103],
    ['cm-7', 'sku-lm-bl', 'sku-ca-core', 100, 0.0, 0.35, 100, 102.5],
  ];
  return defs.map(([id, jti, comp, prio, gapMin, gapMax, idxMin, idxMax]) => ({
    id,
    jti_sku_id: jti,
    competitor_sku_id: comp,
    market: 'SG',
    territory_id: null,
    channel_id: null,
    mapping_priority: prio,
    desired_gap_min: gapMin,
    desired_gap_max: gapMax,
    desired_price_index_min: idxMin,
    desired_price_index_max: idxMax,
    comparison_method: null,
    effective_from: iso(now, -365),
    effective_to: null,
    active: true,
    notes: '',
  }));
}

/** Retail prices in SG move in 10-cent steps. */
function toRetail(value) {
  return round(Math.round(value * 10) / 10, 2);
}

function competitorBasePrice(skuId, dayOffset) {
  const sku = COMPETITOR_SKUS.find((s) => s.id === skuId);
  let base = sku.base;
  if (skuId === COMPETITOR_MOVE.sku_id && dayOffset >= COMPETITOR_MOVE.from_day) {
    base = round(base + COMPETITOR_MOVE.delta, 2);
  }
  return base;
}

export function buildSeedData(nowIso = new Date().toISOString()) {
  const now = nowIso;
  const skus = buildSkus();
  const priceRules = buildPriceRules(now);
  const competitorMappings = buildCompetitorMappings(now);

  const outlets = OUTLET_DEFS.map(([id, code, name, territory, channel, tme]) => ({
    id,
    outlet_code: code,
    name,
    territory_id: territory,
    channel_id: channel,
    assigned_tme_id: tme,
    active: true,
  }));

  const visits = [];
  const images = [];
  const observations = [];
  const fieldActions = [];

  let visitSeq = 0;
  let obsSeq = 0;
  let imgSeq = 0;

  for (const outlet of outlets) {
    const rand = rngFor(`outlet|${outlet.id}`);
    const scripted = SCRIPTED[outlet.id] ?? {};
    /**
     * Each outlet has a persistent pricing posture. The offset is triangular (sum of two
     * uniforms) so most outlets sit near the recommended price and a minority sit clearly
     * outside it — the shape real dispersion tends to take.
     */
    const outletOffset = scripted.offset ?? round((rand() + rand() - 1) * 0.4, 2);

    // Visit cadence: every ~14 days, staggered per outlet. The stagger is subtracted so
    // no visit is ever dated in the future relative to `now`.
    const stagger = Math.floor(rand() * 6);
    const visitDays = [-84, -70, -56, -42, -28, -14, -3].map((d) => d - stagger);

    for (let visitIndex = 0; visitIndex < visitDays.length; visitIndex += 1) {
      const day = visitDays[visitIndex];
      visitSeq += 1;
      const visitId = `vis-${String(visitSeq).padStart(4, '0')}`;
      const startedAt = iso(now, day, 9 + Math.floor(rand() * 8), Math.floor(rand() * 60));
      const submittedAt = new Date(new Date(startedAt).getTime() + 4 * 60000).toISOString();

      visits.push({
        id: visitId,
        outlet_id: outlet.id,
        user_id: outlet.assigned_tme_id,
        started_at: startedAt,
        submitted_at: submittedAt,
        status: 'submitted',
        notes: '',
      });

      imgSeq += 1;
      const imageId = `img-${String(imgSeq).padStart(4, '0')}`;
      const lowQuality = rand() < 0.08;
      images.push({
        id: imageId,
        visit_id: visitId,
        storage_url: null,
        file_name: `shelf-${outlet.outlet_code}-${Math.abs(day)}.jpg`,
        image_source: rand() < 0.7 ? 'camera' : 'gallery',
        quality_status: lowQuality ? 'Multiple Ambiguous Labels' : 'Good',
        uploaded_at: startedAt,
      });

      const observedAt = submittedAt;
      const ctxBase = {
        market: 'SG',
        territory_id: outlet.territory_id,
        channel_id: outlet.channel_id,
        outlet_id: outlet.id,
      };

      // --- JTI observations ---
      const jtiCount = 4 + Math.floor(rand() * 3); // 4..6 SKUs per visit
      const jtiStart = Math.floor(rand() * JTI_SKUS.length);
      const chosenJti = [];
      for (let i = 0; i < jtiCount; i += 1) {
        chosenJti.push(JTI_SKUS[(jtiStart + i) % JTI_SKUS.length]);
      }
      // Scripted SKUs must appear at every visit so the demo narrative is continuous.
      const scriptedSkuIds = [
        ...(scripted.engagement ? [scripted.engagement.sku_id] : []),
        ...Object.keys(scripted.skuOverrides ?? {}),
      ];
      for (const id of scriptedSkuIds) {
        if (!chosenJti.some((s) => s.id === id)) {
          chosenJti.push(JTI_SKUS.find((s) => s.id === id));
        }
      }

      for (const skuDef of chosenJti) {
        const rule = resolveEffectivePriceRule(
          priceRules,
          { ...ctxBase, sku_id: skuDef.id },
          observedAt,
        );
        const mapping = resolveCompetitorMapping(
          competitorMappings,
          skuDef.id,
          ctxBase,
          observedAt,
        );

        let price;
        const engagement = scripted.engagement;
        if (engagement && engagement.sku_id === skuDef.id) {
          price =
            visitIndex <= engagement.action_visit_index ? engagement.before : engagement.after;
        } else if (scripted.skuOverrides?.[skuDef.id] !== undefined) {
          price = scripted.skuOverrides[skuDef.id];
        } else {
          const base = rule?.recommended_price ?? skuDef.recommended;
          price = toRetail(base + outletOffset + (rand() - 0.5) * 0.24);
        }

        const lowConfidence = rand() < 0.07;
        const confidence = lowConfidence
          ? round(0.5 + rand() * 0.22, 2)
          : round(0.88 + rand() * 0.11, 2);
        const manuallyCorrected = rand() < 0.12;
        const detected = manuallyCorrected ? toRetail(price + (rand() < 0.5 ? -0.1 : 0.1)) : price;

        obsSeq += 1;
        observations.push({
          id: `obs-${String(obsSeq).padStart(5, '0')}`,
          visit_id: visitId,
          outlet_id: outlet.id,
          image_id: imageId,
          sku_id: skuDef.id,
          detected_price: detected,
          confirmed_price: price,
          currency: 'SGD',
          recognition_confidence: confidence,
          manual_correction: manuallyCorrected,
          observed_at: observedAt,
          excluded: false,
          exclusion_reason: null,
          image_source: images[images.length - 1].image_source,
          ...snapshotPriceRule(rule),
          ...snapshotCompetitorMapping(mapping),
        });
      }

      // --- Competitor observations ---
      const compCount = 2 + Math.floor(rand() * 2);
      const compStart = Math.floor(rand() * COMPETITOR_SKUS.length);
      const chosenComp = [];
      for (let i = 0; i < compCount; i += 1) {
        chosenComp.push(COMPETITOR_SKUS[(compStart + i) % COMPETITOR_SKUS.length]);
      }
      // Ensure the competitor mapped to a scripted JTI SKU is observed in the same visit,
      // so the demo always has a comparable price gap / Price Index.
      for (const jtiId of scriptedSkuIds) {
        const mapping = resolveCompetitorMapping(competitorMappings, jtiId, ctxBase, observedAt);
        if (mapping && !chosenComp.some((s) => s.id === mapping.competitor_sku_id)) {
          chosenComp.push(COMPETITOR_SKUS.find((s) => s.id === mapping.competitor_sku_id));
        }
      }

      for (const skuDef of chosenComp) {
        let price;
        const engagement = scripted.engagement;
        if (engagement && skuDef.id === 'sku-ca-value') {
          price = engagement.competitor;
        } else {
          price = toRetail(
            competitorBasePrice(skuDef.id, day) + outletOffset * 0.6 + (rand() - 0.5) * 0.2,
          );
        }
        obsSeq += 1;
        observations.push({
          id: `obs-${String(obsSeq).padStart(5, '0')}`,
          visit_id: visitId,
          outlet_id: outlet.id,
          image_id: imageId,
          sku_id: skuDef.id,
          detected_price: price,
          confirmed_price: price,
          currency: 'SGD',
          recognition_confidence: round(0.86 + rand() * 0.13, 2),
          manual_correction: false,
          observed_at: observedAt,
          excluded: false,
          exclusion_reason: null,
          image_source: images[images.length - 1].image_source,
          price_rule_id: null,
          recommended_price_snapshot: null,
          recommended_min_snapshot: null,
          recommended_max_snapshot: null,
          competitor_mapping_id: null,
          competitor_sku_id_snapshot: null,
          desired_gap_min_snapshot: null,
          desired_gap_max_snapshot: null,
          desired_price_index_min_snapshot: null,
          desired_price_index_max_snapshot: null,
          comparison_method_snapshot: null,
        });
      }
    }
  }

  // --- Scripted field actions ---
  const engagementOutlet = outlets.find((o) => o.id === 'out-n1');
  const engagementVisit = visits
    .filter((v) => v.outlet_id === 'out-n1')
    .sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at))[
    SCRIPTED['out-n1'].engagement.action_visit_index
  ];
  if (engagementVisit) {
    fieldActions.push({
      id: 'fa-0001',
      visit_id: engagementVisit.id,
      outlet_id: engagementOutlet.id,
      opportunity_id: null,
      user_id: engagementOutlet.assigned_tme_id,
      action_type: 'Outlet agreed to adjust price',
      action_at: engagementVisit.submitted_at,
      follow_up_date: iso(now, -16),
      notes:
        'Discussed observed price position versus mapped competitor. Outlet agreed to review shelf price at next delivery.',
      sku_ids: ['sku-lm-rlxl'],
    });
  }

  // Persistent, unresolved follow-up in the East.
  const persistentVisits = visits
    .filter((v) => v.outlet_id === 'out-e1')
    .sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
  if (persistentVisits.length >= 3) {
    const v = persistentVisits[persistentVisits.length - 3];
    fieldActions.push({
      id: 'fa-0002',
      visit_id: v.id,
      outlet_id: 'out-e1',
      opportunity_id: null,
      user_id: 'usr-tme-1',
      action_type: 'Follow-up required',
      action_at: v.submitted_at,
      follow_up_date: iso(now, -7),
      notes: 'Strategic SKU remains above recommended range. Follow-up scheduled.',
      sku_ids: ['sku-lm-rlxl'],
    });
  }

  // A few routine discussions across other territories.
  const discussionOutlets = ['out-w2', 'out-c5', 'out-e3'];
  discussionOutlets.forEach((outletId, i) => {
    const v = visits
      .filter((x) => x.outlet_id === outletId)
      .sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at))[1];
    if (!v) return;
    fieldActions.push({
      id: `fa-001${i + 3}`,
      visit_id: v.id,
      outlet_id: outletId,
      opportunity_id: null,
      user_id: outlets.find((o) => o.id === outletId).assigned_tme_id,
      action_type: 'Discussed with outlet',
      action_at: v.submitted_at,
      follow_up_date: null,
      notes: 'Shared observed competitive position for mapped SKUs.',
      sku_ids: ['sku-lm-dfxl'],
    });
  });

  return {
    schema_version: 2,
    market: 'SG',
    generated_at: now,
    territories: TERRITORIES,
    channels: CHANNELS,
    users: USERS,
    brands: BRANDS,
    skus,
    outlets,
    price_rules: priceRules,
    competitor_mappings: competitorMappings,
    visits,
    images,
    price_observations: observations,
    field_actions: fieldActions,
    opportunity_states: {},
  };
}
