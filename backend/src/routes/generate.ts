import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { personPipelineReady, itemPipelineReady } from "../env.js";
import { uploadBase64, withRetry } from "../lib/cloudinary.js";
import { createPersonBatch, createItemBatch } from "../services/generation.service.js";
import { recomputeBatchStatus } from "../services/finalize.js";

// Mounted behind loadUser + requireAuth (see index.ts).
export const generateRouter: Router = Router();

const generateSchema = z.object({
  contentType: z.enum(["PERSON", "ITEM"]),
  brandIds: z.array(z.string()).default([]), // Person targets (brand IDs)
  styles: z.array(z.string()).default([]), // Item targets (style names)
  themeId: z.string().optional(), // theme removed from the core flow (optional metadata)
  refMode: z.enum(["ALL", "EACH"]).default("ALL"),
  prompt: z.string().default(""),
  perBrandPrompts: z.record(z.string()).default({}), // keyed by brandId (Person) or style (Item)
  imageCount: z.number().int().min(1).max(4).default(1),
  referenceImages: z.array(z.string()).default([]), // base64 data URLs (Person ALL global)
  perBrandRefs: z.record(z.array(z.string())).default({}), // base64 per brandId (Person EACH)
  perBrandCounts: z.record(z.number().int().min(1).max(4)).default({}), // per brandId (Person EACH)
  aspectRatio: z.string().default("1:1"), // fal aspect_ratio (Person ALL global)
  perBrandAspect: z.record(z.string()).default({}), // fal aspect_ratio per brandId (Person EACH)
});

// ---- Run ----
generateRouter.post("/generate", async (req: Request, res: Response) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const d = parsed.data;
  const userId = req.user!.sub;

  if (d.contentType === "PERSON" && !personPipelineReady) {
    res.status(503).json({ error: "person_pipeline_not_configured" });
    return;
  }
  if (d.contentType === "ITEM" && !itemPipelineReady) {
    res.status(503).json({ error: "item_pipeline_not_configured" });
    return;
  }

  if (d.contentType === "PERSON" && d.brandIds.length === 0) {
    res.status(400).json({ error: "no_brands" });
    return;
  }
  if (d.contentType === "ITEM" && d.styles.length === 0) {
    res.status(400).json({ error: "no_styles" });
    return;
  }

  // Theme is optional metadata now — look it up only if supplied.
  let themeName = "";
  if (d.themeId) {
    const theme = await prisma.theme.findUnique({ where: { id: d.themeId }, select: { name: true } });
    if (!theme) {
      res.status(400).json({ error: "invalid_theme" });
      return;
    }
    themeName = theme.name;
  }

  try {
    // Upload user reference images to Cloudinary (shared by Person + Item).
    const day = new Date().toISOString().slice(0, 10);

    // Global (ALL) refs.
    const userRefUrls: string[] = [];
    for (const [i, dataUrl] of d.referenceImages.entries()) {
      const up = await withRetry(
        () => uploadBase64(dataUrl, `userref_${Date.now()}_${i}`, `brands/person_userref/${day}`),
        `userref#${i}`,
      );
      if (up.success && up.secure_url) userRefUrls.push(up.secure_url);
    }

    // Per-key (EACH) refs, keyed by brandId (Person) or style name (Item).
    const perKeyRefUrls: Record<string, string[]> = {};
    for (const [key, dataUrls] of Object.entries(d.perBrandRefs)) {
      const urls: string[] = [];
      for (const [i, dataUrl] of dataUrls.entries()) {
        const up = await withRetry(
          () => uploadBase64(dataUrl, `userref_${key}_${Date.now()}_${i}`, `brands/person_userref/${day}`),
          `userref:${key}#${i}`,
        );
        if (up.success && up.secure_url) urls.push(up.secure_url);
      }
      if (urls.length) perKeyRefUrls[key] = urls;
    }

    if (d.contentType === "PERSON") {
      const result = await createPersonBatch({
        userId,
        brandIds: d.brandIds,
        themeName,
        refMode: d.refMode,
        sharedDescription: d.prompt,
        perBrandPrompts: d.perBrandPrompts,
        imageCount: d.imageCount,
        userRefUrls,
        perBrandRefUrls: perKeyRefUrls,
        perBrandCounts: d.perBrandCounts,
        aspectRatio: d.aspectRatio,
        perBrandAspect: d.perBrandAspect,
      });
      res.json(result);
      return;
    }

    const result = await createItemBatch({
      userId,
      styles: d.styles,
      themeName,
      sharedDescription: d.prompt,
      perStylePrompts: d.perBrandPrompts,
      imageCount: d.imageCount,
      userRefUrls,
      perStyleRefUrls: perKeyRefUrls,
      perStyleCounts: d.perBrandCounts,
      aspectRatio: d.aspectRatio,
      perStyleAspect: d.perBrandAspect,
    });
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    res.status(400).json({ error: msg });
  }
});

// ---- Gallery (per-user, completed images) ----
const gallerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  brand: z.string().optional(),
});

generateRouter.get("/generations", async (req: Request, res: Response) => {
  const parsed = gallerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { limit, offset, brand } = parsed.data;
  const userId = req.user!.sub;

  const where = {
    userId,
    status: "DONE" as const,
    generatedImageUrl: { not: null },
    ...(brand ? { brandName: brand } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.generation.count({ where }),
    prisma.generation.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
      select: {
        id: true,
        brandName: true,
        theme: true,
        description: true,
        generatedImageUrl: true,
        actionType: true,
        createdAt: true,
      },
    }),
  ]);

  res.json({ images: rows, total, hasMore: offset + rows.length < total });
});

// ---- Batch status (polling) ----
generateRouter.get("/batches/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "id_required" });
    return;
  }
  const batch = await prisma.batch.findFirst({
    where: { id, userId: req.user!.sub },
    select: {
      id: true,
      status: true,
      actionType: true,
      generations: {
        select: {
          id: true,
          brandName: true,
          status: true,
          statusMessage: true,
          generatedImageUrl: true,
        },
      },
    },
  });
  if (!batch) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const g = batch.generations;
  const completed = g.filter((x) => x.status === "DONE").length;
  const failed = g.filter((x) => x.status === "FAILED").length;
  const cancelled = g.filter((x) => x.status === "CANCELLED").length;
  const total = g.length;
  const finished = completed + failed + cancelled;

  res.json({
    batch: { id: batch.id, status: batch.status, actionType: batch.actionType },
    total,
    completed,
    failed,
    cancelled,
    processing: total - finished,
    progress: total > 0 ? Math.round((finished / total) * 100) : 0,
    isComplete: finished === total,
    generations: g,
  });
});

// ---- Stop (cancel) ----
generateRouter.post("/batches/:id/stop", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "id_required" });
    return;
  }
  const batch = await prisma.batch.findFirst({
    where: { id, userId: req.user!.sub },
    select: { id: true },
  });
  if (!batch) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  // Best-effort: synchronous providers can't be aborted mid-flight, so this
  // mainly cancels jobs still QUEUED in BullMQ (not yet picked up by a worker).
  const jobs = await prisma.job.findMany({
    where: { batchId: id, status: { in: ["QUEUED", "PROCESSING"] } },
    select: { id: true, generationId: true },
  });

  for (const job of jobs) {
    await prisma.job.update({ where: { id: job.id }, data: { status: "CANCELLED" } });
    await prisma.generation.update({
      where: { id: job.generationId },
      data: { status: "CANCELLED", statusMessage: "🚫 Cancelled", generatedImageUrl: null },
    });
  }

  await recomputeBatchStatus(id);
  res.json({ ok: true, cancelled: jobs.length });
});
