# GM demo — what changed, what it cannot do, and how to run it

This is the response to the 14 September review. It covers what was changed and why, what the
application still cannot tell you, how the changes were verified given that no live model call
is possible from the build environment, and the sequence to run on the day.

Every figure below comes from the synthetic demonstration dataset. None of it is a market
benchmark, and the prices are illustrative arithmetic chosen so the sums can be checked on
screen.

---

## 1. What changed

### The demo fixture (§A)

The Punggol sample used to go through the ordinary generative simulator, which produced a
plausible mix rather than a coherent one: it returned Winston Red but not Pall Mall Red, Winston
Red's own primary mapping, so the screen built to compare them had nothing to compare and the
price gap and Price Index were blank. The three built-in samples now return agreed fixtures
(`public/app/demoImages.js`). Punggol contains a correct reading, a price-position exception, a
same-visit comparable pair and an uncertain reading with a named alternative:

| SKU | Price | Shelf | Facings | Ticket | Confidence |
|---|---|---|---|---|---|
| Winston Red | SGD 14.20 | 1 | 3 | red | 0.97 |
| Pall Mall Red | SGD 13.50 | 1 | 2 | blue | 0.95 |
| Winston Blue | SGD 13.60 | 2 | 2 | dark blue | 0.94 |
| Mevius Original | SGD 14.50 | 2 | 1 | green | 0.58, alternative Mevius Sky Blue 0.34 |

Winston Red against Pall Mall Red: gap SGD 0.70, index 105.185… shown as 105.2, against a
configured corridor of 0.00–0.35 and 100–103. Both are per pack of 20 in the same outlet and the
same visit.

**Which provider runs in which path** — the question the review asked directly. There is one
provider registry (`services/recognition/provider.js`) and the active provider is chosen in
Admin → Recognition. It is the same provider for a built-in sample and an uploaded photo; what
differs is what the simulator does with the file:

| Path | Active provider | What it reads |
|---|---|---|
| Built-in sample, simulator active | `mock-simulator` | Nothing. Returns the agreed fixture for that file name. |
| Own photo, simulator active | `mock-simulator` | Nothing. Generates detections from the catalogue, seeded by the image identity. |
| Either, a vision model active | `gemini:gemini-3.8-flash`, `openai:gpt-4o` or another configured model | The image, through the Worker. Fails loudly on error. |

Two vendors are wired up for real recognition, each on its own key: Google Gemini
(`GEMINI_API_KEY`) and OpenAI (`OPENAI_API_KEY`), plus the Cloudflare-hosted models on the
`AI` binding. Gemini 3.8 Flash is the strongest of them on a crowded shelf photograph. Having
two matters for the demo: one account being rate-limited or unfunded on the day is then a
switch in Admin, not a dead slide.

The mode is now stated **before** Process is pressed, on the acquisition step, and repeated on
the processing and results screens. A real provider that fails throws; it never falls back to
the simulator.

### Snapshot semantics (§B)

Manager screens were reading every observation ever recorded. An outlet visited ten times
counted ten times against one visited once, June prices sat in a view labelled as the current
picture, and a low-confidence reading nobody had confirmed carried the same weight as a verified
one.

There are now two explicit modes, named on the screen with an as-of time and a freshness window.
The current picture keeps one eligible observation per outlet, SKU and pack configuration.
Everything held out is counted and itemised — awaiting confirmation, dated after the as-of time,
older than the window, superseded — because those are four different problems with four
different owners. A verified price with a newer unconfirmed reading behind it is flagged rather
than resolved.

### Coverage denominators (§C)

Filtered to East, "Market Coverage" reported 25% for a territory whose every outlet had been
visited: six was East's, twenty-four was the country's. That figure is gone. Four questions
replace it, each computed inside the selected scope and each printing its numerator and
denominator: outlet visit coverage, fresh SKU coverage, comparable-pair availability,
competitive alignment. East now reads 6 of 6.

### Field outcomes (§D)

The page led with 80% beside the word "effectiveness". It meant four price changes in five
engagements that had a subsequent observation, and one of the four was a price that moved
further from where it was meant to be.

Outcomes are now classified against the configured intended interval. For a value *x* and an
interval [L, U], distance = max(L − x, 0, x − U); improvement means that distance fell, not that
the absolute gap got smaller — a gap narrowing toward zero can be a price leaving the corridor it
was meant to sit in. Engagements with nothing observed since are counted and listed, not dropped
from the denominator. Where the gap and index tests disagree, the less favourable result is
reported and both components are shown. "Any observed price change" survives underneath, labelled
as a description of the shelf rather than a rate of success.

The engagement-to-price-change rate and the median gap improvement were deleted rather than
relabelled.

### Comparable pairs (§B.6)

