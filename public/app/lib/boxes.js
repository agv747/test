/**
 * Where a detection sits on the photograph.
 *
 * This module is loaded by BOTH the browser and the Worker (`shared/recognition.js`
 * re-exports it), because the two halves of the job live in different places: the Worker
 * parses whatever coordinates a model reports, and only the browser holds the pixels needed
 * to check whether those coordinates point at anything.
 *
 * The check exists because vision models fabricate. Asked for boxes, a model that read a
 * shelf photo correctly — right products, right prices — returned a tidy two-by-three
 * lattice of identical rectangles sitting a tenth of the image above the packs they claimed
 * to mark. Nothing about the numbers themselves was wrong: they were plausible, in range,
 * internally consistent, and pointed at empty background. Geometry alone cannot catch that.
 * The pixels can: a rectangle over a price label or a pack contains text, edges and
 * contrast, while a rectangle over the dark inside of a cabinet contains almost nothing.
 */

function clamp01(value) {
  if (!Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Reads the optional location a model reports for a detection, as `{x, y, w, h}` in
 * fractions of the image with `source: 'model'`.
 *
 * Two shapes are accepted, `[x0, y0, x1, y1]` and `{x, y, w, h}`, because models disagree.
 * They also disagree on scale: a model trained on a 0–1000 grid reports integers, so a box
 * outside the unit square is rescaled rather than thrown away. Anything that still fails to
 * describe a positive area is dropped — a rectangle over the wrong line is worse than no
 * rectangle, because it invites the TME to confirm a price they never actually checked.
 */
export function parseBox(value) {
  let x0;
  let y0;
  let x1;
  let y1;

  if (Array.isArray(value) && value.length === 4) {
    [x0, y0, x1, y1] = value.map(Number);
  } else if (value && typeof value === 'object') {
    const x = Number(value.x);
    const y = Number(value.y);
    const w = Number(value.w ?? value.width);
    const h = Number(value.h ?? value.height);
    x0 = x;
    y0 = y;
    x1 = x + w;
    y1 = y + h;
  } else {
    return null;
  }

  const corners = [x0, y0, x1, y1];
  if (!corners.every((n) => Number.isFinite(n))) return null;

  // 0–1 fractions, 0–100 percentages and the 0–1000 grid all appear in the wild.
  const extent = Math.max(...corners.map(Math.abs));
  const scale = extent <= 1.5 ? 1 : extent <= 100 ? 100 : 1000;
  [x0, y0, x1, y1] = corners.map((n) => clamp01(n / scale));

  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  const w = Math.max(x0, x1) - x;
  const h = Math.max(y0, y1) - y;
  if (w < 0.02 || h < 0.01) return null;

  return { x: round3(x), y: round3(y), w: round3(w), h: round3(h), source: 'model' };
}

/**
 * Lays detections out as horizontal bands in the order the model read them, so a photo can
 * still be annotated when the model reports no usable coordinates — which is most of the
 * time, and always for a price list read as text.
 *
 * The result is explicitly marked `source: 'inferred'` and every screen that draws it says
 * the positions are approximate. It holds because a Singapore price list is a single column
 * read top to bottom; it does not hold for packs spread across a cabinet, which is why the
 * label matters.
 *
 * Detections are left untouched if any of them is already placed, rather than mixing
 * measured and invented geometry in one picture.
 */
export function inferBoxes(detections) {
  const rows = detections ?? [];
  if (!rows.length || rows.some((d) => d.bounding_box)) return rows;

  const band = 1 / rows.length;
  const gap = Math.min(0.012, band * 0.18);
  return rows.map((row, i) => ({
    ...row,
    bounding_box: {
      x: 0.03,
      y: round3(i * band + gap),
      w: 0.94,
      h: round3(band - gap * 2),
      source: 'inferred',
    },
  }));
}

/* ------------------------------------------------ checking a box against the pixels */

/** A gradient this steep is an edge — print, a shelf lip, the outline of a pack. */
const EDGE_STEP = 24;

/**
 * Fraction of pixels in a region that sit on an edge.
 *
 * Measured rather than mean deviation, average contrast, or range, because a model's box is
 * usually loose: measured on a real price list, a box three times taller than the line it
 * marks scored 0.027 by mean deviation — below empty shelf at 0.035 — because the surplus
 * white swamped the text. The same box scored 0.078 by edge density against 0.000 for a
 * blank region, since surplus background adds no edges to find. Range separates them too,
 * but a single bright speck carries it, and sensor noise in a dark cabinet is exactly that.
 *
 * @param {{data: Uint8ClampedArray|number[], width: number, height: number}} luma
 *        single-channel luminance samples, row-major, 0–255
 * @param {{x,y,w,h}} box in fractions of the image
 */
export function regionDetail(luma, box) {
  const { data, width, height } = luma ?? {};
  if (!width || !height) return 0;

  const x0 = Math.max(0, Math.floor((box?.x ?? 0) * width));
  const y0 = Math.max(0, Math.floor((box?.y ?? 0) * height));
  // Stop one short of the far edge: each sample is compared with its right and lower neighbour.
  const x1 = Math.min(width - 1, Math.ceil(((box?.x ?? 0) + (box?.w ?? 1)) * width));
  const y1 = Math.min(height - 1, Math.ceil(((box?.y ?? 0) + (box?.h ?? 1)) * height));
  if (x1 <= x0 || y1 <= y0) return 0;

  let edges = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const value = data[y * width + x];
      const gradient =
        Math.abs(data[y * width + x + 1] - value) + Math.abs(data[(y + 1) * width + x] - value);
      if (gradient > EDGE_STEP) edges += 1;
      count += 1;
    }
  }
  return count ? edges / count : 0;
}

