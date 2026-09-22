# Cloudflare runbook

Everything needed to deploy this application, point it at its database, give it a recognition
key and check that what is live is what you think is live.

Verified against the account on 22 September 2026. Where a fact could not be verified from
here, it says so and names where to look instead.

---

## 0. Read this first: the branch that is live is probably not the branch you are reading

| | Branch | Tip |
|---|---|---|
| **Default branch** — what Cloudflare builds on a Git-connected deploy | `claude/tic-tac-toe-cloudflare-vfhfd7` | `a3e2d4f` |
| **Working branch** — everything since the 14 September review | `claude/build-test-deploy-cqh66v` | `02f7b40`, **9 commits ahead** |

The default branch has an unhelpful name — it was created for a different exercise and the
price-check project landed on it. It is still the default, and a Git-connected Cloudflare
project builds **the default branch only**.

So unless someone has merged, none of this is on the live site: the current/historical snapshot
modes, the four coverage metrics, classified field outcomes, the GM Overview, the price
intervals, per-SKU competitor effects, the comparable-pair rule, Gemini, or the v3 market
schema. The live URL will look like the application did on 14 September, and every screenshot
in `docs/GM-DEMO.md` will disagree with it.

Two ways to fix that, depending on what you want:

```bash
# A. Ship it: open a PR from the working branch into the default branch and merge.
#    Cloudflare then builds it on the next push.

# B. Deploy the working branch directly, bypassing Git builds entirely:
git checkout claude/build-test-deploy-cqh66v
npm run deploy      # wrangler uploads this working tree to the `price-check` Worker
```

Option B overwrites the live Worker with whatever is checked out locally, including
uncommitted edits. That is convenient for a demo and a bad habit for anything else, because
the live code then corresponds to no commit anybody can find.

---

## 1. What already exists on the account

Verified by querying the account:

| Resource | Value |
|---|---|
| Worker | `price-check`, id `daf35467c5224ec1824e1115ce392ed1`, created 10 September 2026 |
| Live URL | https://price-check.anton-grebelny.workers.dev |
| D1 database | `retail-price-intelligence`, uuid `9fabe7e1-fb10-455b-adf8-15bcb16a8f5d` |
| Other Workers on the account | `tic-tac-toe`, `test` — unrelated to this project; do not deploy over them |

`wrangler.toml` already binds all of it. **The Worker name in `wrangler.toml` must stay
`price-check`** — change it and `wrangler deploy` creates a second Worker at a second URL
instead of updating the live one, and the old one keeps serving.

Bindings declared in `wrangler.toml`: `ASSETS` (static files), `AI` (Workers AI vision models),
`DB` (the D1 database above). Whether the deployed Worker actually has them attached cannot be
read from the API here — check **Workers & Pages → price-check → Settings → Bindings**, or
just call `/api/config`, which reports what is really bound (see §6).

> The D1 listing API reports `num_tables: 0` for this database. That field is wrong — the
> database holds 32 tables and over 1,300 observations. Do not treat it as evidence the
> database is empty.

---

## 2. Credentials

### Interactive, on a machine with a browser

```bash
npx wrangler login
```

### Headless — CI, a container, or an agent

```bash
export CLOUDFLARE_API_TOKEN=...     # created below
export CLOUDFLARE_ACCOUNT_ID=...    # Workers & Pages → right sidebar → Account ID
```

Create the token at **My Profile → API Tokens → Create Token**. The "Edit Cloudflare Workers"
template covers a deploy. For the D1 commands in §4 the token also needs **Account → D1 →
Edit**. Least privilege for this project:

| Scope | Permission | Needed for |
|---|---|---|
| Account → Workers Scripts | Edit | `wrangler deploy` |
| Account → Workers KV Storage | Edit | asset uploads |
| Account → D1 | Edit | `wrangler d1 execute`, seeding, migration |
| Account → Workers AI | Read | the `AI` binding's models |

The token is a credential for the whole account. Never commit it; never paste it into the
application, which has no authentication and would hand it to anyone with the URL.

---

## 3. Deploying

```bash
npx wrangler deploy --dry-run    # validates the bundle, needs no credentials at all
npm run deploy                   # publishes
```

The deploy is an asset upload plus a script upload. No server-side state is involved, so it is
safe to repeat and safe to roll back.

**After any deploy that adds a database column, call the migration once:**

```bash
curl -X POST https://price-check.anton-grebelny.workers.dev/api/migrate
```

`CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, including adding a
column declared after it was made — so without this, new columns are absent in production
while the code reads them back as `undefined`. Nothing fails; the feature simply never
appears. `/api/migrate` issues the additive `ALTER TABLE … ADD COLUMN` statements instead and
treats "duplicate column name" as success, so running it twice is a no-op and it never touches
data. The v3 market and Taiwan tables on the working branch need it.

### Rolling back

**Workers & Pages → price-check → Deployments** lists every version with its commit or upload
time; each has a *Rollback* action. Rolling back the Worker does **not** roll back the
database, and the migration above is additive, so an older Worker simply ignores the newer
columns. That is by design: a rollback should not delete data.

---

## 4. The database

```bash
# Generate and apply the demo dataset
node scripts/seed-db.mjs                                                    # writes dist/seed.sql
npx wrangler d1 execute retail-price-intelligence --remote --file=dist/seed.sql
npx wrangler d1 execute retail-price-intelligence --local  --file=dist/seed.sql   # local dev copy

