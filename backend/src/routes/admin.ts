import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { cloudinaryConfigured } from "../env.js";
import { uploadBase64, withRetry } from "../lib/cloudinary.js";
import { MODEL_KEYS, MODEL_OPTIONS } from "../lib/falModels.js";
import { createBrand } from "../services/brand.service.js";
import { layoutSpecSchema, createLayoutSpecVersion } from "../services/layoutSpec.js";
import { clampStyleProfile } from "../lib/styleProfile.js";
import { parseDecorEntries, decorEntryUrls } from "../lib/decorLibrary.js";
import { Prisma } from "../../generated/prisma/client.js";

// All routes here are mounted behind loadUser + requireAdmin (see index.ts).
export const adminRouter: Router = Router();

const addEmailSchema = z.object({
  email: z.string().email().transform((e) => e.toLowerCase()),
  note: z.string().max(500).optional(),
});

// ---- Allowlist ----
adminRouter.get("/allowed-emails", async (_req: Request, res: Response) => {
  const emails = await prisma.allowedEmail.findMany({ orderBy: { createdAt: "desc" } });
  res.json({ allowedEmails: emails });
});

adminRouter.post("/allowed-emails", async (req: Request, res: Response) => {
  const parsed = addEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { email, note } = parsed.data;

  const existing = await prisma.allowedEmail.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: "already_exists" });
    return;
  }

  const created = await prisma.allowedEmail.create({
    data: { email, note: note ?? null, addedBy: req.user!.email },
  });
  res.status(201).json({ allowedEmail: created });
});

adminRouter.delete("/allowed-emails/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "id_required" });
    return;
  }
  try {
    await prisma.allowedEmail.delete({ where: { id } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});

// ---- Users (role / activation) ----
adminRouter.get("/users", async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      createdAt: true,
      lastLoginAt: true,
    },
  });
  res.json({ users });
});

const patchUserSchema = z.object({
  role: z.enum(["ADMIN", "DESIGNER", "CRM", "MANAGER", "SUPER_DESIGNER", "CRM_SUPER"]).optional(),
  isActive: z.boolean().optional(),
});

adminRouter.patch("/users/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "id_required" });
    return;
  }
  const parsed = patchUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }

  // Guard against self-lockout: an admin can't demote or deactivate themselves.
  if (id === req.user!.sub) {
    if ((parsed.data.role !== undefined && parsed.data.role !== "ADMIN") || parsed.data.isActive === false) {
      res.status(400).json({ error: "cannot_modify_self" });
      return;
    }
  }

  // Build the update payload without explicit `undefined` (exactOptionalPropertyTypes).
  const data: {
    role?: "ADMIN" | "DESIGNER" | "CRM" | "MANAGER" | "SUPER_DESIGNER" | "CRM_SUPER";
    isActive?: boolean;
  } = {};
  if (parsed.data.role !== undefined) data.role = parsed.data.role;
  if (parsed.data.isActive !== undefined) data.isActive = parsed.data.isActive;

  try {
    const updated = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });
    res.json({ user: updated });
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});

// ============================================================
// Catalog management: BrandNanoRef (Person refs) + PromptTemplate
// ============================================================

/** Brands with their NanoRef images + PERSON prompt, plus categories + ITEM prompts. */
adminRouter.get("/catalog", async (_req: Request, res: Response) => {
  const [brands, categories, personPrompts, itemPrompts] = await Promise.all([
    prisma.brand.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        forcedAspectRatio: true,
        imageModel: true,
        nanoRef: { select: { referenceImages: true } },
      },
    }),
    prisma.brandCategory.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }] }),
    prisma.promptTemplate.findMany({ where: { type: "PERSON" }, select: { key: true, content: true } }),
    prisma.promptTemplate.findMany({
      where: { type: "ITEM" },
      orderBy: { key: "asc" },
      select: { key: true, content: true },
    }),
  ]);

  // PERSON prompt is looked up by brand name (case-insensitive), matching the
  // generation flow — so map by lowercased key rather than via the brandId FK.
  const personByKey = new Map(personPrompts.map((p) => [p.key.toLowerCase(), p.content]));

  res.json({
    brands: brands.map((b) => ({
      id: b.id,
      name: b.name,
      forcedAspectRatio: b.forcedAspectRatio,
      imageModel: b.imageModel,
      referenceImages: b.nanoRef?.referenceImages ?? [],
      personPrompt: personByKey.get(b.name.toLowerCase()) ?? "",
    })),
    categories: categories.map((c) => ({ id: c.id, name: c.name })),
    itemPrompts: itemPrompts.map((p) => ({ key: p.key, content: p.content })),
    models: MODEL_OPTIONS,
  });
});

