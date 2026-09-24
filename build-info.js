/**
 * The release stamp, baked into the code rather than passed as a Worker variable.
 *
 * This used to be `--var "DEPLOY_COMMIT:<sha>"` on the deploy command, which made every
 * deployment send a binding mutation to a Worker whose other bindings include the provider API
 * keys. On 24 September 2026 a Gemini credential that had served a request at 08:26 was gone by
 * 08:44, with two such deploys and nothing else in between; the job log in `rei_jobs` records
 * both sides of it. Cloudflare documents that deployments never delete secrets, so the exact
 * mechanism is unexplained — but a deploy that carries no binding change at all cannot be the
 * cause of the next one, and the release stamp never needed to be a binding.
 *
 * CI overwrites this file with the real commit immediately before `wrangler deploy`. It is not
 * committed back, so the checked-in value is always the development placeholder.
 */
export const BUILD_SHA = 'development';
