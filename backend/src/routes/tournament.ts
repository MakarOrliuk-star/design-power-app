import { Router } from "express";
import type { Request, Response } from "express";
import archiver from "archiver";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { itemPipelineReady } from "../env.js";
import {
  createTournamentBatches,
  nextDesNumber,
  MAX_TOURNAMENT_BRANDS,
  MAX_TOURNAMENT_COUNT,
} from "../services/tournament.service.js";

// Tournaments page API (Phase 3). Mounted behind loadUser + requireAuth +
// requireZone("DESIGNER") — see index.ts.
export const tournamentRouter: Router = Router();

const MODES = ["BASE", "VIP"] as const;
type Mode = (typeof MODES)[number];

// ---- Config: categories -> elements -> default prompts + my overrides ----

tournamentRouter.get("/config", async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const [categories, overrides] = await Promise.all([
    prisma.tournamentCategory.findMany({
      orderBy: { order: "asc" },
      select: {
        id: true,
        key: true,
        name: true,
        hasModes: true,
        fixedMode: true,
        order: true,
        elements: {
          where: { isActive: true },
          orderBy: [{ order: "asc" }, { name: "asc" }],
          select: {
            id: true,
            name: true,
            order: true,
            referenceImages: true,
            prompts: { select: { mode: true, content: true, updatedAt: true } },
          },
        },
      },
    }),
    prisma.userTournamentPromptOverride.findMany({
      where: { userId },
      select: { elementId: true, mode: true, content: true, baseUpdatedAt: true },
    }),
  ]);

  const overrideByKey = new Map(overrides.map((o) => [`${o.elementId}:${o.mode}`, o]));

  res.json({
    categories: categories.map((c) => ({
      id: c.id,
      key: c.key,
      name: c.name,
      hasModes: c.hasModes,
      fixedMode: c.fixedMode,
      order: c.order,
      elements: c.elements.map((e) => {
        const prompts: Partial<Record<Mode, { content: string; updatedAt: string }>> = {};
        const ovr: Partial<Record<Mode, { content: string; defaultChanged: boolean }>> = {};
        for (const p of e.prompts) {
          prompts[p.mode] = { content: p.content, updatedAt: p.updatedAt.toISOString() };
          const o = overrideByKey.get(`${e.id}:${p.mode}`);
          if (o) {
            ovr[p.mode] = {
              content: o.content,
              // The admin touched the default AFTER the user's edit/ack ->
              // the UI shows "default changed: keep mine / take new default".
              defaultChanged: p.updatedAt.getTime() > o.baseUpdatedAt.getTime(),
            };
          }
        }
        return {
          id: e.id,
          name: e.name,
          order: e.order,
          referenceImages: e.referenceImages,
          prompts,
          overrides: ovr,
        };
      }),
    })),
  });
});

// ---- Per-user prompt overrides (Phase 0: stored in DB, live until reset) ----

/** The element's default prompt row for a mode — overrides require one. */
async function findDefaultPrompt(elementId: string, mode: Mode) {
  return prisma.tournamentPrompt.findUnique({
    where: { elementId_mode: { elementId, mode } },
    select: { updatedAt: true, content: true, element: { select: { isActive: true } } },
  });
}

const overridePutSchema = z.object({
  elementId: z.string().min(1),
  mode: z.enum(MODES),
  content: z.string().trim().min(1).max(5000),
});

tournamentRouter.put("/overrides", async (req: Request, res: Response) => {
  const parsed = overridePutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { elementId, mode, content } = parsed.data;
  const userId = req.user!.sub;

  const def = await findDefaultPrompt(elementId, mode);
  if (!def || !def.element.isActive) {
    res.status(404).json({ error: "prompt_not_found" });
    return;
  }

  // Editing implies the user saw the CURRENT default — snapshot its updatedAt
  // so the "default changed" banner only reappears on a future admin edit.
  const row = await prisma.userTournamentPromptOverride.upsert({
    where: { userId_elementId_mode: { userId, elementId, mode } },
    create: { userId, elementId, mode, content, baseUpdatedAt: def.updatedAt },
    update: { content, baseUpdatedAt: def.updatedAt },
    select: { elementId: true, mode: true, content: true },
  });
  res.json({ override: row });
});

const overrideKeySchema = z.object({
  elementId: z.string().min(1),
  mode: z.enum(MODES),
});

/** Reset to default: DELETE /overrides?elementId=..&mode=BASE */
tournamentRouter.delete("/overrides", async (req: Request, res: Response) => {
  const parsed = overrideKeySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { elementId, mode } = parsed.data;
  const del = await prisma.userTournamentPromptOverride.deleteMany({
    where: { userId: req.user!.sub, elementId, mode },
  });
  res.json({ ok: true, deleted: del.count });
});

/** "Keep mine" on the default-changed banner: re-snapshot baseUpdatedAt. */
tournamentRouter.post("/overrides/ack", async (req: Request, res: Response) => {
  const parsed = overrideKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const { elementId, mode } = parsed.data;
  const userId = req.user!.sub;

  const def = await findDefaultPrompt(elementId, mode);
  if (!def) {
    res.status(404).json({ error: "prompt_not_found" });
    return;
  }
  const upd = await prisma.userTournamentPromptOverride.updateMany({
    where: { userId, elementId, mode },
    data: { baseUpdatedAt: def.updatedAt },
  });
  if (upd.count === 0) {
    res.status(404).json({ error: "override_not_found" });
    return;
  }
  res.json({ ok: true });
});

