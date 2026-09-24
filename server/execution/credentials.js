import { requireThat } from '../../public/app/execution/domain.js';
import { fromBase64, toBase64 } from './storage.js';
const ENV_KEYS = { gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai_compatible: 'COMPATIBLE_API_KEY' };
export const hasEnvironmentCredential = (env, provider) => Boolean(env[ENV_KEYS[provider]]);
async function encryptionKey(env) {
  requireThat(typeof env.AI_CREDENTIALS_ENCRYPTION_KEY === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(env.AI_CREDENTIALS_ENCRYPTION_KEY), 'AI_SECRET_STORE_UNAVAILABLE', 'Configure AI_CREDENTIALS_ENCRYPTION_KEY as a base64-encoded random 32-byte secret before storing API keys.', 503);
  return crypto.subtle.importKey('raw', fromBase64(env.AI_CREDENTIALS_ENCRYPTION_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptCredential(env, secret, connectionId) {
  requireThat(typeof secret === 'string' && secret.length >= 8 && secret.length <= 4096 && !/[\r\n]/.test(secret), 'AI_AUTH_FAILED', 'Invalid API key format.');
  const iv = crypto.getRandomValues(new Uint8Array(12)), key = await encryptionKey(env);
  const bytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(connectionId) }, key, new TextEncoder().encode(secret));
  return { version: '1', iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(bytes)) };
}
export async function getCredential(env, connection) {
  if (connection.credentialSource === 'environment') {
    const secret = env[ENV_KEYS[connection.provider]];
    // Name the variable and where it lives. "Not configured" sent the last reader to re-check
    // settings inside the app, where nothing was wrong: the value is a Worker secret, and the
    // app can only report its absence, never set it.
    requireThat(secret, 'AI_NOT_CONFIGURED', `This connection reads its key from the Worker secret ${ENV_KEYS[connection.provider] ?? 'for this provider'}, which is not set on the deployment. Add it under Workers & Pages → price-check → Settings → Variables and Secrets, or switch the connection to a stored key.`, 503);
    return secret;
  }
  requireThat(connection.encryptedCredential, 'AI_NOT_CONFIGURED', 'Configure a credential for this connection.', 503);
  const encrypted = connection.encryptedCredential;
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(encrypted.iv), additionalData: new TextEncoder().encode(connection.id) }, await encryptionKey(env), fromBase64(encrypted.ciphertext)));
  } catch { throw Object.assign(new Error('The stored credential could not be decrypted. Rotate it using the current encryption key.'), { code: 'AI_SECRET_STORE_UNAVAILABLE', status: 503 }); }
}
export function connectionDto(connection, env) {
  const { encryptedCredential, ...safe } = connection;
  return { ...safe, credentialConfigured: connection.credentialSource === 'environment' ? hasEnvironmentCredential(env, connection.provider) : Boolean(encryptedCredential) };
}
