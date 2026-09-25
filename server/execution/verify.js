/**
 * One button that tests the path a real run takes, and says which step failed.
 *
 * The old screen had three separate checks and none of them tested what mattered. "Test
 * credentials" listed models, so it passed while every audit failed; the image probe was a
 * different button on a different tab; and both answered through the job queue, up to a minute
 * later. A model id could be typed by hand and routed without the provider ever being asked
 * whether it exists — which is how `gemini-3.7-flash`, a model that does not exist, spent two
 * days as the configured default and returned 404 on every run.
 *
 * So the check is the run: resolve the credential, ask the provider for its model list, then
 * send the synthetic probe image to the model that will actually be used. A step that fails
 * stops the sequence and the remaining steps are reported as not reached — which is the
 * difference between "the key is wrong" and "the key is fine, the model is not there".
 *
 * Nothing here throws. The caller renders the steps, and a failure is data rather than an
 * exception, because the whole point is showing where it broke.
 */
import { getCredential } from './credentials.js';
import { listProviderModels, runProvider, validateConnection } from './adapters.js';
import { probeInput } from './jobs.js';
import { TASK_TW } from '../../public/app/execution/ai-contracts.js';

const step = (key, label) => ({ key, label, state: 'not_reached', detail: null, durationMs: null });

/** A provider error is already written for a reader; anything else must not leak a stack. */
function describe(error) {
  return error?.code ? error.message : 'The check could not be completed.';
}

/**
 * @param {object} env Worker bindings.
 * @param {object} connection A stored connection record's data.
 * @param {string|null} remoteModelId The exact provider model id to probe, when one is chosen.
 * @param {object} [options] `fetchImpl` for tests, `task` to probe a module other than Taiwan.
 * @returns {Promise<{ok: boolean, steps: object[], models: object[]}>}
 */
export async function verifyConnection(env, connection, remoteModelId, { fetchImpl = fetch, task = TASK_TW } = {}) {
  const steps = [
    step('credential', 'API key'),
    step('listing', 'Model list'),
    step('vision', 'Image recognition'),
  ];
  const at = (key) => steps.find((s) => s.key === key);
  let models = [], credential = null;

  try {
    validateConnection(connection, env);
    credential = await getCredential(env, connection);
    Object.assign(at('credential'), { state: 'passed', detail: connection.credentialSource === 'encrypted' ? 'Stored in this application, encrypted.' : 'Read from a Worker secret.' });
  } catch (error) {
    Object.assign(at('credential'), { state: 'failed', detail: describe(error) });
    return { ok: false, steps, models };
  }

  const listedAt = Date.now();
  try {
    const page = await listProviderModels(connection, credential, null, { fetchImpl });
    models = page.models ?? [];
    Object.assign(at('listing'), { state: 'passed', durationMs: Date.now() - listedAt, detail: `${models.length} model${models.length === 1 ? '' : 's'} offered by this key.` });
  } catch (error) {
    // A provider may withhold listing while still serving generation, so this is not fatal on
    // its own — but it does mean the model list cannot be trusted to contain the chosen id.
    Object.assign(at('listing'), { state: 'warned', durationMs: Date.now() - listedAt, detail: `${describe(error)} A model id can still be entered by hand.` });
  }

  if (!remoteModelId) {
    Object.assign(at('vision'), { state: 'not_reached', detail: 'Choose a model to test recognition.' });
    return { ok: at('credential').state === 'passed', steps, models };
  }

  const known = models.some((m) => m.remoteModelId === remoteModelId);
  if (models.length && !known) {
    // The exact failure that cost two days: a plausible id the provider has never heard of.
    Object.assign(at('vision'), { state: 'failed', detail: `This key does not offer ${remoteModelId}. Pick one of the ${models.length} models listed above.` });
    return { ok: false, steps, models };
  }

  const probedAt = Date.now();
  try {
    const model = { remoteModelId, structuredOutput: true, coordinateConvention: 'xywh_normalized', maxOutputTokens: 8192 };
    const response = await runProvider(connection, credential, model, probeInput(task), { timeoutMs: 45000, maxOutputTokens: 8192 }, { fetchImpl });
    const found = new Set((response.result?.products ?? response.result?.prices ?? []).map((x) => x.skuCandidateId));
    const both = found.has('PROBE-A') && found.has('PROBE-B');
    Object.assign(at('vision'), {
      state: both ? 'passed' : 'warned',
      durationMs: response.durationMs ?? Date.now() - probedAt,
      detail: both
        ? 'The model read a synthetic test image and returned both labelled rectangles.'
        : 'The model answered in the right format but missed part of the test image. It will run; accuracy on a real shelf is not measured by this check.',
    });
  } catch (error) {
    Object.assign(at('vision'), { state: 'failed', durationMs: Date.now() - probedAt, detail: describe(error) });
  }
  return { ok: steps.every((s) => s.state === 'passed' || s.state === 'warned'), steps, models };
}
