/**
 * Sample shelf photos offered on the image-acquisition step.
 *
 * By default these are served as ordinary static assets. A standalone single-file build
 * (see `scripts/bundle-standalone.mjs`) embeds them as data URIs and publishes them on
 * `globalThis.__RPI_EMBEDDED_IMAGES__` before the bundle runs, so the same code works
 * whether the app is served by the Worker or opened as one self-contained HTML file.
 */

const EMBEDDED = globalThis.__RPI_EMBEDDED_IMAGES__;

export const DEMO_IMAGES = EMBEDDED ?? [
  { label: 'Punggol', file: 'shelf-punggol-central.jpg', url: '/demo-images/shelf-punggol-central.jpg' },
  { label: 'Yishun', file: 'shelf-yishun-mini-mart.jpg', url: '/demo-images/shelf-yishun-mini-mart.jpg' },
  { label: 'Jurong West', file: 'shelf-jurong-west.jpg', url: '/demo-images/shelf-jurong-west.jpg' },
];

/**
 * Loads a sample image as a File, so it enters the visit through exactly the same path as
 * a photo the TME picked from their own gallery — including quality validation.
 */
export async function loadSampleImage(index) {
  const sample = DEMO_IMAGES[index];
  if (!sample) throw new Error(`No sample image at index ${index}`);
  const response = await fetch(sample.url);
  if (!response.ok) throw new Error(`Sample image unavailable (${response.status})`);
  const blob = await response.blob();
  return new File([blob], sample.file, { type: blob.type || 'image/jpeg' });
}
