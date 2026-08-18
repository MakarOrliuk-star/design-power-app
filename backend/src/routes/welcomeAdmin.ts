import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { cloudinaryConfigured } from "../env.js";
import { uploadBase64, withRetry } from "../lib/cloudinary.js";
import {
  createCategory,
  createElement,
  deleteCategoryAudited,
  listChangeLog,
  loadPackConfig,
  saveSystemPrompt,
  softDeleteElement,
  updateCategoryAudited,
  updateElementAudited,
} from "../services/welcomePack.service.js";
import type { PackActor } from "../services/welcomePack.service.js";

/**
 * Welcome packs admin (TASK welcome-packs): category/element CRUD, default
 * prompts, the own-reference images and the system wrapper. Mounted at
 * /api/welcome-admin behind requireAdminOrManager — mirroring the tournament
 * admin, where MANAGER edits the packs but never reaches the ADMIN-only /api/admin.
 *
 * The domain logic lives in services/welcomePack.service.ts, shared with the
 * super-designer's «Edit Welcome packs» window — one copy of the rules, and
 * every edit from EITHER surface lands in the same audit log, which
 * GET /change-log serves back to the panel.
 */
export const welcomeAdminRouter: Router = Router();

function actorOf(req: Request): PackActor {
  return { userId: req.user!.sub, userEmail: req.user!.email };
}

// ---- Full config (includes inactive elements + the system wrapper) ----

welcomeAdminRouter.get("/config", async (_req: Request, res: Response) => {
  res.json(await loadPackConfig());
});

// ---- Change log: who changed what, from either surface ----

welcomeAdminRouter.get("/change-log", async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
  res.json({ entries: await listChangeLog(limit) });
});

// ---- Categories CRUD ----

const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  usesOwnReferences: z.boolean().default(false),
});

welcomeAdminRouter.post("/categories", async (req: Request, res: Response) => {
  const parsed = createCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const result = await createCategory(parsed.data, actorOf(req));
  res.status(201).json({ category: result.category });
});

const patchCategorySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  order: z.number().int().min(0).optional(),
  usesOwnReferences: z.boolean().optional(),
});

/** Rename / reorder / own-references flag — the key is frozen at creation. */
welcomeAdminRouter.patch("/categories/:id", async (req: Request, res: Response) => {
  const parsed = patchCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
  const result = await updateCategoryAudited(String(req.params.id ?? ""), patch, actorOf(req));
  if (!result.ok) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ category: result.category });
});

/**
 * HARD delete (unlike elements): cascades to elements, default prompts and
 * user overrides. Generation history is untouched — it keeps the denormalized
 * welCategoryKey/welElementName, so old batches and their ZIPs still work.
 * The audit entry keeps the full category snapshot.
 */
welcomeAdminRouter.delete("/categories/:id", async (req: Request, res: Response) => {
  const result = await deleteCategoryAudited(String(req.params.id ?? ""), actorOf(req));
  if (!result.ok) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});

// ---- Elements CRUD ----

const createElementSchema = z.object({
  categoryId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
});

welcomeAdminRouter.post("/elements", async (req: Request, res: Response) => {
  const parsed = createElementSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const result = await createElement(parsed.data, actorOf(req));
  if (!result.ok) {
    const status = result.error === "category_not_found" ? 404 : 409;
    res.status(status).json({ error: result.error });
    return;
  }
  res.status(201).json({ element: { id: result.element.id, ...result.snapshot } });
});

const patchElementSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  order: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  referenceImages: z.array(z.string().trim()).max(2).optional(),
});

welcomeAdminRouter.patch("/elements/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "");
  const parsed = patchElementSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
  const result = await updateElementAudited(id, patch, actorOf(req));
  if (!result.ok) {
    if (result.error === "element_not_found") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(409).json({ error: result.error });
    return;
  }
  const { prompt: _prompt, ...element } = result.snapshot;
  res.json({ element: { id, ...element } });
});

/** Soft delete: history (Generation rows) keeps the denormalized name. */
welcomeAdminRouter.delete("/elements/:id", async (req: Request, res: Response) => {
  const result = await softDeleteElement(String(req.params.id ?? ""), actorOf(req));
  if (!result.ok) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});

// ---- Default prompts ----

const putPromptSchema = z.object({
  elementId: z.string().min(1),
  content: z.string().trim().min(1).max(5000),
});

welcomeAdminRouter.put("/prompts", async (req: Request, res: Response) => {
  const parsed = putPromptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { elementId, content } = parsed.data;
  // updatedAt bumps on every write — users with an override see the
  // "default changed" banner (their baseUpdatedAt snapshot is now older).
  const result = await updateElementAudited(elementId, { prompt: content }, actorOf(req));
  if (!result.ok) {
    if (result.error === "element_not_found") {
      res.status(404).json({ error: "element_not_found" });
      return;
    }
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ prompt: { elementId, content } });
});

// ---- System wrapper ----

const systemPromptSchema = z.object({ content: z.string().trim().min(1).max(10000) });

welcomeAdminRouter.put("/system-prompt", async (req: Request, res: Response) => {
  const parsed = systemPromptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  res.json({ systemPrompt: await saveSystemPrompt(parsed.data.content, actorOf(req)) });
});

// ---- Own-reference upload (same flow as the admin NanoRef upload) ----

/** ~10 MB of binary once base64-decoded — a hard stop before Cloudinary. */
const MAX_DATA_URL_CHARS = 14_000_000;
const uploadSchema = z.object({ dataUrl: z.string().min(1) });

welcomeAdminRouter.post("/upload", async (req: Request, res: Response) => {
  if (!cloudinaryConfigured) {
    res.status(503).json({ error: "cloudinary_not_configured" });
    return;
  }
  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  if (parsed.data.dataUrl.length > MAX_DATA_URL_CHARS) {
    res.status(413).json({ error: "file_too_large" });
    return;
  }
  const folder = `welcome/own-refs/${new Date().toISOString().slice(0, 10)}`;
  const up = await withRetry(
    () => uploadBase64(parsed.data.dataUrl, `welref_${Date.now()}`, folder),
    "welcome_admin_upload",
  );
  if (up.success && up.secure_url) {
    res.json({ secure_url: up.secure_url });
  } else {
    res.status(502).json({ error: up.error ?? "upload_failed" });
  }
});
