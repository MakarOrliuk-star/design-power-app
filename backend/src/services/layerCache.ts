import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { runBriaRemoveBg } from "../lib/fal.js";
import { uploadBuffer, withRetry } from "../lib/cloudinary.js";
import { hasUsefulAlpha, normalizeLayer } from "../lib/layerNormalize.js";

/**
 * Normalized-layer cache (TASK email-composition, Phase 2; R-PLAN §4).
 * source image → sha256 → NormalizedLayer row + Cloudinary asset with a
 * DETERMINISTIC public id (layer_<hash>): re-running stage A on the same
 * source skips background removal, normalization and upload; regenerating one
 * asset never rebuilds the other layers. Background removal runs only when
 * the source has no useful alpha (nano-banana never has; the check makes the
 * pipeline provider-proof per TASK §3.3).
 */

export const LAYER_FOLDER = "layers";

export function sourceHashOf(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export async function fetchBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

export type LayerResult =
  | {
      ok: true;
      hash: string;
      publicId: string;
      url: string;
      width: number;
      height: number;
      cached: boolean;
    }
  | { ok: false; reason: string };

export async function getOrCreateNormalizedLayer(
  sourceUrl: string,
  label: string,
): Promise<LayerResult> {
  const src = await fetchBuffer(sourceUrl);
  if (!src) return { ok: false, reason: "source download failed" };
  const hash = sourceHashOf(src);

  const hit = await prisma.normalizedLayer.findUnique({ where: { sourceHash: hash } });
  if (hit) {
    console.log(`🧩 layer ${label}: hash=${hash.slice(0, 12)} bbox=${hit.width}×${hit.height} cache=hit`);
    return {
      ok: true,
      hash,
      publicId: hit.publicId,
      url: hit.url,
      width: hit.width,
      height: hit.height,
      cached: true,
    };
  }

  // Transparent already? (future providers) → normalize directly; otherwise
  // cut the background first (the штатный fallback, A1/DI-Q13).
  let cutout = src;
  if (!(await hasUsefulAlpha(src))) {
    const br = await runBriaRemoveBg(sourceUrl);
    if (!br.success || !br.imageUrl) {
      return { ok: false, reason: `background removal: ${br.error ?? "unknown"}` };
    }
    const cut = await fetchBuffer(br.imageUrl);
    if (!cut) return { ok: false, reason: "cutout download failed" };
    cutout = cut;
  }

  const norm = await normalizeLayer(cutout);
  if (!norm.ok) return { ok: false, reason: norm.reason };

  const publicId = `layer_${hash.slice(0, 20)}`;
  const up = await withRetry(() => uploadBuffer(norm.png, publicId, LAYER_FOLDER), `layer#${label}`);
  if (!up.success || !up.secure_url || !up.public_id) {
    return { ok: false, reason: `layer upload: ${up.error ?? "unknown"}` };
  }

  // upsert (create-only): a concurrent worker that lost the race just reuses
  // the row — both uploaded the same bytes to the same public id.
  const row = await prisma.normalizedLayer.upsert({
    where: { sourceHash: hash },
    create: {
      sourceHash: hash,
      publicId: up.public_id,
      url: up.secure_url,
      width: norm.width,
      height: norm.height,
    },
    update: {},
  });
  console.log(
    `🧩 layer ${label}: hash=${hash.slice(0, 12)} bbox=${norm.width}×${norm.height} ` +
      `opaque=${(norm.opaqueRatio * 100).toFixed(0)}% cache=miss`,
  );
  return {
    ok: true,
    hash,
    publicId: row.publicId,
    url: row.url,
    width: row.width,
    height: row.height,
    cached: false,
  };
}
