/**
 * Store — single source of truth for entities, configuration and session.
 *
 * Observations live in the D1 database behind `/api/data`, so a visit submitted on a phone
 * is visible to a manager on a laptop. The whole dataset is loaded once at startup and kept
 * in memory, which keeps every read synchronous for the UI and the services; writes update
 * memory immediately and are sent to the API in the background.
 *
 * When the API is unavailable — a plain static host, the single-file standalone build, or a
 * deploy without the database binding — the store falls back to the bundled seed data and
 * keeps working locally. `dataSource()` reports which of the two is in effect so the UI can
 * say so rather than silently showing per-browser data.
 *
 * Session and configuration stay per-browser in localStorage: they are the viewer's own
 * preferences, not shared observation data.
 */

import { buildSeedData, SEED_FINGERPRINT } from './seed.js';
import { defaultConfig } from './config.js';

/**
 * The cache key carries the seed fingerprint, so changing the SKU catalogue, outlets or
 * users automatically orphans every previously cached copy. A hand-maintained version
 * number was missed once and shipped stale data to everyone who had opened the app before.
 */
const STORAGE_KEY = `rpi-sg:data:${SEED_FINGERPRINT}`;
const CONFIG_KEY = 'rpi-sg:config:v3';
const SESSION_KEY = 'rpi-sg:session:v3';
const API_BASE = '/api';

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

/** 'database' once the API has answered; 'local' while running on the bundled seed. */
let source = 'local';
let lastError = null;

export function dataSource() {
  return { source, error: lastError };
}

/**
 * Loads the dataset. Prefers the database; falls back to the local seed so the app always
 * starts, and records which happened.
 */
export async function init({ now = new Date().toISOString(), offline = false } = {}) {
  config = readJson(CONFIG_KEY) ?? defaultConfig();
  session =
    readJson(SESSION_KEY) ?? {
      user_id: 'usr-tme-1',
      role: 'field',
      /** Manager filter state persists across navigation. */
      filters: {},
    };

  if (!offline) {
    const remote = await fetchDataset();
    if (remote) {
      data = remote;
      source = 'database';
      lastError = null;
      notify();
      return data;
    }
  }

  const cached = readJson(STORAGE_KEY);
  data = cached?.seed_fingerprint === SEED_FINGERPRINT ? cached : buildSeedData(now);
  source = 'local';
  writeJson(STORAGE_KEY, data);
  notify();
  return data;
}

async function fetchDataset() {
  if (typeof fetch === 'undefined') return null;
  try {
    const response = await fetch(`${API_BASE}/data`, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      lastError = `API responded ${response.status}`;
      return null;
    }
    const body = await response.json();
    if (!Array.isArray(body?.price_observations)) {
      lastError = 'API returned an unexpected shape';
      return null;
    }
    return body;
  } catch (err) {
    lastError = err.message;
    return null;
  }
}

/** Discards local overrides and reloads. Against a database this re-reads shared data. */
export async function reload(now = new Date().toISOString()) {
  if (hasStorage) {
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(CONFIG_KEY);
    } catch {
      /* ignore */
    }
  }
  config = defaultConfig();
  return init({ now });
}

/**
 * Reads are synchronous by design — every page and service depends on it. `init()` runs
 * before the first render; these guards only cover a direct call from a test or a console.
 */
export function getData() {
  if (!data) data = buildSeedData();
  return data;
}

export function getConfig() {
  if (!config) config = defaultConfig();
  return config;
}

export function updateConfig(patch) {
  config = { ...getConfig(), ...patch };
  writeJson(CONFIG_KEY, config);
  notify();
  return config;
}

