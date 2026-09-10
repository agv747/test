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
  toRow,
  upsertSql,
} from './shared/schema.js';
import { buildSeedData } from './public/app/seed.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, url) {
  if (!env.DB) return json({ error: 'No database binding configured' }, 503);

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
  if (url.pathname === '/api/seed' && request.method === 'POST') {
    return seed(env, request);
  }
  return json({ error: 'Not found' }, 404);
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
  const populated = current.ok && current.seeded;

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

  for (const statement of ddlStatements()) {
    await env.DB.prepare(statement).run();
  }

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