Where an outlet had no competitor reading, the code substituted a median of other outlets in the
territory and fed it into the verdict. That outlet then produced an index, a position and a
contribution to alignment, all of them describing shops elsewhere. Only two readings of the same
shelf, close enough in time, now carry a verdict; a territory median is shown as context and
named as one. A competitor price dated after the JTI price is rejected outright.

Comparable-pair availability consequently fell from 77% to 51%, and the matrix reports 62
observations without a comparable competitor instead of 1. Those are the true figures. A visibly
missing comparison is what sends somebody to go and read one; a plausible number is not.

### GM Overview (§E)

A new route, and the manager's landing page. A scope line, four metrics with denominators, three
signals. The Control Tower keeps every filter and metric one click away. At 1366×768 the message,
the metrics and the top priority sit above the fold — measured in the browser, not asserted.

A signal is a group: one issue, one SKU, one selected scope. The old card was two things at
once — "Winston Red — Tampines Hub Convenience" subtitled "East · 19 outlets affected", with the
identical subtitle on a different outlet's card. A group below the materiality bar is left out
and its absence explained, rather than padded in to fill three slots.

### Price intervals (§F)

Each SKU was a filled bar as long as its median price, on an axis with no numbers. A filled bar
is read from zero, so prices clustered between SGD 12.60 and 16.00 looked several times apart;
and a median hid the dispersion the page exists to show. Each row is now P10–P90, P25–P75 and a
median marker on one labelled SGD axis, built from one price per outlet. Below eight outlets the
row draws its actual prices as points. Where several outlet-specific rules apply, the corridor is
withheld and the count shown.

"Premium position under pressure" was inferred from Marlboro being a premium brand while JTI's
Singapore portfolio tops out at Core — which is the architecture working. The observation stays;
the conclusion is gone.

### Competitor events (§G)

One Price Index — 101.6 — was reported as the position of Winston Red, Camel Filters and LD Red
together. They sit at three price levels with three corridors, so it was nobody's position.
Effects are now a row per mapping against its own corridor, and the trend chart is one line per
SKU. The movement itself is measured across outlets observed in both periods, with the paired
count shown: comparing all-of-before against all-of-after made a change in the visit schedule
read as a change in price.

The matrix columns said "Competitor cheaper" while classifying against the configured corridor.
Camel Blue at 13.20 against Chesterfield at 13.30 was filed there although Camel is cheaper — it
is a value SKU mapped to sit SGD 0.70–0.30 below, so ten cents below is above where it belongs.
The axis now reads "above / within / below intended relative position".

### Master data and evidence (§H)

`sticks_per_pack` and `pack_type` are recorded on the SKU and snapshotted onto each observation
beside the rule and mapping. Every price is labelled with the pack it buys, and rows for
different configurations are never compared. Observed time (the shelf) and recorded time (the
upload) are separate fields, shown separately. `reviewed_by` and `reviewed_at` record who
confirmed a reading and when.

A TME who checks a low-confidence reading and finds it right now has "Confirm as read", which
sets the review metadata without changing a value or raising the correction flag. Before this,
the only way to clear a pending reading was to retype the same number, which filed a verification
as a correction and poisoned the record corrections exist to build.

Submitting is idempotent: a double tap files one visit. The guard deliberately lives outside the
wizard state, because a successful save ends by resetting that state.

### Schema migration

`CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so every column added
to the descriptor after the first deploy was absent in the deployed database while the code read
it back as `undefined` — no error, just a feature that never appeared. `POST /api/migrate` issues
the additive `ALTER TABLE … ADD COLUMN` statements, treating "duplicate column name" as success,
so re-running it is a no-op. **Run it once after deploying.**

---

## 2. Known limitations

These are things the application cannot currently tell you. Several are properties of the
problem, not of the build.

- **Recognition accuracy is unmeasured.** The percentage shown is the model reporting on itself,
  and in the simulator it is a value the fixture was written with. A model can be confidently
  wrong, and under plain packaging — where two variants differ only by their price ticket — it
  routinely is. Establishing accuracy needs a labelled set of 100–200 local images scored against
  what the pack actually was, with confidently-wrong readings counted separately.
- **No live model call was possible from the build environment.** Outbound HTTPS to
  `api.openai.com` and `generativelanguage.googleapis.com` is refused by the egress proxy
  (`CONNECT tunnel failed, response 403`), as is the deployed Worker host. Both vision paths were
  verified by stubbing the Worker's `fetch` in unit tests and `/api/recognise` in the browser
  suite — the request shape, the response shape and every failure branch are covered, but nothing
  here proves the model ids still resolve on Google's side. **Run one real photo through the
  deployed app before the meeting, on whichever model you intend to show.**
- **Causation is not established and cannot be.** Field Effectiveness reports observed sequences.
  No revenue uplift, recovered margin or ROI can be derived from these observations alone.
- **Expected assortment is a working definition** — outlet–SKU combinations observed at least
  once in the full history. It is not an approved assortment, and the screens say so.
- **The recommended ranges and desired corridors are synthetic,** configured for the demo.
- **There is no authentication.** Anyone with the URL can use the app. The OpenAI key is held
  only as a Worker secret, never in the database and never accepted through a form, precisely
  because a key held either way would be a key anyone with the URL could take. Server-side
  authorisation must be established separately before real data.
- **Camera and gallery on real devices are untested here.** The acquisition path, preview,
  rotation and HEIC handling need a run on an actual iPhone and Android.
- **A single competitor event cannot distinguish a tax change from a competitor's decision.**
  Cigarette excise moves the whole market; the app reports what was observed and does not infer
  a cause.

---

## 3. Validation

```bash
npm test        # 370 unit tests
npm run smoke   # 160 browser checks against a real page, Playwright/Chromium
SHOTS=1 npm run smoke   # the same, writing screenshots to .smoke-screenshots/
npx esbuild worker.js --bundle --format=esm --outfile=/dev/null   # Worker bundle
```

The review's acceptance table, and where each row is covered:

| Scenario | Covered by |
|---|---|
| East has six eligible outlets and all six were visited | `tests/coverage.test.js`; browser check "a territory's coverage counts that territory's outlets" |
| Ten historical visits at one outlet, one at another | `tests/snapshot.test.js`; browser check "the current picture is narrower than the record" |
| Competitor stale or observed in the future | `tests/pairing.test.js` |
| Low-confidence result correct without edits | `tests/packAndMigration.test.js`; browser check "a reading can be confirmed without being changed" |
| Built-in Punggol sample | `tests/demoFixture.test.js`; browser checks for the mapped competitor and the fixture prices |
| Real recognition unavailable | `tests/modelFailure.test.js`; the provider throws rather than falling back |
| Price moves away from the intended interval | `tests/fieldOutcome.test.js` |
| Competitor moves while JTI price is unchanged | `tests/fieldOutcome.test.js` (`movementSource`) |
| Several JTI SKUs mapped to Pall Mall | `tests/intervalsAndMoves.test.js` |
| Same visit submitted twice | `tests/submitOnce.test.js` |
| No current comparable observations | `tests/pairing.test.js` — unknown, never 0% or 100% |
| Recommendation changes after a historical observation | `tests/priceRules.test.js` — the snapshot on the observation governs |
| iPhone/Android camera and gallery | **Not covered.** Needs a device run. |

---

## 4. Demo sequence, 6–7 minutes

Run it once on the laptop and once on the phone beforehand. Do not open Admin during the meeting.

| Time | Screen | Point |
|---|---|---|
| 0:00–0:40 | **GM Overview** | Four questions answered above the fold: what changed, where it matters, who has it, how fresh the evidence is. Note the scope line — market, as-of, window, and the demo marking. |
| 0:40–1:30 | **Top signal** | Name the SKU, the mapped competitor, the outlet count and the evidence age. Open the outlet list: the count in the heading is the rows underneath it. Do not start with how many photos were taken. |
| 1:30–3:15 | **Field check** | Punggol → load the Punggol sample. **Stop on the acquisition step and read the recognition-mode card aloud** — this is simulated, and it says so before anything is processed. Process. Shelf schematic first. Tap Mevius: low confidence, a named alternative, and "Confirm as read" for the case where the model was right. Show Winston Red 14.20 against Pall Mall Red 13.50 — gap 0.70, index 105.2, corridor 100–103. |
| 3:15–4:00 | **Submit, then the outlet** | Record a field action and submit. Switch to the manager persona and open the outlet: the visit and its image are there. Note that the Control Tower total is unchanged — the new reading supersedes the old one for that outlet rather than adding weight to it. |
| 4:00–5:00 | **Price Architecture** | One median hides the spread. Show the P10–P90 intervals on the shared axis, the JTI corridor drawn separately, and Marlboro Red and Gold as points because they have too few outlets for a percentile. |
| 5:00–6:00 | **Competitor Moves** | Pall Mall Red fell SGD 0.40, measured across the outlets seen in both periods. Then the per-SKU table: Winston Red, Camel Filters and LD Red are each above their own corridor, and those corridors differ. This is the slide where the single blended 101.6 used to be. |
| 6:00–7:00 | **Field Effectiveness, then the ask** | 40% improved, 20% unchanged, 40% worsened — and 80% "any observed price change", labelled as a description of the shelf. Then ask for the pilot: scope, process owner, reference images, success criteria. |

Fallbacks: have a short screen recording ready, and know that "Full analysis →" on the GM
Overview goes to the Control Tower if anyone asks for the detail.
