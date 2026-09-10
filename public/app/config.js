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

  /** Active recognition model id — see RECOGNITION_MODELS. */
  recognition_model: 'mock-simulator',

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

/**
 * Recognition models offered in Admin (§27).
 *
 * `kind: 'simulated'` does not look at the image at all — it is a deterministic generator
 * for demos and offline work. Everything else runs a real vision model server-side through
 * the Worker's `AI` binding, so no credential ever reaches the browser.
 *
 * Cloudflare-hosted models (`@cf/…`) need only the AI binding. Third-party models
 * (`author/model`) additionally need an AI Gateway with Unified Billing, where Cloudflare
 * holds the provider credentials.
 */
export const RECOGNITION_MODELS = [
  {
    id: 'mock-simulator',
    label: 'MVP Simulator',
    kind: 'simulated',
    tier: 'free',
    reads_image: false,
    description:
      'Generates plausible detections from the SKU catalogue and price rules without looking at the image. Deterministic, offline — for demos and development only.',
    cost: 'Free',
  },
  {
    id: '@cf/meta/llama-3.2-11b-vision-instruct',
    label: 'Llama 3.2 11B Vision',
    kind: 'workers-ai',
    tier: 'free',
    recommended: true,
    reads_image: true,
    description:
      'Cloudflare-hosted vision model. Reads the price list directly and is the recommended starting point — it runs inside the free daily allocation.',
    cost: 'Free daily allocation (10,000 Neurons/day)',
  },
  {
    id: '@cf/llava-hf/llava-1.5-7b-hf',
    label: 'LLaVA 1.5 7B',
    kind: 'workers-ai',
    tier: 'free',
    reads_image: true,
    description:
      'Smaller image-to-text model. Cheapest in Neurons, so it stretches the free allocation furthest, but less reliable on a dense price list.',
    cost: 'Free daily allocation (10,000 Neurons/day)',
  },
  {
    id: '@cf/meta/llama-4-scout-17b-16e-instruct',
    label: 'Llama 4 Scout 17B',
    kind: 'workers-ai',
    tier: 'free',
    reads_image: true,
    description:
      'Natively multimodal mixture-of-experts model. Stronger than Llama 3.2, and heavier — it consumes the daily allocation faster.',
    cost: 'Free daily allocation, then Workers AI rates',
  },
  {
    id: '@cf/qwen/qwen3.8-27b',
    label: 'Qwen 3.8 27B',
    kind: 'workers-ai',
    tier: 'paid',
    reads_image: true,
    description:
      'The strongest Cloudflare-hosted option for a dense price list. A frontier model: it needs the Workers Paid plan or prepaid AI Gateway credits.',
    cost: '$0.45 / M input tokens, $3.20 / M output tokens',
  },
  {
    id: 'openai/gpt-4.1-mini',
    label: 'GPT-4.1 mini (via AI Gateway)',
    kind: 'gateway',
    tier: 'paid',
    reads_image: true,
    description:
      'Third-party model routed through AI Gateway. Needs a gateway with Unified Billing and prepaid credits; Cloudflare holds the provider credentials, so no API key is stored here.',
    cost: 'Billed through AI Gateway credits',
  },
];

export const DEFAULT_RECOGNITION_MODEL = 'mock-simulator';

/**
 * The model to suggest when someone wants real recognition without arranging billing.
 * Kept separate from the default so a fresh install still starts on the simulator.
 */
export const RECOMMENDED_FREE_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

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