/** Create a new brand (TASK §2): name + categories + base PERSON prompt + style. */
const createBrandSchema = z.object({
  name: z.string().min(1).max(120).transform((s) => s.trim()),
  categoryIds: z.array(z.string()).default([]),
  personPrompt: z.string().default(""), // base prompt → PromptTemplate(PERSON)
  stylePrompt: z.string().default(""), // brand-specific style → BrandNanoRef.stylePrompt
  referenceImages: z.array(z.string()).max(10).default([]),
  // TASK §7: "9:16" forces every generation of the brand to 9:16; null (the
  // default for new brands) honours the user's 1:1/9:16 pick.
  forcedAspectRatio: z.enum(["9:16"]).nullable().default(null),
});

adminRouter.post("/brands", async (req: Request, res: Response) => {
  const parsed = createBrandSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { name, categoryIds, personPrompt, stylePrompt, referenceImages, forcedAspectRatio } =
    parsed.data;
  if (!name) {
    res.status(400).json({ error: "name_required" });
    return;
  }

  const result = await createBrand({
    name,
    categoryIds,
    personPrompt,
    stylePrompt,
    referenceImages,
    forcedAspectRatio,
    createdById: req.user!.sub,
  });
  if (!result.ok) {
    res
      .status(result.error === "already_exists" ? 409 : 500)
      .json({ error: result.error });
    return;
  }
  res.status(201).json({ brand: result.brand });
});

/**
 * Update an existing brand's settings: the forced-format toggle (TASK §7) and/or
 * the fal model override (Task 1). Both fields are optional so the front-end can
 * PATCH either independently; `imageModel: null` clears the override (→ default).
 */
const patchBrandSchema = z.object({
  forcedAspectRatio: z.enum(["9:16"]).nullable().optional(),
  imageModel: z
    .string()
    .nullable()
    .optional()
    .refine((v) => v == null || MODEL_KEYS.includes(v), { message: "unknown_model" }),
});
adminRouter.patch("/brands/:id", async (req: Request, res: Response) => {
  const parsed = patchBrandSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const id = String(req.params.id ?? "");

  // Only write the keys the client actually sent (exactOptionalPropertyTypes).
  const data: { forcedAspectRatio?: string | null; imageModel?: string | null } = {};
  if (parsed.data.forcedAspectRatio !== undefined) data.forcedAspectRatio = parsed.data.forcedAspectRatio;
  if (parsed.data.imageModel !== undefined) data.imageModel = parsed.data.imageModel;

  try {
    const brand = await prisma.brand.update({
      where: { id },
      data,
      select: { id: true, name: true, forcedAspectRatio: true, imageModel: true },
    });
    res.json({ brand });
  } catch {
    res.status(404).json({ error: "brand_not_found" });
  }
});

/** Set a brand's NanoRef reference images (Cloudinary URLs). */
const nanoRefSchema = z.object({ referenceImages: z.array(z.string()).max(10) });
adminRouter.put("/brands/:id/nanoref", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "id_required" });
    return;
  }
  const parsed = nanoRefSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const brand = await prisma.brand.findUnique({ where: { id }, select: { id: true } });
  if (!brand) {
    res.status(404).json({ error: "brand_not_found" });
    return;
  }
  const referenceImages = parsed.data.referenceImages.map((s) => s.trim()).filter(Boolean);
  const row = await prisma.brandNanoRef.upsert({
    where: { brandId: id },
    create: { brandId: id, referenceImages, stylePrompt: "" },
    update: { referenceImages },
  });
  res.json({ referenceImages: row.referenceImages });
});

