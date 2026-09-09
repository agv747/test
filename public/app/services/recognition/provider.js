/**
 * RecognitionService — provider abstraction (§27).
 *
 * The UI only ever talks to `analyzePriceImage(image, context)`. Swapping the MVP
 * simulator for Trax / a Vision API / a multimodal model means registering another
 * provider that returns the same detection shape — no UI change.
 *
 * Detection shape:
 *   {
 *     raw_text: string,
 *     brand_candidate: string|null,
 *     sku_candidate: string|null,       // sku id
 *     price_candidate: number|null,
 *     confidence: number,               // 0..1
 *     bounding_box: {x,y,w,h}|null,     // normalised 0..1, optional
 *     alternatives: [{sku_id, label, confidence}]  // optional
 *   }
 */

const providers = new Map();
let activeProviderId = null;

export function registerProvider(provider) {
  if (!provider?.id || typeof provider.analyzePriceImage !== 'function') {
    throw new Error('Recognition provider must expose an id and analyzePriceImage()');
  }
  providers.set(provider.id, provider);
  if (!activeProviderId) activeProviderId = provider.id;
  return provider;
}

export function listProviders() {
  return [...providers.values()].map((p) => ({ id: p.id, label: p.label, kind: p.kind }));
}

export function setActiveProvider(id) {
  if (!providers.has(id)) throw new Error(`Unknown recognition provider: ${id}`);
  activeProviderId = id;
}

export function getActiveProvider() {
  const provider = providers.get(activeProviderId);
  if (!provider) throw new Error('No recognition provider registered');
  return provider;
}

/**
 * @param {object} image  { id, name, size, width, height, image_source }
 * @param {object} context { outlet, skus, priceRules, observedAt, ... }
 * @returns {Promise<{provider:string, detections:object[]}>}
 */
export async function analyzePriceImage(image, context) {
  const provider = getActiveProvider();
  const detections = await provider.analyzePriceImage(image, context);
  return { provider: provider.id, detections };
}
