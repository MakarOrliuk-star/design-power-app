import { Router } from "express";
import type { Request, Response } from "express";
import archiver from "archiver";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { itemPipelineReady } from "../env.js";
import {
  createWelcomeBatches,
  MAX_WELCOME_BRANDS,
  MAX_WELCOME_COUNT,
} from "../services/welcome.service.js";
import {
  nextDesNumber,
  packFolderOf,
  sanitizeName,
  splitBrandGender,
  toPngUrl,
  trailingIndexOf,
  uniqueEntryPath,
} from "../lib/packShared.js";

// Welcome packs page API (TASK welcome-packs, Phase 4). Mounted behind
// loadUser + requireAuth + requireZone("DESIGNER") — see index.ts. Mirrors
// routes/tournament.ts; the pack-editing surfaces live in welcomePack.ts
// (super-designer) and welcomeAdmin.ts (admin panel).
export const welcomeRouter: Router = Router();

// ---- Config: categories -> elements -> default prompt + my override ----

welcomeRouter.get("/config", async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const [categories, overrides] = await Promise.all([
    prisma.welcomeCategory.findMany({
      orderBy: { order: "asc" },
      select: {
        id: true,
        key: true,
        name: true,
        usesOwnReferences: true,
        order: true,
        elements: {
          where: { isActive: true },
          orderBy: [{ order: "asc" }, { name: "asc" }],
          select: {
            id: true,
            name: true,
            order: true,
            referenceImages: true,
            prompt: { select: { content: true, updatedAt: true } },
          },
        },
      },
    }),
    prisma.userWelcomePromptOverride.findMany({
      where: { userId },
      select: { elementId: true, content: true, baseUpdatedAt: true },
    }),
  ]);

  const overrideByElement = new Map(overrides.map((o) => [o.elementId, o]));

  res.json({
    categories: categories.map((c) => ({
      id: c.id,
      key: c.key,
      name: c.name,
      usesOwnReferences: c.usesOwnReferences,
      order: c.order,
      elements: c.elements.map((e) => {
        const o = overrideByElement.get(e.id);
        return {
          id: e.id,
          name: e.name,
          order: e.order,
          referenceImages: e.referenceImages,
          prompt: e.prompt
            ? { content: e.prompt.content, updatedAt: e.prompt.updatedAt.toISOString() }
            : null,
          override:
            o && e.prompt
              ? {
                  content: o.content,
                  // The default was touched AFTER the user's edit/ack -> the UI
                  // shows "default changed: keep mine / take new default".
                  defaultChanged: e.prompt.updatedAt.getTime() > o.baseUpdatedAt.getTime(),
                }
              : o
                ? { content: o.content, defaultChanged: false }
                : null,
        };
      }),
    })),
  });
});

// ---- Per-user prompt overrides (stored in the DB, live until reset) ----

/** The element's default prompt row — overrides require one. */
async function findDefaultPrompt(elementId: string) {
  return prisma.welcomePrompt.findUnique({
    where: { elementId },
    select: { updatedAt: true, content: true, element: { select: { isActive: true } } },
  });
}

const overridePutSchema = z.object({
  elementId: z.string().min(1),
  content: z.string().trim().min(1).max(5000),
});

welcomeRouter.put("/overrides", async (req: Request, res: Response) => {
  const parsed = overridePutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { elementId, content } = parsed.data;
  const userId = req.user!.sub;

  const def = await findDefaultPrompt(elementId);
  if (!def || !def.element.isActive) {
    res.status(404).json({ error: "prompt_not_found" });
    return;
  }

  // Editing implies the user saw the CURRENT default — snapshot its updatedAt
  // so the "default changed" banner only reappears on a future admin edit.
  const row = await prisma.userWelcomePromptOverride.upsert({
    where: { userId_elementId: { userId, elementId } },
    create: { userId, elementId, content, baseUpdatedAt: def.updatedAt },
    update: { content, baseUpdatedAt: def.updatedAt },
    select: { elementId: true, content: true },
  });
  res.json({ override: row });
});

const overrideKeySchema = z.object({ elementId: z.string().min(1) });