/** Upsert a PromptTemplate (PERSON key=brand name, ITEM key=style name). */
const promptSchema = z.object({
  type: z.enum(["PERSON", "ITEM"]),
  key: z.string().min(1),
  content: z.string(),
  brandId: z.string().optional(),
});
adminRouter.put("/prompt", async (req: Request, res: Response) => {
  const parsed = promptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { type, key, content, brandId } = parsed.data;
  const row = await prisma.promptTemplate.upsert({
    where: { type_key: { type, key } },
    create: { type, key, content, brandId: brandId ?? null },
    update: { content, ...(brandId ? { brandId } : {}) },
  });
  res.json({ prompt: { type: row.type, key: row.key, content: row.content } });
});

/** Upload a base64 image to Cloudinary, returning its secure_url (for ref slots). */
const uploadSchema = z.object({ dataUrl: z.string().min(1) });
adminRouter.post("/upload", async (req: Request, res: Response) => {
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
    "admin_upload",
  );
  if (up.success && up.secure_url) {
    res.json({ secure_url: up.secure_url });
  } else {
    res.status(502).json({ error: up.error ?? "upload_failed" });
  }
});

// ============================================================
// Brand change log (TASK download-and-edit-style §2): who edited which brand,
// full before/after snapshots — written by the super-designer edit surface.
// ============================================================
const brandLogsSchema = z.object({
  brandId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
adminRouter.get("/brand-logs", async (req: Request, res: Response) => {
  const parsed = brandLogsSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { brandId, limit, offset } = parsed.data;
  const where = brandId ? { brandId } : {};
  const [logs, total] = await Promise.all([
    prisma.brandChangeLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        brandId: true,
        brandName: true,
        userEmail: true,
        action: true,
        before: true,
        after: true,
        createdAt: true,
      },
    }),
    prisma.brandChangeLog.count({ where }),
  ]);
  res.json({ logs, total, hasMore: offset + logs.length < total });
});

// ============================================================
// Smartico brands (Unique-Image-Smartico maintenance)
// Canonical brand_id list used to normalize ZIP folder names. CRUD for the CRM
// service; seeded from the legacy SMARTICO_BRANDS list.
// ============================================================

adminRouter.get("/smartico-brands", async (_req: Request, res: Response) => {
  const smarticoBrands = await prisma.smarticoBrand.findMany({ orderBy: { name: "asc" } });
  res.json({ smarticoBrands });
});

const smarticoBrandSchema = z.object({
  name: z.string().min(1).max(120).transform((s) => s.trim()),
});

adminRouter.post("/smartico-brands", async (req: Request, res: Response) => {
  const parsed = smarticoBrandSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { name } = parsed.data;
  if (!name) {
    res.status(400).json({ error: "name_required" });
    return;
  }

  const existing = await prisma.smarticoBrand.findUnique({ where: { name }, select: { id: true } });
  if (existing) {
    res.status(409).json({ error: "already_exists" });
    return;
  }

  const created = await prisma.smarticoBrand.create({ data: { name } });
  res.status(201).json({ smarticoBrand: created });
});

adminRouter.patch("/smartico-brands/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "id_required" });
    return;
  }
  const parsed = smarticoBrandSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { name } = parsed.data;
  if (!name) {
    res.status(400).json({ error: "name_required" });
    return;
  }

  // Reject a rename that would collide with a different existing brand.
  const clash = await prisma.smarticoBrand.findUnique({ where: { name }, select: { id: true } });
  if (clash && clash.id !== id) {
    res.status(409).json({ error: "already_exists" });
    return;
  }

  try {
    const updated = await prisma.smarticoBrand.update({ where: { id }, data: { name } });
    res.json({ smarticoBrand: updated });
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});

