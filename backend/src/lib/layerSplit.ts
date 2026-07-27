import sharp from "sharp";
import { ALPHA_NOISE_THRESHOLD } from "./layerNormalize.js";

/**
 * Item splitting (TASK email-composition, эталоны push/pop-up): the ITEM
 * generation returns SEVERAL distinct objects (letters, banknotes, coins) on
 * one transparent layer. The reference banners place them as separate props
 * scattered around the character, so the compositor needs them as separate
 * layers — this module cuts the layer into its connected alpha blobs.
 *
 * Pure buffer→buffers, no network, deterministic: same input bytes → same
 * pieces in the same order (largest first), same encoded PNG bytes.
 */

/** Pixels below this alpha are holes, not subject (same gate as normalize). */
const ALPHA_ON = ALPHA_NOISE_THRESHOLD;
/** A blob smaller than this share of the LARGEST blob is cutout debris. */
export const MIN_PIECE_RATIO = 0.02;
/** …and anything under this many pixels can never be a usable prop. */
export const MIN_PIECE_PX = 24 * 24;
/** Safety cap — a shredded cutout must not spawn hundreds of layers. */
export const MAX_PIECES = 24;

export interface LayerPiece {
  png: Buffer;
  width: number;
  height: number;
  /** Opaque pixel count — the sort key (largest piece is the "hero" object). */
  area: number;
}

const PNG_OPTS = { compressionLevel: 9, adaptiveFiltering: false, palette: false } as const;

/**
 * Split a normalized transparent layer into its connected components.
 * Returns pieces sorted by area, largest first; a layer holding a single
 * object yields exactly one piece (the caller can then treat it as before).
 */
export async function splitLayerPieces(
  input: Buffer,
  opts: { maxPieces?: number; minPieceRatio?: number } = {},
): Promise<LayerPiece[]> {
  const maxPieces = opts.maxPieces ?? MAX_PIECES;
  const minRatio = opts.minPieceRatio ?? MIN_PIECE_RATIO;
  if (maxPieces <= 0) return [];

  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const n = W * H;
  if (n === 0) return [];

  // 8-connected labeling with an explicit stack (recursion would blow up on a
  // full-canvas blob) — labels are 1-based, 0 means background.
  const labels = new Int32Array(n);
  const blobs: Array<{ label: number; x0: number; y0: number; x1: number; y1: number; area: number }> =
    [];
  const stack: number[] = [];
  let next = 0;
  for (let start = 0; start < n; start++) {
    if (labels[start] !== 0 || data[start * 4 + 3]! < ALPHA_ON) continue;
    next += 1;
    let x0 = W;
    let y0 = H;
    let x1 = 0;
    let y1 = 0;
    let area = 0;
    stack.push(start);
    labels[start] = next;
    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % W;
      const y = (p - x) / W;
      area += 1;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          const q = ny * W + nx;
          if (labels[q] === 0 && data[q * 4 + 3]! >= ALPHA_ON) {
            labels[q] = next;
            stack.push(q);
          }
        }
      }
    }
    blobs.push({ label: next, x0, y0, x1, y1, area });
  }
  if (blobs.length === 0) return [];

  blobs.sort((a, b) => b.area - a.area || a.x0 - b.x0 || a.y0 - b.y0);
  const largest = blobs[0]!.area;
  const kept = blobs
    .filter((b) => b.area >= Math.max(MIN_PIECE_PX, largest * minRatio))
    .slice(0, maxPieces);

  const pieces: LayerPiece[] = [];
  for (const b of kept) {
    const w = b.x1 - b.x0 + 1;
    const h = b.y1 - b.y0 + 1;
    // Copy the bbox, blanking every pixel that belongs to a NEIGHBOURING blob —
    // otherwise a prop overlapping another one's bounding box drags it along.
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const src = (b.y0 + y) * W + (b.x0 + x);
        const dst = (y * w + x) * 4;
        if (labels[src] !== b.label) continue;
        out[dst] = data[src * 4]!;
        out[dst + 1] = data[src * 4 + 1]!;
        out[dst + 2] = data[src * 4 + 2]!;
        out[dst + 3] = data[src * 4 + 3]!;
      }
    }
    const png = await sharp(out, { raw: { width: w, height: h, channels: 4 } })
      .png(PNG_OPTS)
      .toBuffer();
    pieces.push({ png, width: w, height: h, area: b.area });
  }
  return pieces;
}
