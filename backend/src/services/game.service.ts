import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import sharp from "sharp";
import { prisma } from "../lib/prisma.js";
import { cloudinaryConfigured } from "../env.js";
import { uploadBuffer, withRetry } from "../lib/cloudinary.js";
import { listEntryPaths, extractAndProcess } from "../lib/smartico/zip.js";
import {
  assetNameOf,
  classifyEntry,
  isUsableEntry,
  MAX_ENTRIES,
  type GameLayer,
} from "../lib/gameZip.js";
import {
  DEFAULT_CANVAS,
  DEFAULT_TEMPLATE_KEY,
  DEFAULT_TEMPLATE_SPEC,
  parseTemplateSpec,
  type GameTemplateSpec,
} from "../lib/gameTemplate.js";
import {
  composeGameImage,
  normalizeOptions,
  type ComposeOptionsInput,
} from "../lib/gameCompose.js";
import type { GameAsset, GameAssetPack, GameComposition, GameTemplate } from "../../generated/prisma/client.js";

/**
 * Game manager service (TASK game-manager, Phase 2).
 *
 * Owns the three things the page does: take a designer's ZIP apart, glue a
 * background and a person onto the stencil, and keep the Results feed.
 */

const CLOUD_FOLDER = (userId: string) => `game/${userId}`;
/** Reading many images at once is memory-bound, not CPU-bound — keep it modest. */
const PARSE_CONCURRENCY = 4;

// ------------------------------------------------------------------
// Template (Q6 — a single stencil)
// ------------------------------------------------------------------

/**
 * The default stencil, created on first use rather than seeded: the seed is
 * create-only by contract, and a template that appears the moment the module is
 * first opened cannot drift out of sync with lib/gameTemplate.ts.
 */
export async function ensureDefaultTemplate(): Promise<GameTemplate> {
  const existing = await prisma.gameTemplate.findUnique({ where: { key: DEFAULT_TEMPLATE_KEY } });
  if (existing) return existing;
  return prisma.gameTemplate.create({
    data: {
      key: DEFAULT_TEMPLATE_KEY,
      name: "Game 9:16",
      canvasW: DEFAULT_CANVAS.width,
      canvasH: DEFAULT_CANVAS.height,
      spec: DEFAULT_TEMPLATE_SPEC as unknown as object,
    },
  });
}

export function specOf(template: GameTemplate): GameTemplateSpec {
  return parseTemplateSpec(template.spec);
}

// ------------------------------------------------------------------
// ZIP intake
// ------------------------------------------------------------------

export interface IngestResult {
  pack: GameAssetPack;
}

/**
 * Register the upload and start parsing it.
 *
 * The parse runs detached and reports through the pack row, which the page
 * polls: a 200 MB archive (Q12) takes minutes of Cloudinary round-trips, far
 * past any sane request timeout. It deliberately does NOT go through BullMQ —
 * that would tie the feature's correctness to the worker service being
 * redeployed, and an MVP that loses one upload to a restart is a better trade
 * than one that silently never parses. Moving it onto a queue later is a
 * drop-in: `parsePack` is already a standalone async function over ids.
 */
export async function ingestPack(
  userId: string,
  zipPath: string,
  filename: string,
): Promise<IngestResult> {
  // Q13: a new archive replaces the previous set.
  await prisma.gameAssetPack.updateMany({
    where: { userId, isActive: true },
    data: { isActive: false },
  });

  const pack = await prisma.gameAssetPack.create({
    data: { userId, filename, status: "PARSING" },
  });

  void parsePack(pack.id, userId, zipPath).catch(async (err) => {
    console.error(`Game pack ${pack.id} parse crashed:`, err);
    await prisma.gameAssetPack
      .update({ where: { id: pack.id }, data: { status: "FAILED", error: String(err) } })
      .catch(() => undefined);
  });

  return { pack };
}

export async function parsePack(packId: string, userId: string, zipPath: string): Promise<void> {
  try {
    const all = await listEntryPaths(zipPath);
    const usable = all.filter(isUsableEntry).slice(0, MAX_ENTRIES);

    if (!usable.length) {
      await prisma.gameAssetPack.update({
        where: { id: packId },
        data: { status: "FAILED", error: "no_images_in_archive", totalCount: 0 },
      });
      return;
    }

    await prisma.gameAssetPack.update({
      where: { id: packId },
      data: { totalCount: usable.length },
    });

    const seen = new Set<string>(); // Q13 dedup, in-process fast path
    let stored = 0;

    await extractAndProcess(zipPath, new Set(usable), PARSE_CONCURRENCY, async (path, buffer) => {
      const checksum = createHash("sha1").update(buffer).digest("hex");
      if (seen.has(checksum)) return;
      seen.add(checksum);

      const meta = await sharp(buffer).metadata().catch(() => null);
      if (!meta?.width || !meta.height) return; // not a decodable image after all

      const kind: GameLayer = await classifyEntry(path, buffer);
      const name = assetNameOf(path);
      const url = await storeAsset(userId, buffer, `${packId}_${checksum.slice(0, 12)}`);
      if (!url) return;

      await prisma.gameAsset.create({
        data: {
          packId,
          userId,
          kind,
          source: "UPLOAD",
          name,
          url,
          width: meta.width,
          height: meta.height,
          checksum,
        },
      });
      stored++;
      await prisma.gameAssetPack
        .update({ where: { id: packId }, data: { assetCount: stored } })
        .catch(() => undefined);
    });

    await prisma.gameAssetPack.update({
      where: { id: packId },
      data: {
        status: stored > 0 ? "READY" : "FAILED",
        error: stored > 0 ? null : "no_images_stored",
        assetCount: stored,
      },
    });
  } finally {
    // formidable wrote the upload to a temp file; it is ours to clean up.
    await unlink(zipPath).catch(() => undefined);
  }
}

