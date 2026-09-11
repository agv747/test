/**
 * Finding the price rows in a shelf photograph, and anchoring detections to them.
 *
 * Why this exists rather than using what the model reports:
 *
 * Asked for coordinates, gpt-4o returned a tidy lattice of identical rectangles twice over,
 * sitting well above the packs it had just read correctly. Checking those rectangles against
 * the pixels catches the case where they land on empty background, but not this one — a
 * cabinet photo has edges nearly everywhere, so a fabricated rectangle lands on *something*
 * and survives. The model reads text well and localises badly, and no amount of prompting
 * changed that. So its coordinates are no longer used to place anything.
 *
 * What the photograph itself offers is far more reliable. A Singapore tobacco cabinet is a
 * stack of shelves, and every shelf carries a rail of small printed price tickets: a thin
 * horizontal band, densely packed with vertical strokes, repeated across the width. That is
 * a shape a projection can find without recognising anything.
 *
 * The model still decides WHAT was read and in what order; the image decides WHERE each row
 * sits. Neither is asked to do the other's job.
 */

const EDGE_STEP = 26;

/**
 * Per-row density of vertical strokes, the signature of a line of print.
 *
 * Horizontal gradients only: a shelf edge or the top of a pack is a long horizontal line and
 * would swamp a full gradient, while the digits on a price ticket are vertical strokes.
 *
 * @param {{data: Uint8ClampedArray|number[], width: number, height: number}} luma
 * @returns {number[]} one value per image row, 0–1
 */
export function rowStrokeProfile(luma) {
  const { data, width, height } = luma ?? {};
  if (!width || !height) return [];

  const profile = new Array(height).fill(0);
  for (let y = 0; y < height; y += 1) {
    let hits = 0;
    for (let x = 0; x < width - 1; x += 1) {
      if (Math.abs(data[y * width + x + 1] - data[y * width + x]) > EDGE_STEP) hits += 1;
    }
    profile[y] = hits / (width - 1);
  }
  return profile;
}

/** Moving average, used both to smooth the profile and to model its slowly varying floor. */
export function smooth(values, radius) {
  if (radius < 1) return values.slice();
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    let total = 0;
    let count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j += 1) {
      total += values[j];
      count += 1;
    }
    out[i] = total / count;
  }
  return out;
}

/**
 * Topographic prominence: how far a peak stands above the lowest point separating it from
 * anything higher.
 *
 * This is what distinguishes a rail from the edge of a packshot band. A rail is a spike with
 * empty shelf either side, so it falls away on both. The leading edge of a band of packs
 * looks like a peak locally, but the band continues at the same level behind it — that
 * plateau is its own surroundings, and its prominence is nearly nothing.
 */
export function prominence(profile, index) {
  const peak = profile[index];

  let leftFloor = peak;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (profile[i] > peak) break;
    if (profile[i] < leftFloor) leftFloor = profile[i];
  }

  let rightFloor = peak;
  for (let i = index + 1; i < profile.length; i += 1) {
    if (profile[i] > peak) break;
    if (profile[i] < rightFloor) rightFloor = profile[i];
  }

  return peak - Math.max(leftFloor, rightFloor);
}

/**
 * Locates the price rails: thin rows of print standing clear of their surroundings.
 *
 * The cut is relative to the strongest rail found as well as absolute, so a dim photograph
 * is judged against itself rather than against a studio shot, and a photograph with nothing
 * rail-like in it yields nothing rather than the least-flat row it can find.
 *
 * @returns {{y: number, strength: number}[]} rail centres as fractions of image height,
 *          ordered top to bottom
 */
export function detectPriceRows(luma, options = {}) {
  const { minSeparation = 0.04, minProminence = 0.03, relative = 0.25, maxRows = 12 } = options;
  const height = luma?.height ?? 0;
  if (height < 20) return [];

  const profile = smooth(rowStrokeProfile(luma), Math.max(1, Math.round(height * 0.006)));

  const candidates = [];
  for (let y = 1; y < height - 1; y += 1) {
    if (profile[y] < profile[y - 1] || profile[y] < profile[y + 1]) continue;
    const strength = prominence(profile, y);
    if (strength >= minProminence) candidates.push({ row: y, strength });
  }
  if (!candidates.length) return [];

  const best = Math.max(...candidates.map((c) => c.strength));
  const cut = Math.max(minProminence, best * relative);
  const gap = Math.max(2, Math.round(height * minSeparation));

  const peaks = [];
  for (const candidate of candidates.filter((c) => c.strength >= cut).sort((a, b) => b.strength - a.strength)) {
    // Strongest first, so one rail yields one row however wide its own spike is.
    if (peaks.some((p) => Math.abs(p.row - candidate.row) < gap)) continue;
    peaks.push(candidate);
    if (peaks.length >= maxRows) break;
  }

  return peaks
    .sort((a, b) => a.row - b.row)
    .map((p) => ({
      y: Math.round((p.row / height) * 1000) / 1000,
      strength: Math.round(p.strength * 1000) / 1000,
    }));
}

