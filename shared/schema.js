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
  /**
   * A market is the unit of separation, and it is explicit.
   *
   * Singapore prices and Taiwan planogram adherence are different questions in different
   * currencies under different law. Inferring the market from a currency or a browser locale
   * would make "which country is this number about" a guess, so it is a stored selection that
   * every query, rule lookup, export and cache key carries.
   */
  markets: {
    id: T,
    code: T,
    name: T,
    currency: T,
    timezone: T,
    /** BCP-47 tags, in preference order. Taiwan operates in zh-Hant and English. */
    supported_locales: 'json',
    /** Which modules this market runs: price_intelligence, planogram. */
    enabled_modules: 'json',
    policy_version: T,
    active: 'bool',
  },

  territories: { id: T, name: T, market: T, market_id: T },

  channels: { id: T, name: T },

  users: { id: T, name: T, role: T, territory_id: T, market_id: T, active: 'bool' },

  brands: { id: T, name: T, company: T, market_id: T, is_jti: 'bool' },

  skus: {
    id: T,
    brand_id: T,
    market_id: T,
    sku_code: T,
    name: T,
    /** Local-language name. Taiwan's catalogue is read in Traditional Chinese on the shelf. */
    name_local: T,
    is_jti: 'bool',
    is_strategic: 'bool',
    strategic_priority: T,
    tier: T,
    /**
     * Pack configuration. A price is only comparable within one: SGD 14.20 for a pack of 20
     * and SGD 14.20 for a pack of 10 are not the same price, and nothing on the screens said
     * which was being shown. Every price in this system is per pack as configured here.
     */
    sticks_per_pack: I,
    pack_type: T,
    active: 'bool',
  },

  outlets: {
    id: T,
    outlet_code: T,
    name: T,
    market_id: T,
    /** Retail account or chain. Planogram assignment resolves through it. */
    account_id: T,
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
    market_id: T,
    /** Which task the visit carried: price_check, planogram_audit. A visit may carry both. */
    modules: 'json',
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
    /** Who confirmed or corrected it. "Reviewed" with nobody attached is not a review. */
    reviewed_by: T,
    /**
     * Pack configuration as it stood when the price was read, alongside the rule and mapping
     * snapshots and for the same reason: a later catalogue edit must not silently restate
     * what was observed.
     */
    sticks_per_pack_snapshot: I,
    pack_type_snapshot: T,
    /**
     * When the shelf was seen, versus when the reading reached the system. They differ for an
     * offline capture, and "as of" means nothing if the two are conflated. `observed_at` above
     * is the shelf; this is the upload.
     */
    recorded_at: T,
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

  /* ------------------------------------------- Taiwan: planogram verification (TW-2, T-2) */

  /**
   * A physical display unit. An outlet has several; each is identified independently.
   *
   * `geometry` is the row/slot shape the fixture family declares, so a rule can say "row 2,
   * slot 4" and mean a place a person can point at. Physical dimensions are deliberately
   * absent: millimetres cannot be inferred from an uncalibrated photograph, and a number that
   * looks measured but is not is worse than no number.
   */
  fixture_types: {
    id: T,
    market_id: T,
    name: T,
    name_local: T,
    display_type: T,
    row_count: I,
    slots_per_row: I,
    orientation: T,
    /** 'exact_slot' where positions are identifiable, 'zone' where only blocks are. */
    geometry: T,
    notes: T,
    active: 'bool',
  },

  fixtures: {
    id: T,
    market_id: T,
    outlet_id: T,
    fixture_type_id: T,
    fixture_code: T,
    /** A replacement cabinet is a new revision, not an edit of the old one. */
    revision: I,
    orientation: T,
    reference_image_id: T,
    active_from: T,
    active_to: T,
    active: 'bool',
  },

  /** Stable identity. The versions carry the content. */
  planograms: {
    id: T,
    market_id: T,
    code: T,
    name: T,
    account_id: T,
    fixture_type_id: T,
    active: 'bool',
  },

  /**
   * An immutable published version.
   *
   * Published content never changes; a correction is a new version. That is what lets a
   * September audit still be explained by the plan that was in force in September, and what
   * stops a later edit silently restating what the field was asked to do.
   */
  planogram_versions: {
    id: T,
    planogram_id: T,
    market_id: T,
    version: T,
    /** draft | in_review | approved | published | retired */
    lifecycle: T,
    fixture_type_id: T,
    effective_from: T,
    effective_to: T,
    published_at: T,
    author_id: T,
    approver_id: T,
    change_note: T,
    source_document: T,
    /** Over the rule set, so a claim that two versions are identical can be checked. */
    content_hash: T,
  },

  /**
   * One typed requirement.
   *
   * `stable_rule_key` survives republication, so an issue opened against "row 2 slot 4 must
   * carry SKU A" stays the same issue when the planogram is reissued with that rule intact.
   * Without it, every republication would close every issue and open identical new ones.
   */
  planogram_rules: {
    id: T,
    version_id: T,
    stable_rule_key: T,
    /** assortment | exact_position | zone | facing_count | sequence */
    rule_type: T,
    row_id: T,
    slot_id: T,
    zone_id: T,
    expected_sku_id: T,
    allowed_sku_ids: 'json',
    min_facings: I,
    max_facings: I,
    sequence_group: T,
    sequence_index: I,
    /** mandatory | advisory. Only mandatory failures block "verified to plan". */
    criticality: T,
    notes: T,
  },

  /** Which version applies where, resolved by explicit scope and effective date. */
  planogram_assignments: {
    id: T,
    market_id: T,
    /** outlet_fixture | account_cluster | account_default | market_default */
    scope_type: T,
    outlet_id: T,
    fixture_id: T,
    account_id: T,
    cluster_id: T,
    fixture_type_id: T,
    version_id: T,
    effective_from: T,
    effective_to: T,
    approver_id: T,
    active: 'bool',
  },

  /**
   * A time-limited, approved departure from the published baseline.
   *
   * Two different operations, kept apart: `amend` changes what is allowed, `exempt` removes
   * the rule from evaluation. An exemption is reported separately and never improves an
   * adherence figure by quietly deleting the difficult cases from its denominator.
   */
  planogram_exceptions: {
    id: T,
    market_id: T,
    outlet_id: T,
    fixture_id: T,
    version_id: T,
    affected_rule_keys: 'json',
    /** amend | exempt */
    exception_type: T,
    amended_allowed_sku_ids: 'json',
    amended_min_facings: I,
    amended_max_facings: I,
    reason: T,
    approver_id: T,
    valid_from: T,
    valid_to: T,
    status: T,
  },

  /**
   * The photographs of one fixture on one occasion, and the reference they are bound to.
   *
   * `phase` keeps a follow-up capture apart from the capture that raised the issue: mixing
   * before and after evidence in one set is how a photograph of a fixed shelf comes to be
   * offered as proof that it was never broken.
   */
  capture_sets: {
    id: T,
    market_id: T,
    visit_id: T,
    outlet_id: T,
    fixture_id: T,
    /** before | after | follow_up */
    phase: T,
    captured_at: T,
    /** device_clock | user_stated | file_metadata | unknown — shown, never assumed. */
    timestamp_source: T,
    resolved_assignment_id: T,
    version_id: T,
    /** Why no reference could be bound, when that is the case. */
    resolution_problem: T,
    status: T,
    created_at: T,
  },

  /** One photograph. `supersedes_id` records a retake rather than overwriting the original. */
  capture_images: {
    id: T,
    capture_set_id: T,
    file_name: T,
    private_object_key: T,
    mime_type: T,
    width: I,
    height: I,
    source: T,
    captured_at: T,
    uploaded_at: T,
    quality_flags: 'json',
    /** Which rows this photograph is declared to cover, when overlap cannot be resolved. */
    covers_rows: 'json',
    supersedes_id: T,
  },

  /** What ran, on what, with which catalogue and in which mode. */
  recognition_runs: {
    id: T,
    capture_set_id: T,
    provider: T,
    model_version: T,
    catalogue_version: T,
    /** simulated | real_model | human_annotated — never inferred, always displayed. */
    recognition_mode: T,
    state: T,
    started_at: T,
    finished_at: T,
    duration_ms: I,
    error: T,
    input_hash: T,
  },

  /**
   * One front-visible product face at one position.
   *
   * `physical_facing_id` is the identity across photographs: the same pack seen in two
   * overlapping images is one facing, and two adjacent identical packs are two. Neither
   * follows from the SKU, which is why it is stored rather than derived.
   */
  observed_facings: {
    id: T,
    capture_set_id: T,
    run_id: T,
    physical_facing_id: T,
    row_id: T,
    slot_id: T,
    zone_id: T,
    /** product_face | dummy_pack | price_label | promotional_image | empty */
    entity_type: T,
    candidate_skus: 'json',
    provider_score: R,
    confirmed_sku_id: T,
    /** visible | partially_occluded | unknown */
    visibility: T,
    /** pending | confirmed | rejected */
    review_state: T,
    reviewed_by: T,
    reviewed_at: T,
    /** How it got here: provider, or a person who added a missed facing. */
    origin: T,
    notes: T,
  },

  /** A facing's link to the pixels behind it. Several images may support one facing. */
  facing_evidence: {
    id: T,
    facing_id: T,
    capture_image_id: T,
    bbox: 'json',
    coordinate_space: T,
    registration_confidence: R,
  },

  /**
   * What the photographs could and could not show.
   *
   * The difference between "nothing is there" and "nobody could see" is the difference
   * between a deviation and a retake, and it is invisible unless it is recorded.
   */
  evidence_regions: {
    id: T,
    capture_set_id: T,
    row_id: T,
    slot_from: I,
    slot_to: I,
    zone_id: T,
    /** usable | obscured | unseen */
    status: T,
    reason: T,
    reviewed_by: T,
  },

  /**
   * One evaluation of one confirmed layout against one reference snapshot.
   *
   * The four status dimensions are stored separately rather than collapsed: a partial
   * evidence set can still contain genuine confirmed deviations, and one status word would
   * have to choose which of those two facts to hide.
   */
  planogram_assessments: {
    id: T,
    market_id: T,
    capture_set_id: T,
    fixture_id: T,
    outlet_id: T,
    version_id: T,
    exception_ids: 'json',
    engine_version: T,
    policy_version: T,
    /** valid | missing | conflict | fixture_mismatch | time_uncertain */
    reference_status: T,
    /** complete | partial | unusable */
    evidence_status: T,
    /** pending | confirmed | rejected */
    review_status: T,
    /** none | deviations | not_evaluable */
    finding_status: T,
    summary: 'json',
    input_hash: T,
    assessed_at: T,
    submitted_at: T,
    submitted_by: T,
    confirmed_at: T,
    confirmed_by: T,
    incomplete_reason: T,
  },

  /** One rule, one verdict, with the evidence that produced it. */
  rule_results: {
    id: T,
    assessment_id: T,
    stable_rule_key: T,
    rule_type: T,
    criticality: T,
    /** pass | fail | unknown | exempt | not_applicable */
    status: T,
    expected: 'json',
    observed: 'json',
    /** [confirmed_min, plausible_max] where a count cannot be pinned down. */
    count_interval: 'json',
    reason: T,
    evidence_facing_ids: 'json',
    exception_id: T,
  },

  /**
   * The work item. Deliberately separate from the finding that raised it.
   *
   * A confirmed deviation stays a historical fact after its issue closes; closing the issue
   * does not unmake the observation. `episode` and `previous_issue_id` keep a recurrence
   * linked to what came before without reopening a case that was genuinely fixed.
   */
  execution_issues: {
    id: T,
    market_id: T,
    outlet_id: T,
    fixture_id: T,
    /** fixture + rule key + deviation family: the identity a repeat visit appends to. */
    dedupe_key: T,
    episode: I,
    previous_issue_id: T,
    stable_rule_key: T,
    rule_type: T,
    criticality: T,
    first_assessment_id: T,
    latest_assessment_id: T,
    closing_assessment_id: T,
    /** open | assigned | in_progress | awaiting_evidence | awaiting_verification |
     *  closed_verified | blocked | closed_invalid | closed_approved_exception |
     *  superseded_by_reference_change */
    status: T,
    owner_id: T,
    due_date: T,
    first_detected_at: T,
    last_detected_at: T,
    closed_at: T,
    closure_reason: T,
  },

  issue_events: {
    id: T,
    issue_id: T,
    event_type: T,
    actor_id: T,
    at: T,
    from_status: T,
    to_status: T,
    assessment_id: T,
    reason: T,
    notes: T,
  },

  /** Who did what to which entity. Required by T-2 for every mutation that matters. */
  audit_events: {
    id: T,
    market_id: T,
    actor_id: T,
    actor_role: T,
    entity_type: T,
    entity_id: T,
    action: T,
    at: T,
    changed: 'json',
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
  // Taiwan: the joins every planogram screen makes.
  'CREATE INDEX IF NOT EXISTS idx_fixtures_outlet ON fixtures (outlet_id)',
  'CREATE INDEX IF NOT EXISTS idx_pg_versions_planogram ON planogram_versions (planogram_id)',
  'CREATE INDEX IF NOT EXISTS idx_pg_rules_version ON planogram_rules (version_id)',
  'CREATE INDEX IF NOT EXISTS idx_pg_assign_fixture ON planogram_assignments (fixture_id)',
  'CREATE INDEX IF NOT EXISTS idx_capture_sets_fixture ON capture_sets (fixture_id)',
  'CREATE INDEX IF NOT EXISTS idx_facings_capture_set ON observed_facings (capture_set_id)',
  'CREATE INDEX IF NOT EXISTS idx_assessments_fixture ON planogram_assessments (fixture_id)',
  'CREATE INDEX IF NOT EXISTS idx_rule_results_assessment ON rule_results (assessment_id)',
  'CREATE INDEX IF NOT EXISTS idx_issues_fixture ON execution_issues (fixture_id)',
  'CREATE INDEX IF NOT EXISTS idx_issues_dedupe ON execution_issues (dedupe_key)',
  'CREATE INDEX IF NOT EXISTS idx_issue_events_issue ON issue_events (issue_id)',
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

/**
 * Statements that bring an existing database up to the current declaration.
 *
 * `CREATE TABLE IF NOT EXISTS` is silent about a table that exists but is missing a column:
 * adding `sticks_per_pack` to the descriptor changed the DDL and changed nothing in a
 * deployed D1, where the table was created before the column existed. Reads then came back
 * with the column absent and the feature simply did not appear — no error anywhere.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so each statement is issued on its own and a
 * "duplicate column name" is the expected outcome on an already-migrated database. The caller
 * runs them one at a time and tolerates exactly that error, which is why this returns one
 * statement per column rather than a batch.
 */
export function migrationStatements() {
  const statements = [];
  for (const [table, columns] of Object.entries(TABLES)) {
    for (const [name, declared] of Object.entries(columns)) {
      if (name === 'id') continue;
      statements.push({
        table,
        column: name,
        sql: `ALTER TABLE ${table} ADD COLUMN ${name} ${sqlType(declared)}`,
      });
    }
  }
  return statements;
}

/** Whether a failed ALTER simply means the column is already there. */
export function isDuplicateColumnError(error) {
  return /duplicate column name/i.test(String(error?.message ?? error ?? ''));
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