/** Upload to Cloudinary. Returns null when the upload fails or is unconfigured. */
async function storeAsset(userId: string, buffer: Buffer, publicId: string): Promise<string | null> {
  if (!cloudinaryConfigured) {
    console.warn("Game: Cloudinary is not configured — asset dropped");
    return null;
  }
  const res = await withRetry(
    () => uploadBuffer(buffer, publicId, CLOUD_FOLDER(userId)),
    `game/${publicId}`,
  );
  return res.success ? (res.secure_url ?? null) : null;
}

// ------------------------------------------------------------------
// Composition
// ------------------------------------------------------------------

export interface ComposeRequest {
  backgroundAssetId?: string | null | undefined;
  personAssetId?: string | null | undefined;
  options?: ComposeOptionsInput | null | undefined;
}

export type ComposeOutcome =
  | { ok: true; composition: GameComposition }
  | { ok: false; error: "no_layers" | "asset_not_found" | "fetch_failed" | "upload_failed" };

async function fetchLayer(asset: GameAsset | null): Promise<Buffer | null> {
  if (!asset) return null;
  const res = await fetch(asset.url);
  if (!res.ok) throw new Error(`layer_fetch_failed:${asset.id}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Compose synchronously: sharp needs a few hundred milliseconds and the only
 * slow part is the Cloudinary round-trip, so a job queue would buy latency, not
 * throughput. The route still returns the finished row, which is what the
 * Results grid renders.
 */
export async function composeForUser(
  userId: string,
  req: ComposeRequest,
): Promise<ComposeOutcome> {
  const backgroundId = req.backgroundAssetId ?? null;
  const personId = req.personAssetId ?? null;
  if (!backgroundId && !personId) return { ok: false, error: "no_layers" };

  const assets = await prisma.gameAsset.findMany({
    where: { userId, id: { in: [backgroundId, personId].filter((v): v is string => !!v) } },
  });
  const background = assets.find((a) => a.id === backgroundId) ?? null;
  const person = assets.find((a) => a.id === personId) ?? null;
  if ((backgroundId && !background) || (personId && !person)) {
    return { ok: false, error: "asset_not_found" };
  }

  const template = await ensureDefaultTemplate();
  const options = normalizeOptions(req.options);

  let buffers: [Buffer | null, Buffer | null];
  try {
    buffers = await Promise.all([fetchLayer(background), fetchLayer(person)]);
  } catch (err) {
    console.error("Game compose: layer fetch failed:", err);
    return { ok: false, error: "fetch_failed" };
  }

  const { buffer } = await composeGameImage({
    spec: specOf(template),
    canvasW: template.canvasW,
    canvasH: template.canvasH,
    background: buffers[0],
    person: buffers[1],
    options,
  });

  const publicId = `composition_${Date.now()}_${createHash("sha1").update(buffer).digest("hex").slice(0, 10)}`;
  const url = await storeAsset(userId, buffer, publicId);
  if (!url) return { ok: false, error: "upload_failed" };

  const composition = await prisma.gameComposition.create({
    data: {
      userId,
      templateId: template.id,
      backgroundAssetId: background?.id ?? null,
      personAssetId: person?.id ?? null,
      options: options as unknown as object,
      url,
      status: "DONE",
    },
  });
  return { ok: true, composition };
}

// ------------------------------------------------------------------
// Results feed (Q15 persistent, Q16 clear = hide)
// ------------------------------------------------------------------

export function listResults(userId: string, limit = 200) {
  return prisma.gameComposition.findMany({
    where: { userId, isDeleted: false },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function clearResults(userId: string): Promise<number> {
  const res = await prisma.gameComposition.updateMany({
    where: { userId, isDeleted: false },
    data: { isDeleted: true },
  });
  return res.count;
}

// ------------------------------------------------------------------
// Page state — one call hydrates the whole screen
// ------------------------------------------------------------------

export async function loadState(userId: string) {
  const template = await ensureDefaultTemplate();
  const pack = await prisma.gameAssetPack.findFirst({
    where: { userId, isActive: true },
    orderBy: { createdAt: "desc" },
  });
  const assets = pack
    ? await prisma.gameAsset.findMany({
        where: { packId: pack.id },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const results = await listResults(userId);
  return { template, pack, assets, results };
}