/**
 * Keeps the largest run of near-evenly-spaced rows, and drops the rest.
 *
 * Shelves are evenly spaced and so are the lines of a printed price list; the clutter around
 * them is not. On a real demo photograph this is what separates the six price lines from the
 * shop name, the "SMOKING KILLS" band and the row of pack labels above them — all of which
 * are lines of print, and all of which would otherwise be offered as places to put a price.
 *
 * A gap in the run is allowed, since a rail can be obscured, but not so many that any set of
 * rows could be fitted to some progression: at most half the slots may be empty.
 */
export function evenlySpacedRows(rows, options = {}) {
  const { tolerance = 0.3, minRun = 3, minSpacing = 0.04 } = options;
  if (rows.length < minRun) return rows;

  let best = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const step = rows[j].y - rows[i].y;
      if (step < minSpacing) continue;

      const run = [rows[i]];
      let last = rows[i].y;
      for (const row of rows.slice(i + 1)) {
        const steps = Math.round((row.y - last) / step);
        if (steps >= 1 && Math.abs(row.y - (last + steps * step)) <= tolerance * step) {
          run.push(row);
          last = row.y;
        }
      }

      const slots = (run.at(-1).y - run[0].y) / step + 1;
      if (run.length >= minRun && slots <= run.length * 2 && run.length > best.length) best = run;
    }
  }
  return best.length ? best : rows;
}

/* --------------------------------------------------------------- anchoring */

/**
 * Groups consecutive detections that share a price.
 *
 * One shelf rail carries one price across several facings, and a model reading such a shelf
 * reports that price once per facing. Consecutive runs of equal price are therefore the best
 * available proxy for "these belong to the same rail" — and it needs no coordinates.
 */
export function groupByPrice(detections) {
  const groups = [];
  for (const detection of detections) {
    const price = detection.confirmed_price ?? detection.detected_price ?? null;
    const last = groups.at(-1);
    if (last && last.price === price) last.items.push(detection);
    else groups.push({ price, items: [detection] });
  }
  return groups;
}

/**
 * Places each detection at a point on the photograph, above the price it was read from.
 *
 * Rows found in the image are used in reading order: the model is told to report top to
 * bottom, so the first price group belongs to the topmost rail. When there are fewer rows
 * than groups — or no rows at all — the groups are spread evenly down the image instead, and
 * marked as such so the screen can say the placement is only approximate.
 *
 * Two kinds of position are left alone: one the TME placed by hand, and a rectangle from a
 * provider that genuinely locates things (a shelf-recognition service, say). The vision
 * models are not in that category and no longer report coordinates at all.
 *
 * @returns {object[]} detections with `bounding_box` set to `{x, y, source}`
 */
export function anchorDetections(detections, rows = []) {
  const groups = groupByPrice(detections ?? []);
  if (!groups.length) return detections ?? [];

  const usable = rows.length >= groups.length ? rows.slice(0, groups.length) : null;
  const source = usable ? 'row' : 'band';

  const placed = [];
  groups.forEach((group, groupIndex) => {
    const y = usable
      ? usable[groupIndex].y
      : (groupIndex + 0.5) / groups.length;

    group.items.forEach((detection, i) => {
      const kept = detection.bounding_box?.source;
      if (kept === 'manual' || kept === 'model') {
        placed.push(detection);
        return;
      }

      // Facings share a rail, so they are spread across its width in the order read. A rail
      // with a single price would put every label on the centre line, where neighbouring
      // rows are closer together than a label is tall and they cover each other — so those
      // alternate side to side instead.
      const x =
        group.items.length === 1
          ? (groupIndex % 2 === 0 ? 0.3 : 0.7)
          : (i + 0.5) / group.items.length;
      placed.push({
        ...detection,
        bounding_box: {
          x: Math.round(Math.min(0.9, Math.max(0.1, x)) * 1000) / 1000,
          y: Math.round(Math.min(0.98, Math.max(0.02, y)) * 1000) / 1000,
          source,
        },
      });
    });
  });
  return placed;
}

/**
 * The point a marker should aim at.
 *
 * Providers that genuinely locate things return a rectangle; everything here returns a
 * point. A rectangle is aimed at from the middle of its top edge, which is where a label
 * sitting above it would point.
 */
export function anchorOf(box) {
  if (!box) return null;
  if (Number.isFinite(box.w) && Number.isFinite(box.h)) {
    return { x: box.x + box.w / 2, y: box.y, source: box.source };
  }
  return { x: box.x, y: box.y, source: box.source };
}
