import { Router } from "express";
import type { Request, Response } from "express";
import archiver from "archiver";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { personPipelineReady, itemPipelineReady, editPipelineReady } from "../env.js";
import { uploadBase64, uploadFromUrl, withRetry } from "../lib/cloudinary.js";
import { createPersonBatch, createItemBatch, createEditBatch } from "../services/generation.service.js";
import { recomputeBatchStatus } from "../services/finalize.js";
import { probeAspectRatio, probeImageSize } from "../lib/imageSize.js";
import { runBriaExpand, runSeedvrUpscale, runBriaGenfill, runBriaEraser } from "../lib/fal.js";
import { ensureEnglishPrompt } from "../lib/promptLang.js";

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

// ---- Edit selected images (TASK §5: fal nano-banana-2/edit) ----
const editSchema = z.object({
  generationIds: z.array(z.string()).min(1), // source images to edit
  prompt: z.string().default(""), // shared instruction (All mode)
  perPrompts: z.record(z.string()).default({}), // per-source instruction (Each mode), keyed by generationId
  aspectRatio: z.string().default("1:1"),
  perAspect: z.record(z.string()).default({}),
});

generateRouter.post("/generate/edit", async (req: Request, res: Response) => {
  const parsed = editSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  if (!editPipelineReady) {
    res.status(503).json({ error: "edit_pipeline_not_configured" });
    return;
  }
  const d = parsed.data;
  const userId = req.user!.sub;

  // Resolve the sources: must belong to the user and have a generated image.
  const rows = await prisma.generation.findMany({
    where: {
      id: { in: d.generationIds },
      userId,
      status: "DONE",
      generatedImageUrl: { not: null },
    },
    select: { id: true, brandName: true, theme: true, actionType: true, generatedImageUrl: true },
  });
  if (rows.length === 0) {
    res.status(404).json({ error: "no_editable_images" });
    return;
  }

  const prepared = rows.map((r) => ({
    row: r,
    prompt: (d.perPrompts[r.id] || d.prompt).trim(),
    // Any explicit aspect from the request wins; "" means "derive from the source".
    override: d.perAspect[r.id] || (d.aspectRatio !== "1:1" ? d.aspectRatio : ""),
  }));

  if (prepared.some((p) => !p.prompt)) {
    res.status(400).json({ error: "empty_prompt" });
    return;
  }

  // Preserve each source image's aspect ratio on the edit (TASK): the original
  // aspect isn't stored anywhere, so we read it from the source's actual pixels
  // and pass the nearest fal aspect_ratio. Probe only when there's no override;
  // on failure we fall back to the request default ("1:1").
  const sources = await Promise.all(
    prepared.map(async (p) => {
      const probed = p.override ? null : await probeAspectRatio(p.row.generatedImageUrl!);
      return {
        sourceImageUrl: p.row.generatedImageUrl!,
        brandName: p.row.brandName,
        theme: p.row.theme,
        actionType: p.row.actionType,
        prompt: p.prompt,
        aspect: p.override || probed || d.aspectRatio,
      };
    }),
  );

  try {
    const result = await createEditBatch(userId, sources);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    res.status(400).json({ error: msg });
  }
});

// Store a fal result under a NEW Cloudinary public_id (old asset stays as backup)
// and REPLACE the source image in place — same Generation id, so it keeps its
// tab/group. Returns the new secure_url, or null on upload failure. Shared by the
// Scale and Inpaint routes.
async function storeReplacement(
  row: { id: string; brandName: string },
  imageUrl: string,
  prefix: string,
): Promise<string | null> {
  const fileName = `${prefix}_${row.id}_${Date.now()}.png`;
  const uploaded = await withRetry(
    () => uploadFromUrl(imageUrl, fileName, `${prefix}/${row.brandName}`),
    `${prefix} ${row.id}`,
  );
  if (!uploaded.success || !uploaded.secure_url) return null;
  await prisma.generation.update({
    where: { id: row.id },
    data: { generatedImageUrl: uploaded.secure_url },
  });
  return uploaded.secure_url;
}

const clamp = (v: number, min: number, max: number) => Math.round(Math.min(Math.max(v, min), max));
const MAX_CANVAS = 4096; // bria practical ceiling; also bounds file weight / cost

