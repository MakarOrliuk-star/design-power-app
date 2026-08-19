import { Router } from "express";
import type { Request, Response } from "express";
import archiver from "archiver";
import formidable from "formidable";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { MAX_ZIP_BYTES } from "../lib/gameZip.js";
import {
  BLUR_SIGMA_MAX,
  BLUR_SIGMA_MIN,
  SCALE_MAX,
  SCALE_MIN,
} from "../lib/gameCompose.js";
import {
  clearResults,
  composeForUser,
  ingestPack,
  listResults,
  loadState,
} from "../services/game.service.js";

/**
 * Game manager API (TASK game-manager, Phase 2).
 *
 * Mounted at /api/game behind loadUser + requireAuth + requireGameZone — see
 * index.ts, where it has to sit ABOVE the catch-all /api mount or the Design
 * zone guard would claim these paths first.
 */
export const gameRouter: Router = Router();

const userIdOf = (req: Request): string => req.user!.sub;

// ---- Page state -----------------------------------------------------------

/** One call hydrates the whole screen: stencil, current pack, assets, results. */
gameRouter.get("/state", async (req: Request, res: Response) => {
  res.json(await loadState(userIdOf(req)));
});

// ---- Asset packs (the designer's ZIP) -------------------------------------

/**
 * Accepts one ZIP and answers immediately with the pack row: parsing runs in
 * the background (see services/game.service.ts) and the client polls
 * GET /packs/:id until it leaves PARSING.
 */
gameRouter.post("/packs", async (req: Request, res: Response) => {
  const form = formidable({
    keepExtensions: true,
    maxFiles: 1,
    maxFileSize: MAX_ZIP_BYTES,
  });

  let tempPath: string | null = null;
  try {
    const [, files] = await form.parse(req);
    const file = Object.values(files).flat().find((f): f is formidable.File => Boolean(f));
    if (!file) {
      res.status(400).json({ error: "no_file", hint: "ожидается ZIP-архив" });
      return;
    }
    tempPath = file.filepath;

    const name = file.originalFilename ?? "pack.zip";
    if (!name.toLowerCase().endsWith(".zip")) {
      res.status(400).json({ error: "not_a_zip", hint: "принимается только .zip" });
      return;
    }

    const { pack } = await ingestPack(userIdOf(req), file.filepath, name);
    tempPath = null; // ownership moved to the parser, which unlinks it
    res.status(202).json({ pack });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // formidable words its own limit errors — pass them through, otherwise a
    // 200 MB rejection reads as "something went wrong".
    res.status(400).json({ error: "upload_failed", details: message });
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => undefined);
  }
});

gameRouter.get("/packs/:id", async (req: Request, res: Response) => {
  const pack = await prisma.gameAssetPack.findFirst({
    where: { id: String(req.params.id ?? ""), userId: userIdOf(req) },
  });
  if (!pack) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const assets = await prisma.gameAsset.findMany({
    where: { packId: pack.id },
    orderBy: { createdAt: "asc" },
  });
  res.json({ pack, assets });
});

// ---- Composition ----------------------------------------------------------

const composeSchema = z.object({
  backgroundAssetId: z.string().min(1).nullable().optional(),
  personAssetId: z.string().min(1).nullable().optional(),
  options: z
    .object({
      blur: z.boolean().optional(),
      blurSigma: z.number().min(BLUR_SIGMA_MIN).max(BLUR_SIGMA_MAX).optional(),
      scale: z.number().min(SCALE_MIN).max(SCALE_MAX).optional(),
    })
    .optional(),
});

const COMPOSE_ERRORS: Record<string, { status: number; hint: string }> = {
  no_layers: { status: 400, hint: "нужен хотя бы один слой — фон или персонаж" },
  asset_not_found: { status: 404, hint: "ассет не найден или принадлежит другому пользователю" },
  fetch_failed: { status: 502, hint: "не удалось скачать слой из хранилища" },
  upload_failed: { status: 502, hint: "не удалось загрузить результат в Cloudinary" },
};

gameRouter.post("/compose", async (req: Request, res: Response) => {
  const parsed = composeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const result = await composeForUser(userIdOf(req), parsed.data);
  if (!result.ok) {
    const mapped = COMPOSE_ERRORS[result.error] ?? { status: 500, hint: "" };
    res.status(mapped.status).json({ error: result.error, hint: mapped.hint });
    return;
  }
  res.status(201).json({ composition: result.composition });
});

// ---- Neural generation — Q18: contract now, pipeline later ----------------

/**
 * Deliberate 501s. The response shape is the one the real endpoints will use,
 * so switching them on is a backend-only change: the page already handles
 * `{ error, message }` and shows the message verbatim.
 */
function notImplemented(res: Response, what: string): void {
  res.status(501).json({
    error: "not_implemented",
    message: `Генерация «${what}» скоро появится.`,
  });
}

gameRouter.post("/generate/background", (_req: Request, res: Response) =>
  notImplemented(res, "Background"),
);
gameRouter.post("/generate/person", (_req: Request, res: Response) =>
  notImplemented(res, "Item"),
);

// ---- Results --------------------------------------------------------------

gameRouter.get("/results", async (req: Request, res: Response) => {
  res.json({ results: await listResults(userIdOf(req)) });
});

/** Q16: hides the feed, keeps the files. */
gameRouter.delete("/results", async (req: Request, res: Response) => {
  res.json({ cleared: await clearResults(userIdOf(req)) });
});

gameRouter.get("/results/export.zip", async (req: Request, res: Response) => {
  const rows = (await listResults(userIdOf(req))).filter((r) => r.url);
  if (!rows.length) {
    res.status(404).json({ error: "nothing_to_export" });
    return;
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="game-results.zip"`);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    console.error("Game ZIP export error:", err);
    res.destroy(err);
  });
  archive.pipe(res);

  let index = 1;
  for (const row of rows) {
    // The client cancelled the download — stop fetching images nobody wants.
    if (res.destroyed) return;
    try {
      const resp = await fetch(row.url!);
      if (!resp.ok) continue;
      archive.append(Buffer.from(await resp.arrayBuffer()), {
        name: `game_${String(index).padStart(3, "0")}.png`,
      });
      index++;
    } catch (err) {
      console.warn(`Game ZIP export: skipped ${row.id}`, err);
    }
  }

  await archive.finalize();
});
