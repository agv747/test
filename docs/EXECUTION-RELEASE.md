# Taiwan execution pilot and AI connections

This release preserves the Singapore application and adds an independent Taiwan workspace. Start at `/#/tw/overview`; AI administration is at `/#/admin/ai`.

## Demo for the general manager (6 minutes)

1. Select Taiwan. The public workspace is explicitly synthetic; changes are stored in this browser. Initial completion is 2/4 eligible fixtures and verification is 1/2 submitted audits. One fixture has no reference and is excluded.
2. Open fixture F2. Compare Expected, Photo and Differences. Unknown slots remain unknown; they are never counted as matches. The sample includes misplaced products and occluded positions.
3. Open Issues, assign a task and record an action. An action alone does not close the issue.
4. Open the prepared follow-up capture for F2, review the visible slots, confirm and submit. Verify the two resolved issues against this later audit. Reload to show persistence.
5. Open the planogram library. Published revisions cannot be edited. Duplicate a revision into a draft and publish only when ready. Fixture assignments have non-overlapping dates.
6. Open AI Models & Connections. Gemini, OpenAI, Anthropic and compatible endpoints are available. Without configured credentials the UI says Not configured. Never describe the synthetic demo as live recognition.

## Cloudflare setup for private use

The Worker remains `price-check`, using its existing DB binding. Deployment adds tables/columns without dropping existing data. Private workspace, image and job tables are created on demand. A one-minute Cron Trigger recovers queued jobs.

Set secrets in Cloudflare Worker Settings → Variables and Secrets, or `wrangler secret put NAME`:

- `ADMIN_ACCESS_TOKEN`: URL-safe token of 3–512 characters. Three-character tokens are accepted for convenience but easily guessed; a random token of at least 32 characters remains recommended. Generate locally with `openssl rand -hex 32`. Paste it into the app's private-workspace sign-in, not a URL.
- `AI_CREDENTIALS_ENCRYPTION_KEY`: base64-encoded 32 random bytes (`openssl rand -base64 32`). Needed to save encrypted provider credentials. Keep the same key across deployments; changing it without migration makes stored credentials unreadable.
- Alternatively, provider keys can come from `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `COMPATIBLE_API_KEY`.
- Optional `APP_ACCESS_USERS_JSON`: an array of `{ "token": "<random token>", "id": "user-id", "name": "Name", "role": "admin|manager|field|viewer", "markets": ["SG", "TW"] }`. Every token must satisfy the same length/character rules.
- Optional `AI_COMPATIBLE_BASE_URLS`: the deployment-controlled exact allowlist of HTTPS compatible API bases. Provide a comma-separated list without trailing slashes. Use only endpoints controlled and trusted by your organization.

Sign in, add a connection, test credentials, discover or manually enter model IDs, run each task capability probe, then select a default for SG price recognition and/or TW planogram recognition. Credentials are server-side; stored keys use AES-GCM. Model availability is discovered from the provider rather than assumed. A selected SG route is also available in the existing capture workflow.

The database starts with an empty private Taiwan workspace. Import catalogue/fixtures and plans using the supplied templates in `public/demo/tw/`; those files are synthetic examples. User photos in private mode are stored separately from public assets and require an authenticated scoped image request.

## Verified in this release

- Domain tests: immutable plans, assignment dates, unknown versus empty, conservative counts, exact slot metrics, optimistic concurrency, duplicate submission, issue lifecycle and overview denominators.
- AI adapter tests: Gemini/OpenAI/Anthropic/compatible request contracts, output schemas, coordinate formats, encryption, capability gating, bounded retries, exclusive job claims and unknown cost handling. Provider calls in tests are fixtures, not paid live calls.
- API tests use real local SQLite for authentication, private media, role scope, route validation and idempotency.
- Browser checks cover the Taiwan follow-up workflow, issue closure, draft plans, persistence, mobile layouts and Singapore navigation. The existing Singapore smoke suite remains available.

Run `npm test`, `npm run smoke` and `npm run smoke:execution`. Browser scripts accept `CHROMIUM_PATH` and JSON `CHROMIUM_ARGS` when using a managed Chromium installation.

## Boundaries and next production work

This is a pilot implementation, not a claim that every item of a future enterprise specification is complete. The public Singapore sample continues to use the application's existing demo data architecture; do not load confidential operational Singapore data before extending authorization to every legacy data endpoint. Live recognition and model-license actions require authentication.

Taiwan private operational state uses a revision-controlled D1 JSON record capped at 1.5 MB; media and jobs are separate. For large-scale rollout, normalize operational entities, paginate reads and migrate media to private R2. The present shelf mapping assumes a regular grid and user-reviewed image ranges; it is not a calibrated tobacco pack detector. Validate on authorized local photographs, including visually similar variants, Traditional Chinese labels, reflections, occlusion and cabinet layouts before making accuracy claims. The synthetic fixture test cannot establish commercial SKU accuracy or legal conformity.

Compatible endpoints are deployment-allowlisted and reject literal private IPs and redirects. Network-level egress controls are recommended before accepting arbitrary customer-managed endpoints. Billing may be unknown after provider interruptions; the UI must not imply zero cost.

Singapore retains the existing price-rule semantics, including the legacy “Either measure” OR mode. Changing this to an AND policy requires a separate agreed rules migration. Existing Cloudflare operational history is retained in `CLOUDFLARE.md`; the authentication and lazy migration changes above supersede the corresponding older statements.