// ---- Scale one image: Midjourney-style outpaint + auto 2x upscale (TASK §1) ----
// Synchronous (single image): place the source on a larger canvas via bria/expand,
// upscale the result 2x, store it, and replace the source in place. The client
// sends EITHER `pad` (edge-expand: extra px per side, source pixels) OR a full
// `placement` (free move/zoom: target canvas + scaled image size + position). The
// backend probes the real source dimensions rather than trusting the client.
const padSchema = z.object({
  top: z.number().min(0),
  right: z.number().min(0),
  bottom: z.number().min(0),
  left: z.number().min(0),
});
const placementSchema = z.object({
  canvasW: z.number().positive(),
  canvasH: z.number().positive(),
  imgW: z.number().positive(),
  imgH: z.number().positive(),
  imgX: z.number().min(0),
  imgY: z.number().min(0),
});
const scaleSchema = z.object({
  generationId: z.string(),
  pad: padSchema.optional(),
  placement: placementSchema.optional(),
  prompt: z.string().optional(),
});

interface ExpandBox {
  canvasW: number;
  canvasH: number;
  originX: number;
  originY: number;
  imgW: number;
  imgH: number;
}

generateRouter.post("/generate/scale", async (req: Request, res: Response) => {
  const parsed = scaleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  if (!editPipelineReady) {
    res.status(503).json({ error: "scale_pipeline_not_configured" });
    return;
  }
  const d = parsed.data;
  if (!d.pad && !d.placement) {
    res.status(400).json({ error: "no_target" });
    return;
  }
  const userId = req.user!.sub;

  // Source must belong to the user and have a stored image.
  const row = await prisma.generation.findFirst({
    where: { id: d.generationId, userId, status: "DONE", generatedImageUrl: { not: null } },
    select: { id: true, generatedImageUrl: true, brandName: true },
  });
  if (!row) {
    res.status(404).json({ error: "no_editable_image" });
    return;
  }

  // Backend is the source of truth for dimensions (client value is preview-only).
  const size = await probeImageSize(row.generatedImageUrl!);
  if (!size) {
    res.status(422).json({ error: "probe_failed" });
    return;
  }

  // Resolve the expand box from whichever payload was sent.
  let box: ExpandBox;
  if (d.placement) {
    const canvasW = clamp(d.placement.canvasW, 1, MAX_CANVAS);
    const canvasH = clamp(d.placement.canvasH, 1, MAX_CANVAS);
    const imgW = clamp(d.placement.imgW, 1, canvasW);
    const imgH = clamp(d.placement.imgH, 1, canvasH);
    box = {
      canvasW,
      canvasH,
      imgW,
      imgH,
      originX: clamp(d.placement.imgX, 0, canvasW - imgW),
      originY: clamp(d.placement.imgY, 0, canvasH - imgH),
    };
    // Nothing to outpaint if the image fills the whole canvas.
    if (box.imgW >= canvasW && box.imgH >= canvasH) {
      res.status(400).json({ error: "no_expansion" });
      return;
    }
  } else {
    // Edge-expand: cap each side to <=100% of that dimension (max doubling).
    const left = clamp(d.pad!.left, 0, size.width);
    const right = clamp(d.pad!.right, 0, size.width);
    const top = clamp(d.pad!.top, 0, size.height);
    const bottom = clamp(d.pad!.bottom, 0, size.height);
    if (left + right + top + bottom === 0) {
      res.status(400).json({ error: "no_expansion" });
      return;
    }
    box = {
      canvasW: size.width + left + right,
      canvasH: size.height + top + bottom,
      originX: left,
      originY: top,
      imgW: size.width,
      imgH: size.height,
    };
  }

  try {
    // Bria rejects non-ASCII prompts — translate a Russian prompt to English
    // first (ASCII passes through untouched). Explicit failure beats a 422.
    let prompt: string | undefined;
    if (d.prompt?.trim()) {
      const eng = await ensureEnglishPrompt(d.prompt);
      if (!eng.ok) {
        res.status(502).json({ error: "prompt_translation_failed" });
        return;
      }
      prompt = eng.prompt;
    }

    // 1. Outpaint the empty margins.
    const expand = await runBriaExpand(row.generatedImageUrl!, {
      ...box,
      ...(prompt ? { prompt } : {}),
    });
    if (!expand.success || !expand.imageUrl) {
      res.status(502).json({ error: "expand_failed", detail: expand.error });
      return;
    }

    // 2. Auto 2x upscale (recovers quality lost in outpaint). On failure, fall
    //    back to the expanded image so the user still gets the wider frame.
    const up = await runSeedvrUpscale(expand.imageUrl, 2);
    const finalUrl = up.success && up.imageUrl ? up.imageUrl : expand.imageUrl;

    const secureUrl = await storeReplacement(row, finalUrl, "scaled");
    if (!secureUrl) {
      res.status(502).json({ error: "upload_failed" });
      return;
    }
    res.json({ generationId: row.id, generatedImageUrl: secureUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    res.status(500).json({ error: "scale_failed", detail: msg });
  }
});

// ---- Inpaint one image: mask-based fill/erase via Bria (TASK §1 Scale) ----
// Synchronous. The client paints a binary mask (white = target area) at the SOURCE
// resolution and sends it as a data URL. mode="fill" → bria/genfill (needs a
// prompt); mode="erase" → bria/eraser. Result replaces the source in place.
const inpaintSchema = z.object({
  generationId: z.string(),
  maskDataUrl: z.string().min(1), // data:image/png;base64,...
  mode: z.enum(["fill", "erase"]),
  prompt: z.string().optional(),
});

generateRouter.post("/generate/inpaint", async (req: Request, res: Response) => {
  const parsed = inpaintSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  if (!editPipelineReady) {
    res.status(503).json({ error: "scale_pipeline_not_configured" });
    return;
  }
  const d = parsed.data;
  if (d.mode === "fill" && !d.prompt?.trim()) {
    res.status(400).json({ error: "empty_prompt" });
    return;
  }
  const userId = req.user!.sub;

  const row = await prisma.generation.findFirst({
    where: { id: d.generationId, userId, status: "DONE", generatedImageUrl: { not: null } },
    select: { id: true, generatedImageUrl: true, brandName: true },
  });
  if (!row) {
    res.status(404).json({ error: "no_editable_image" });
    return;
  }

  try {
    // Bria genfill rejects non-ASCII prompts — translate a Russian prompt to
    // English first (ASCII passes through untouched). Done before the mask
    // upload so a translation failure costs nothing.
    let prompt = "";
    if (d.mode === "fill") {
      const eng = await ensureEnglishPrompt(d.prompt!);
      if (!eng.ok) {
        res.status(502).json({ error: "prompt_translation_failed" });
        return;
      }
      prompt = eng.prompt;
    }

    // Bria needs a mask URL — upload the painted mask to Cloudinary first.
    const maskUpload = await withRetry(
      () => uploadBase64(d.maskDataUrl, `mask_${row.id}_${Date.now()}.png`, `masks/${row.brandName}`),
      `mask ${row.id}`,
    );
    if (!maskUpload.success || !maskUpload.secure_url) {
      res.status(502).json({ error: "mask_upload_failed" });
      return;
    }

    const result =
      d.mode === "fill"
        ? await runBriaGenfill(row.generatedImageUrl!, maskUpload.secure_url, prompt)
        : await runBriaEraser(row.generatedImageUrl!, maskUpload.secure_url);
    if (!result.success || !result.imageUrl) {
      res.status(502).json({ error: "inpaint_failed", detail: result.error });
      return;
    }

    const secureUrl = await storeReplacement(row, result.imageUrl, "inpainted");
    if (!secureUrl) {
      res.status(502).json({ error: "upload_failed" });
      return;
    }
    res.json({ generationId: row.id, generatedImageUrl: secureUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    res.status(500).json({ error: "inpaint_failed", detail: msg });
  }
});

// ---- Gallery (per-user, completed images) ----
// Result page tabs (TASK §3). Content type is derived from actionType:
//   FULL / NANO_REF -> Person, CREATE_ITEM -> Item. There is no BACKGROUND
//   pipeline yet, so that tab returns nothing (Phase 0 decision). Edited images
//   (isEdit=true) live only in the "edited" tab and are excluded elsewhere.
type ContentType = "Person" | "Item" | "Background" | "Tournament";
function contentTypeOf(actionType: "FULL" | "CREATE_ITEM" | "NANO_REF" | "TOURNAMENT"): ContentType {
  if (actionType === "TOURNAMENT") return "Tournament";
  return actionType === "CREATE_ITEM" ? "Item" : "Person";
}

/** Tab-specific Generation filter, merged into the base gallery where clause. */
function tabWhere(
  tab: "generated" | "person" | "item" | "background" | "edited" | "tournament",
): Prisma.GenerationWhereInput {
  switch (tab) {
    case "person":
      return { isEdit: false, actionType: { in: ["FULL", "NANO_REF"] } };
    case "item":
      return { isEdit: false, actionType: "CREATE_ITEM" };
    case "background":
      // No BACKGROUND actionType yet — match nothing until a pipeline exists.
      return { actionType: { in: [] } };
    case "edited":
      return { isEdit: true };
    case "tournament":
      // Archive's "Tournament Pack" tab (задача 4): the flat read-only view of
      // tournament results, with the standard period/search filters.
      return { actionType: "TOURNAMENT" };
    case "generated":
    default:
      // Tournament results live in their own Result tab ("Tournament Pack",
      // Phase 6) — keep them out of the generic gallery tabs.
      return { isEdit: false, actionType: { not: "TOURNAMENT" } };
  }
}

// Archive time windows (TASK §2). The DB keeps at most ~3 months of results, so
// "3months" is the widest window and the default (shows everything available).
export type GalleryPeriod = "today" | "week" | "month" | "3months";

/** Lower bound (createdAt >=) for a gallery period. `now` is injectable for tests. */
export function periodSince(period: GalleryPeriod, now: Date = new Date()): Date {
  const d = new Date(now);
  switch (period) {
    case "today":
      d.setHours(0, 0, 0, 0);
      return d;
    case "week":
      d.setDate(d.getDate() - 7);
      return d;
    case "month":
      d.setMonth(d.getMonth() - 1);
      return d;
    case "3months":
    default:
      d.setMonth(d.getMonth() - 3);
      return d;
  }
}

const gallerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  brand: z.string().optional(), // exact brand match (Result page)
  search: z.string().trim().min(1).optional(), // partial brand match (Archive search)
  period: z.enum(["today", "week", "month", "3months"]).default("3months"),
  tab: z
    .enum(["generated", "person", "item", "background", "edited", "tournament"])
    .default("generated"),
});

type GalleryTab = "generated" | "person" | "item" | "background" | "edited" | "tournament";

/** Shared gallery where-clause builder, reused by the list + ZIP export routes. */
function galleryWhere(
  userId: string,
  q: {
    brand?: string | undefined;
    search?: string | undefined;
    period: GalleryPeriod;
    tab: GalleryTab;
  },
): Prisma.GenerationWhereInput {
  return {
    userId,
    status: "DONE",
    // Unsaved brand-test runs (super-designer modal) never reach the gallery;
    // «Сохранить» flips isTest to false and the image appears here.
    isTest: false,
    generatedImageUrl: { not: null },
    createdAt: { gte: periodSince(q.period) },
    ...(q.brand ? { brandName: q.brand } : {}),
    ...(q.search ? { brandName: { contains: q.search, mode: "insensitive" } } : {}),
    ...tabWhere(q.tab),
  };
}

generateRouter.get("/generations", async (req: Request, res: Response) => {
  const parsed = gallerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { limit, offset, brand, search, period, tab } = parsed.data;
  const userId = req.user!.sub;

  const where = galleryWhere(userId, { brand, search, period, tab });

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
        isEdit: true,
        createdAt: true,
        tourFileName: true, // Archive tournament tab shows the fixed ZIP name
      },
    }),
  ]);

  const images = rows.map((r) => ({
    ...r,
    contentType: contentTypeOf(r.actionType),
  }));

  res.json({ images, total, hasMore: offset + rows.length < total });
});

