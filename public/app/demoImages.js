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

/**
 * What the built-in samples are agreed to contain.
 *
 * A demo photo that goes through the ordinary generative simulator gives a different answer
 * per image seed, and the Punggol sample happened to produce Winston Red without Pall Mall
 * Red — its own mapped competitor — so the one screen meant to show competitive analysis
 * showed an empty price gap and an empty Price Index. The main demo could not demonstrate
 * the main idea.
 *
 * Each built-in sample now has an agreed fixture: the same detections every time, chosen so
 * that one visit contains all four situations the story needs.
 *
 *   a correct reading            Winston Blue, sitting inside its recommended range
 *   a price-position exception   Winston Red above range AND outside its competitor corridor
 *   a same-visit comparable pair Winston Red with Pall Mall Red, its primary mapping
 *   an uncertain reading         Mevius, low confidence, with a named alternative
 *
 * ILLUSTRATIVE ARITHMETIC, NOT OBSERVED RETAIL PRICES. Winston Red 14.20 against Pall Mall
 * Red 13.50, both per pack of 20 in the same outlet and visit: gap 0.70, index 105.185…
 * shown as 105.2, against a configured corridor of 0.00–0.35 and 100–103. The numbers are
 * chosen to make the arithmetic checkable on screen; they are not a market benchmark.
 */
export const DEMO_FIXTURE_NOTE =
  'Synthetic demo fixture. The prices are illustrative arithmetic chosen to exercise the ' +
  'comparison, not observed Singapore retail prices.';

export const DEMO_FIXTURES = {
  'shelf-punggol-central.jpg': {
    outlet_hint: 'Punggol Central Minimart',
    detections: [
      { sku_id: 'sku-jti-winston-red', price: 14.2, confidence: 0.97, shelf: 1, facings: 3, ticket: 'red' },
      { sku_id: 'sku-bat-pallmall-red', price: 13.5, confidence: 0.95, shelf: 1, facings: 2, ticket: 'blue' },
      { sku_id: 'sku-jti-winston-blue', price: 13.6, confidence: 0.94, shelf: 2, facings: 2, ticket: 'dark blue' },
      {
        sku_id: 'sku-jti-mevius-original',
        price: 14.5,
        confidence: 0.58,
        shelf: 2,
        facings: 1,
        ticket: 'green',
        raw_text: 'MEVIUS …  $14.50?',
        alternatives: [{ sku_id: 'sku-jti-mevius-sky', probability: 0.34 }],
      },
    ],
  },

  'shelf-yishun-mini-mart.jpg': {
    outlet_hint: 'Yishun Mini Mart',
    detections: [
      { sku_id: 'sku-jti-winston-red', price: 13.6, confidence: 0.96, shelf: 1, facings: 2, ticket: 'red' },
      { sku_id: 'sku-bat-pallmall-red', price: 13.4, confidence: 0.95, shelf: 1, facings: 2, ticket: 'blue' },
      { sku_id: 'sku-jti-camel-blue', price: 12.9, confidence: 0.93, shelf: 2, facings: 3, ticket: 'orange' },
      { sku_id: 'sku-pmi-chesterfield', price: 13.4, confidence: 0.92, shelf: 2, facings: 2, ticket: 'yellow' },
    ],
  },

  'shelf-jurong-west.jpg': {
    outlet_hint: 'Jurong West Mini Mart',
    detections: [
      { sku_id: 'sku-jti-mevius-original', price: 14.4, confidence: 0.96, shelf: 1, facings: 2, ticket: 'green' },
      { sku_id: 'sku-bat-lucky-red', price: 14.3, confidence: 0.94, shelf: 1, facings: 2, ticket: 'red' },
      { sku_id: 'sku-jti-ld-red', price: 12.6, confidence: 0.62, shelf: 2, facings: 2, ticket: 'grey',
        raw_text: 'LD RED  $12.60?' },
    ],
  },
};

/** Whether this image is one of the built-in samples, and what it is agreed to contain. */
export function demoFixtureFor(image) {
  const name = image?.name ?? image?.file ?? '';
  return DEMO_FIXTURES[name] ?? null;
}
