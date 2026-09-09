/**
 * Store — single source of truth for entities, configuration and session.
 *
 * Persistence is localStorage in the MVP. Every read/write goes through this module, so
 * replacing it with a REST/D1 backend is a one-file change; UI and services never touch
 * storage directly.
 */

import { buildSeedData } from './seed.js';
import { defaultConfig } from './config.js';

const STORAGE_KEY = 'rpi-sg:data:v2';
const CONFIG_KEY = 'rpi-sg:config:v2';
const SESSION_KEY = 'rpi-sg:session:v2';

const hasStorage = (() => {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
})();

const listeners = new Set();

let data = null;
let config = null;
let session = null;

function readJson(key) {
  if (!hasStorage) return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  if (!hasStorage) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('Persistence failed', err);
  }
}

export function init({ force = false, now = new Date().toISOString() } = {}) {
  const stored = force ? null : readJson(STORAGE_KEY);
  data = stored && stored.schema_version === 2 ? stored : buildSeedData(now);
  config = readJson(CONFIG_KEY) ?? defaultConfig();
  session =
    readJson(SESSION_KEY) ?? {
      user_id: 'usr-tme-1',
      role: 'field',
      /** Manager filter state persists across navigation. */
      filters: {},
    };
  if (!stored || force) writeJson(STORAGE_KEY, data);
  notify();
  return data;
}

export function resetToSeed(now = new Date().toISOString()) {
  data = buildSeedData(now);
  config = defaultConfig();
  writeJson(STORAGE_KEY, data);
  writeJson(CONFIG_KEY, config);
  notify();
  return data;
}

export function getData() {
  if (!data) init();
  return data;
}

export function getConfig() {
  if (!config) init();
  return config;
}

export function updateConfig(patch) {
  config = { ...getConfig(), ...patch };
  writeJson(CONFIG_KEY, config);
  notify();
  return config;
}

export function getSession() {
  if (!session) init();
  return session;
}

export function setSession(patch) {
  session = { ...getSession(), ...patch };
  writeJson(SESSION_KEY, session);
  notify();
  return session;
}

export function currentUser() {
  const s = getSession();
  return getData().users.find((u) => u.id === s.user_id) ?? getData().users[0];
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error('Store listener failed', err);
    }
  }
}

function persist() {
  writeJson(STORAGE_KEY, data);
  notify();
}

/* ---------------------------------------------------------------------------
 * Lookups
 * ------------------------------------------------------------------------- */

export function byId(collection, id) {
  return getData()[collection]?.find((x) => x.id === id) ?? null;
}

export function outletById(id) {
  return byId('outlets', id);
}

export function skuById(id) {
  return byId('skus', id);
}

export function jtiSkus() {
  return getData().skus.filter((s) => s.is_jti && s.active !== false);
}

export function competitorSkus() {
  return getData().skus.filter((s) => !s.is_jti && s.active !== false);
}

/** SKUs with their brand name denormalised — used by the recognition provider. */
export function skusWithBrand() {
  const brands = new Map(getData().brands.map((b) => [b.id, b]));
  return getData().skus.map((s) => ({ ...s, brand_name: brands.get(s.brand_id)?.name ?? '' }));
}

/* ---------------------------------------------------------------------------
 * Mutations
 * ------------------------------------------------------------------------- */

function nextId(collection, prefix) {
  const n = getData()[collection].length + 1;
  return `${prefix}-${Date.now().toString(36)}-${n}`;
}

export function createVisit({ outlet_id, user_id, notes = '' }) {
  const visit = {
    id: nextId('visits', 'vis'),
    outlet_id,
    user_id,
    started_at: new Date().toISOString(),
    submitted_at: null,
    status: 'draft',
    notes,
  };
  getData().visits.push(visit);
  persist();
  return visit;
}

export function updateVisit(id, patch) {
  const visit = byId('visits', id);
  if (!visit) return null;
  Object.assign(visit, patch);
  persist();
  return visit;
}

export function addImage(image) {
  const record = { id: nextId('images', 'img'), uploaded_at: new Date().toISOString(), ...image };
  getData().images.push(record);
  persist();
  return record;
}

export function removeImage(id) {
  const d = getData();
  d.images = d.images.filter((i) => i.id !== id);
  d.price_observations = d.price_observations.filter((o) => o.image_id !== id);
  persist();
}

export function addObservations(observations) {
  const created = observations.map((o, i) => ({
    id: `obs-${Date.now().toString(36)}-${i}`,
    currency: 'SGD',
    excluded: false,
    exclusion_reason: null,
    ...o,
  }));
  getData().price_observations.push(...created);
  persist();
  return created;
}

export function updateObservation(id, patch) {
  const obs = byId('price_observations', id);
  if (!obs) return null;
  Object.assign(obs, patch);
  persist();
  return obs;
}

export function addFieldAction(action) {
  const record = {
    id: nextId('field_actions', 'fa'),
    action_at: new Date().toISOString(),
    ...action,
  };
  getData().field_actions.push(record);
  persist();
  return record;
}

/** Opportunities are derived, so lifecycle state is stored separately, keyed by opportunity id. */
export function setOpportunityState(id, patch) {
  const d = getData();
  d.opportunity_states[id] = { ...(d.opportunity_states[id] ?? {}), ...patch };
  persist();
  return d.opportunity_states[id];
}

export function getOpportunityState(id) {
  return getData().opportunity_states?.[id] ?? null;
}

/* --- Master data CRUD (Admin screens) --- */

export function upsertPriceRule(rule) {
  const d = getData();
  const existing = d.price_rules.find((r) => r.id === rule.id);
  if (existing) Object.assign(existing, rule);
  else d.price_rules.push({ ...rule, id: rule.id || nextId('price_rules', 'pr') });
  persist();
  return rule;
}

export function deletePriceRule(id) {
  const d = getData();
  d.price_rules = d.price_rules.filter((r) => r.id !== id);
  persist();
}

export function upsertCompetitorMapping(mapping) {
  const d = getData();
  const existing = d.competitor_mappings.find((m) => m.id === mapping.id);
  if (existing) Object.assign(existing, mapping);
  else d.competitor_mappings.push({ ...mapping, id: mapping.id || nextId('competitor_mappings', 'cm') });
  persist();
  return mapping;
}

export function deleteCompetitorMapping(id) {
  const d = getData();
  d.competitor_mappings = d.competitor_mappings.filter((m) => m.id !== id);
  persist();
}

export function updateSku(id, patch) {
  const sku = byId('skus', id);
  if (!sku) return null;
  Object.assign(sku, patch);
  persist();
  return sku;
}

export function replaceCollection(name, rows) {
  getData()[name] = rows;
  persist();
}
