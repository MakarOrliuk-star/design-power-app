import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { cloudinaryConfigured } from "../env.js";
import { uploadBase64, withRetry } from "../lib/cloudinary.js";

/**
 * Tournament admin (Phase 4): element CRUD per category, default prompts
 * (BASE/VIP), the 2 provider references, the system wrapper. Mounted at
 * /api/tournament-admin behind requireAdminOrManager (Phase 0 decision:
 * MANAGER edits tournaments too, but never reaches the ADMIN-only /api/admin).
 */
export const tournamentAdminRouter: Router = Router();

const MODES = ["BASE", "VIP"] as const;
type Mode = (typeof MODES)[number];

/** Which prompt modes an element of this category carries. */
function modesOf(category: { hasModes: boolean; fixedMode: Mode | null }): Mode[] {
  return category.hasModes ? ["BASE", "VIP"] : [category.fixedMode ?? "BASE"];
}

// ---- Full config (includes inactive elements + the system wrapper) ----

tournamentAdminRouter.get("/config", async (_req: Request, res: Response) => {
  const [categories, wrapper] = await Promise.all([
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
          orderBy: [{ order: "asc" }, { name: "asc" }],
          select: {
            id: true,
            name: true,
            order: true,
            isActive: true,
            referenceImages: true,
            prompts: { select: { mode: true, content: true, updatedAt: true } },
          },
        },
      },
    }),
    prisma.promptTemplate.findUnique({
      where: { type_key: { type: "TOURNAMENT", key: "system" } },
      select: { content: true },
    }),
  ]);
  res.json({ categories, systemPrompt: wrapper?.content ?? "" });
});

// ---- Elements CRUD ----

const createElementSchema = z.object({
  categoryId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
});

tournamentAdminRouter.post("/elements", async (req: Request, res: Response) => {
  const parsed = createElementSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { categoryId, name } = parsed.data;

  const category = await prisma.tournamentCategory.findUnique({
    where: { id: categoryId },
    select: { id: true, hasModes: true, fixedMode: true },
  });
  if (!category) {
    res.status(404).json({ error: "category_not_found" });
    return;
  }
  const clash = await prisma.tournamentElement.findUnique({
    where: { categoryId_name: { categoryId, name } },
    select: { id: true },
  });
  if (clash) {
    res.status(409).json({ error: "already_exists" });
    return;
  }

  const last = await prisma.tournamentElement.findFirst({
    where: { categoryId },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  // New elements get placeholder prompts for every mode of the category so the
  // designers' page always has something to show/override.
  const element = await prisma.tournamentElement.create({
    data: {
      categoryId,
      name,
      order: (last?.order ?? -1) + 1,
      prompts: {
        create: modesOf(category).map((mode) => ({
          mode,
          content: `[placeholder ${mode}] Default prompt for "${name}" — edit me in Admin → Tournaments.`,
        })),
      },
    },
    select: { id: true, name: true, order: true, isActive: true, referenceImages: true },
  });
  res.status(201).json({ element });
});

const patchElementSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  order: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  referenceImages: z.array(z.string().trim()).max(2).optional(), // provider refs
});

tournamentAdminRouter.patch("/elements/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "");
  const parsed = patchElementSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const existing = await prisma.tournamentElement.findUnique({
    where: { id },
    select: { categoryId: true },
  });
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // Reject a rename that collides with another element of the same category.
  if (parsed.data.name) {
    const clash = await prisma.tournamentElement.findUnique({
      where: { categoryId_name: { categoryId: existing.categoryId, name: parsed.data.name } },
      select: { id: true },
    });
    if (clash && clash.id !== id) {
      res.status(409).json({ error: "already_exists" });
      return;
    }
  }

  // Only write the keys the client actually sent (exactOptionalPropertyTypes).
  const data: {
    name?: string;
    order?: number;
    isActive?: boolean;
    referenceImages?: string[];
  } = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.order !== undefined) data.order = parsed.data.order;
  if (parsed.data.isActive !== undefined) data.isActive = parsed.data.isActive;
  if (parsed.data.referenceImages !== undefined)
    data.referenceImages = parsed.data.referenceImages.filter(Boolean);

  const element = await prisma.tournamentElement.update({
    where: { id },
    data,
    select: { id: true, name: true, order: true, isActive: true, referenceImages: true },
  });
  res.json({ element });
});

/** Soft delete: history (Generation rows) keeps the denormalized name. */
tournamentAdminRouter.delete("/elements/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "");
  try {
    await prisma.tournamentElement.update({ where: { id }, data: { isActive: false } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});

// ---- Default prompts ----

const putPromptSchema = z.object({
  elementId: z.string().min(1),
  mode: z.enum(MODES),
  content: z.string().trim().min(1).max(5000),
});

tournamentAdminRouter.put("/prompts", async (req: Request, res: Response) => {
  const parsed = putPromptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { elementId, mode, content } = parsed.data;

  const element = await prisma.tournamentElement.findUnique({
    where: { id: elementId },
    select: { category: { select: { hasModes: true, fixedMode: true } } },
  });
  if (!element) {
    res.status(404).json({ error: "element_not_found" });
    return;
  }
  if (!modesOf(element.category).includes(mode)) {
    res.status(400).json({ error: "invalid_mode" });
    return;
  }

  // updatedAt bumps on every write — users with an override see the
  // "default changed" banner (their baseUpdatedAt snapshot is now older).
  const prompt = await prisma.tournamentPrompt.upsert({
    where: { elementId_mode: { elementId, mode } },
    create: { elementId, mode, content },
    update: { content },
    select: { elementId: true, mode: true, content: true, updatedAt: true },
  });
  res.json({ prompt });
});

// ---- System wrapper ----

const systemPromptSchema = z.object({ content: z.string().trim().min(1).max(10000) });

tournamentAdminRouter.put("/system-prompt", async (req: Request, res: Response) => {
  const parsed = systemPromptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const row = await prisma.promptTemplate.upsert({
    where: { type_key: { type: "TOURNAMENT", key: "system" } },
    create: { type: "TOURNAMENT", key: "system", content: parsed.data.content },
    update: { content: parsed.data.content },
    select: { content: true },
  });
  res.json({ systemPrompt: row.content });
});

// ---- Provider reference upload (same flow as the admin NanoRef upload) ----

const uploadSchema = z.object({ dataUrl: z.string().min(1) });

tournamentAdminRouter.post("/upload", async (req: Request, res: Response) => {
  if (!cloudinaryConfigured) {
    res.status(503).json({ error: "cloudinary_not_configured" });
    return;
  }
  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const folder = `tournaments/provider-refs/${new Date().toISOString().slice(0, 10)}`;
  const up = await withRetry(
    () => uploadBase64(parsed.data.dataUrl, `provref_${Date.now()}`, folder),
    "tournament_admin_upload",
  );
  if (up.success && up.secure_url) {
    res.json({ secure_url: up.secure_url });
  } else {
    res.status(502).json({ error: up.error ?? "upload_failed" });
  }
});
