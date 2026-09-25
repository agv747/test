/**
 * Cloudflare Worker entry point.
 *
 * Serves the static application from `public/`, and exposes a small API over the D1
 * database so that observations are shared across devices: a visit a TME submits on a phone
 * is visible to a manager on a laptop, which localStorage alone could never do.
 *
 * Routes:
 *   GET  /api/data       full dataset snapshot, in the shape the client store expects
 *   POST /api/mutations  apply a batch of writes
 *   POST /api/seed       create the tables and load the demo dataset (only while empty)
 *   POST /api/recognise  run a vision model over a captured image
 *   GET  /api/health     database reachability and row counts
 *
 * The client falls back to its bundled seed data when the API is unavailable, so the app
 * still runs from a plain static host or as the single-file standalone build.
 */

import {
  TABLE_NAMES,
  TABLES,
  columnNames,
  ddlStatements,
  fromRow,
  isDuplicateColumnError,
  migrationStatements,
  toRow,
  upsertSql,
} from './shared/schema.js';
import { buildSeedData } from './public/app/seed.js';
import { buildModelInput, buildPrompt, parseModelResponse } from './shared/recognition.js';
import { RECOGNITION_MODELS } from './public/app/config.js';
import { handleExecution } from './server/execution/api.js';
import { getActor, sameOrigin } from './server/execution/auth.js';
import { processDueJobs } from './server/execution/jobs.js';
import { hasEnvironmentCredential } from './server/execution/credentials.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/execution/')) return handleExecution(request, env);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(processDueJobs(env));
  },
};

async function handleApi(request, env, url) {
  // These need the AI binding, not the database.
  if (url.pathname === '/api/recognise' && request.method === 'POST') {
    const actor = await getActor(request, env);
    if (!actor || !actor.markets.includes('SG') || actor.role === 'viewer') return json({ error: 'Sign in to use live recognition.' }, 401);
    sameOrigin(request);
    return recognise(env, request);
  }
  if (url.pathname === '/api/model-licence' && request.method === 'POST') {
    const actor = await getActor(request, env);
    if (actor?.role !== 'admin') return json({ error: 'Administrator access required.' }, 403);
    sameOrigin(request);
    return acceptModelLicence(env, request);
  }
  if (url.pathname === '/api/config' && request.method === 'GET') {
    return json(describeBindings(env));
  }
  if (!env.DB) return json({ error: 'No database binding configured' }, 503);
  if (['/api/data', '/api/health', '/api/mutations', '/api/seed'].includes(url.pathname)) await ensureSchema(env);

  if (url.pathname === '/api/health') {
    return json(await health(env));
  }
  if (url.pathname === '/api/data' && request.method === 'GET') {
    return json(await readAll(env));
  }
  if (url.pathname === '/api/mutations' && request.method === 'POST') {
    const body = await request.json();
    return json(await applyMutations(env, body.mutations ?? []));
  }
  if (url.pathname === '/api/migrate' && request.method === 'POST') {
    return json(await migrate(env));
  }
  if (url.pathname === '/api/seed' && request.method === 'POST') {
    return seed(env, request);
  }
  return json({ error: 'Not found' }, 404);
}

/* --------------------------------------------------------------- migration */

/**
 * Brings a deployed database up to the current column declaration, without touching data.
 *
 * Seeding creates tables with `IF NOT EXISTS`, which does nothing at all to a table that
 * already exists — so every column added to the descriptor after the first deploy was missing
 * in production while the code read it back as `undefined`. Nothing failed; the feature was
 * simply absent. This runs the additive `ALTER`s instead, one at a time, treating "duplicate
 * column name" as success: it is what an already-migrated database says.
 *
 * It is safe to call repeatedly, and adds no data, so it needs no seed token — re-running it
 * on a live database is a no-op by construction.
 */