export function getSession() {
  if (!session) session = { user_id: 'usr-tme-1', role: 'field', filters: {} };
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

/**
 * Records a change: memory and the local cache update immediately so the UI never waits,
 * and the same change is sent to the database in the background.
 *
 * A failed send is surfaced through `dataSource()` rather than swallowed — the alternative
 * is a visit that looks submitted but exists only in one browser, which is the failure this
 * whole layer exists to prevent.
 */
function persist(mutations = []) {
  writeJson(STORAGE_KEY, data);
  notify();
  if (mutations.length && source === 'database') void pushMutations(mutations);
}

/** Writes still in flight, so a caller can await a clean hand-off before navigating away. */
const pending = new Set();

async function pushMutations(mutations) {
  const task = (async () => {
    try {
      const response = await fetch(`${API_BASE}/mutations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mutations }),
      });
      if (!response.ok) throw new Error(`API responded ${response.status}`);
      lastError = null;
    } catch (err) {
      lastError = `Could not save to the database: ${err.message}`;
      console.error('Mutation failed', err, mutations);
      notify();
    }
  })();
  pending.add(task);
  try {
    await task;
  } finally {
    pending.delete(task);
  }
}

/** Resolves once every queued write has been sent. */
export async function flush() {
  await Promise.allSettled([...pending]);
  return lastError;
}

const upsert = (table, row) => ({ op: 'upsert', table, row });
const remove = (table, id) => ({ op: 'delete', table, id });

/** What the deployed Worker actually has bound, or null when there is no API. */
export async function workerConfig() {
  try {
    const response = await fetch(`${API_BASE}/config`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Runs one recognition call against a known image and returns the full result, including
 * the raw model response — so a failing model can be diagnosed from inside the app.
 */
export async function testRecognitionModel(model, sampleUrl, skus, currency = 'SGD') {
  const started = Date.now();
  const imageResponse = await fetch(sampleUrl);
  if (!imageResponse.ok) throw new Error(`Could not load the test image (${imageResponse.status})`);
  const blob = await imageResponse.blob();
  const image = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the test image'));
    reader.readAsDataURL(blob);
  });

  const response = await fetch(`${API_BASE}/recognise`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image, model, skus, currency }),
  });
  const body = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    elapsed_ms: Date.now() - started,
    image_bytes: blob.size,
    ...body,
  };
}

/** Accepts a model licence. Requires explicit confirmation; never called implicitly. */
export async function acceptModelLicence(model) {
  const response = await fetch(`${API_BASE}/model-licence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, confirmed: true }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `API responded ${response.status}`);
  return body;
}

/** Database reachability and row counts, or null when there is no API behind this build. */
export async function databaseHealth() {
  try {
    const response = await fetch(`${API_BASE}/health`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Bootstraps an empty database with the demo dataset. The Worker refuses when the database
 * already holds data, so this cannot wipe live observations by accident.
 */
export async function seedDatabase() {
  const response = await fetch(`${API_BASE}/seed`, { method: 'POST' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `API responded ${response.status}`);
  await init();
  return body;
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
  persist([upsert('visits', visit)]);
  return visit;
}

export function updateVisit(id, patch) {
  const visit = byId('visits', id);
  if (!visit) return null;
  Object.assign(visit, patch);
  persist([upsert('visits', visit)]);
  return visit;
}

export function addImage(image) {
  const record = { id: nextId('images', 'img'), uploaded_at: new Date().toISOString(), ...image };
  getData().images.push(record);
  persist([upsert('images', record)]);
  return record;
}

export function removeImage(id) {
  const d = getData();
  const orphaned = d.price_observations.filter((o) => o.image_id === id).map((o) => o.id);
  d.images = d.images.filter((i) => i.id !== id);
  d.price_observations = d.price_observations.filter((o) => o.image_id !== id);
  persist([
    remove('images', id),
    ...orphaned.map((obsId) => remove('price_observations', obsId)),
  ]);
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
  persist(created.map((o) => upsert('price_observations', o)));
  return created;
}

export function updateObservation(id, patch) {
  const obs = byId('price_observations', id);
  if (!obs) return null;
  Object.assign(obs, patch);
  persist([upsert('price_observations', obs)]);
  return obs;
}

export function addFieldAction(action) {
  const record = {
    id: nextId('field_actions', 'fa'),
    action_at: new Date().toISOString(),
    ...action,
  };
  getData().field_actions.push(record);
  persist([upsert('field_actions', record)]);
  return record;
}

/** Opportunities are derived, so lifecycle state is stored separately, keyed by opportunity id. */
export function setOpportunityState(id, patch) {
  const d = getData();
  d.opportunity_states[id] = { ...(d.opportunity_states[id] ?? {}), ...patch };
  persist([
    upsert('opportunity_states', {
      id,
      ...d.opportunity_states[id],
      updated_at: new Date().toISOString(),
    }),
  ]);
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
  const saved = d.price_rules.find((r) => r.id === rule.id) ?? d.price_rules[d.price_rules.length - 1];
  persist([upsert('price_rules', saved)]);
  return saved;
}

export function deletePriceRule(id) {
  const d = getData();
  d.price_rules = d.price_rules.filter((r) => r.id !== id);
  persist([remove('price_rules', id)]);
}

export function upsertCompetitorMapping(mapping) {
  const d = getData();
  const existing = d.competitor_mappings.find((m) => m.id === mapping.id);
  if (existing) Object.assign(existing, mapping);
  else d.competitor_mappings.push({ ...mapping, id: mapping.id || nextId('competitor_mappings', 'cm') });
  const saved =
    d.competitor_mappings.find((m) => m.id === mapping.id) ??
    d.competitor_mappings[d.competitor_mappings.length - 1];
  persist([upsert('competitor_mappings', saved)]);
  return saved;
}

export function deleteCompetitorMapping(id) {
  const d = getData();
  d.competitor_mappings = d.competitor_mappings.filter((m) => m.id !== id);
  persist([remove('competitor_mappings', id)]);
}

export function updateSku(id, patch) {
  const sku = byId('skus', id);
  if (!sku) return null;
  Object.assign(sku, patch);
  persist([upsert('skus', sku)]);
  return sku;
}

export function replaceCollection(name, rows) {
  getData()[name] = rows;
  persist(rows.map((row) => upsert(name, row)));
}
