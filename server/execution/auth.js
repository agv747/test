import { requireThat } from '../../public/app/execution/domain.js';
import { digest } from './storage.js';

/**
 * Who may sign in, and the two different length rules that decide it.
 *
 * `ADMIN_ACCESS_TOKEN` accepts three characters at the owner's request; tokens listed in
 * `APP_ACCESS_USERS_JSON` keep the 32-character minimum. Relaxing only the single
 * deployment-owned token is deliberate — it is the one a person types by hand, while the user
 * list is machine-generated and has no reason to be short.
 *
 * What the short admin token costs, recorded where the number lives: it is the only
 * authentication the private workspace has, `sessionCookie` stores it verbatim as the session
 * cookie, and nothing here limits attempts. Three characters over the alphabet below is a few
 * hundred thousand guesses — minutes of scripted traffic — and whoever lands it holds an admin
 * session over the shared workspace and the AI credential screens.
 *
 * The character class and the 512 ceiling are NOT length policy and must stay whatever the
 * minimum becomes. The token goes into a `Set-Cookie` header, so a value carrying `;`, a comma
 * or a newline could forge cookie attributes; the ceiling bounds the work an unauthenticated
 * caller can force per request.
 */
function configuredUsers(env) {
  let users = [];
  if (env.APP_ACCESS_USERS_JSON) {
    try { users = JSON.parse(env.APP_ACCESS_USERS_JSON); } catch { return []; }
  }
  if (!Array.isArray(users)) return [];
  users = users.filter(u => typeof u.token === 'string' && u.token.length >= 32 && /^[A-Za-z0-9_-]+$/.test(u.token) && ['admin', 'manager', 'field', 'viewer'].includes(u.role) && Array.isArray(u.markets));
  if (typeof env.ADMIN_ACCESS_TOKEN === 'string' && env.ADMIN_ACCESS_TOKEN.length >= 3 && env.ADMIN_ACCESS_TOKEN.length <= 512 && /^[A-Za-z0-9_-]+$/.test(env.ADMIN_ACCESS_TOKEN)) {
    users.push({ token: env.ADMIN_ACCESS_TOKEN, id: 'admin', name: 'Administrator', role: 'admin', markets: ['SG', 'TW'] });
  }
  return users;
}
export const authConfigured = env => configuredUsers(env).length > 0;
export async function actorForToken(env, token) {
  if (typeof token !== 'string' || token.length < 3 || token.length > 512) return null;
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
