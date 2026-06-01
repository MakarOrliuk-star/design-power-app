import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

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