async function migrate(env) {
  const ddl = ddlStatements();
  await env.DB.batch(ddl.filter(sql => sql.startsWith('CREATE TABLE')).map(sql => env.DB.prepare(sql)));
  const present = new Map();
  for (const table of TABLE_NAMES) {
    const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    present.set(table, new Set(results.map(c => c.name)));
  }
  const missing = migrationStatements().filter(s => !present.get(s.table).has(s.column));
  for (const statement of missing) {
    try { await env.DB.prepare(statement.sql).run(); }
    catch (err) { if (!isDuplicateColumnError(err)) throw err; }
  }
  await env.DB.batch(ddl.filter(sql => sql.startsWith('CREATE INDEX')).map(sql => env.DB.prepare(sql)));
  return { ok: true, added: missing.map(s => `${s.table}.${s.column}`), already_present: migrationStatements().length - missing.length, failed: [] };
}

const schemaReady = new WeakMap();
async function ensureSchema(env) {
  if (!schemaReady.has(env.DB)) schemaReady.set(env.DB, (async () => {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS rei_schema_migrations (version TEXT PRIMARY KEY,applied_at TEXT NOT NULL)').run();
    if (await env.DB.prepare('SELECT version FROM rei_schema_migrations WHERE version=?').bind('execution-v1').first()) return;
    await migrate(env);
    await env.DB.prepare('INSERT OR IGNORE INTO rei_schema_migrations(version,applied_at) VALUES(?,?)').bind('execution-v1', new Date().toISOString()).run();
  })().catch(e => { schemaReady.delete(env.DB); throw e; }));
  await schemaReady.get(env.DB);
}

/* ------------------------------------------------------------- recognition */

/**
 * Runs a vision model over a captured image and returns detections in the shape the field
 * workflow already consumes.
 *
 * The call happens here, not in the browser: the model is reached through the Worker's `AI`
 * binding, so no credential is ever shipped to a device that a TME carries into a shop.
 *
 * Failures are reported as failures. Falling back to the simulator would put invented
 * prices in front of a TME under the banner of a real model, which is worse than an error.
 */
async function recognise(env, request) {
  const body = await request.json();
  const { image, model, skus = [], currency = 'SGD' } = body ?? {};

  // A model called directly against the account's own key needs only that key. Everything
  // else goes through Workers AI and needs the binding.
  const descriptor = RECOGNITION_MODELS.find((m) => m.id === model);
  const direct = descriptor?.kind === 'openai' || descriptor?.kind === 'gemini';
  if (!direct && !env.AI) {
    return json(
      {
        error: 'No AI binding configured',
        hint: 'Add [ai] binding = "AI" to wrangler.toml and redeploy, or use the MVP Simulator.',
      },
      503,
    );
  }

  if (typeof image !== 'string' || !image.length) throw new Error('image is required');
  if (typeof model !== 'string' || !model.length) throw new Error('model is required');
  if (!Array.isArray(skus) || !skus.length) throw new Error('skus is required');

  const base64 = image.includes(',') ? image.slice(image.indexOf(',') + 1) : image;
  const prompt = buildPrompt(skus, currency);
  const started = Date.now();

  let raw;
  try {
    raw = await runModel(env, model, prompt, base64);
  } catch (err) {
    return json({ error: explainModelFailure(err, model), model, raw_error: err.message }, 502);
  }

  const text = extractText(raw);
  const { detections, unmatched } = parseModelResponse(text, skus, { currency });

  return json({
    model,
    detections,
    unmatched,
    duration_ms: Date.now() - started,
    // Returned so an operator can see what the model actually said when a read looks wrong.
    raw_response: text?.slice(0, 4000) ?? null,
  });
}

/**
 * Workers AI vision models do not share an input shape, so each model declares its own in
 * the catalogue. Third-party models additionally route through AI Gateway.
 */