/**
 * A region with fewer edges than this holds no label, no price and no pack.
 *
 * Three and a half times below the weakest legitimate box measured on a real photo, and far
 * above what sensor noise in a dark cabinet produces — noise moves a few levels, well under
 * the gradient an edge has to clear.
 */
export const FLAT_REGION_DETAIL = 0.02;

/**
 * Discards model-reported boxes that point at featureless parts of the photograph.
 *
 * Only `model` boxes are judged. An inferred layout makes no claim about the image and a
 * box the TME placed by hand is theirs, not ours to overrule.
 *
 * A box is kept if it holds real detail in its own right, or at least a third as much as
 * the photograph as a whole — the relative test is what stops a uniformly dim photo from
 * losing every box.
 *
 * @returns {{detections: object[], rejected: number}}
 */
export function vetBoxesAgainstImage(detections, luma, options = {}) {
  const { floor = FLAT_REGION_DETAIL, relative = 0.25 } = options;
  const rows = detections ?? [];
  if (!rows.length || !luma?.width || !luma?.height) return { detections: rows, rejected: 0 };

  const overall = regionDetail(luma, { x: 0, y: 0, w: 1, h: 1 });
  const threshold = Math.min(floor, overall * relative);

  let rejected = 0;
  const vetted = rows.map((row) => {
    if (row.bounding_box?.source !== 'model') return row;
    if (regionDetail(luma, row.bounding_box) >= threshold) return row;
    rejected += 1;
    return { ...row, bounding_box: null, box_rejected: 'featureless' };
  });

  // Every position discarded means the model located nothing; fall back to reading order
  // rather than leaving a photograph with no annotation at all.
  return { detections: rejected ? inferBoxes(vetted) : vetted, rejected };
}

/**
 * Reduces an image to a small single-channel luminance grid.
 *
 * Deliberately coarse: 160px on the long edge is around twenty thousand samples, enough to
 * tell a price label from empty shelf, scanned in well under a millisecond, and nothing
 * beside the round trip a TME is already waiting on.
 *
 * Returns null wherever there is no canvas to draw on, so the caller keeps the model's
 * boxes rather than discarding them on the strength of a check that never ran.
 */
export function sampleLuminance(source, maxEdge = 160) {
  if (typeof document === 'undefined' || !source) return null;
  try {
    const width = source.width ?? source.naturalWidth;
    const height = source.height ?? source.naturalHeight;
    if (!width || !height) return null;

    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0, w, h);
    const { data } = context.getImageData(0, 0, w, h);

    const grey = new Uint8ClampedArray(w * h);
    for (let i = 0; i < grey.length; i += 1) {
      const p = i * 4;
      grey[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
    }
    return { data: grey, width: w, height: h };
  } catch {
    // A tainted canvas or a browser that blocks readback is not a reason to reject boxes.
    return null;
  }
}
