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
  loadPackConfig,
  reorderCategories,
  reorderElements,
  rollbackElement,
  saveSystemPrompt,
  softDeleteElement,
  updateCategoryAudited,
  updateElementAudited,
} from "../services/tournamentPack.service.js";
import type { PackActor } from "../services/tournamentPack.service.js";

/**
 * «Edit Tournament pack» (TASK tournament-pack): the super-designer's window on
 * Home, mounted at /api/tournament-pack behind requireSuperDesigner. Same data
 * as the admin panel's Tournaments section, but every write is audited and
 * elements are rollback-able — see services/tournamentPack.service.ts.
 *
 * This router is deliberately separate from /api/tournament-admin: the admin
 * surface keeps its own (unaudited, per-field) endpoints untouched, so nothing
 * a super-designer does here can regress the admin panel.
 */
export const tournamentPackRouter: Router = Router();

function actorOf(req: Request): PackActor {
  return { userId: req.user!.sub, userEmail: req.user!.email };
}

// ---- Full pack (categories + elements + prompts + the system wrapper) ----

tournamentPackRouter.get("/config", async (_req: Request, res: Response) => {
  res.json(await loadPackConfig());
});

// ---- Categories ----

const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  hasModes: z.boolean(),
  fixedMode: z.enum(TOURNAMENT_MODES).nullable().optional(),
});

tournamentPackRouter.post("/categories", async (req: Request, res: Response) => {
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

const renameCategorySchema = z.object({ name: z.string().trim().min(1).max(120) });

tournamentPackRouter.patch("/categories/:id", async (req: Request, res: Response) => {
  const parsed = renameCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const result = await updateCategoryAudited(
    String(req.params.id ?? ""),
    { name: parsed.data.name },
    actorOf(req),
  );
  if (!result.ok) {
    res.status(404).json({ error: result.error });
    return;
  }
  res.json({ category: result.category });
});

const reorderSchema = z.object({ orderedIds: z.array(z.string().min(1)).min(1) });

tournamentPackRouter.post("/categories/reorder", async (req: Request, res: Response) => {
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
tournamentPackRouter.delete("/categories/:id", async (req: Request, res: Response) => {
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
  nameVip: z.string().trim().min(1).max(120).optional(),
});

tournamentPackRouter.post("/elements", async (req: Request, res: Response) => {
  const parsed = createElementSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const result = await createElement(parsed.data, actorOf(req));
  if (!result.ok) {
    const status =
      result.error === "category_not_found" ? 404 : result.error === "already_exists" ? 409 : 400;
    res.status(status).json({ error: result.error });
    return;
  }
  res.status(201).json({ element: result.element, snapshot: result.snapshot });
});

/**
 * The one save behind «Сохранить (для всех)»: names, both prompts, provider
 * refs and the active flag in a single audited write.
 */
const patchElementSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  nameVip: z.string().trim().min(1).max(120).nullable().optional(),
  isActive: z.boolean().optional(),
  referenceImages: z.array(z.string().trim()).max(2).optional(), // provider refs
  prompts: z
    .array(z.object({ mode: z.enum(TOURNAMENT_MODES), content: z.string().trim().min(1).max(5000) }))
    .max(2)
    .optional(),
});

/** Domain errors → HTTP status; shared by PATCH and rollback. */
function elementErrorStatus(error: string): number {
  if (error === "element_not_found") return 404;
  if (error === "already_exists") return 409;
  if (error === "nothing_to_rollback") return 409;
  return 400;
}

tournamentPackRouter.patch("/elements/:id", async (req: Request, res: Response) => {
  const parsed = patchElementSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  // Drop keys the client did not send (exactOptionalPropertyTypes).
  const patch = Object.fromEntries(
    Object.entries(parsed.data).filter(([, v]) => v !== undefined),
  );
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

tournamentPackRouter.post("/elements/reorder", async (req: Request, res: Response) => {
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
tournamentPackRouter.delete("/elements/:id", async (req: Request, res: Response) => {
  const result = await softDeleteElement(String(req.params.id ?? ""), actorOf(req));
  if (!result.ok) {
    res.status(404).json({ error: result.error });
    return;
  }
  res.json({ ok: true, snapshot: result.snapshot });
});

tournamentPackRouter.post("/elements/:id/rollback", async (req: Request, res: Response) => {
  const result = await rollbackElement(String(req.params.id ?? ""), actorOf(req));
  if (!result.ok) {
    res.status(elementErrorStatus(result.error)).json({ error: result.error });
    return;
  }
  res.json({ snapshot: result.snapshot });
});

// ---- System wrapper ----

const systemPromptSchema = z.object({ content: z.string().trim().min(1).max(10000) });

tournamentPackRouter.put("/system-prompt", async (req: Request, res: Response) => {
  const parsed = systemPromptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  res.json({ systemPrompt: await saveSystemPrompt(parsed.data.content, actorOf(req)) });
});

// ---- Provider reference upload ----

/** ~10 MB of binary once base64-decoded — a hard stop before Cloudinary. */
const MAX_DATA_URL_CHARS = 14_000_000;
const uploadSchema = z.object({ dataUrl: z.string().min(1) });

tournamentPackRouter.post("/upload", async (req: Request, res: Response) => {
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
    "tournament_pack_upload",
  );
  if (up.success && up.secure_url) {
    res.json({ secure_url: up.secure_url });
  } else {
    res.status(502).json({ error: up.error ?? "upload_failed" });
  }
});