async function runModel(env, model, prompt, base64) {
  const descriptor = RECOGNITION_MODELS.find((m) => m.id === model);

  if (descriptor?.kind === 'openai') return callOpenAI(env, descriptor, prompt, base64);
  if (descriptor?.kind === 'gemini') return callGemini(env, descriptor, prompt, base64);

  const shape = descriptor?.input ?? (model.startsWith('@cf/') ? 'image_url' : 'messages');
  const input = buildModelInput(shape, prompt, base64);

  if (model.startsWith('@cf/')) return env.AI.run(model, input);
  return env.AI.run(model, input, { gateway: { id: env.AI_GATEWAY_ID || 'default' } });
}

/**
 * Calls OpenAI directly with the account's own key.
 *
 * The key lives in the Worker's secret store and is read here only. It is never written to
 * the database, never returned by any endpoint, and never reaches the browser — this
 * application has no authentication, so a key it could hand out would be a key anyone with
 * the URL could take.
 *
 * JSON mode is requested, which removes most of the prose-wrapping the parser otherwise has
 * to cope with.
 */
export async function callOpenAI(env, descriptor, prompt, base64) {
  if (!env.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY is not configured. Add it as a Worker secret (Cloudflare dashboard → the Worker → Settings → Variables and Secrets → Add, type Secret).',
    );
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: descriptor.api_model,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'high' } },
          ],
        },
      ],
    }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.error?.message ?? `HTTP ${response.status}`;
    const code = body?.error?.code ? ` (${body.error.code})` : '';
    throw new Error(`OpenAI: ${detail}${code}`);
  }
  return body;
}

/**
 * Calls Google's Gemini API directly with the account's own key.
 *
 * Same custody rule as the OpenAI key: it lives in the Worker's secret store and is read
 * here only. It is never written to the database, never returned by any endpoint and never
 * reaches the browser — this application has no authentication, so a key it could hand out
 * would be a key anyone with the URL could take.
 *
 * A JSON response type is requested, so the parser is not left stripping prose. Temperature
 * is pinned to zero: reading a price off a ticket is transcription, and there is nothing for
 * sampling to improve.
 */
export async function callGemini(env, descriptor, prompt, base64) {
  if (!env.GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Add it as a Worker secret (Cloudflare dashboard → the Worker → Settings → Variables and Secrets → Add, type Secret).',
    );
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${descriptor.api_model}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      // The key goes in a header rather than the query string, so it cannot end up in a
      // proxy or gateway access log alongside the URL.
      'x-goog-api-key': env.GEMINI_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { inline_data: { mime_type: 'image/jpeg', data: base64 } },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0,
        maxOutputTokens: 4096,
      },
    }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.error?.message ?? `HTTP ${response.status}`;
    const status = body?.error?.status ? ` (${body.error.status})` : '';
    throw new Error(`Gemini: ${detail}${status}`);
  }

  /**
   * A 200 with no text is a real outcome here, not an edge case.
   *
   * Gemini answers 200 and returns no candidate when a safety filter stops the request, and
   * a candidate with no parts when it runs out of output tokens mid-answer. Both would reach
   * the parser as "the model read nothing from this image", which sends a TME to retake a
   * photograph that was never the problem. Each is named instead.
   */
  const blocked = body?.promptFeedback?.blockReason;
  if (blocked) {
    throw new Error(
      `Gemini: the request was blocked by a safety filter (${blocked}). This is a property of the filter, not of the photograph — retaking it will not help. Use another model for this image.`,
    );
  }

  const candidate = body?.candidates?.[0];
  const finish = candidate?.finishReason;
  if (finish && finish !== 'STOP' && !candidate?.content?.parts?.length) {
    throw new Error(
      finish === 'MAX_TOKENS'
        ? 'Gemini: the answer was cut off before any of it arrived (MAX_TOKENS). Photograph fewer products at once, or use a model with a larger output budget.'
        : `Gemini: the model stopped without answering (${finish}).`,
    );
  }

  return body;
}