/** Reset to default: DELETE /overrides?elementId=.. */
welcomeRouter.delete("/overrides", async (req: Request, res: Response) => {
  const parsed = overrideKeySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const del = await prisma.userWelcomePromptOverride.deleteMany({
    where: { userId: req.user!.sub, elementId: parsed.data.elementId },
  });
  res.json({ ok: true, deleted: del.count });
});

/** "Keep mine" on the default-changed banner: re-snapshot baseUpdatedAt. */
welcomeRouter.post("/overrides/ack", async (req: Request, res: Response) => {
  const parsed = overrideKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const { elementId } = parsed.data;
  const userId = req.user!.sub;

  const def = await findDefaultPrompt(elementId);
  if (!def) {
    res.status(404).json({ error: "prompt_not_found" });
    return;
  }
  const upd = await prisma.userWelcomePromptOverride.updateMany({
    where: { userId, elementId },
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
  brandIds: z.array(z.string().min(1)).min(1).max(MAX_WELCOME_BRANDS),
  count: z.number().int().min(1).max(MAX_WELCOME_COUNT).default(1),
  aspect: z.enum(["1:1", "9:16"]).default("1:1"),
  selections: z.array(z.object({ elementId: z.string().min(1) })).min(1),
});

welcomeRouter.post("/generate", async (req: Request, res: Response) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  if (!itemPipelineReady) {
    res.status(503).json({ error: "welcome_pipeline_not_configured" });
    return;
  }
  try {
    const batches = await createWelcomeBatches({
      userId: req.user!.sub,
      brandIds: parsed.data.brandIds,
      count: parsed.data.count,
      aspect: parsed.data.aspect,
      selections: parsed.data.selections,
    });
    res.json({ batches });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    res.status(400).json({ error: msg });
  }
});

// ---- Welcome Pack (Result tab): batch history, newest first ----

const packsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  offset: z.coerce.number().int().min(0).default(0),
});

welcomeRouter.get("/packs", async (req: Request, res: Response) => {
  const parsed = packsSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { limit, offset } = parsed.data;
  const where = { userId: req.user!.sub, actionType: "WELCOME" as const };

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
            welCategoryKey: true,
            welElementName: true,
            welFileName: true,
          },
        },
      },
    }),
  ]);

  res.json({ batches, total, hasMore: offset + batches.length < total });
});

// ---- ZIP export (DES-1XXXXX.zip; a NEW DES number on every download) ----

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
welcomeRouter.get("/export.zip", async (req: Request, res: Response) => {
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
      actionType: "WELCOME",
      status: "DONE",
      generatedImageUrl: { not: null },
      welFileName: { not: null },
      ...(ids.length ? { id: { in: ids } } : { batchId: batchId! }),
    },
    orderBy: { createdAt: "asc" },
    take: MAX_EXPORT,
    select: {
      id: true,
      generatedImageUrl: true,
      brandName: true,
      welElementName: true,
      welFileName: true,
    },
  });
  if (rows.length === 0) {
    res.status(404).json({ error: "no_images" });
    return;
  }

  // A new sequential DES number is issued on EVERY download — the counter is
  // shared with the tournament export (one DES sequence for the whole app).
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
    console.error("Welcome ZIP export error:", err);
    res.destroy(err);
  });
  archive.pipe(res);

  // Folder layout (same as tournaments): {Brand}/{Element}_N[_gender].png —
  // brand folders right at the archive root; the (Men)/(Women) variants share
  // one folder, the gender becomes a file-name suffix.
  const used = new Set<string>();
  for (const r of rows) {
    // The client closed the connection (cancelled download / left the page) —
    // stop fetching images nobody will receive.
    if (res.destroyed) return;
    const fileName = r.welFileName!;
    const element = sanitizeName(r.welElementName ?? "") || packFolderOf(fileName);
    const { base, gender } = splitBrandGender(r.brandName);
    const brand = sanitizeName(base) || "Unknown";
    try {
      const resp = await fetch(toPngUrl(r.generatedImageUrl!));
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      const path = uniqueEntryPath(
        used,
        `${brand}/${element}_${trailingIndexOf(fileName)}${gender ? `_${gender}` : ""}.png`,
      );
      archive.append(buf, { name: path });
    } catch (err) {
      console.warn(`Welcome ZIP export: skipped ${r.id}`, err);
    }
  }

  await archive.finalize();
});