adminRouter.delete("/smartico-brands/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "id_required" });
    return;
  }
  try {
    await prisma.smarticoBrand.delete({ where: { id } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});

// ============================================================
// Image Bundles maintenance (TASK crm-bundle, D8/D13)
// Bundle types (extensible asset configs) + Neural prompt presets.
// ============================================================

const bundleTypeAssetSchema = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(80),
  width: z.number().int().min(64).max(4096),
  height: z.number().int().min(64).max(4096),
  templateUrl: z.string().url().optional(),
  zones: z
    .record(
      z.string(),
      z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
    )
    .optional(),
  // "ai_reference" — композиция из референсов вариации (TASK ai-reference):
  // включение/откат режима = правка данных из админки, без деплоя.
  composeMode: z.enum(["ai", "layered", "ai_reference"]).optional(),
  // Якорь стиля кампании (TASK multiformat-promo, A2-1): генерируется первым,
  // остальные ai_reference-форматы наследуют его стиль. Не задан — якорем
  // становится "email" (см. resolveStyleAnchorKey).
  styleAnchor: z.boolean().optional(),
  // Versioned geometry reference (Phase 1): render resolves the latest active
  // LayoutSpec with this key. Absent → legacy zones/composeMode path.
  layoutSpecKey: z.string().min(1).max(60).optional(),
  // Static decor cutout URLs the engine scatters into decor bands (Phase 3).
  decorUrls: z.array(z.string().url()).max(20).optional(),
  // Golden composite for the validator's SSIM check (Phase 4/6).
  goldenUrl: z.string().url().optional(),
  // TASK glow-fade-density (DI3-15): галки пост-обработки ai_reference-ассета.
  // Отсутствие поля = оба эффекта включены (см. resolveEffectsConfig).
  effects: z
    .object({ glow: z.boolean().optional(), fade: z.boolean().optional() })
    .optional(),
  // Лимит предметов зависимого формата (DI3-9/DI3-14). Границы подняты
  // 2026-08-13 после живого прогона: коридор 4–8 давал пустые кадры.
  maxProps: z.number().int().min(8).max(24).optional(),
});

const bundleTypeSchema = z.object({
  key: z.string().min(1).max(60),
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  isActive: z.boolean().optional(),
  assets: z.array(bundleTypeAssetSchema).min(1).max(20),
});

adminRouter.get("/bundle-types", async (_req: Request, res: Response) => {
  const bundleTypes = await prisma.bundleType.findMany({ orderBy: { createdAt: "asc" } });
  res.json({ bundleTypes });
});

adminRouter.post("/bundle-types", async (req: Request, res: Response) => {
  const parsed = bundleTypeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const existing = await prisma.bundleType.findUnique({
    where: { key: parsed.data.key },
    select: { id: true },
  });
  if (existing) {
    res.status(409).json({ error: "already_exists" });
    return;
  }
  const created = await prisma.bundleType.create({
    data: {
      key: parsed.data.key,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      isActive: parsed.data.isActive ?? true,
      assets: parsed.data.assets,
    },
  });
  res.status(201).json({ bundleType: created });
});

adminRouter.patch("/bundle-types/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "id_required" });
    return;
  }
  const parsed = bundleTypeSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const data: Record<string, unknown> = {};
  if (parsed.data.key !== undefined) data.key = parsed.data.key;
  if (parsed.data.title !== undefined) data.title = parsed.data.title;
  if (parsed.data.description !== undefined) data.description = parsed.data.description;
  if (parsed.data.isActive !== undefined) data.isActive = parsed.data.isActive;
  if (parsed.data.assets !== undefined) data.assets = parsed.data.assets;
  try {
    const updated = await prisma.bundleType.update({ where: { id }, data });
    res.json({ bundleType: updated });
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});

// ============================================================
// Layout specs (TASK email-composition, Phase 1) — versioned geometry.
// Rows are immutable: POST creates the NEXT version for the key; PATCH only
// toggles isActive (rollback = deactivate the newer version). Editing needs
// no code deploy — the render path resolves the latest active version.
// ============================================================

adminRouter.get("/layout-specs", async (_req: Request, res: Response) => {
  const layoutSpecs = await prisma.layoutSpec.findMany({
    orderBy: [{ key: "asc" }, { version: "desc" }],
  });
  res.json({ layoutSpecs });
});

const createLayoutSpecSchema = z.object({
  key: z.string().min(1).max(60),
  spec: z.unknown(),
});

