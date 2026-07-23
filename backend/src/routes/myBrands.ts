import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { cloudinaryConfigured, personPipelineReady } from "../env.js";
import { uploadBase64, withRetry } from "../lib/cloudinary.js";
import {
  createBrand,
  updateBrand,
  deleteBrand,
  getBrandSnapshot,
  updateBrandAudited,
  rollbackBrand,
} from "../services/brand.service.js";
import { createBrandTestBatch } from "../services/generation.service.js";
import { MODEL_KEYS, MODEL_OPTIONS } from "../lib/falModels.js";

// Super-designer surface (TASK super-designer). Mounted behind loadUser +
// requireAuth + requireSuperDesigner (see index.ts). Every brand mutation here
// is OWNER-ONLY — even for ADMIN/MANAGER, who edit foreign brands through the
// admin panel instead. Legacy brands (createdById=null) are nobody's → 403.
export const myBrandsRouter: Router = Router();

/**
 * Load a brand and enforce ownership. Replies 404/403 and returns null when the
 * caller may not touch it.
 */
async function loadOwnBrand(
  req: Request,
  res: Response,
): Promise<{ id: string; name: string } | null> {
  const id = String(req.params.id ?? "");
  if (!id) {
    res.status(400).json({ error: "id_required" });
    return null;
  }
  const brand = await prisma.brand.findUnique({
    where: { id },
    select: { id: true, name: true, createdById: true },
  });
  if (!brand) {
    res.status(404).json({ error: "brand_not_found" });
    return null;
  }
  if (brand.createdById !== req.user!.sub) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return { id: brand.id, name: brand.name };
}

// ---- List own brands (Library) ----
myBrandsRouter.get("/", async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const brands = await prisma.brand.findMany({
    where: { createdById: userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      isActive: true,
      forcedAspectRatio: true,
      createdAt: true,
      categories: { select: { categoryId: true } },
      nanoRef: { select: { referenceImages: true, stylePrompt: true } },
      prompts: { where: { type: "PERSON" }, select: { content: true } },
      _count: { select: { testGenerations: { where: { isTest: false, status: "DONE" } } } },
    },
  });
  const categories = await prisma.brandCategory.findMany({
    orderBy: [{ order: "asc" }, { name: "asc" }],
    select: { id: true, name: true },
  });
  res.json({
    brands: brands.map((b) => ({
      id: b.id,
      name: b.name,
      isActive: b.isActive,
      forcedAspectRatio: b.forcedAspectRatio,
      createdAt: b.createdAt,
      categoryIds: b.categories.map((c) => c.categoryId),
      referenceImages: b.nanoRef?.referenceImages ?? [],
      stylePrompt: b.nanoRef?.stylePrompt ?? "",
      personPrompt: b.prompts[0]?.content ?? "",
      savedTestCount: b._count.testGenerations,
    })),
    categories,
  });
});

// ---- Create ----
const createSchema = z.object({
  name: z.string().min(1).max(120).transform((s) => s.trim()),
  categoryIds: z.array(z.string()).default([]),
  personPrompt: z.string().default(""),
  stylePrompt: z.string().default(""),
  referenceImages: z.array(z.string()).max(10).default([]),
  forcedAspectRatio: z.enum(["9:16"]).nullable().default(null),
});

myBrandsRouter.post("/", async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  if (!parsed.data.name) {
    res.status(400).json({ error: "name_required" });
    return;
  }
  const result = await createBrand({ ...parsed.data, createdById: req.user!.sub });
  if (!result.ok) {
    res.status(result.error === "already_exists" ? 409 : 500).json({ error: result.error });
    return;
  }
  res.status(201).json({ brand: result.brand });
});

// ---- Update own brand (Library / edit modal) ----
const updateSchema = z.object({
  name: z.string().min(1).max(120).transform((s) => s.trim()).optional(),
  categoryIds: z.array(z.string()).optional(),
  personPrompt: z.string().optional(),
  stylePrompt: z.string().optional(),
  referenceImages: z.array(z.string()).max(10).optional(),
  forcedAspectRatio: z.enum(["9:16"]).nullable().optional(),
});

