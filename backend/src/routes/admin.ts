import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { cloudinaryConfigured } from "../env.js";
import { uploadBase64, withRetry } from "../lib/cloudinary.js";

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
  role: z.enum(["ADMIN", "DESIGNER"]).optional(),
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
    if (parsed.data.role === "DESIGNER" || parsed.data.isActive === false) {
      res.status(400).json({ error: "cannot_modify_self" });
      return;
    }
  }

  // Build the update payload without explicit `undefined` (exactOptionalPropertyTypes).
  const data: { role?: "ADMIN" | "DESIGNER"; isActive?: boolean } = {};
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

/** Brands with their NanoRef images + PERSON prompt, plus all ITEM prompts. */
adminRouter.get("/catalog", async (_req: Request, res: Response) => {
  const [brands, personPrompts, itemPrompts] = await Promise.all([
    prisma.brand.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, nanoRef: { select: { referenceImages: true } } },
    }),
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
      referenceImages: b.nanoRef?.referenceImages ?? [],
      personPrompt: personByKey.get(b.name.toLowerCase()) ?? "",
    })),
    itemPrompts: itemPrompts.map((p) => ({ key: p.key, content: p.content })),
  });
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
