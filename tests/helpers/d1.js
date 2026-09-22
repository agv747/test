import { DatabaseSync } from 'node:sqlite';
/** Real SQLite semantics, adapted to the D1 API used by this Worker. */
export function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:');
  const wrap = (sql, params = []) => ({
    bind: (...values) => wrap(sql, values),
    async first() { return sqlite.prepare(sql).get(...params) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...params) }; },
    async run() { const result = sqlite.prepare(sql).run(...params); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
  });
  return { prepare: sql => wrap(sql), async batch(statements) { sqlite.exec('BEGIN'); try { const results = []; for (const s of statements) results.push(await s.run()); sqlite.exec('COMMIT'); return results; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }, close: () => sqlite.close() };
}
