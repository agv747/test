/**
 * Vision-model prompt construction and response parsing.
 *
 * Kept pure and separate from the Worker so the fragile parts — coaxing JSON out of a
 * model's prose, matching free-text brand names back to catalogue SKUs, and normalising
 * prices — are unit-tested rather than only exercised by a live model call.
 *
 * Singapore context that shapes the prompt: point-of-sale display of tobacco has been
 * banned since 2017 and packaging has been standardised since 2020, so what the camera
 * usually sees is a printed price list, not branded packs on a shelf.
 */

/** Builds the instruction sent with the image. */
export function buildPrompt(skus, currency = 'SGD') {
  const catalogue = skus
    .map((s) => `- ${s.brand_name ? `${s.brand_name} ` : ''}${s.name}`)
    .join('\n');

  return `You are reading a retail price capture photograph taken in a Singapore convenience store or mini mart. It usually shows a printed cigarette PRICE LIST, and sometimes standardised (plain) packs in an opened cabinet. Standardised packaging means packs carry no brand colours or logos — the brand name is printed in a plain font, so read the TEXT.

Extract every product line you can read, with its price.

Products that may appear (match to these exactly where you can):
${catalogue}

Rules:
- Report the price per pack in ${currency}, as a number, without a currency symbol.
- Use the product name exactly as written in the list above when it clearly matches.
- If a line is readable but matches nothing in the list, still report it with the text you read.
- Do not invent products you cannot see. Do not guess a price you cannot read.
- confidence is your own 0-1 estimate of how certain you are of BOTH the product and the price.
- Report the lines in the ORDER THEY APPEAR in the image, top to bottom, left to right. This
  order is used to place each price back on the photograph, so it matters as much as the
  values. Where one price covers several facings side by side, report each facing.
- Do not report coordinates. You are not asked where anything is.

Respond with JSON only, no commentary, in exactly this shape:
{"detections":[{"product":"Winston Red","price":13.60,"confidence":0.95,"text":"WINSTON Red $13.60"}]}`;
}

/* -------------------------------------------------------------- model input */

/** Decodes base64 into a byte array, for models that take raw image bytes. */
export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Builds the request body for one model.
 *
 * Workers AI vision models do not share an input shape: some take `{prompt, image}` with a
 * data URL, LLaVA takes raw image bytes, and the chat-style models take multimodal
 * `messages`. The shape is declared per model rather than guessed from the id, so adding a
 * model is a data change.
 *
 * @param {'image_url'|'image_bytes'|'messages'} shape
 */
export function buildModelInput(shape, prompt, base64, maxTokens = 1500) {
  const dataUrl = `data:image/jpeg;base64,${base64}`;

  if (shape === 'image_bytes') {
    return { prompt, image: base64ToBytes(base64), max_tokens: maxTokens };
  }
  if (shape === 'image_url') {
    return { prompt, image: dataUrl, max_tokens: maxTokens };
  }
  return {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: maxTokens,
  };
}

/* ------------------------------------------------------------------ parsing */

/**
 * Pulls the JSON object out of a model response that may be wrapped in prose or a fenced
 * code block. Returns null when nothing parseable is present.
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    const direct = tryParse(trimmed);
    if (direct) return direct;

    // Fall back to the outermost {...} span.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      const spanned = tryParse(trimmed.slice(start, end + 1));
      if (spanned) return spanned;
    }
  }
  return null;
}

function tryParse(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Normalises a label for comparison: lowercase, alphanumerics and spaces only. */
export function normalise(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Matches a free-text product label to a catalogue SKU.
 *
 * Scores token overlap against "<brand> <name>" and the SKU code, requiring the brand token
 * to be present so that "Winston Red" never matches "Marlboro Red" on the shared word.
 *
 * @returns {{sku: object, score: number}|null}
 */
export function matchSku(label, skus) {
  const wanted = new Set(normalise(label).split(' ').filter(Boolean));
  if (!wanted.size) return null;

  let best = null;
  for (const sku of skus) {
    const brandTokens = normalise(sku.brand_name).split(' ').filter(Boolean);
    const nameTokens = normalise(sku.name).split(' ').filter(Boolean);
    const codeTokens = normalise(sku.sku_code).split(' ').filter(Boolean);
    const all = new Set([...brandTokens, ...nameTokens, ...codeTokens]);

    // The brand must be recognisable, otherwise variant words alone decide the match.
    const brandHit = brandTokens.length === 0 || brandTokens.every((t) => wanted.has(t));
    if (!brandHit) continue;

    let hits = 0;
    for (const token of wanted) if (all.has(token)) hits += 1;
    if (!hits) continue;

    // Reward covering the SKU's own tokens, so "Winston Red" beats bare "Winston".
    const coverage = hits / new Set([...brandTokens, ...nameTokens]).size;
    const precision = hits / wanted.size;
    const score = (coverage + precision) / 2;

    if (!best || score > best.score) best = { sku, score };
  }
  return best && best.score >= 0.5 ? best : null;
}

/** Parses a price that may arrive as a number, "13.60", "$13.60" or "SGD 13,60". */
export function parsePrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? round2(value) : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^\d.,]/g, '').replace(',', '.');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? round2(parsed) : null;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

/**
 * Converts a model response into the detection shape the application already consumes.
 *
 * Unmatched lines are kept with `sku_candidate: null` rather than dropped: the TME can
 * correct them in the field, and a silently discarded price is worse than a visible one
 * that needs confirming.
 *
 * @returns {{detections: object[], unmatched: number}}
 */
export function parseModelResponse(text, skus, options = {}) {
  const { defaultConfidence = 0.6, maxDetections = 40 } = options;
  const payload = extractJson(text);
  const rows = Array.isArray(payload?.detections)
    ? payload.detections
    : Array.isArray(payload)
      ? payload
      : [];

  const detections = [];
  let unmatched = 0;

  for (const row of rows.slice(0, maxDetections)) {
    const label = row?.product ?? row?.name ?? row?.sku ?? '';
    const price = parsePrice(row?.price);
    if (price === null) continue;

    const match = matchSku(label, skus);
    if (!match) unmatched += 1;

    const stated = clamp01(Number(row?.confidence));
    // An unmatched product is inherently less certain than the model's own estimate.
    const confidence = match
      ? (stated ?? defaultConfidence)
      : Math.min(stated ?? defaultConfidence, 0.5);

    detections.push({
      raw_text: String(row?.text ?? label ?? '').slice(0, 200),
      brand_candidate: match?.sku.brand_name ?? String(label).split(' ')[0] ?? null,
      sku_candidate: match?.sku.id ?? null,
      price_candidate: price,
      confidence: round2(confidence),
      // No position. The vision models are not asked for one and cannot supply one: asked
      // twice, gpt-4o returned a fabricated grid of rectangles above the packs it had just
      // read correctly. Detections are shown as a shelf schematic instead of on the photo.
      bounding_box: null,
      alternatives: [],
      detected_is_jti: match ? Boolean(match.sku.is_jti) : null,
      match_score: match ? round2(match.score) : null,
    });
  }

  return { detections, unmatched };
}