adminRouter.post("/layout-specs", async (req: Request, res: Response) => {
  const parsed = createLayoutSpecSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const specParsed = layoutSpecSchema.safeParse(parsed.data.spec);
  if (!specParsed.success) {
    // `issues` с полным путём поля, а не только flatten по первому сегменту:
    // спека Задания 2 глубоко вложена (scatter.layers[0].sizePct,
    // background.glowPlate.radius, safe.levels.ambience.coveragePct), и без
    // пути редактор в админке не поймёт, что именно он сломал.
    res.status(400).json({
      error: "invalid_spec",
      details: specParsed.error.flatten(),
      issues: specParsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const created = await createLayoutSpecVersion(
    parsed.data.key,
    specParsed.data,
    req.user?.email,
  );
  res.status(201).json({ layoutSpec: created });
});

adminRouter.patch("/layout-specs/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "id_required" });
    return;
  }
  const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  try {
    const updated = await prisma.layoutSpec.update({
      where: { id },
      data: { isActive: parsed.data.isActive },
    });
    res.json({ layoutSpec: updated });
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});

// ---- Style-profile «казино-дизайнера» (DV-E1, ограничение 4) ----
// Ручной override профиля brand-variant'а. Тот же кламп, что у модели и у
// рендера: координат в профиле нет и быть не может, значения вне коридоров
// отбрасываются. `profile: null` снимает override — следующий prepare-variant
// снова спросит модель. Применяется при следующем рендере ассета
// (перегенерация из CRM), в сохранённые картинки задним числом не лезет.
adminRouter.patch("/bundle-variants/:id/style-profile", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "id_required" });
    return;
  }
  const parsed = z
    .object({ profile: z.record(z.unknown()).nullable() })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const variant = await prisma.bundleBrandVariant.findUnique({
    where: { id },
    include: { bundle: { select: { bundleType: { select: { assets: true } } } } },
  });
  if (!variant) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  let value: Prisma.InputJsonValue | typeof Prisma.DbNull = Prisma.DbNull;
  if (parsed.data.profile !== null) {
    // Кламп против ЭФФЕКТИВНОЙ библиотеки декора — той же, из которой рендер
    // потом соберёт кадр: библиотека бренда (DV-C2′), а без неё — общая по
    // layered-слотам типа бандла.
    const brand = await prisma.brand.findUnique({
      where: { name: variant.brandName },
      select: { decorUrls: true },
    });
    // D-N9': библиотека бренда хранит и строки, и тегированные записи —
    // фильтр «только строки» терял бы автосохранённую нарезку листа.
    const brandUrls = decorEntryUrls(parseDecorEntries(brand?.decorUrls));
    const typeAssets = variant.bundle.bundleType.assets as unknown as Array<{
      composeMode?: string;
      decorUrls?: string[];
    }>;
    const slotUrls: string[] = [];
    for (const a of typeAssets) {
      if (a.composeMode !== "layered") continue;
      for (const url of a.decorUrls ?? []) {
        if (!slotUrls.includes(url)) slotUrls.push(url);
      }
    }
    const libraryUrls = brandUrls.length > 0 ? brandUrls : slotUrls;
    const clamped = clampStyleProfile(parsed.data.profile, { libraryUrls });
    if (!clamped) {
      res.status(400).json({
        error: "invalid_profile",
        details:
          "ни одно поле не прошло кламп (glowHex #RRGGBB; typoMaterial из пресетов; " +
          "tokens ≤ 3 по ≤ 14 символов; density 0..1; decorUrls из библиотеки слота)",
      });
      return;
    }
    value = { ...clamped, source: "manual" } as unknown as Prisma.InputJsonValue;
  }

  const updated = await prisma.bundleBrandVariant.update({
    where: { id },
    data: { styleProfile: value },
    select: { id: true, brandName: true, styleProfile: true },
  });
  res.json({ variant: updated });
});

const promptPresetSchema = z.object({
  title: z.string().min(1).max(120),
  text: z.string().min(1).max(1500),
  order: z.number().int().min(0).max(10_000).optional(),
  isActive: z.boolean().optional(),
});