/** What is actually wired up, so Admin can show it instead of guessing. */
function describeBindings(env) {
  return {
    ai_binding: Boolean(env.AI),
    db_binding: Boolean(env.DB),
    ai_gateway_id: env.AI_GATEWAY_ID || 'default',
    seed_token_configured: Boolean(env.SEED_TOKEN),
    // Presence only. No value is ever returned by any endpoint.
    // Alias-aware, so this endpoint and a real run can never disagree about the same key.
    openai_key_configured: hasEnvironmentCredential(env, 'openai'),
    gemini_key_configured: hasEnvironmentCredential(env, 'gemini'),
    /**
     * The same facts keyed by secret name, so Admin can ask "is the secret this model needs
     * present" instead of carrying a branch per provider — which is how the OpenAI-only check
     * came to report a missing key against every bring-your-own-key model.
     */
    secrets: {
      OPENAI_API_KEY: hasEnvironmentCredential(env, 'openai'),
      GEMINI_API_KEY: hasEnvironmentCredential(env, 'gemini'),
    },
    models: RECOGNITION_MODELS.filter((m) => m.reads_image).map((m) => ({
      id: m.id,
      label: m.label,
      tier: m.tier,
      input: m.input,
      requires_licence: Boolean(m.licence),
    })),
  };
}

/**
 * Accepts a model's licence by sending the literal prompt the provider requires.
 *
 * This is a legal act — Meta's terms include a representation about where the accepting
 * party is domiciled — so it is never done automatically as part of a failed call. The
 * caller must ask for it explicitly, having been shown the terms.
 */
async function acceptModelLicence(env, request) {
  if (!env.AI) return json({ error: 'No AI binding configured' }, 503);

  const { model, confirmed } = (await request.json()) ?? {};
  const descriptor = RECOGNITION_MODELS.find((m) => m.id === model);

  if (!descriptor) return json({ error: `Unknown model: ${model}` }, 400);
  if (!descriptor.licence) {
    return json({ error: `${model} does not require a licence acceptance.` }, 400);
  }
  if (confirmed !== true) {
    return json({ error: 'The licence must be confirmed explicitly.' }, 400);
  }

  try {
    // The provider gate expects exactly this prompt, once per account per model.
    const result = await env.AI.run(model, { prompt: 'agree' });
    return json({ accepted: true, model, licence: descriptor.licence, response: extractText(result) });
  } catch (err) {
    return json({ error: explainModelFailure(err, model), raw_error: err.message }, 502);
  }
}

/**
 * Turns a provider error code into something an operator can act on.
 *
 * The raw codes ("2021: Insufficient AI Gateway credits") say nothing about what to do
 * next, and the thing to do next is almost always "pick a model that runs inside the free
 * daily allocation".
 */
