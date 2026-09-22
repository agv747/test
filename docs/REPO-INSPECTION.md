# Repository inspection

Specification v3.0 §1 requires this before editing: what is real, what is simulated, what is
browser-only, and what is missing. This is a source-level inventory of the repository as it
stands, not a reading of the deployed UI.

Read at commit `237471f`, 22 September 2026.

---

## 1. Stack and deployment — real

| Layer | What is actually there |
|---|---|
| Frontend | Plain ES modules, no framework, no build step. `public/` is served as static assets. One module per screen under `public/app/ui/`, with delegated event handling in `main.js`. |
| Domain logic | Pure modules under `public/app/services/`, framework-free and imported by both the UI and the tests. No business logic in the UI components. |
| API | One Cloudflare Worker (`worker.js`): `/api/data`, `/api/mutations`, `/api/seed`, `/api/migrate`, `/api/recognise`, `/api/model-licence`, `/api/config`, `/api/health`. |
| Database | Cloudflare D1 (`retail-price-intelligence`), live and populated — 1,322 price observations, 15 SKUs, 24 outlets at the time of inspection. |
| Schema | `shared/schema.js` declares every table and column once and drives the DDL, the reads and the writes, so the two sides cannot drift. Additive migration through `POST /api/migrate`. |
| Tests | 370 `node:test` unit tests over the domain services; 168 Playwright checks driving a real Chromium through the whole field and manager workflow. |
| Dependencies | None declared. Tooling is installed on demand (`npm run toolchain`). |

**Conclusion for §T-1:** the existing Cloudflare deployment is suitable and there is no concrete
blocker. Retain it. The domain services are already the "shared pure domain logic, independent
of model/vendor and UI" that T-1 asks for, and the Taiwan comparison engine belongs beside them.

## 2. Recognition — both real and simulated, and it says which

Recognition is behind `analyzePriceImage(image, context) → detections[]` with a provider
registry. Four provider kinds are wired:

| Kind | Models | Real? |
|---|---|---|
| `simulated` | `mock-simulator` — **the default** | No. Generates detections from the catalogue; built-in sample photos return a fixed agreed fixture. |
| `workers-ai` | LLaVA 1.5, Llama 3.2 Vision, Llama 4 Scout, Qwen 3.8 | Yes, through the Worker's `AI` binding. |
| `openai` | GPT-4o, GPT-4.1 mini | Yes, direct with `OPENAI_API_KEY`. |
| `gemini` | Gemini 3.8 / 3.7 Flash | Yes, direct with `GEMINI_API_KEY`. |

The active mode is displayed **before** processing and a real provider that fails throws rather
than substituting simulated prices. Neither key is configured on the deployment at the time of
inspection, so the app currently runs on the simulator unless one is set.

**No live model call has ever been made from this build environment** — the egress proxy refuses
CONNECT to `api.openai.com` and `generativelanguage.googleapis.com`. Every vision path is
verified against stubbed responses. No recognition accuracy has been measured, in either market.

## 3. Browser-only — and one of these matters

| What | Where it lives | Assessment |
|---|---|---|
| Selected user, manager filters, snapshot mode | `localStorage` | Correct. These are the viewer's own preferences, not observations. |
| Configuration thresholds edited on the Admin tabs | `localStorage` | **A gap.** Admin edits a threshold; nobody else sees it. Spec §SG-8.8 wants configurable rules, and they are configurable — per browser. Acceptable for the demo, not for a pilot. |
| Observations, visits, field actions, master data | D1, via `/api/mutations` | Correct and shared. The top bar says which of the two is live. |

## 4. Missing — the real gaps against v3

| Gap | Impact on v3 |
|---|---|
| **No authentication at all.** The role switcher is a demo control; every endpoint is open to anyone with the URL. | §T-4 and acceptance **A23** ("server denies unauthorized access; UI filtering alone is insufficient") **cannot be satisfied** by this codebase without an auth layer that does not exist. Market scoping added now is scoping, not authorization, and must be labelled as such. |
| **No image storage.** The `images` table holds a file name, source and quality status. `storage_url` is written as `null`. The photograph itself never leaves the browser. | §T-2 wants `private_object_key`; the whole Taiwan module depends on evidence crops being retrievable. **This blocks "every displayed issue links to its image region"** beyond the capture session. |
| **No async job dispatch.** `/api/recognise` runs the model inside the request. | Acceptable while a single image takes seconds. §T-1's queue/retry/callback design is not needed until a real Taiwan provider is integrated, and there is none yet. |
| **No market concept.** `territories.market`, `price_rules.market` and `competitor_mappings.market` carry the string `'SG'`; nothing else does, and nothing scopes by it. | §2 needs this first. Built in this change. |
| **No Taiwan module.** No fixtures, planograms, versions, assignments, exceptions, capture sets, realograms, rule results or execution issues. | Built in this change, as the P0.2–P0.6 vertical slice. |
| **No offline drafts.** A visit in progress lives in module state and is lost on reload. | §TW-4.1 wants local drafts with an honest sync state. Out of this slice; stated as a boundary. |

## 5. What this change does, and what it does not

Following §1 ("deliver incrementally", "do not create a second user/outlet/visit system") and
D-1's P0.1–P0.6, this change adds the market shell and the Taiwan vertical slice on the existing
foundation. Singapore keeps its routes, its data and its history.

It does **not** add: authentication, object storage, asynchronous recognition, offline drafts,
a real Taiwan recognition provider, or any measured accuracy. Each of those is named where it
is missing, on the screen as well as in this document, rather than approximated.
