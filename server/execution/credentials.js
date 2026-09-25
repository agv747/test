import { requireThat } from '../../public/app/execution/domain.js';
import { fromBase64, toBase64 } from './storage.js';
/**
 * Where a provider key may live on the deployment, and how to tell a missing one apart from a
 * misnamed one.
 *
 * The canonical name is first; the rest are names people reasonably reach for and which
 * Google's own SDKs accept. A value is trimmed before use, because a key pasted with a
 * trailing newline is truthy here and then fails much later as a provider auth error.
 */
export const ENV_KEYS = {
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  openai_compatible: ['COMPATIBLE_API_KEY'],
};
export function readEnvSecret(env, provider) {
  for (const name of ENV_KEYS[provider] ?? []) {
    const value = typeof env?.[name] === 'string' ? env[name].trim() : '';
    if (value) return { name, value };
  }
  return null;
}
export const hasEnvironmentCredential = (env, provider) => Boolean(readEnvSecret(env, provider));
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
    const found = readEnvSecret(env, connection.provider);
    // Four rounds were spent unable to tell "the secret never reached the Worker" from "it is
    // there under another name" — the old message could not distinguish them, so it sent the
    // reader back to the same screen each time. Every other provider key is checked here purely
    // to answer that: if one of them IS visible, secrets do reach this deployment and the fault
    // is this key's name; if none is, nothing reached it, which in the dashboard means the edit
    // to Variables and Secrets was staged and never deployed.
    const names = (ENV_KEYS[connection.provider] ?? []).join(', ');
    const otherVisible = Object.keys(ENV_KEYS).some((p) => p !== connection.provider && readEnvSecret(env, p));
    const diagnosis = otherVisible
      ? `Another provider's key IS visible here, so secrets do reach this Worker — this one is missing or stored under a different name.`
      : `No provider key of any kind is visible here, so nothing has reached this Worker: in the Cloudflare dashboard an edit to Variables and Secrets stays staged until you press Deploy.`;
    requireThat(found, 'AI_NOT_CONFIGURED', `${diagnosis} Looked for ${names} under Workers & Pages → price-check → Settings → Variables and Secrets. /api/config reports which keys are present without signing in. A stored key on this connection avoids Worker secrets altogether.`, 503);
    return found.value;
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