myBrandsRouter.patch("/:id", async (req: Request, res: Response) => {
  const own = await loadOwnBrand(req, res);
  if (!own) return;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  // Strip undefined keys (exactOptionalPropertyTypes).
  const input = Object.fromEntries(
    Object.entries(parsed.data).filter(([, v]) => v !== undefined),
  );
  const result = await updateBrand(own.id, input);
  if (!result.ok) {
    const status =
      result.error === "brand_not_found" ? 404 : result.error === "already_exists" ? 409 : 500;
    res.status(status).json({ error: result.error });
    return;
  }
  res.json({ brand: result.brand });
});

// ---- Delete own brand ----
myBrandsRouter.delete("/:id", async (req: Request, res: Response) => {
  const own = await loadOwnBrand(req, res);
  if (!own) return;
  const ok = await deleteBrand(own.id);
  if (!ok) {
    res.status(404).json({ error: "brand_not_found" });
    return;
  }
  res.json({ ok: true });
});

// ---- Upload a reference image (base64 → Cloudinary), mirrors /api/admin/upload ----
const uploadSchema = z.object({ dataUrl: z.string().min(1) });
myBrandsRouter.post("/upload", async (req: Request, res: Response) => {
  if (!cloudinaryConfigured) {
    res.status(503).json({ error: "cloudinary_not_configured" });
    return;
  }
  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const folder = `brands/nanoref/${new Date().toISOString().slice(0, 10)}`;
  const up = await withRetry(
    () => uploadBase64(parsed.data.dataUrl, `nanoref_${Date.now()}`, folder),
    "my_brands_upload",
  );
  if (up.success && up.secure_url) {
    res.json({ secure_url: up.secure_url });
  } else {
    res.status(502).json({ error: up.error ?? "upload_failed" });
  }
});

// ---- «Протестировать бренд»: run one test generation ----
const testSchema = z.object({
  prompt: z.string().trim().min(1),
  aspectRatio: z.enum(["1:1", "9:16"]).default("9:16"),
});

myBrandsRouter.post("/:id/test", async (req: Request, res: Response) => {
  const own = await loadOwnBrand(req, res);
  if (!own) return;
  if (!personPipelineReady) {
    res.status(503).json({ error: "person_pipeline_not_configured" });
    return;
  }
  const parsed = testSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  try {
    const result = await createBrandTestBatch({
      userId: req.user!.sub,
      brandId: own.id,
      prompt: parsed.data.prompt,
      aspectRatio: parsed.data.aspectRatio,
    });
    res.json(result);
  } catch {
    res.status(500).json({ error: "test_failed" });
  }
});

// ---- «Сохранить»: keep a finished test image → it lands in Results ----
myBrandsRouter.post("/:id/test/:generationId/save", async (req: Request, res: Response) => {
  const own = await loadOwnBrand(req, res);
  if (!own) return;
  const generationId = String(req.params.generationId ?? "");
  const gen = await prisma.generation.findUnique({
    where: { id: generationId },
    select: { id: true, userId: true, brandId: true, isTest: true, status: true },
  });
  if (!gen || gen.brandId !== own.id || gen.userId !== req.user!.sub) {
    res.status(404).json({ error: "generation_not_found" });
    return;
  }
  if (gen.status !== "DONE") {
    res.status(409).json({ error: "not_done" });
    return;
  }
  if (gen.isTest) {
    await prisma.generation.update({ where: { id: gen.id }, data: { isTest: false } });
  }
  res.json({ ok: true });
});

// ============================================================
// «Edit current style» (TASK download-and-edit-style §2): a super-designer may
// edit ANY brand — including legacy/admin ones — with every change audited in
// BrandChangeLog (before/after snapshots) and rollback-able. This deliberately
// supersedes the owner-only rule above, which still guards Library CRUD.
// ============================================================

// ---- All brands for the edit dropdown (+ selects data for the modal) ----
myBrandsRouter.get("/editable", async (_req: Request, res: Response) => {
  const [brands, categories] = await Promise.all([
    prisma.brand.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, isActive: true },
    }),
    prisma.brandCategory.findMany({
      orderBy: [{ order: "asc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
  ]);
  res.json({ brands, categories, models: MODEL_OPTIONS });
});

// ---- Full editable state of one brand ----
myBrandsRouter.get("/editable/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "");
  const snapshot = await getBrandSnapshot(id);
  if (!snapshot) {
    res.status(404).json({ error: "brand_not_found" });
    return;
  }
  const logCount = await prisma.brandChangeLog.count({ where: { brandId: id } });
  res.json({ id, ...snapshot, canRollback: logCount > 0 });
});

