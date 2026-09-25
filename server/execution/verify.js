/**
 * One button that tests the path a real run takes, for every module that will take it.
 *
 * The old screen had three separate checks and none of them tested what mattered. "Test
 * credentials" listed models, so it passed while every audit failed; the image probe was a
 * different button on a different tab; and both answered through the job queue, up to a minute
 * later. A model id could be typed by hand and routed without the provider ever being asked
 * whether it exists — which is how a model that does not exist spent two days as the default.
 *
 * Replacing that with a probe was not enough on its own. A check is only worth trusting if
 * passing it means the real thing passes, and the first version diverged from `executeRun` in
 * four ways that can each flip the outcome: it built a synthetic model object instead of the
 * stored record, so `structuredOutput`, the coordinate convention and the output limit were
 * whatever this file hardcoded; it used its own timeout and token budget instead of the route's;
 * it skipped the enabled/market/credential checks `selectModel` applies; and it only ever
 * probed Taiwan, leaving Price Validation untested.
 *
 * So it now resolves each module through `selectModel` — the same function, with the same
 * purpose, that the scheduled worker calls — and sends the probe with that module's route
 * settings. What remains different is the input alone: a small synthetic image instead of a
 * shelf photograph. That difference is real and is stated on screen rather than papered over;
 * everything else about the call is the run.
 */
import { getCredential } from './credentials.js';
import { listProviderModels, runProvider, validateConnection } from './adapters.js';
import { probeInput, selectModel } from './jobs.js';
import { listRecords, writeRecord } from './storage.js';
import { TASK_TW, TASK_SG } from '../../public/app/execution/ai-contracts.js';

const MODULES = [
  { task: TASK_TW, market: 'TW', label: 'Planogram Check' },
  { task: TASK_SG, market: 'SG', label: 'Price Validation' },
];
const step = (key, label) => ({ key, label, state: 'not_reached', detail: null, durationMs: null });

/** A provider or domain error is already written for a reader; anything else must not leak. */
const describe = (error) => (error?.code ? error.message : 'The check could not be completed.');

/**
 * @param {object} env Worker bindings.
 * @param {object} actor The signed-in administrator, needed for the same authorization a run does.
 * @param {object} connection A stored connection record's data.
 * @param {string|null} remoteModelId The provider model id to test where no route names one yet.
 * @param {object} [options] `fetchImpl` for tests.
 * @returns {Promise<{ok: boolean, steps: object[], models: object[]}>}
 */
export async function verifyConnection(env, actor, connection, remoteModelId, { fetchImpl = fetch } = {}) {
  const steps = [step('credential', 'API key'), step('listing', 'Model list')];
  for (const m of MODULES) steps.push(step(`vision:${m.task}`, `Recognition · ${m.label}`));
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
    // A provider may withhold listing while still serving generation, so this is not fatal —
    // but the list can no longer be used to rule a model in or out.
    Object.assign(at('listing'), { state: 'warned', durationMs: Date.now() - listedAt, detail: `${describe(error)} A model id can still be entered by hand.` });
  }

  // Adopt what the key offers, so the first check has something to probe and every later one
  // resolves the same stored record a run would. This is where the removed "refresh models"
  // button went: validating a provider is when its catalogue becomes known.
  let stored = env.DB ? await listRecords(env.DB, 'model').catch(() => []) : [];
  if (env.DB && models.length) {
    for (const m of models) {
      if (stored.some((x) => x.connectionId === connection.id && x.remoteModelId === m.remoteModelId)) continue;
      const id = crypto.randomUUID();
      await writeRecord(env.DB, 'model', id, {
        ...m, id, connectionId: connection.id, enabled: true, structuredOutput: true,
        coordinateConvention: 'xywh_normalized', capabilities: {},
        maxOutputTokens: Math.min(m.providerMetadata?.outputTokenLimit ?? 8192, 32768),
        createdAt: new Date().toISOString(),
      }, 0, connection.allowedMarkets.join(',')).catch(() => {});
    }
    stored = await listRecords(env.DB, 'model').catch(() => stored);
  }
  for (const module of MODULES) {
    const slot = at(`vision:${module.task}`);
    // Exactly what the scheduled worker resolves, including the enabled, market and credential
    // checks. Falling back to a capability selection covers the first run, before a route exists.
    let selection = null, routed = true;
    try {
      selection = await selectModel(env, actor, module.market, module.task);
    } catch (error) {
      routed = false;
      const candidate = stored.find((m) => m.connectionId === connection.id && m.remoteModelId === remoteModelId);
      if (!candidate) { Object.assign(slot, { state: 'not_reached', detail: `${describe(error)} Choose a model for this module, then check again.` }); continue; }
      try { selection = await selectModel(env, actor, module.market, module.task, candidate.id, 'capability'); }
      catch (inner) { Object.assign(slot, { state: 'failed', detail: describe(inner) }); continue; }
    }

    if (models.length && !models.some((m) => m.remoteModelId === selection.model.remoteModelId)) {
      // The failure that cost two days: a plausible id the provider has never heard of.
      Object.assign(slot, { state: 'failed', detail: `This key does not offer ${selection.model.remoteModelId}. Pick one of the ${models.length} models listed above.` });
      continue;
    }

    const probedAt = Date.now();
    try {
      const response = await runProvider(selection.connection, credential, selection.model, probeInput(module.task), { timeoutMs: selection.route.timeoutMs, maxOutputTokens: selection.route.maxOutputTokens }, { fetchImpl });
      const found = new Set((response.result?.products ?? response.result?.prices ?? []).map((x) => x.skuCandidateId));
      const both = found.has('PROBE-A') && found.has('PROBE-B');
      Object.assign(slot, {
        state: both ? 'passed' : 'warned',
        durationMs: response.durationMs ?? Date.now() - probedAt,
        detail: `${esc(selection.model.displayName ?? selection.model.remoteModelId)}${routed ? '' : ' (not saved for this module yet)'} · ${both
          ? 'read a synthetic test image and returned both labelled rectangles.'
          : 'answered in the right format but missed part of the test image. It will run; accuracy on a real shelf is not measured here.'}`,
      });
    } catch (error) {
      Object.assign(slot, { state: 'failed', durationMs: Date.now() - probedAt, detail: describe(error) });
    }
  }
  const reached = steps.filter((s) => s.state !== 'not_reached');
  return { ok: reached.length > 0 && reached.every((s) => s.state === 'passed' || s.state === 'warned'), steps, models };
}

/** The model name is provider-supplied text arriving in a message; keep it from carrying markup. */
const esc = (value) => String(value ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
