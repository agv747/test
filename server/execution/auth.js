import { requireThat } from '../../public/app/execution/domain.js';
import { digest } from './storage.js';

/**
 * The shortest token the deployment will accept.
 *
 * Set to 1 at the owner's request, so a short hand-typed token works. What that costs is worth
 * stating where the number lives: this token is the only authentication the private workspace
 * has, `sessionCookie` stores it verbatim as the session cookie, and nothing here rate-limits
 * attempts. A three-character token from the 64-character alphabet below is a few hundred
 * thousand guesses — minutes of scripted traffic — and whoever lands it holds an admin session
 * over the shared workspace and the AI credential screens.
 *
 * The other two checks are NOT length policy and must stay. The character class keeps the token
 * safe to place in a `Set-Cookie` header: a value carrying `;`, a comma or a newline would let
 * an attacker forge cookie attributes. The 512 ceiling bounds the work an unauthenticated
 * caller can force per request.
 */
const MIN_TOKEN_LENGTH = 1;
const MAX_TOKEN_LENGTH = 512;
function configuredUsers(env) {
  let users = [];
  if (env.APP_ACCESS_USERS_JSON) {
    try { users = JSON.parse(env.APP_ACCESS_USERS_JSON); } catch { return []; }
  }
  if (!Array.isArray(users)) return [];
  if (env.ADMIN_ACCESS_TOKEN) users.push({ token: env.ADMIN_ACCESS_TOKEN, id: 'admin', name: 'Administrator', role: 'admin', markets: ['SG', 'TW'] });
  return users.filter(u => typeof u.token === 'string' && u.token.length >= MIN_TOKEN_LENGTH && u.token.length <= MAX_TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(u.token) && ['admin', 'manager', 'field', 'viewer'].includes(u.role) && Array.isArray(u.markets));
}
export const authConfigured = env => configuredUsers(env).length > 0;
export async function actorForToken(env, token) {
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) return null;
  const hash = await digest(token);
  for (const u of configuredUsers(env)) {
    const expected = await digest(u.token); let diff = 0;
    for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ expected.charCodeAt(i);
    if (diff === 0) return { id: u.id, name: u.name, role: u.role, markets: u.markets.filter(m => ['SG', 'TW'].includes(m)) };
  }
  return null;
}
export async function getActor(request, env) {
  const token = request.headers.get('cookie')?.split(';').map(p => p.trim()).find(p => p.startsWith('rei_session='))?.slice(12);
  return actorForToken(env, token);
}
export function sameOrigin(request) {
  const origin = request.headers.get('origin'), target = new URL(request.url);
  requireThat(!origin || origin === target.origin, 'FORBIDDEN', 'Cross-origin writes are not allowed.', 403);
  requireThat(request.headers.get('sec-fetch-site') !== 'cross-site', 'FORBIDDEN', 'Cross-site writes are not allowed.', 403);
}
export function sessionCookie(token, request, clear = false) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `rei_session=${clear ? '' : token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 28800}${secure}`;
}
