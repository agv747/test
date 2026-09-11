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

npm test        # 144 unit/integration tests (node:test, no browser needed)
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
    store.js                     loads from /api/data, writes through /api/mutations
    lib/                         stats, dates, csv, formatting, deterministic RNG
    services/                    all business logic — pure, framework-free, unit-tested
      priceRuleService.js        effective-rule resolution + overlap validation
      competitorMappingService.js
      pricePositionService.js    range status, gap, Price Index, competitive alignment
      opportunityService.js      priority scoring, categories, lifecycle
      analyticsService.js        KPIs, matrix, dispersion, moves, field effectiveness
      visitService.js            the field workflow
      imageService.js            acquisition + quality validation
      recognition/               provider abstraction, simulator + vision models
    ui/                          one module per screen; render + delegated handlers
shared/
  schema.js                      D1 tables and columns, declared once for both sides
  recognition.js                 vision prompt, JSON extraction, SKU matching (pure)
tests/                           node:test suites
scripts/                         static server, smoke test, seeder, bundler
worker.js                        Worker entry: static assets + /api routes
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
| MVP Simulator *(default)* | **No** | free, offline |
| `@cf/llava-hf/llava-1.5-7b-hf` **(recommended)** | Yes | free daily allocation |
| `@cf/meta/llama-3.2-11b-vision-instruct` | Yes | free allocation, one-time licence acceptance |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | Yes | free allocation, one-time licence acceptance |
| `openai:gpt-4.1-mini` | Yes | **your own OpenAI key** |
| `openai:gpt-4o` | Yes | **your own OpenAI key** |
| `@cf/qwen/qwen3.8-27b` | Yes | **paid** — Workers Paid plan or AI Gateway credits |
| `openai/gpt-4.1-mini` | Yes | **paid** — AI Gateway credits |

**Using your own OpenAI key.** The key is stored as a **Worker secret**, never in the
database and never returned to a browser:

```bash
npx wrangler secret put OPENAI_API_KEY
```

…or Cloudflare dashboard → the Worker → Settings → Variables and Secrets → Add → type
**Secret** → name `OPENAI_API_KEY`. Admin shows only whether it is configured.

This application has **no authentication**: anyone with the URL can use it, and therefore
anyone with the URL can spend against that key. Set a spending limit on the OpenAI side. A
key accepted through a form and stored in the database would be worse — it could be taken,
not merely spent.

**Licence-gated models.** The Llama models require a one-time acceptance of Meta's Community
License, sent as the literal prompt `agree`. That acceptance also represents that you are
**not domiciled in the European Union**, so the app never sends it automatically: Admin shows
both documents and keeps the button disabled until a box is ticked. LLaVA carries no such
restriction, which is why it is the recommended default.

**Testing a model.** Admin → Recognition provider → *Test on a sample image* runs the chosen
model against a demo price list through the real `/api/recognise` path and writes the whole
exchange to a call log — HTTP status, elapsed time, every detection with its matched SKU and
confidence, and the raw model response. **Deployment configuration** on the same screen
reports what is actually bound: `env.AI`, `env.DB`, the AI Gateway id, and whether the
OpenAI key is set.

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

## Shelf overlay — recognition results drawn on the photo

Step 3 of a price check offers two views of the same detections, and the working list stays
the default:

- **List** — the cards a TME confirms and submits. Works with no image on the device.
- **Shelf overlay** — the captured photo with a marker per detection carrying the price, the
  SKU and the recognition percentage. Tapping a marker opens that detection for correction.
  A full-screen button removes the surrounding chrome.

This is an annotated still, not live camera passthrough. A vision model answers in seconds,
not in frames, so a continuously updating overlay would either lag far behind the camera or
cost one model call per frame; freezing the frame is also what the task needs, since prices
are read once per visit and then corrected.

**Where the rectangles come from is always stated on screen**, because a rectangle on a
photograph reads as evidence:

| Source | Meaning |
|---|---|
| `model` | The model reported coordinates and they survived the check below. |
| `inferred` | It reported none — or reported ones that failed the check — so lines are laid out in the order it read them, top to bottom. Approximate. |
| `manual` | The TME dragged the marker there. Saved with the observation. |
| `simulated` | The MVP Simulator invented both the prices and the rectangles. |

Most vision models return no coordinates when reading a printed price list, so `inferred` is
the common case. The prompt asks for an optional `box`, states the coordinate frame instead of
assuming the model shares one, and says to leave `box` out of every detection rather than
estimate. Measured and inferred geometry are never mixed in one picture, and the weakest
provenance present is what the picture as a whole is allowed to claim.

### Why coordinates are checked against the pixels

A vision model read a shelf photo correctly — right products, right prices — and returned a
tidy two-by-three lattice of identical rectangles sitting a tenth of the image above the packs
they claimed to mark. Every number was in range and internally consistent, so no amount of
geometry could tell they were invented.

The pixels can. `public/app/lib/boxes.js` samples the uploaded frame to a 160px luminance grid
and measures **edge density** — the fraction of pixels sitting on a steep gradient — inside
each reported box. A price label or a pack is full of edges; the dark inside of a cabinet has
almost none. A box below the threshold is discarded, and if every box is discarded the whole
set falls back to reading order rather than leaving the photo unannotated.

Edge density rather than average contrast, which was tried first and failed: measured on a
real price list, a legitimate box three times taller than the line it marks scored *below*
empty shelf on average contrast, because the surplus white swamped the text. It scored 0.078
against 0.000 on edge density, since surplus background adds no edges to find. Range separates
them too, but one bright speck carries it — and that is what sensor noise in a dark cabinet is.

The check runs in the browser, because that is the only place the pixels exist: the Worker
receives a base64 JPEG it cannot decode. Where there is no canvas to read (a tainted canvas, a
browser that blocks readback) nothing is rejected — a check that could not run is not evidence
against the model.

### Moving a marker

**✥ Move markers** turns the overlay into a placing surface: drag any marker onto the pack or
price label it belongs to, and it is recorded as `manual` and saved with the visit. Outside
that mode a marker is a plain tap target and a touch that starts on one scrolls the page —
markers cover most of the photo, so making every one of them swallow a swipe would leave the
page unscrollable on a phone. Moving a marker never touches the price, the SKU, or the
"corrected" flag: where a detection sits is not a correction of what was read.

### The recognition percentage

The percentage beside a detection is the model's own certainty that it read **both the
product name and the price** correctly. It says nothing about whether the price is
commercially good or bad. It is never rendered as a bare number next to a price-position
pill, where it read as one more business figure — it carries the word *Recognition*, a plain
word (*read clearly* / *read with doubt* / *needs confirming*) so the reading never depends on
colour, and the explanation sits on the same screen. Below
`config.confidence_review_threshold` (0.75) the detection is marked **Review Required** and
does not drive a price-position judgement until it is confirmed.

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
      // {x, y, w, h} as fractions of the image, plus source: 'model'. Omit it and the
      // shelf overlay lays the detections out in reading order, labelled approximate.
      // A box that points at a featureless part of the photo is discarded — see
      // "Why coordinates are checked against the pixels".
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
  metadata (name, source, quality status) is stored. The shelf overlay therefore works during
  the visit, on the device that took the photo, and Image Review shows a detection's region as
  geometry without the photograph behind it.
- Persistence is per-browser `localStorage`, so data is not shared between devices.
- Opportunity lifecycle state is stored separately from the derived opportunity, keyed by
  outlet + SKU.
