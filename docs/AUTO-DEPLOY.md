# Automatic production deployment

Target: Worker `price-check`, https://price-check.anton-grebelny.workers.dev/.
Workflow: `.github/workflows/deploy.yml`, **Deploy price-check**.

## One-time connection

1. Create a Cloudflare API token using the **Edit Cloudflare Workers** template, scoped to the account containing `price-check`. Where resource-specific Workers roles are available, prefer Workers Editor scoped to this Worker. Do not use the Global API Key or grant unrelated account administration permissions. Follow the current Cloudflare token UI for the chosen authorization model.
2. Open https://github.com/agv747/test/settings/secrets/actions and create two repository secrets:
   - `CLOUDFLARE_API_TOKEN`: the token value, entered directly in GitHub.
   - `CLOUDFLARE_ACCOUNT_ID`: the account ID shown in Cloudflare for this Worker (not the D1 database ID).
3. Open https://github.com/agv747/test/actions/workflows/deploy.yml and run **Deploy price-check** on `claude/tic-tac-toe-cloudflare-vfhfd7`, or re-run the first failed attempt after adding the secrets.
4. Confirm the Deploy and Verify steps both pass. A successful build alone is insufficient.
5. After the first successful GitHub Actions deployment, disable the old automatic Workers Builds deployment for the same Worker if configured. Use one production publisher to avoid races. This workflow does not change that dashboard setting for you.

The API token cannot be created or installed by the repository editing connector available in this session. Enter it directly in the services; do not send it in chat or commit it. Until these secrets are present and the first workflow succeeds, automatic deployment is prepared but not activated/verified.

## Normal use

Each push/merge into the named production branch tests the project, publishes the Worker and its static assets to production, then checks `/api/execution/session` for the exact deployed commit. Other branches and PRs do not deploy. Manual runs from other branches are blocked. Queued workflows check out the current production branch rather than intentionally rolling back to an old queued commit. Deployments are serialized and an active deployment is not canceled by another push.

Wrangler is pinned to 4.136.1. GitHub checkout and Node setup actions are pinned to reviewed tag SHAs. Node 24 runs the existing SQLite-based tests. GitHub permissions are read-only; the Cloudflare token is exposed only in credential-check/deploy steps.

Deployment uses the existing wrangler.toml (Worker name, DB, AI binding and one-minute cron) and `--keep-vars`; it does not run seed, migrations or secret rotation. Existing Worker secrets stay in Cloudflare. `DEPLOY_COMMIT` is a non-secret release marker supplied by the workflow and exposed as `buildSha` in the public session response. Deploying outside this workflow can leave that marker stale unless the other publisher also sets it, another reason to use one deployment mechanism.

Verification checks availability, the release marker, authentication configuration and D1 binding presence. It does not read private records, prove data integrity, or issue paid Gemini calls. If Cloudflare blocks the runner or the version does not propagate within the retry window, verification fails explicitly; the workflow does not claim a verified release and does not automatically roll back an already published deployment.

## Troubleshooting

- Missing secrets: add the two names above and re-run the workflow.
- Permission denied: inspect the deploy log and adjust only the missing permission on the correct Worker/account. Never print token values.
- Tests fail: fix the code before deploying; do not bypass the Test step.
- API HTTP 403/1010: investigate the Cloudflare access policy for the public endpoint; do not disable protection broadly just to make the check pass.
- Gemini error: deployment success and provider connectivity are separate; inspect the authorized app run.
- Rollback: explicitly select a previously confirmed Worker version in Cloudflare. Coordinate schema compatibility and subsequent automatic releases; data is not rolled back by this workflow.

References:
- https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
- https://developers.cloudflare.com/workers/authorization/workers/
- https://developers.cloudflare.com/workers/versions-and-deployments/
