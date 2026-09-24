import { upgradeDemoCatalogue } from './catalogue.js';
import { applyCommand, clone, DomainError } from './domain.js';
import { buildTaiwanDemo, DEMO_TIME, DEMO_ACTOR } from './demo.js';
const DEMO_KEY = 'rei.tw.demo.v1', MODE_KEY = 'rei.workspace.mode';
let demo, workspace, revision = 0, mode = 'demo', actor = null, auth = {}, ai = null;
const urls = new Map();
export async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`/api/execution${path}`, { method, credentials: 'same-origin', headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new DomainError(data.error?.code ?? 'API_UNAVAILABLE', data.error?.message ?? 'The shared server is unavailable.', response.status);
  return data;
}
function loadDemo() {
  try { const saved = JSON.parse(localStorage.getItem(DEMO_KEY)); if (saved?.schemaVersion === 1 && saved?.demo) return upgradeDemoCatalogue(saved); } catch { /* recover a malformed local demo */ }
  return buildTaiwanDemo();
}
export async function initExecution() {
  demo = loadDemo();
  try { auth = await api('/session'); actor = auth.actor; } catch { auth = { authConfigured: false, databaseConfigured: false }; }
  mode = actor && localStorage.getItem(MODE_KEY) === 'shared' ? 'shared' : 'demo';
  if (mode === 'shared') await refreshWorkspace(); else workspace = demo;
  await restoreImageUrls();
  if (actor) await refreshAi().catch(() => {});
}
export const getExecution = () => ({ workspace, revision, mode, actor, auth, ai });
export const executionActor = () => mode === 'demo' ? DEMO_ACTOR : actor;
export const clock = () => mode === 'demo' ? DEMO_TIME : new Date().toISOString();
export async function refreshWorkspace() {
  if (mode === 'demo') { workspace = demo; return workspace; }
  const data = await api('/workspace'); workspace = data.workspace; revision = data.revision; return workspace;
}
export async function setWorkspaceMode(value) {
  if (value === 'shared' && !actor) throw new DomainError('AUTH_REQUIRED', 'Sign in from AI settings to open the private workspace.');
  mode = value === 'shared' ? 'shared' : 'demo'; localStorage.setItem(MODE_KEY, mode); await refreshWorkspace(); await restoreImageUrls();
}
export async function signIn(accessToken) { const data = await api('/session', { accessToken }); actor = data.actor; auth.authConfigured = true; await refreshAi(); }
export async function signOut() { await api('/session', undefined, 'DELETE'); actor = null; ai = null; await setWorkspaceMode('demo'); }
export async function refreshAi() { if (!actor) return null; ai = await api('/ai/state'); return ai; }
export async function command(type, payload) {
  if (mode === 'demo') {
    const result = applyCommand(demo, { type, payload }, DEMO_ACTOR, { now: DEMO_TIME }); demo = result.workspace; workspace = demo;
    // No provider credentials and no image bytes enter browser storage.
    localStorage.setItem(DEMO_KEY, JSON.stringify(demo)); return result.result;
  }
  const result = await api('/commands', { expectedRevision: revision, command: { type, payload } }); workspace = result.workspace; revision = result.revision; return result.result;
}
export async function resetDemo() { demo = buildTaiwanDemo(); localStorage.setItem(DEMO_KEY, JSON.stringify(demo)); if (mode === 'demo') workspace = demo; }
function imageDb() {
  return new Promise((resolve, reject) => { const r = indexedDB.open('rei-local-demo', 1); r.onupgradeneeded = () => r.result.createObjectStore('images'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
async function localImage(id, blob) {
  const db = await imageDb();
  return new Promise((resolve, reject) => { const tx = db.transaction('images', blob ? 'readwrite' : 'readonly'), store = tx.objectStore('images'), r = blob ? store.put(blob, id) : store.get(id); let value; r.onsuccess = () => { value = r.result; }; tx.oncomplete = () => { db.close(); resolve(value); }; tx.onerror = () => { db.close(); reject(tx.error); }; });
}
async function restoreImageUrls() {
  for (const i of workspace.captures.flatMap(c => c.images).filter(i => i.localImage)) {
    if (!urls.has(i.id)) { const blob = await localImage(i.id).catch(() => null); if (blob) urls.set(i.id, URL.createObjectURL(blob)); }
  }
}
export const imageUrl = image => image?.localImage ? urls.get(image.id) ?? '' : image?.url ?? '';
function dataUrl(blob) { return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(blob); }); }
export async function prepareImage(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new DomainError('AI_IMAGE_UNSUPPORTED', 'Choose JPEG, PNG or WebP. Convert HEIC before uploading.');
  if (file.size > 8 * 1024 * 1024) throw new DomainError('IMAGE_TOO_LARGE', 'Each image must be at most 8 MB.');
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  if (bitmap.width * bitmap.height > 40000000) { bitmap.close(); throw new DomainError('IMAGE_TOO_LARGE', 'Use an image smaller than 40 megapixels.'); }
  const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height)), canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  const originalWidth = bitmap.width, originalHeight = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .92));
  if (!blob) throw new Error('Could not process this image. Try another file.');
  return { blob, original: await dataUrl(file), processed: await dataUrl(blob), width: canvas.width, height: canvas.height, originalWidth, originalHeight, name: file.name };
}
export async function uploadImage(captureId, file, range = 'Overview', slotKeys = []) {
  const image = await prepareImage(file), cap = workspace.captures.find(c => c.id === captureId);
  if (mode === 'demo') {
    const id = crypto.randomUUID(); await localImage(id, image.blob); urls.set(id, URL.createObjectURL(image.blob));
    return command('capture.image', { captureId, expectedRevision: cap.revision, image: { id, name: file.name, width: image.width, height: image.height, mimeType: 'image/jpeg', localImage: true, range, slotKeys, synthetic: false } });
  }
  const { blob, ...payload } = image;
  const result = await api(`/captures/${encodeURIComponent(captureId)}/images`, { ...payload, range, slotKeys, expectedRevision: revision }); workspace = result.workspace; revision = result.revision; return result.image;
}
export async function launchRun(captureId, modelId) {
  const cap = workspace.captures.find(c => c.id === captureId);
  if (mode !== 'shared') throw new DomainError('AUTH_REQUIRED', 'Use the private workspace to send images to a real provider.');
  const run = await api('/ai/runs', { task: 'tw_planogram_recognition', captureId, captureRevision: cap.revision, ...(modelId ? { modelId } : {}), idempotencyKey: crypto.randomUUID() });
  localStorage.setItem(`rei.run.${captureId}`, run.id); triggerRun(run.id); return run;
}
// Jobs are already persisted by enqueueRun; the scheduled worker processes them.
export function triggerRun(id) { return id; }
export function savedRunId(captureId) { return localStorage.getItem(`rei.run.${captureId}`); }
export function downloadJson(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
