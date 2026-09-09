# Retail Price Intelligence — Singapore

Mobile-first field price capture plus a manager-facing price-intelligence decision-support
application. Built to the v2.0 product specification.

> **Market context.** Singapore retail outlets independently determine their final selling
> price. This application observes, benchmarks, prioritises and supports commercial
> influence. It does **not** enforce retailer pricing, and a price outside a JTI
> recommended range is a market signal — not a violation.

---

## Quick start

```bash
npm install

npm test        # 96 unit/integration tests (node:test, no browser needed)
npm run serve   # plain static server on http://localhost:8787
npm run dev     # the real Cloudflare Worker runtime (wrangler)
npm run smoke   # end-to-end browser test: full field flow + every manager route
npm run deploy  # publish to Cloudflare Workers
```

No build step. The app is plain ES modules served as static assets by a Cloudflare Worker.

### Trying the demo

1. Open the app — you start as **Wei Ling Tan (Trade Marketer)**.
2. **Start Price Check → search "Punggol" → Punggol Central Minimart.**
3. **Choose from Gallery.** Sample shelf photos are linked on that screen, or use any photo
   from your own device — the recognition simulator works with any image.
4. Confirm the detected prices, correct one, record a field action, submit.
5. Switch the user dropdown (top right) to **Priya Nair — Manager** and open the
   **Price Control Tower**: the visit you just submitted is already in the KPIs, the price
   position matrix and the opportunity list.

`Reset demo` in the top bar restores the seeded dataset at any time.

---

## Architecture

```
public/
  index.html                     app shell
  styles/app.css                 design system
  demo-images/                   sample shelf photos for the gallery flow
  app/
    main.js                      router, app shell, event delegation
    config.js                    every business threshold and weight (data-driven)
    seed.js                      deterministic demo dataset
    store.js                     persistence + mutations (localStorage today)
    lib/                         stats, dates, csv, formatting, deterministic RNG
    services/                    all business logic — pure, framework-free, unit-tested
      priceRuleService.js        effective-rule resolution + overlap validation
      competitorMappingService.js
      pricePositionService.js    range status, gap, Price Index, competitive alignment
      opportunityService.js      priority scoring, categories, lifecycle
      analyticsService.js        KPIs, matrix, dispersion, moves, field effectiveness
      visitService.js            the field workflow
      imageService.js            acquisition + quality validation
      recognition/               provider abstraction + MVP simulator
    ui/                          one module per screen; render + delegated handlers
tests/                           node:test suites
scripts/                         static server, smoke test, demo image generator
worker.js                        Cloudflare Worker entry (serves static assets)
```

### Design rules the code follows

- **No business logic in UI components.** Pricing rules, competitor mappings, scoring
  weights and thresholds all live in `config.js` or master data and are read at runtime.
  The Admin screens edit them; nothing is hard-coded in a component.
- **Recognition is behind an interface.** `analyzePriceImage(image, context) → detections[]`.
  The MVP simulator is one registered provider; swapping in Trax, a Vision API or a
  multimodal model means registering another provider and changing no UI code.
- **Historical integrity.** Every observation stores a *snapshot* of the price rule and the
  competitor mapping that were effective when it was recorded. Analytics read the snapshot,
  never the live master rule — so editing a rule today does not silently restate last
  month's dashboard.
- **Terminology is enforced by a test.** `tests/terminology.test.js` scans all user-facing
  source for compliance framing ("violation", "non-compliant", "target price", …) and fails
  the build if any appears.

### Rule resolution

The most specific effective rule wins:

```
Outlet  >  Territory + Channel  >  Territory  >  Channel  >  Market
```

Ties break on explicit `priority`, then the most recent `effective_from`, then rule id — so
resolution is deterministic. The Price Rules admin screen flags any pair of rules that
share a scope, a priority and an overlapping date window, because those would be ambiguous.

### Key formulas

| Metric | Definition |
|---|---|
| Recommended Price Alignment | `within-range JTI observations / JTI observations with a valid recommendation` |
| Price Gap | `jti_price − competitor_price` |
| Price Index | `jti_price / competitor_price × 100` (100 = parity) |
| Competitive Alignment | gap inside the desired band **or** Price Index inside the desired band (per-mapping `comparison_method` may narrow this to one measure) |
| Price Dispersion | `P90 − P10` (median, P10, P25, P75, P90 and IQR are all reported) |
| Priority Score | `Strategic + Competitive Severity + Range Severity + Persistence + Outlet Scale + Competitor Move + Unresolved Action − Low Confidence` |

---

## What the seeded demo data demonstrates

24 outlets across Central / North / East / West, four channels, six JTI SKUs, six competitor
SKUs and roughly 860 price observations over 12 weeks — engineered to show:

- the same JTI SKU sold at different prices across outlets (real dispersion);
- observations below, within and above the recommended range;
- a **superseded price rule** (the Strategic SKU recommendation moved from SGD 13.50 to
  13.70 forty-five days ago) so historical integrity is visible;
- a **territory override** (East prices L&M Double Forward XL Fresh at 14.40, not 14.30);
- a **future-dated rule** that is visible in admin but does not affect past observations;
- a **material competitor price drop** (Competitor A Core, −SGD 0.50, 20 days ago);
- a **persistent Strategic SKU opportunity** at Punggol Central Minimart;
- **low-confidence detections** feeding the Image Review queue;
- a **TME engagement followed by an observed price improvement** at Yishun Mini Mart
  (SGD 14.50 → 14.00, gap +0.80 → +0.30) — reported as an observed sequence, never as
  causation.

---

## Replacing the recognition simulator

```js
import { registerProvider, setActiveProvider } from './services/recognition/provider.js';

registerProvider({
  id: 'trax',
  label: 'Trax',
  kind: 'production',
  async analyzePriceImage(image, context) {
    const res = await fetch('/api/recognise', { method: 'POST', body: image.file });
    const { items } = await res.json();
    return items.map((item) => ({
      raw_text: item.text,
      brand_candidate: item.brand,
      sku_candidate: item.skuId,
      price_candidate: item.price,
      confidence: item.confidence,
      bounding_box: item.box,
      alternatives: item.alternatives,
    }));
  },
});
setActiveProvider('trax');
```

Nothing else changes. The active provider is switchable at runtime from
**Admin → Recognition provider**.

## Replacing localStorage with a backend

`store.js` is the only module that touches persistence. Every read and write in the app goes
through it, so swapping `localStorage` for a REST API, D1 or KV is a one-file change; the UI
and the services are untouched.

---

## Known MVP limitations

- Recognition is simulated. It is deterministic per image, so demos are reproducible, but it
  does not read pixels.
- Images are previewed from an object URL and are not uploaded or persisted; only their
  metadata (name, source, quality status) is stored.
- Persistence is per-browser `localStorage`, so data is not shared between devices.
- Opportunity lifecycle state is stored separately from the derived opportunity, keyed by
  outlet + SKU.