export function explainModelFailure(err, model) {
  const message = String(err?.message ?? err ?? '');

  if (/(OPENAI|GEMINI)_API_KEY is not configured/i.test(message)) {
    return message;
  }

  /**
   * Gemini's failures are checked before OpenAI's, because several of the strings overlap
   * ("429", "403") and the first matching branch wins. A Gemini error always says "Gemini:".
   */
  if (/^Gemini: the request was blocked|^Gemini: the answer was cut off|^Gemini: the model stopped/i.test(message)) {
    return message;
  }
  if (/^Gemini:/i.test(message)) {
    if (/API_KEY_INVALID|API key not valid/i.test(message)) {
      return `The Google API key was rejected. Check the GEMINI_API_KEY secret on the Worker — it must be a live key from Google AI Studio, not a Google Cloud service-account credential.`;
    }
    if (/PERMISSION_DENIED|SERVICE_DISABLED|has not been used in project/i.test(message)) {
      return `The Google account has the key but not access to ${model}. Enable the Generative Language API for that project, or generate the key from Google AI Studio, which enables it for you.`;
    }
    if (/RESOURCE_EXHAUSTED|quota|\b429\b/i.test(message)) {
      return `The Google AI Studio quota is spent for now. Free-tier keys are rate-limited per minute and per day; wait and retry, add billing to the project, or switch to a model marked "Free daily allocation" in Admin → Recognition provider.`;
    }
    if (/NOT_FOUND|is not found for API version|not supported for generateContent/i.test(message)) {
      return `${model} is not available on this Google account or API version. Google's model names change between generations; try Gemini 3.7 Flash, or another provider in Admin → Recognition provider.`;
    }
    if (/\b400\b|INVALID_ARGUMENT/i.test(message)) {
      return `Gemini rejected the request. Most often the image is too large — the whole request must stay under 20 MB — so retake the photo or use a smaller one. Original error: ${message}`;
    }
    return message;
  }
  if (/openai:.*(invalid_api_key|incorrect api key|401)/i.test(message)) {
    return `The OpenAI key was rejected. Check the OPENAI_API_KEY secret on the Worker — it must be a live key for an account with access to ${model}.`;
  }
  if (/insufficient_quota|exceeded your current quota/i.test(message)) {
    return `The OpenAI account has no remaining quota. Add billing at platform.openai.com, or switch to a Cloudflare-hosted model marked "Free allocation".`;
  }
  if (/model_not_found|does not exist or you do not have access/i.test(message)) {
    return `${model} is not available on this OpenAI account. Some models need a paid account or a verified organisation; try OpenAI GPT-4.1 mini, or a Cloudflare-hosted model.`;
  }
  if (/5016|you must submit the prompt/i.test(message)) {
    return `${model} requires a one-time licence acceptance before first use. Open Admin → Recognition provider, read the licence and acceptable-use policy linked there, and press "Accept licence". Note the terms exclude parties domiciled in the European Union.`;
  }
  if (/2021|insufficient .*credit/i.test(message)) {
    return `${model} is a paid model: it needs the Workers Paid plan or prepaid AI Gateway credits. Choose a model marked "Free daily allocation" in Admin → Recognition provider — Llama 3.2 11B Vision is the recommended one.`;
  }
  if (/5035|requires the workers paid/i.test(message) || /\b403\b/.test(message)) {
    return `${model} requires the Workers Paid plan. Choose a model marked "Free daily allocation" in Admin → Recognition provider, or upgrade the account.`;
  }
  if (/3040|out of capacity/i.test(message)) {
    return `${model} is temporarily out of capacity at Cloudflare. Retry, or pick another model.`;
  }
  if (/\b429\b|rate limit/i.test(message)) {
    return `Rate limited, or the 10,000 Neurons/day free allocation is spent — it resets at 00:00 UTC. Retry later or pick a lighter model.`;
  }
  if (/no such model|not found|invalid model/i.test(message)) {
    return `${model} is not available on this account. Cloudflare's model catalogue changes; pick another model in Admin → Recognition provider.`;
  }
  return `Model call failed: ${message}`;
}

