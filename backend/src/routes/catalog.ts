import { Router } from "express";
import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";

// Mounted behind loadUser + requireAuth (see index.ts). Read-only catalog data
// for the Home generator + per-user favorite toggles.
export const catalogRouter: Router = Router();

/** Everything the Home page needs in one round-trip. */
catalogRouter.get("/home", async (req: Request, res: Response) => {
  const userId = req.user!.sub;

  const [brands, categories, themes, itemStyles] = await Promise.all([
    prisma.brand.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        categories: { select: { categoryId: true } },
        favorites: { where: { userId }, select: { userId: true } },
        nanoRef: { select: { id: true } },
      },
    }),
    prisma.brandCategory.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }] }),
    prisma.theme.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }] }),
    // Item styles = the configured ITEM prompt-template keys (separate from brands).
    prisma.promptTemplate.findMany({
      where: { type: "ITEM" },
      orderBy: { key: "asc" },
      select: { key: true },
    }),
  ]);

  res.json({
    brands: brands.map((b) => ({
      id: b.id,
      name: b.name,
      categoryIds: b.categories.map((c) => c.categoryId),
      isFavorite: b.favorites.length > 0,
      hasNanoRef: b.nanoRef !== null,
    })),
    categories: categories.map((c) => ({ id: c.id, name: c.name, order: c.order })),
    themes: themes.map((t) => ({ id: t.id, name: t.name })),
    itemStyles: itemStyles.map((p) => p.key),
  });
});

/** Add a brand to the current user's favorites (idempotent). */
catalogRouter.post("/favorites/:brandId", async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const brandId = req.params.brandId;
  if (typeof brandId !== "string" || !brandId) {
    res.status(400).json({ error: "brandId_required" });
    return;
  }

  const brand = await prisma.brand.findUnique({ where: { id: brandId }, select: { id: true } });
  if (!brand) {
    res.status(404).json({ error: "brand_not_found" });
    return;
  }

  await prisma.brandFavorite.upsert({
    where: { userId_brandId: { userId, brandId } },
    create: { userId, brandId },
    update: {},
  });
  res.json({ ok: true });
});

/** Remove a brand from the current user's favorites (idempotent). */
catalogRouter.delete("/favorites/:brandId", async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const brandId = req.params.brandId;
  if (typeof brandId !== "string" || !brandId) {
    res.status(400).json({ error: "brandId_required" });
    return;
  }

  await prisma.brandFavorite.deleteMany({ where: { userId, brandId } });
  res.json({ ok: true });
});