// ---- Audited update (applies globally for every user) ----
const editableUpdateSchema = z.object({
  name: z.string().min(1).max(120).transform((s) => s.trim()).optional(),
  categoryIds: z.array(z.string()).optional(),
  personPrompt: z.string().optional(),
  stylePrompt: z.string().optional(),
  referenceImages: z.array(z.string()).max(10).optional(),
  forcedAspectRatio: z.enum(["9:16"]).nullable().optional(),
  imageModel: z
    .string()
    .nullable()
    .optional()
    .refine((v) => v == null || MODEL_KEYS.includes(v), { message: "unknown_model" }),
  isActive: z.boolean().optional(),
});

myBrandsRouter.patch("/editable/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "");
  const parsed = editableUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const input = Object.fromEntries(
    Object.entries(parsed.data).filter(([, v]) => v !== undefined),
  );
  const result = await updateBrandAudited(id, input, {
    userId: req.user!.sub,
    userEmail: req.user!.email,
  });
  if (!result.ok) {
    const status =
      result.error === "brand_not_found" ? 404 : result.error === "already_exists" ? 409 : 500;
    res.status(status).json({ error: result.error });
    return;
  }
  const snapshot = await getBrandSnapshot(id);
  res.json({ brand: result.brand, changed: result.changed, snapshot });
});

// ---- «Вернуть предыдущую версию»: restore the latest log entry's `before` ----
myBrandsRouter.post("/editable/:id/rollback", async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "");
  const result = await rollbackBrand(id, { userId: req.user!.sub, userEmail: req.user!.email });
  if (!result.ok) {
    const status =
      result.error === "brand_not_found"
        ? 404
        : result.error === "nothing_to_rollback"
          ? 409
          : result.error === "already_exists"
            ? 409
            : 500;
    res.status(status).json({ error: result.error });
    return;
  }
  res.json({ brand: result.brand, snapshot: result.restored });
});

// ---- Test the DRAFT (unsaved) state: one isTest generation with overrides ----
const editableTestSchema = z.object({
  prompt: z.string().trim().min(1),
  aspectRatio: z.enum(["1:1", "9:16"]).default("9:16"),
  personPrompt: z.string().optional(),
  referenceImages: z.array(z.string()).max(10).optional(),
  imageModel: z
    .string()
    .nullable()
    .optional()
    .refine((v) => v == null || MODEL_KEYS.includes(v), { message: "unknown_model" }),
});

myBrandsRouter.post("/editable/:id/test", async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "");
  if (!personPipelineReady) {
    res.status(503).json({ error: "person_pipeline_not_configured" });
    return;
  }
  const brand = await prisma.brand.findUnique({ where: { id }, select: { id: true } });
  if (!brand) {
    res.status(404).json({ error: "brand_not_found" });
    return;
  }
  const parsed = editableTestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { prompt, aspectRatio, personPrompt, referenceImages, imageModel } = parsed.data;
  const overrides: { personPrompt?: string; imageModel?: string | null; referenceImages?: string[] } = {};
  if (personPrompt !== undefined) overrides.personPrompt = personPrompt;
  if (referenceImages !== undefined) overrides.referenceImages = referenceImages;
  if ("imageModel" in req.body) overrides.imageModel = imageModel ?? null;
  try {
    const result = await createBrandTestBatch({
      userId: req.user!.sub,
      brandId: id,
      prompt,
      aspectRatio,
      ...(Object.keys(overrides).length ? { overrides } : {}),
    });
    res.json(result);
  } catch {
    res.status(500).json({ error: "test_failed" });
  }
});

// ---- Saved test results for a brand (Library) ----
myBrandsRouter.get("/:id/tests", async (req: Request, res: Response) => {
  const own = await loadOwnBrand(req, res);
  if (!own) return;
  const tests = await prisma.generation.findMany({
    where: {
      brandId: own.id,
      userId: req.user!.sub,
      actionType: "NANO_REF",
      isTest: false,
      status: "DONE",
      generatedImageUrl: { not: null },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      description: true,
      generatedImageUrl: true,
      createdAt: true,
    },
  });
  res.json({ tests });
});
