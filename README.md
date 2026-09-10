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
npm run deploy  # publish to Cloudflare Workers
```

No build step. The app is plain ES modules served as static assets by a Cloudflare Worker.

**The application declares no dependencies at all**, so `npm install` fetches nothing and the
lockfile holds only the root package. That is deliberate: a declared dependency means the
deploy build runs `npm ci`, and a lockfile that resolves differently on the build machine than
on the author's then fails the deploy for reasons unrelated to the app. Local tooling is
installed on demand instead:

```bash
npm run toolchain   # installs wrangler + playwright + esbuild (no-save)
npm run smoke       # end-to-end browser test: full field flow + every manager route
npm run bundle      # single self-contained HTML file in dist/
npm run demo-images # regenerate the sample shelf photos
```

### Where the data lives

Observations are stored in **Cloudflare D1**, so a visit a TME submits on a phone is visible
to a manager on a laptop. The client loads the whole dataset once from `/api/data` and keeps
it in memory, which keeps every read synchronous; writes update memory immediately and are
sent to `/api/mutations` in the background.

| Route | Purpose |
|---|---|
| `GET /api/data` | full dataset snapshot, in the shape the client store expects |
| `POST /api/mutations` | batch of upserts / deletes, constrained to the declared schema |
| `POST /api/seed` | create the tables and load the demo dataset — **only while empty** |
| `GET /api/health` | reachability and row counts |

`shared/schema.js` declares every table and column once and drives the DDL, the reads and
the writes, so the two sides cannot drift. SQLite has no boolean and a few fields hold
arrays, so the descriptor marks those columns and the conversions happen in one place.

**Bootstrapping a fresh database:** open **Admin → Database** and press *Load demo data into
the database*. Seeding without a credential is allowed only while the database is empty, so a
new deployment can bootstrap itself but nobody can wipe live observations by calling a URL.
Re-seeding a populated database needs an `x-seed-token` header matching a `SEED_TOKEN`
binding, which is deliberately not configured.

**Without a database** — a plain static host, the standalone build, or a deploy with no D1
binding — the client falls back to its bundled seed data and keeps working. The top bar says
which of the two is live, because an app quietly running on per-browser data looks identical
to one reading shared observations, and a TME could otherwise submit a visit that never
leaves their phone.

Session state (selected user, manager filters) and the tuning values on the Admin tabs stay
per-browser in `localStorage`: they are the viewer's own preferences, not observations. The
cache key carries a fingerprint derived from the seed catalogue, so changing a SKU, outlet or
user automatically orphans every previously cached copy.

```bash
node scripts/seed-db.mjs                                   # writes dist/seed.sql
npx wrangler d1 execute retail-price-intelligence --local  --file=dist/seed.sql
npx wrangler d1 execute retail-price-intelligence --remote --file=dist/seed.sql
SMOKE_BASE=http://127.0.0.1:8787 npm run smoke             # smoke against a real Worker + D1
```

### Deploying

The app deploys as a single Cloudflare Worker serving `public/` as static assets. Validate
the bundle at any time without credentials:

```bash
npx wrangler deploy --dry-run
```

To publish you need Cloudflare credentials. Either authenticate interactively:

```bash
npx wrangler login    # opens a browser
npm run deploy
```

…or supply an API token via environment variables (for CI or a headless environment):

```bash
export CLOUDFLARE_API_TOKEN=...     # "Edit Cloudflare Workers" template
export CLOUDFLARE_ACCOUNT_ID=...    # Cloudflare dashboard → Workers & Pages → Account ID
npm run deploy
```

The token needs **Account → Workers Scripts → Edit**. The Worker name in `wrangler.toml`
must match the deployed Worker (`price-check`), otherwise the deploy creates a second copy
instead of updating the live one.

Deploying from Git instead: Cloudflare builds the repository's **default branch**. If the
live URL serves something unexpected, check **Workers & Pages → the project → Deployments**
for which commit was built and whether the build succeeded — a failed build leaves the
previous deployment serving.

Nothing in the app is server-side — state lives in the visitor's browser — so a deploy is
just an asset upload and is safe to repeat.

### Trying the demo

1. Open the app — you start as **TME East** (a Trade Marketer).
2. **Start Price Check → search "Punggol" → Punggol Central Minimart.**
3. **Choose from Gallery**, or tap one of the **sample shelf photos** on that screen — the
   recognition simulator works with any image, including a real photo from your device.
4. Confirm the detected prices, correct one, record a field action, submit.
5. Switch the user dropdown (top right) to **Commercial Manager** and open the
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

## Singapore market specifics reflected in the data

- **Brands and owners are real.** JTI's Singapore portfolio here is Winston, Mevius, Camel
  and LD; competitors are Marlboro / L&M / Chesterfield (Philip Morris International),
  Dunhill / Pall Mall / Lucky Strike (British American Tobacco) and Davidoff (Imperial
  Brands). Note that **L&M is a PMI brand**, not a JTI one — the specification's illustrative
  example placed it on the JTI side.
- **Prices are indicative, not a price list.** They sit in the SGD 12.60–16.00 band Singapore
  retail occupies, with Marlboro at the top and LD at the bottom. Replace them with JTI
  master data before any real use.
- **Point-of-sale display is banned** (since 1 August 2017): general retailers must keep
  tobacco out of the public's line of sight in plain storage. What a TME can photograph is
  therefore the **price list** and pack faces inside an opened cabinet — not an open shelf.
  The sample capture images are drawn that way.
- **Standardised packaging** (since 1 July 2020) means no brand colours or logos, so a real
  recognition provider must read the brand name in a standard font against a drab base, with
  graphic health warnings over most of the pack. That makes accurate OCR of the price list
  more valuable than pack recognition.

Demo users are labelled by role and territory — TME East, Commercial Manager, Master Data
Admin — so nothing in the dataset reads as a real individual.

## What the seeded demo data demonstrates

24 outlets across Central / North / East / West, four channels, seven JTI SKUs (Winston,
Mevius, Camel, LD), eight competitor SKUs from PMI, BAT and Imperial, and roughly 900 price
observations over 12 weeks — engineered to show:

- the same JTI SKU sold at different prices across outlets (real dispersion);
- observations below, within and above the recommended range;
- a **superseded price rule** (the Strategic SKU recommendation moved from SGD 13.40 to
  13.60 forty-five days ago) so historical integrity is visible;
- a **territory override** (East prices Mevius Original at 14.50, not 14.40);
- a **future-dated rule** that is visible in admin but does not affect past observations;
- a **material competitor price drop** (Pall Mall Red, −SGD 0.50, 20 days ago);
- a **persistent Strategic SKU opportunity** at Punggol Central Minimart;
- **low-confidence detections** feeding the Image Review queue;
- a **TME engagement followed by an observed price improvement** at Yishun Mini Mart
  (SGD 14.50 → 14.00, gap +0.80 → +0.30) — reported as an observed sequence, never as
  causation.

---

## Recognition models

**Admin → Recognition provider** picks the model. The choice is stored in configuration and
survives a reload.

| Model | Reads the image? | Cost |
|---|---|---|
| MVP Simulator | **No** | free, offline |
| `@cf/meta/llama-3.2-11b-vision-instruct` **(recommended)** | Yes | free daily allocation |
| `@cf/llava-hf/llava-1.5-7b-hf` | Yes | free daily allocation |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | Yes | free daily allocation, then Workers AI rates |
| `@cf/qwen/qwen3.8-27b` | Yes | **paid** — Workers Paid plan or AI Gateway credits |
| `openai/gpt-4.1-mini` | Yes | **paid** — AI Gateway credits |

Workers AI includes **10,000 Neurons per day at no charge** on both the Free and Paid plans.
Models marked *free allocation* run inside it; the frontier and third-party models fail with
a credits error until billing is arranged. The Admin screen marks each model, and the Worker
turns provider codes into instructions — `2021: Insufficient AI Gateway credits` becomes a
sentence naming the free models to use instead.

The **simulator does not look at the photograph.** It generates plausible detections from the
SKU catalogue and the effective price rules, seeded from the image file identity so the same
photo always gives the same answer. It exists for demos and offline work; the prices it
reports are invented. The Admin screen and the active-model card both say so, because a
simulator that looks like recognition is the most expensive kind of misunderstanding here.

Real models run **server-side** through the Worker's `AI` binding (`POST /api/recognise`), so
no credential ever reaches a device a TME carries into a shop. The browser downscales the
photo to 1600px before upload — a phone image is far larger than a model needs to read a
price list, and the round trip is what the TME waits on.

A model answers in free text, so `shared/recognition.js` extracts the JSON, matches what was
read back to catalogue SKUs (requiring the brand token, so "Winston Red" never matches
"Marlboro Red" on the shared word) and normalises prices. A line it cannot match is still
shown to the TME with its price and flagged low confidence — a silently discarded price is
worse than one that needs confirming. That module is pure and unit-tested; the live model
call is not something tests can cover.

Recognition failures are reported as failures. The app does not fall back to the simulator,
because putting invented prices in front of a TME under the banner of a real model is worse
than an error.

### Local development with the AI binding

Workers AI has no local emulation: binding it makes `wrangler dev` open a remote proxy
session that needs Cloudflare credentials. Two configurations exist for this reason:

```bash
npm run dev          # wrangler.toml       — assets + D1 + AI, needs `wrangler login`
npm run dev:local    # wrangler.local.toml — assets + local D1, fully offline
```

Under `dev:local`, `/api/recognise` returns 503 and the simulator is used. Keep the bindings
in the two files in step.

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