// ---- ZIP export (TASK §2) ----
// Streams the selected (or, if none selected, the whole filtered) set of images
// into a single .zip. Mounted as a GET so the browser can download it via a
// same-origin navigation (the session cookie rides along through the proxy).
const MAX_EXPORT = 300; // safety cap on a single archive

const exportSchema = gallerySchema
  .pick({ brand: true, search: true, period: true, tab: true })
  .extend({
    // Optional explicit selection — comma-separated Generation ids. When present
    // it wins over the filters (export exactly what the user ticked).
    ids: z
      .string()
      .optional()
      .transform((s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : [])),
  });

/** Safe, collision-free archive entry name: "0001_Brand.png". */
export function zipEntryName(index: number, brandName: string, url: string): string {
  const safeBrand = (brandName || "image").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40);
  const m = /\.([a-zA-Z0-9]{2,4})(?:\?|$)/.exec(url);
  const ext = m?.[1] ? m[1].toLowerCase() : "png";
  return `${String(index + 1).padStart(4, "0")}_${safeBrand}.${ext}`;
}

generateRouter.get("/generations/export.zip", async (req: Request, res: Response) => {
  const parsed = exportSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { brand, search, period, tab, ids } = parsed.data;
  const userId = req.user!.sub;

  const where: Prisma.GenerationWhereInput = ids.length
    ? {
        userId,
        status: "DONE",
        generatedImageUrl: { not: null },
        id: { in: ids },
      }
    : galleryWhere(userId, { brand, search, period, tab });

  const rows = await prisma.generation.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: MAX_EXPORT,
    select: { id: true, brandName: true, generatedImageUrl: true },
  });

  if (rows.length === 0) {
    res.status(404).json({ error: "no_images" });
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="archive-${stamp}.zip"`);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    console.error("ZIP export error:", err);
    res.destroy(err);
  });
  archive.pipe(res);

  let index = 0;
  for (const r of rows) {
    if (!r.generatedImageUrl) continue;
    try {
      const resp = await fetch(r.generatedImageUrl);
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      archive.append(buf, { name: zipEntryName(index, r.brandName, r.generatedImageUrl) });
      index += 1;
    } catch (err) {
      console.warn(`ZIP export: skipped ${r.id}`, err);
    }
  }

  await archive.finalize();
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