// ---- Generate: one batch per selected category ----

const generateSchema = z.object({
  brandIds: z.array(z.string().min(1)).min(1).max(MAX_TOURNAMENT_BRANDS),
  count: z.number().int().min(1).max(MAX_TOURNAMENT_COUNT).default(1),
  selections: z
    .array(z.object({ elementId: z.string().min(1), mode: z.enum(MODES).optional() }))
    .min(1),
});

tournamentRouter.post("/generate", async (req: Request, res: Response) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  if (!itemPipelineReady) {
    res.status(503).json({ error: "tournament_pipeline_not_configured" });
    return;
  }
  try {
    const batches = await createTournamentBatches({
      userId: req.user!.sub,
      brandIds: parsed.data.brandIds,
      count: parsed.data.count,
      selections: parsed.data.selections,
    });
    res.json({ batches });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    res.status(400).json({ error: msg });
  }
});

// ---- Tournament Pack (Result tab): batch history, newest first ----

const packsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  offset: z.coerce.number().int().min(0).default(0),
});

tournamentRouter.get("/packs", async (req: Request, res: Response) => {
  const parsed = packsSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { limit, offset } = parsed.data;
  const where = { userId: req.user!.sub, actionType: "TOURNAMENT" as const };

  const [total, batches] = await Promise.all([
    prisma.batch.count({ where }),
    prisma.batch.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
      select: {
        id: true,
        status: true,
        createdAt: true,
        generations: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            status: true,
            statusMessage: true,
            generatedImageUrl: true,
            brandName: true,
            tourCategoryKey: true,
            tourElementName: true,
            tourMode: true,
            tourFileName: true,
          },
        },
      },
    }),
  ]);

  res.json({ batches, total, hasMore: offset + batches.length < total });
});

// ---- ZIP export (DES-1XXXXX.zip; a NEW DES number on every download) ----

/** Force a PNG delivery URL (spec: files in the ZIP are .png). */
export function toPngUrl(url: string): string {
  if (/\.png(\?|$)/i.test(url)) return url;
  // Cloudinary: an f_png transformation converts on the fly.
  if (url.includes("/upload/")) return url.replace("/upload/", "/upload/f_png/");
  return url;
}

/** "Bonuskong_Tournament_1_2" -> its pack folder "Bonuskong_Tournament_1". */
export function packFolderOf(fileName: string): string {
  return fileName.replace(/_\d+$/, "");
}

/** Collision-free archive path: appends "-2", "-3"... before the extension. */
export function uniqueEntryPath(used: Set<string>, path: string): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const m = /^(.*)(\.[a-z0-9]+)$/i.exec(path);
  const stem = m ? m[1]! : path;
  const ext = m ? m[2]! : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

const exportSchema = z.object({
  batchId: z.string().min(1).optional(),
  ids: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : [])),
});
const MAX_EXPORT = 500; // safety cap on a single archive

// GET so the browser downloads it via same-origin navigation (session cookie
// rides along through the frontend proxy) — same pattern as the Archive export.
tournamentRouter.get("/export.zip", async (req: Request, res: Response) => {
  const parsed = exportSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { batchId, ids } = parsed.data;
  if (!batchId && ids.length === 0) {
    res.status(400).json({ error: "no_target" });
    return;
  }
  const userId = req.user!.sub;

  const rows = await prisma.generation.findMany({
    where: {
      userId,
      actionType: "TOURNAMENT",
      status: "DONE",
      generatedImageUrl: { not: null },
      tourFileName: { not: null },
      ...(ids.length ? { id: { in: ids } } : { batchId: batchId! }),
    },
    orderBy: { createdAt: "asc" },
    take: MAX_EXPORT,
    select: { id: true, generatedImageUrl: true, tourCategoryKey: true, tourFileName: true },
  });
  if (rows.length === 0) {
    res.status(404).json({ error: "no_images" });
    return;
  }

  // A new sequential DES number is issued on EVERY download (Phase 0 decision).
  const desNumber = await nextDesNumber();
  await prisma.zipExport.create({
    data: {
      desNumber,
      userId,
      batchId: ids.length ? null : (batchId ?? null),
      imageIds: rows.map((r) => r.id),
    },
  });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="DES-${desNumber}.zip"`);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    console.error("Tournament ZIP export error:", err);
    res.destroy(err);
  });
  archive.pipe(res);

  // Folder layout (spec): {category}/{Brand_Element}/{Brand_Element_N}.png.
  // Categories with no images simply never appear (Phase 0: no empty folders).
  const used = new Set<string>();
  for (const r of rows) {
    const fileName = r.tourFileName!;
    const category = r.tourCategoryKey ?? "tournament";
    try {
      const resp = await fetch(toPngUrl(r.generatedImageUrl!));
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      const path = uniqueEntryPath(used, `${category}/${packFolderOf(fileName)}/${fileName}.png`);
      archive.append(buf, { name: path });
    } catch (err) {
      console.warn(`Tournament ZIP export: skipped ${r.id}`, err);
    }
  }

  await archive.finalize();
});
