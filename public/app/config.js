/**
 * Application configuration.
 *
 * Every business threshold used by the price-intelligence engine lives here (or in
 * master data) — never inside a UI component. Admin screens read/write this object
 * through `store.getConfig()` / `store.updateConfig()` so the same code path serves
 * a future server-backed configuration table.
 */

export const DEFAULT_CONFIG = {
  market: 'SG',
  currency: 'SGD',

  /** Comparison method used when a mapping does not specify one. gap | price_index | both */
  comparison_method: 'both',

  /** Recognition confidence below which an observation is routed to Image Review. */
  confidence_review_threshold: 0.75,
  /** Manager dashboards may exclude observations below this confidence. */
  confidence_analytics_threshold: 0.6,

  /** Data freshness buckets, in days (§26). */
  freshness: {
    fresh_max_days: 7,
    aging_max_days: 14,
  },

  /** Competitor move detection (§13, §24). */
  competitor_move: {
    lookback_days: 30,
    min_abs_change: 0.2,
    min_pct_change: 1.5,
    strategic_mapping_weight: 1.5,
  },

  /** Price dispersion flags (§15). */
  dispersion: {
    primary_metric: 'p90_minus_p10',
    high_dispersion_abs: 0.8,
    high_dispersion_pct: 5.0,
    min_observations: 5,
  },

  /** Persistent deviation (§10, §24). */
  persistence: {
    min_consecutive_visits: 2,
    min_days_open: 14,
  },

  /** Opportunity priority scoring weights (§17). Tunable by Admin. */
  priority_scoring: {
    strategic_weight: { High: 30, Medium: 18, Low: 8, none: 0 },
    recommended_range_severity_per_pct: 3.0,
    recommended_range_severity_cap: 25,
    competitive_gap_severity_per_index_point: 2.5,
    competitive_gap_severity_cap: 25,
    outlet_scale_per_outlet: 1.2,
    outlet_scale_cap: 15,
    persistence_per_day: 0.6,
    persistence_cap: 15,
    competitor_move_weight: 12,
    unresolved_action_weight: 10,
    low_confidence_penalty: 8,
    thresholds: { high: 60, medium: 35 },
  },

  /** Image quality simulation / validation thresholds (§8.4). */
  image_quality: {
    min_width: 640,
    min_height: 640,
    min_bytes: 40 * 1024,
    allow_continue_anyway: true,
  },
};

/** Deep clone helper so callers never mutate the frozen defaults. */
export function defaultConfig() {
  return structuredClone(DEFAULT_CONFIG);
}

export const PRICE_POSITION_STATUS = {
  WITHIN: 'Within Recommended Range',
  BELOW: 'Below Recommended Range',
  ABOVE: 'Above Recommended Range',
  AT_RISK: 'Competitive Position At Risk',
  STRONG: 'Strong Competitive Position',
  REVIEW: 'Review Required',
  NONE: 'No Recommendation Available',
};

export const FIELD_ACTION_TYPES = [
  'No action',
  'Discussed with outlet',
  'Outlet agreed to review price',
  'Outlet agreed to adjust price',
  'Outlet declined',
  'Follow-up required',
  'Trade investment review required',
  'Competitive position review required',
  'Other',
];

export const FIELD_RECOMMENDATIONS = {
  NONE: 'No action required',
  MONITOR: 'Monitor',
  ENGAGE: 'Engage outlet',
  REVIEW_COMPETITIVE: 'Review competitive positioning',
  REVIEW_INVESTMENT: 'Review trade investment',
  FOLLOW_UP: 'Follow-up required',
};

export const OPPORTUNITY_CATEGORIES = {
  COMPETITIVE_RISK: 'Competitive Risk',
  RECOMMENDED_DEVIATION: 'Recommended Price Deviation',
  PERSISTENT: 'Persistent Deviation',
  COMPETITOR_MOVE: 'Recent Competitor Move',
  DISPERSION: 'High Price Dispersion',
  STRATEGIC_RISK: 'Strategic SKU Risk',
};

export const OPPORTUNITY_STATUSES = [
  'New',
  'Acknowledged',
  'In Progress',
  'Monitoring',
  'Resolved',
  'Closed — No Action',
];

export const IMAGE_QUALITY_STATUSES = [
  'Good',
  'Low Resolution',
  'Blurry',
  'Price Not Visible',
  'Product/SKU Not Visible',
  'Multiple Ambiguous Labels',
  'Unsupported Image',
];