adminRouter.get("/prompt-presets", async (_req: Request, res: Response) => {
  const presets = await prisma.neuralPromptPreset.findMany({
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
  res.json({ presets });
});

adminRouter.post("/prompt-presets", async (req: Request, res: Response) => {
  const parsed = promptPresetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const created = await prisma.neuralPromptPreset.create({
    data: {
      title: parsed.data.title,
      text: parsed.data.text,
      order: parsed.data.order ?? 0,
      isActive: parsed.data.isActive ?? true,
    },
  });
  res.status(201).json({ preset: created });
});

adminRouter.patch("/prompt-presets/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "id_required" });
    return;
  }
  const parsed = promptPresetSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const data: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) data.title = parsed.data.title;
  if (parsed.data.text !== undefined) data.text = parsed.data.text;
  if (parsed.data.order !== undefined) data.order = parsed.data.order;
  if (parsed.data.isActive !== undefined) data.isActive = parsed.data.isActive;
  try {
    const updated = await prisma.neuralPromptPreset.update({ where: { id }, data });
    res.json({ preset: updated });
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});

adminRouter.delete("/prompt-presets/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "id_required" });
    return;
  }
  try {
    await prisma.neuralPromptPreset.delete({ where: { id } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});

// ============================================================
// Логи генераций ai_reference (TASK safe-zone/auto-heal, C2): read-only лента
// для админа — попытки генерации, приёмка и auto-healing из BundleAsset.metadata.qa.
// Отдельной таблицы нет: metadata и есть журнал, эндпоинт лишь проецирует его.
// ============================================================

const aiRefLogsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Попытка из metadata.qa → узкая строка лога (без tech-простыни). */
function aiRefLogAttempt(row: unknown): { score: number; pass: boolean; reasons: string[] } {
  const a = (row ?? {}) as Record<string, unknown>;
  return {
    score: typeof a.score === "number" ? a.score : 0,
    pass: a.pass === true,
    reasons: Array.isArray(a.reasons)
      ? a.reasons.filter((r): r is string => typeof r === "string")
      : [],
  };
}

adminRouter.get("/ai-ref-logs", async (req: Request, res: Response) => {
  const parsed = aiRefLogsSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { limit, offset } = parsed.data;
  const where = {
    metadata: { path: ["specKey"], equals: "ai_reference" },
  } satisfies Prisma.BundleAssetWhereInput;
  const [rows, total] = await Promise.all([
    prisma.bundleAsset.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        assetKey: true,
        status: true,
        imageUrl: true,
        errorMessage: true,
        metadata: true,
        updatedAt: true,
        variant: {
          select: {
            displayName: true,
            bundle: { select: { id: true, name: true } },
          },
        },
      },
    }),
    prisma.bundleAsset.count({ where }),
  ]);

  const logs = rows.map((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const qa = (meta.qa ?? {}) as Record<string, unknown>;
    const healing = qa.healing as Record<string, unknown> | undefined;
    return {
      id: r.id,
      assetKey: r.assetKey,
      status: r.status.toLowerCase(),
      imageUrl: r.imageUrl,
      errorMessage: r.errorMessage,
      updatedAt: r.updatedAt,
      bundleId: r.variant.bundle.id,
      bundleName: r.variant.bundle.name,
      brandName: r.variant.displayName,
      presetTitle: typeof meta.presetTitle === "string" ? meta.presetTitle : null,
      qaPassed: qa.qaPassed === true,
      chosenAttempt: typeof qa.chosenAttempt === "number" ? qa.chosenAttempt : null,
      attempts: Array.isArray(qa.attempts) ? qa.attempts.map(aiRefLogAttempt) : [],
      healing: healing
        ? {
            used: healing.used === true,
            chosenAttempt: typeof healing.chosenAttempt === "number" ? healing.chosenAttempt : null,
            attempts: Array.isArray(healing.attempts) ? healing.attempts.map(aiRefLogAttempt) : [],
          }
        : null,
    };
  });
  res.json({ logs, total, hasMore: offset + rows.length < total });
});
