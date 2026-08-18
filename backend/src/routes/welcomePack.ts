import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { cloudinaryConfigured } from "../env.js";
import { uploadBase64, withRetry } from "../lib/cloudinary.js";
import {
  createCategory,
  createElement,
  deleteCategoryAudited,
  loadPackConfig,
  reorderCategories,
  reorderElements,
  rollbackElement,
  saveSystemPrompt,
  softDeleteElement,
  updateCategoryAudited,
  updateElementAudited,
} from "../services/welcomePack.service.js";
import type { PackActor } from "../services/welcomePack.service.js";

/**
 * «Edit Welcome packs» (TASK welcome-packs): the super-designer's window,
 * mounted at /api/welcome-pack behind requireSuperDesigner. Same data as the
 * admin panel's Welcome section, but every write is audited and elements are
 * rollback-able — see services/welcomePack.service.ts.
 *
 * Deliberately separate from /api/welcome-admin (mirroring the tournament
 * split): the admin surface keeps its own endpoints, so nothing a
 * super-designer does here can regress the admin panel.
 */
export const welcomePackRouter: Router = Router();

function actorOf(req: Request): PackActor {
  return { userId: req.user!.sub, userEmail: req.user!.email };
}

// ---- Full pack (categories + elements + prompts + the system wrapper) ----

welcomePackRouter.get("/config", async (_req: Request, res: Response) => {
  res.json(await loadPackConfig());
});

// ---- Categories ----

const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  usesOwnReferences: z.boolean().default(false),
});

welcomePackRouter.post("/categories", async (req: Request, res: Response) => {
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
  usesOwnReferences: z.boolean().optional(),
});

/** Rename + the own-references flag. The key stays frozen at creation. */
welcomePackRouter.patch("/categories/:id", async (req: Request, res: Response) => {
  const parsed = patchCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
  const result = await updateCategoryAudited(String(req.params.id ?? ""), patch, actorOf(req));
  if (!result.ok) {
    res.status(404).json({ error: result.error });
    return;
  }
  res.json({ category: result.category });
});

const reorderSchema = z.object({ orderedIds: z.array(z.string().min(1)).min(1) });

welcomePackRouter.post("/categories/reorder", async (req: Request, res: Response) => {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const result = await reorderCategories(parsed.data.orderedIds, actorOf(req));
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

/** HARD delete — the audit entry keeps the full category+elements snapshot. */
welcomePackRouter.delete("/categories/:id", async (req: Request, res: Response) => {
  const result = await deleteCategoryAudited(String(req.params.id ?? ""), actorOf(req));
  if (!result.ok) {
    res.status(404).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

// ---- Elements ----

const createElementSchema = z.object({
  categoryId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
});

welcomePackRouter.post("/elements", async (req: Request, res: Response) => {
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
  res.status(201).json({ element: result.element, snapshot: result.snapshot });
});

/**
 * The one save behind «Сохранить (для всех)»: name, prompt, own references and
 * the active flag in a single audited write.
 */
const patchElementSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
  referenceImages: z.array(z.string().trim()).max(2).optional(),
  prompt: z.string().trim().min(1).max(5000).optional(),
});

/** Domain errors → HTTP status; shared by PATCH and rollback. */
function elementErrorStatus(error: string): number {
  if (error === "element_not_found") return 404;
  if (error === "already_exists") return 409;
  if (error === "nothing_to_rollback") return 409;
  return 400;
}

welcomePackRouter.patch("/elements/:id", async (req: Request, res: Response) => {
  const parsed = patchElementSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  // Drop keys the client did not send (exactOptionalPropertyTypes).
  const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
  const result = await updateElementAudited(String(req.params.id ?? ""), patch, actorOf(req));
  if (!result.ok) {
    res.status(elementErrorStatus(result.error)).json({ error: result.error });
    return;
  }
  res.json({ snapshot: result.snapshot, changed: result.changed });
});

const reorderElementsSchema = z.object({
  categoryId: z.string().min(1),
  orderedIds: z.array(z.string().min(1)).min(1),
});

welcomePackRouter.post("/elements/reorder", async (req: Request, res: Response) => {
  const parsed = reorderElementsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const result = await reorderElements(
    parsed.data.categoryId,
    parsed.data.orderedIds,
    actorOf(req),
  );
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

/** Soft delete (isActive=false) — generation history keeps the name. */
welcomePackRouter.delete("/elements/:id", async (req: Request, res: Response) => {
  const result = await softDeleteElement(String(req.params.id ?? ""), actorOf(req));
  if (!result.ok) {
    res.status(404).json({ error: result.error });
    return;
  }
  res.json({ ok: true, snapshot: result.snapshot });
});

welcomePackRouter.post("/elements/:id/rollback", async (req: Request, res: Response) => {
  const result = await rollbackElement(String(req.params.id ?? ""), actorOf(req));
  if (!result.ok) {
    res.status(elementErrorStatus(result.error)).json({ error: result.error });
    return;
  }
  res.json({ snapshot: result.snapshot });
});

// ---- System wrapper ----

const systemPromptSchema = z.object({ content: z.string().trim().min(1).max(10000) });

welcomePackRouter.put("/system-prompt", async (req: Request, res: Response) => {
  const parsed = systemPromptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  res.json({ systemPrompt: await saveSystemPrompt(parsed.data.content, actorOf(req)) });
});

// ---- Own-reference upload ----

/** ~10 MB of binary once base64-decoded — a hard stop before Cloudinary. */
const MAX_DATA_URL_CHARS = 14_000_000;
const uploadSchema = z.object({ dataUrl: z.string().min(1) });

welcomePackRouter.post("/upload", async (req: Request, res: Response) => {
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
    "welcome_pack_upload",
  );
  if (up.success && up.secure_url) {
    res.json({ secure_url: up.secure_url });
  } else {
    res.status(502).json({ error: up.error ?? "upload_failed" });
  }
});
