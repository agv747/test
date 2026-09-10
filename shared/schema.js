/**
 * D1 schema, shared by the Worker API and the seeding script.
 *
 * One descriptor drives DDL, reads and writes, so a column is declared exactly once and the
 * type conversions (SQLite has no boolean, and a few fields hold arrays or objects) cannot
 * drift between the two sides.
 *
 * Column type suffixes:
 *   `bool` — stored as INTEGER 0/1, read back as a JavaScript boolean
 *   `json` — stored as TEXT, read back as the parsed value
 *   everything else is stored and returned as-is (TEXT / REAL / INTEGER)
 */

const T = 'TEXT';
const R = 'REAL';
const I = 'INTEGER';

export const TABLES = {
  territories: { id: T, name: T, market: T },

  channels: { id: T, name: T },

  users: { id: T, name: T, role: T, territory_id: T, active: 'bool' },

  brands: { id: T, name: T, company: T, is_jti: 'bool' },

  skus: {
    id: T,
    brand_id: T,
    sku_code: T,
    name: T,
    is_jti: 'bool',
    is_strategic: 'bool',
    strategic_priority: T,
    tier: T,
    active: 'bool',
  },

  outlets: {
    id: T,
    outlet_code: T,
    name: T,
    territory_id: T,
    channel_id: T,
    assigned_tme_id: T,
    active: 'bool',
  },

  price_rules: {
    id: T,
    market: T,
    territory_id: T,
    channel_id: T,
    outlet_id: T,
    brand_id: T,
    sku_id: T,
    recommended_price: R,
    recommended_min: R,
    recommended_max: R,
    effective_from: T,
    effective_to: T,
    priority: I,
    notes: T,
    active: 'bool',
  },

  competitor_mappings: {
    id: T,
    jti_sku_id: T,
    competitor_sku_id: T,
    market: T,
    territory_id: T,
    channel_id: T,
    mapping_priority: I,
    desired_gap_min: R,
    desired_gap_max: R,
    desired_price_index_min: R,
    desired_price_index_max: R,
    comparison_method: T,
    effective_from: T,
    effective_to: T,
    active: 'bool',
    notes: T,
  },

  visits: {
    id: T,
    outlet_id: T,
    user_id: T,
    started_at: T,
    submitted_at: T,
    status: T,
    notes: T,
  },

  images: {
    id: T,
    visit_id: T,
    storage_url: T,
    file_name: T,
    image_source: T,
    quality_status: T,
    uploaded_at: T,
  },

  price_observations: {
    id: T,
    visit_id: T,
    outlet_id: T,
    image_id: T,
    sku_id: T,
    detected_price: R,
    confirmed_price: R,
    currency: T,
    recognition_confidence: R,
    manual_correction: 'bool',
    observed_at: T,
    excluded: 'bool',
    exclusion_reason: T,
    image_source: T,
    /** Rule snapshot — historical integrity (§25). */
    price_rule_id: T,
    recommended_price_snapshot: R,
    recommended_min_snapshot: R,
    recommended_max_snapshot: R,
    /** Competitor mapping snapshot. */
    competitor_mapping_id: T,
    competitor_sku_id_snapshot: T,
    desired_gap_min_snapshot: R,
    desired_gap_max_snapshot: R,
    desired_price_index_min_snapshot: R,
    desired_price_index_max_snapshot: R,
    comparison_method_snapshot: T,
    /** Present on observations captured through the field workflow. */
    raw_text: T,
    detected_sku_id: T,
    recognition_provider: T,
    bounding_box: 'json',
    review_resolved: 'bool',
    reviewed_at: T,
  },

  field_actions: {
    id: T,
    visit_id: T,
    outlet_id: T,
    opportunity_id: T,
    user_id: T,
    action_type: T,
    action_at: T,
    follow_up_date: T,
    notes: T,
    sku_ids: 'json',
  },

  /** Opportunities are derived, so only their lifecycle state is persisted. */
  opportunity_states: {
    id: T,
    status: T,
    assigned_user_id: T,
    updated_at: T,
  },
};

export const TABLE_NAMES = Object.keys(TABLES);

/** Indexes on the columns the analytics joins filter by. */
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_obs_sku ON price_observations (sku_id)',
  'CREATE INDEX IF NOT EXISTS idx_obs_outlet ON price_observations (outlet_id)',
  'CREATE INDEX IF NOT EXISTS idx_obs_observed_at ON price_observations (observed_at)',
  'CREATE INDEX IF NOT EXISTS idx_obs_visit ON price_observations (visit_id)',
  'CREATE INDEX IF NOT EXISTS idx_visits_outlet ON visits (outlet_id)',
  'CREATE INDEX IF NOT EXISTS idx_actions_outlet ON field_actions (outlet_id)',
  'CREATE INDEX IF NOT EXISTS idx_rules_sku ON price_rules (sku_id)',
  'CREATE INDEX IF NOT EXISTS idx_mappings_jti_sku ON competitor_mappings (jti_sku_id)',
];

function sqlType(declared) {
  if (declared === 'bool' || declared === I) return I;
  if (declared === 'json') return T;
  return declared;
}

/** Full DDL: one CREATE TABLE per collection, plus the indexes. */
export function ddlStatements() {
  const tables = Object.entries(TABLES).map(([table, columns]) => {
    const cols = Object.entries(columns)
      .map(([name, declared]) => `${name} ${sqlType(declared)}${name === 'id' ? ' PRIMARY KEY' : ''}`)
      .join(', ');
    return `CREATE TABLE IF NOT EXISTS ${table} (${cols})`;
  });
  return [...tables, ...INDEXES];
}

/** Converts one application object into the positional values for an INSERT. */
export function toRow(table, object) {
  const columns = TABLES[table];
  return Object.entries(columns).map(([name, declared]) => {
    const value = object[name];
    if (value === undefined || value === null) return null;
    if (declared === 'bool') return value ? 1 : 0;
    if (declared === 'json') return JSON.stringify(value);
    return value;
  });
}

/** Converts one database row back into the application object shape. */
export function fromRow(table, row) {
  const columns = TABLES[table];
  const out = {};
  for (const [name, declared] of Object.entries(columns)) {
    const value = row[name];
    if (declared === 'bool') out[name] = value === null || value === undefined ? null : value === 1;
    else if (declared === 'json') out[name] = parseJson(value);
    else out[name] = value === undefined ? null : value;
  }
  return out;
}

function parseJson(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function columnNames(table) {
  return Object.keys(TABLES[table]);
}

/** `INSERT OR REPLACE` so a re-seed is idempotent and an update is a plain upsert. */
export function upsertSql(table) {
  const cols = columnNames(table);
  return `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
}
