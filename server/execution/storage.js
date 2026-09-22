import { blankWorkspace, DomainError, requireThat } from '../../public/app/execution/domain.js';

// Private tables are intentionally absent from legacy TABLE_NAMES and /api/data.
export const PRIVATE_DDL = [
  'CREATE TABLE IF NOT EXISTS rei_records (kind TEXT NOT NULL,id TEXT NOT NULL,market TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id))',
  'CREATE TABLE IF NOT EXISTS rei_media (image_id TEXT NOT NULL,part INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(image_id,part))',
  'CREATE TABLE IF NOT EXISTS rei_jobs (id TEXT PRIMARY KEY,market TEXT NOT NULL,actor_id TEXT NOT NULL,capture_id TEXT,idem_key TEXT UNIQUE NOT NULL,input_hash TEXT NOT NULL,status TEXT NOT NULL,next_at INTEGER NOT NULL,lease_token TEXT,lease_until INTEGER,created_at INTEGER NOT NULL,payload TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS rei_jobs_due ON rei_jobs(status,next_at)',
];
const initialized = new WeakMap();
export async function initDb(db) {
  requireThat(db, 'DATABASE_UNAVAILABLE', 'Configure the Cloudflare D1 binding.', 503);
  if (!initialized.has(db)) initialized.set(db, db.batch(PRIVATE_DDL.map(sql => db.prepare(sql))).catch(e => { initialized.delete(db); throw e; }));
  await initialized.get(db);
}
export async function readRecord(db, kind, id) {
  await initDb(db); const row = await db.prepare('SELECT revision,payload FROM rei_records WHERE kind=? AND id=?').bind(kind, id).first();
  return row ? { revision: row.revision, data: JSON.parse(row.payload) } : null;
}
export async function listRecords(db, kind) {
  await initDb(db); const { results } = await db.prepare('SELECT revision,payload FROM rei_records WHERE kind=? ORDER BY id').bind(kind).all();
  return results.map(r => ({ ...JSON.parse(r.payload), revision: r.revision }));
}
export async function writeRecord(db, kind, id, data, expectedRevision = 0, market = 'TW') {
  await initDb(db); const payload = JSON.stringify(data);
  requireThat(new TextEncoder().encode(payload).length <= 1500000, 'WORKSPACE_LIMIT', 'This pilot workspace reached its record size limit. Export/archive records before continuing.', 413);
  let result;
  if (expectedRevision === 0) result = await db.prepare('INSERT INTO rei_records(kind,id,market,revision,payload) VALUES(?,?,?,1,?) ON CONFLICT(kind,id) DO NOTHING').bind(kind, id, market, payload).run();
  else result = await db.prepare('UPDATE rei_records SET payload=?,revision=revision+1 WHERE kind=? AND id=? AND revision=?').bind(payload, kind, id, expectedRevision).run();
  requireThat(result.meta.changes === 1, 'REVISION_CONFLICT', 'Another request updated this record. Reload and try again.', 409);
  return expectedRevision + 1;
}
export async function readWorkspace(db) { return await readRecord(db, 'workspace', 'TW') ?? { revision: 0, data: blankWorkspace() }; }
export async function digest(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}
export async function saveMedia(db, imageId, bytes) {
  await initDb(db); const statements = [];
  for (let offset = 0, part = 0; offset < bytes.length; offset += 128 * 1024, part++) statements.push(db.prepare('INSERT INTO rei_media(image_id,part,bytes) VALUES(?,?,?)').bind(imageId, part, bytes.slice(offset, offset + 128 * 1024)));
  await db.batch(statements);
}
export async function readMedia(db, imageId) {
  const { results } = await db.prepare('SELECT bytes FROM rei_media WHERE image_id=? ORDER BY part').bind(imageId).all();
  requireThat(results.length, 'NOT_FOUND', 'Image not found.', 404);
  const arrays = results.map(r => new Uint8Array(r.bytes)), bytes = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0; for (const a of arrays) { bytes.set(a, at); at += a.length; } return bytes;
}
export async function deleteMedia(db, imageId) { await db.prepare('DELETE FROM rei_media WHERE image_id=?').bind(imageId).run(); }
export function toBase64(bytes) { let text = ''; for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode(...bytes.subarray(i, i + 16384)); return btoa(text); }
export function fromBase64(text) { try { return Uint8Array.from(atob(text), c => c.charCodeAt(0)); } catch { throw new DomainError('IMAGE_INVALID', 'Invalid image encoding.'); } }
export function parseImage(dataUrl) {
  requireThat(typeof dataUrl === 'string' && dataUrl.length <= 12 * 1024 * 1024, 'IMAGE_TOO_LARGE', 'Each image must be at most 8 MB.');
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl);
  requireThat(m, 'AI_IMAGE_UNSUPPORTED', 'Use JPEG, PNG or WebP. Convert HEIC before upload.');
  const bytes = fromBase64(m[2]);
  requireThat(bytes.length > 12 && bytes.length <= 8 * 1024 * 1024, 'IMAGE_TOO_LARGE', 'Each image must be at most 8 MB.');
  const text = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  const matches = m[1] === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : m[1] === 'image/png' ? bytes[0] === 137 && text(1, 4) === 'PNG' : text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP';
  requireThat(matches, 'IMAGE_INVALID', 'File content does not match its image type.'); return { mimeType: m[1], bytes };
}
export function scopeWorkspace(w, actor) {
  requireThat(actor.markets.includes('TW'), 'FORBIDDEN', 'Taiwan access required.', 403);
  if (actor.role !== 'field') return w;
  const fixtureIds = new Set(w.fixtures.filter(f => f.ownerId === actor.id).map(f => f.id));
  const planIds = new Set(w.assignments.filter(a => fixtureIds.has(a.fixtureId)).map(a => a.planId));
  return { ...w, fixtures: w.fixtures.filter(f => fixtureIds.has(f.id)), assignments: w.assignments.filter(a => fixtureIds.has(a.fixtureId)), plans: w.plans.filter(p => planIds.has(p.id)), captures: w.captures.filter(c => fixtureIds.has(c.fixtureId)), assessments: w.assessments.filter(a => fixtureIds.has(a.fixtureId)), issues: w.issues.filter(i => fixtureIds.has(i.fixtureId)), events: [] };
}
