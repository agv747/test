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

/**
 * Registered providers with the descriptive metadata Admin renders — tier, cost, licence
 * and whether the provider looks at the image at all. Returning only id/label/kind once
 * silently hid the licence and test controls.
 */
export function listProviders() {
  return [...providers.values()].map((p) => ({
    id: p.id,
    label: p.label,
    kind: p.kind,
    tier: p.tier ?? 'free',
    input: p.input ?? null,
    reads_image: p.reads_image !== false,
    recommended: Boolean(p.recommended),
    description: p.description ?? '',
    cost: p.cost ?? '',
    licence: p.licence ?? null,
  }));
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
 * What is about to read these images, stated before anybody presses Process.
 *
 * A demonstration that shows simulated prices is honest; one that shows simulated prices
 * while the audience believes a model read the photo is not, and the difference is invisible
 * on the results screen — the numbers look identical. So the mode is named on the step where
 * the images are chosen, not discovered afterwards from a provider id in a detail row.
 *
 * There is no third state: a real provider that fails throws, and the workflow shows the
 * error. It never quietly hands the image to the simulator.
 *
 * @param {object[]} images the images queued for this visit
 * @param {(image:object)=>boolean} isFixture whether this image has agreed demo content
 * @returns {{mode:string, label:string, detail:string, tone:string, provider:string}}
 */
export function describeRecognitionMode(images = [], isFixture = () => false) {
  const provider = getActiveProvider();
  const simulated = provider.reads_image === false;
  const fixtures = images.filter((image) => isFixture(image)).length;

  if (simulated && fixtures) {
    return {
      mode: 'fixture',
      provider: provider.id,
      tone: 'watch',
      label: 'Demo recognition — simulated',
      detail:
        fixtures === images.length
          ? 'Every image is a built-in sample and returns its agreed demo content. Nothing in the photo is read.'
          : `${fixtures} of ${images.length} images are built-in samples and return their agreed demo content; the rest are simulated from the catalogue. Nothing in the photos is read.`,
    };
  }
  if (simulated) {
    return {
      mode: 'simulated',
      provider: provider.id,
      tone: 'watch',
      label: 'Demo recognition — simulated',
      detail:
        'Prices are generated from the SKU catalogue and price rules. The image is not read, so the detections are not observations of this shelf.',
    };
  }
  return {
    mode: 'real',
    provider: provider.id,
    tone: 'good',
    label: `Real recognition — ${provider.label}`,
    detail:
      'The image is sent to the model through the Worker and the prices come back from it. If the model fails, this visit stops with an error rather than falling back to simulated prices.',
  };
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
