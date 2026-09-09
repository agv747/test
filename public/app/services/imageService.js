/**
 * ImageService — acquisition, preview and quality validation (§8.3, §8.4).
 *
 * Quality checks run BEFORE recognition so a TME learns immediately that a photo is
 * unusable, instead of at submission time.
 */

import { rngFor } from '../lib/rng.js';

export const SUPPORTED_MIME = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
];

export const SUPPORTED_EXT = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp'];

export function isSupportedImage(file) {
  const type = (file.type || '').toLowerCase();
  if (type && SUPPORTED_MIME.includes(type)) return true;
  const ext = (file.name || '').split('.').pop()?.toLowerCase();
  return SUPPORTED_EXT.includes(ext || '');
}

/**
 * Deterministic quality assessment.
 *
 * Real signals available in the browser (file size, pixel dimensions, MIME type) drive the
 * hard failures. Softer conditions a real vision provider would report (blur, price label
 * not visible, ambiguous labels) are simulated deterministically from the file identity so
 * the recovery UX (§8.4) is demonstrable — a production provider replaces this branch.
 *
 * @param {{name:string, size:number, type:string, width?:number, height?:number}} file
 * @param {object} qualityConfig config.image_quality
 * @returns {{status:string, usable:boolean, canContinue:boolean, reasons:string[]}}
 */
export function assessImageQuality(file, qualityConfig) {
  const reasons = [];

  if (!isSupportedImage(file)) {
    return {
      status: 'Unsupported Image',
      usable: false,
      canContinue: false,
      reasons: ['File type is not a supported image format (JPG, PNG, HEIC, WebP)'],
    };
  }

  if (file.size && file.size < qualityConfig.min_bytes) {
    reasons.push(`File is only ${Math.round(file.size / 1024)} KB — likely a low-resolution copy`);
  }
  const tooSmall =
    (file.width && file.width < qualityConfig.min_width) ||
    (file.height && file.height < qualityConfig.min_height);
  if (tooSmall) {
    reasons.push(`Image is ${file.width}×${file.height}px — below ${qualityConfig.min_width}px`);
  }

  if (reasons.length) {
    return {
      status: 'Low Resolution',
      usable: false,
      canContinue: qualityConfig.allow_continue_anyway,
      reasons,
    };
  }

  // Simulated soft signals — replaced by real provider output in production.
  const rand = rngFor(`quality|${file.name}|${file.size}`);
  const roll = rand();
  if (roll < 0.07) {
    return {
      status: 'Blurry',
      usable: false,
      canContinue: qualityConfig.allow_continue_anyway,
      reasons: ['Label edges are not sharp enough to read prices reliably'],
    };
  }
  if (roll < 0.11) {
    return {
      status: 'Price Not Visible',
      usable: false,
      canContinue: qualityConfig.allow_continue_anyway,
      reasons: ['No price label detected in frame'],
    };
  }
  if (roll < 0.14) {
    return {
      status: 'Multiple Ambiguous Labels',
      usable: true,
      canContinue: true,
      reasons: ['Several price labels overlap — confirm each detection carefully'],
    };
  }

  return { status: 'Good', usable: true, canContinue: true, reasons: [] };
}

/** Reads pixel dimensions in the browser; resolves nulls in non-DOM environments. */
export function readImageDimensions(file) {
  if (typeof window === 'undefined' || typeof Image === 'undefined') {
    return Promise.resolve({ width: null, height: null, dataUrl: null });
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight, dataUrl: url });
    };
    img.onerror = () => resolve({ width: null, height: null, dataUrl: url });
    img.src = url;
  });
}

/** Staged processing steps shown during recognition (§8.5). */
export const PROCESSING_STEPS = [
  'Checking image quality',
  'Detecting product labels',
  'Reading prices',
  'Matching SKUs',
  'Applying pricing rules',
  'Comparing competitor position',
];