# Ad-hoc query
npx wrangler d1 execute retail-price-intelligence --remote \
  --command "SELECT COUNT(*) AS observations FROM price_observations"
```

Seeding through the API instead: **Admin → Database → Load demo data into the database**. That
route refuses to run while the database holds data unless an `x-seed-token` header matches a
`SEED_TOKEN` secret, which is deliberately not configured — so a new deployment can bootstrap
itself and nobody can wipe live observations by calling a URL.

`shared/schema.js` declares every table and column once and drives the DDL, the reads and the
writes. Add a column there, deploy, run `/api/migrate`. Do not hand-edit the live schema: the
two sides will drift and only one of them is under review.

---

## 5. Secrets

Each recognition vendor has its own secret. Neither is configured on the deployment at the
time of writing, so the app runs on the simulator until one is set.

```bash
npx wrangler secret put GEMINI_API_KEY    # Gemini 3.8 / 3.7 Flash
npx wrangler secret put OPENAI_API_KEY    # GPT-4o, GPT-4.1 mini
```

Or: **Workers & Pages → price-check → Settings → Variables and Secrets → Add → type Secret →
Deploy**.

| Secret | Effect if absent | Where the key comes from |
|---|---|---|
| `GEMINI_API_KEY` | Gemini models report "GEMINI_API_KEY not configured" | [Google AI Studio](https://aistudio.google.com/apikey) — an AI Studio key, **not** a Google Cloud service-account credential, which the API rejects |
| `OPENAI_API_KEY` | OpenAI models report the same for their own key | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `SEED_TOKEN` | Re-seeding a populated database is refused — the intended state | You choose it |
| `AI_GATEWAY_ID` | Third-party models route through the gateway named `default` | Your AI Gateway id |

A secret is read only by the Worker. It is never written to the database, never returned by
any endpoint and never reaches a browser — **because this application has no authentication.**
Anyone with the URL can use it and therefore anyone with the URL can spend against those keys.
Set a spending limit on the OpenAI side and a budget on the Google Cloud project behind the
Gemini key.

---

## 6. Checking that a deploy actually worked

```bash
curl -s https://price-check.anton-grebelny.workers.dev/api/health   | jq
curl -s https://price-check.anton-grebelny.workers.dev/api/config   | jq
```

`/api/health` returns database reachability and row counts. `/api/config` reports what is
really bound and which secrets are present — presence only, never a value:

```json
{
  "ai_binding": true,
  "db_binding": true,
  "openai_key_configured": false,
  "gemini_key_configured": false,
  "secrets": { "OPENAI_API_KEY": false, "GEMINI_API_KEY": false }
}
```

The same facts are on screen under **Admin → Recognition provider → Deployment configuration**,
with a *Refresh* button.

To check which *code* is live rather than which bindings: the GM Overview route
(`#/manager/overview`) exists only on the working branch. If the manager lands on the Price
Control Tower instead, the default branch is what is deployed.

Run the browser suite against the deployment rather than the bundled server:

```bash
SMOKE_BASE=https://price-check.anton-grebelny.workers.dev npm run smoke
```

---

## 7. Local development

```bash
npm run dev         # real Workers runtime; the AI binding opens a remote proxy session,
                    # so this needs Cloudflare credentials
npm run dev:local   # wrangler.local.toml — no AI binding, works offline
npm run serve       # plain static server on :8787, no Worker, no API; the client falls
                    # back to bundled seed data
```

The top bar says which data source is live — shared database or per-browser bundled data —
because an app quietly running on local data looks identical to one reading shared
observations, and a field user could otherwise submit a visit that never leaves their phone.

---

## 8. When something is wrong

| Symptom | Cause | Fix |
|---|---|---|
| Live site looks like the old version | Cloudflare built the default branch; your work is on the feature branch | §0 |
| A new feature is invisible, no error anywhere | New column missing in production | `POST /api/migrate` |
| Deploy succeeded, second URL appeared | `name` in `wrangler.toml` was changed | Restore `price-check`, delete the stray Worker |
| `/api/data` returns 503 | `DB` binding not attached to the deployed Worker | Settings → Bindings |
| `/api/recognise` returns 503 | `AI` binding not attached, and the chosen model is a Workers AI one | Attach `AI`, or pick a Gemini/OpenAI model, which do not use it |
| "API key not configured" on one vendor only | That vendor's secret is missing | §5 — each vendor checks its own |
| Git build failed | Build log in Deployments | A failed build leaves the previous deployment serving, so the site keeps working and looks stale |
| Recognition returns simulated prices | The active provider is `mock-simulator`, the default | Admin → Recognition provider. The field screen states the mode before processing |

If a Git build fails, the previous deployment keeps serving. That is safe but quiet: the site
does not break, it just stops changing. Check **Deployments** for which commit was actually
built before concluding a change did not work.