/** Vision models differ in where they put the answer; take the first shape that has text. */
function extractText(raw) {
  if (typeof raw === 'string') return raw;

  // Gemini splits a long answer across several parts, so they are joined rather than taking
  // the first — a truncated JSON object parses as nothing at all.
  const geminiParts = raw?.candidates?.[0]?.content?.parts;
  if (Array.isArray(geminiParts) && geminiParts.length) {
    const text = geminiParts.map((part) => part?.text ?? '').join('');
    if (text.trim()) return text;
  }

  return (
    raw?.response ??
    raw?.result?.response ??
    raw?.choices?.[0]?.message?.content ??
    raw?.output_text ??
    (raw ? JSON.stringify(raw) : null)
  );
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/* ------------------------------------------------------------------- reads */

async function readAll(env) {
  const results = await Promise.all(
    TABLE_NAMES.map(async (table) => {
      const { results: rows } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
      return [table, rows.map((row) => fromRow(table, row))];
    }),
  );

  const data = Object.fromEntries(results);

  // The client keeps opportunity lifecycle state keyed by opportunity id.
  data.opportunity_states = Object.fromEntries(
    (data.opportunity_states ?? []).map((s) => [s.id, s]),
  );

  return {
    schema_version: 3,
    source: 'd1',
    market: 'SG',
    generated_at: new Date().toISOString(),
    ...data,
  };
}

async function health(env) {
  const counts = {};
  try {
    for (const table of TABLE_NAMES) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first();
      counts[table] = row?.n ?? 0;
    }
  } catch (err) {
    // Tables not created yet — a fresh database that has never been seeded.
    return { ok: false, seeded: false, reason: err.message, counts: {} };
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { ok: true, seeded: total > 0, counts };
}

/* -------------------------------------------------------------------- seed */

/**
 * Creates the tables and loads the demo dataset.
 *
 * Seeding is allowed without any credential only while the database is EMPTY, so a fresh
 * deployment can bootstrap itself but nobody can wipe a populated database by calling a
 * URL. Re-seeding a populated database requires `x-seed-token` to match the `SEED_TOKEN`
 * binding, which is deliberately not set by default.
 */
async function seed(env, request) {
  const current = await health(env);
  if (!current.ok) return json({ error: 'Database health check failed; seeding is blocked to protect existing data' }, 503);
  const populated = current.seeded;

  if (populated) {
    const token = request.headers.get('x-seed-token');
    if (!env.SEED_TOKEN || token !== env.SEED_TOKEN) {
      return json(
        {
          error: 'Database already contains data',
          hint: 'Re-seeding a populated database requires the x-seed-token header.',
          counts: current.counts,
        },
        409,
      );
    }
  }

  const data = buildSeedData(new Date().toISOString());

  // Creates any missing table AND adds any column declared since the tables were first made;
  // `CREATE TABLE IF NOT EXISTS` alone leaves an existing table on its original columns.
  await migrate(env);

  let written = 0;
  for (const table of TABLE_NAMES) {
    const rows =
      table === 'opportunity_states'
        ? Object.entries(data.opportunity_states ?? {}).map(([id, state]) => ({ id, ...state }))
        : (data[table] ?? []);

    await env.DB.prepare(`DELETE FROM ${table}`).run();
    if (!rows.length) continue;

    const sql = upsertSql(table);
    // D1 caps how much a single batch may carry, so load in chunks.
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      await env.DB.batch(chunk.map((row) => env.DB.prepare(sql).bind(...toRow(table, row))));
      written += chunk.length;
    }
  }

  return json({ seeded: true, rows: written, counts: (await health(env)).counts });
}

/* ------------------------------------------------------------------ writes */

/**
 * Applies a batch of writes.
 *
 * Only two operations exist, and both are constrained to the tables and columns declared in
 * the shared schema — an unknown table or a column that is not declared is rejected rather
 * than passed through to SQL.
 */
async function applyMutations(env, mutations) {
  if (!Array.isArray(mutations)) throw new Error('mutations must be an array');
  if (mutations.length > 2000) throw new Error('too many mutations in one batch');

  const statements = [];
  for (const mutation of mutations) {
    const { op, table, row, id } = mutation;
    if (!TABLES[table]) throw new Error(`Unknown table: ${table}`);

    if (op === 'upsert') {
      if (!row || typeof row !== 'object') throw new Error('upsert requires a row');
      statements.push(env.DB.prepare(upsertSql(table)).bind(...toRow(table, row)));
    } else if (op === 'delete') {
      if (!id) throw new Error('delete requires an id');
      statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id));
    } else {
      throw new Error(`Unknown operation: ${op}`);
    }
  }

  if (statements.length) await env.DB.batch(statements);
  return { applied: statements.length };
}

/** Exported for the seeding script, which creates the tables before loading rows. */
export { ddlStatements, columnNames };
