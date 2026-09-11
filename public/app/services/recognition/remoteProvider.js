/**
 * Vision-model recognition provider (§27 "Future provider").
 *
 * Sends the captured image to the Worker, which runs the chosen model through its `AI`
 * binding. The model is never called from the browser, so no credential reaches a device
 * carried into a shop.
 *
 * On failure this throws rather than returning invented data: the field workflow shows the
 * error and the TME can retake the photo or switch model. Silently substituting simulated
 * prices under the banner of a real model would be worse than failing.
 */

import { registerProvider } from './provider.js';

const MAX_BYTES = 6 * 1024 * 1024;

/** Reads a File/Blob as a base64 data URL. */
async function toDataUrl(file) {
  if (typeof FileReader === 'undefined') throw new Error('No FileReader in this environment');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the image file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Downscales a large photo before upload. A phone camera image is far larger than any
 * vision model needs to read a price list, and the round trip is what a TME waits on.
 */
async function downscale(file, maxEdge = 1600, quality = 0.85) {
  if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') {
    return toDataUrl(file);
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= MAX_BYTES) {
      bitmap.close?.();
      return toDataUrl(file);
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    return toDataUrl(file);
  }
}

/**
 * Builds a provider bound to one model id, so each model appears as its own entry in the
 * provider registry and the existing `setActiveProvider` switch keeps working unchanged.
 */
export function createRemoteProvider(descriptor) {
  const { id } = descriptor;
  return {
    // Carry the whole descriptor so Admin can show tier, cost and licence without a second
    // lookup, and so a new field on a model needs no change here.
    ...descriptor,
    reads_image: true,

    async analyzePriceImage(image, context) {
      if (!image.file) {
        throw new Error('This model needs the original image file; re-add the photo and retry.');
      }

      const dataUrl = await downscale(image.file);
      const skus = [...(context.jtiSkus ?? []), ...(context.competitorSkus ?? [])].map((s) => ({
        id: s.id,
        name: s.name,
        brand_name: s.brand_name,
        sku_code: s.sku_code,
        is_jti: s.is_jti,
      }));

      const response = await fetch('/api/recognise', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, model: id, skus, currency: context.currency ?? 'SGD' }),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error ?? `Recognition failed (${response.status})`);
      }
      if (!body.detections?.length) {
        throw new Error(
          'The model did not read any product prices from this image. Try a clearer photo of the price list.',
        );
      }
      return body.detections;
    },
  };
}

/** Registers one provider per configured vision model. */
export function registerRemoteProviders(models) {
  return models
    .filter((m) => m.kind !== 'simulated')
    .map((m) => registerProvider(createRemoteProvider(m)));
}
