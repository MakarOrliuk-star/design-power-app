import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { cloudinaryConfigured } from "../env.js";
import { uploadBase64, withRetry } from "../lib/cloudinary.js";
import {
  TOURNAMENT_MODES,
  createCategory,
  createElement,
  deleteCategoryAudited,
  listChangeLog,
  loadPackConfig,
  saveSystemPrompt,
  softDeleteElement,
  updateCategoryAudited,
  updateElementAudited,
} from "../services/tournamentPack.service.js";
import type { PackActor } from "../services/tournamentPack.service.js";

/**
 * Tournament admin (Phase 4): element CRUD per category, default prompts
 * (BASE/VIP), the 2 provider references, the system wrapper. Mounted at
 * /api/tournament-admin behind requireAdminOrManager (Phase 0 decision:
 * MANAGER edits tournaments too, but never reaches the ADMIN-only /api/admin).
 *
 * The domain logic lives in services/tournamentPack.service.ts, shared with the
 * super-designer's «Edit Tournament pack» window (TASK tournament-pack) — one
 * copy of the rules, and every edit from EITHER surface lands in the same audit
 * log, which GET /change-log serves back to the panel.
 */
export const tournamentAdminRouter: Router = Router();

function actorOf(req: Request): PackActor {
  return { userId: req.user!.sub, userEmail: req.user!.email };
}

// ---- Full config (includes inactive elements + the system wrapper) ----

tournamentAdminRouter.get("/config", async (_req: Request, res: Response) => {
  res.json(await loadPackConfig());
});

// ---- Change log: who changed what, from either surface ----

tournamentAdminRouter.get("/change-log", async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
  res.json({ entries: await listChangeLog(limit) });
});

// ---- Categories CRUD ----

const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  hasModes: z.boolean(),
  fixedMode: z.enum(TOURNAMENT_MODES).nullable().optional(),
});

tournamentAdminRouter.post("/categories", async (req: Request, res: Response) => {
  const parsed = createCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { name, hasModes } = parsed.data;
  // Base+VIP categories never carry fixedMode; single-mode ones must say which.
  const fixedMode = hasModes ? null : (parsed.data.fixedMode ?? null);
  if (!hasModes && !fixedMode) {
    res.status(400).json({ error: "invalid_mode_config" });
    return;
  }
  const result = await createCategory({ name, hasModes, fixedMode }, actorOf(req));
  res.status(201).json({ category: result.category });
});

const patchCategorySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  order: z.number().int().min(0).optional(),
});

/** Rename/reorder only — key and the Base/VIP config are frozen at creation. */
tournamentAdminRouter.patch("/categories/:id", async (req: Request, res: Response) => {
  const parsed = patchCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const patch: { name?: string; order?: number } = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.order !== undefined) patch.order = parsed.data.order;

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
 * tourCategoryKey/tourElementName, so old batches and their ZIPs still work.
 * The audit entry keeps the full category snapshot.
 */
tournamentAdminRouter.delete("/categories/:id", async (req: Request, res: Response) => {
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
  nameVip: z.string().trim().min(1).max(120).optional(),
});

tournamentAdminRouter.post("/elements", async (req: Request, res: Response) => {
  const parsed = createElementSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const result = await createElement(parsed.data, actorOf(req));
  if (!result.ok) {
    if (result.error === "category_not_found") {
      res.status(404).json({ error: "category_not_found" });
      return;
    }
    if (result.error === "already_exists") {
      res.status(409).json({ error: "already_exists" });
      return;
    }
    // hasModes categories carry a separate VIP name (required).
    res.status(400).json({ error: "invalid_body", details: { nameVip: ["required"] } });
    return;
  }
  res.status(201).json({ element: { id: result.element.id, ...result.snapshot } });
});

const patchElementSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  nameVip: z.string().trim().min(1).max(120).optional(),
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
  // Only pass the keys the client actually sent (exactOptionalPropertyTypes).
  const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
  const result = await updateElementAudited(id, patch, actorOf(req));
  if (!result.ok) {
    if (result.error === "element_not_found") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (result.error === "already_exists") {
      res.status(409).json({ error: "already_exists" });
      return;
    }
    if (result.error === "vip_not_applicable") {
      res.status(400).json({ error: "invalid_body", details: { nameVip: ["not_applicable"] } });
      return;
    }
    res.status(400).json({ error: result.error });
    return;
  }
  const { prompts: _prompts, ...element } = result.snapshot;
  res.json({ element: { id, ...element } });
});

/** Soft delete: history (Generation rows) keeps the denormalized name. */
tournamentAdminRouter.delete("/elements/:id", async (req: Request, res: Response) => {
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
  mode: z.enum(TOURNAMENT_MODES),
  content: z.string().trim().min(1).max(5000),
});

tournamentAdminRouter.put("/prompts", async (req: Request, res: Response) => {
  const parsed = putPromptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { elementId, mode, content } = parsed.data;
  // updatedAt bumps on every write — users with an override see the
  // "default changed" banner (their baseUpdatedAt snapshot is now older).
  const result = await updateElementAudited(
    elementId,
    { prompts: [{ mode, content }] },
    actorOf(req),
  );
  if (!result.ok) {
    if (result.error === "element_not_found") {
      res.status(404).json({ error: "element_not_found" });
      return;
    }
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ prompt: { elementId, mode, content } });
});

// ---- System wrapper ----

const systemPromptSchema = z.object({ content: z.string().trim().min(1).max(10000) });

tournamentAdminRouter.put("/system-prompt", async (req: Request, res: Response) => {
  const parsed = systemPromptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  res.json({ systemPrompt: await saveSystemPrompt(parsed.data.content, actorOf(req)) });
});

// ---- Provider reference upload (same flow as the admin NanoRef upload) ----

/** ~10 MB of binary once base64-decoded — a hard stop before Cloudinary. */
const MAX_DATA_URL_CHARS = 14_000_000;
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
  if (parsed.data.dataUrl.length > MAX_DATA_URL_CHARS) {
    res.status(413).json({ error: "file_too_large" });
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
