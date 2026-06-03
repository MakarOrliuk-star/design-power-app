import { Router } from "express";
import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";

// Mounted behind loadUser + requireAuth (see index.ts). Read-only catalog data
// for the Home generator + per-user favorite toggles.
export const catalogRouter: Router = Router();

/** Everything the Home page needs in one round-trip. */
catalogRouter.get("/home", async (req: Request, res: Response) => {
  const userId = req.user!.sub;

  const [brands, categories, themes, itemStyles, itemFavorites] = await Promise.all([
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
    // This user's favorite Item styles (keyed by style name).
    prisma.itemStyleFavorite.findMany({ where: { userId }, select: { styleKey: true } }),
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
    itemStyleFavorites: itemFavorites.map((f) => f.styleKey),
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

/** Add an Item style to the current user's favorites (idempotent). */
catalogRouter.post("/item-favorites/:styleKey", async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const styleKey = req.params.styleKey; // URL-decoded by Express
  if (typeof styleKey !== "string" || !styleKey) {
    res.status(400).json({ error: "styleKey_required" });
    return;
  }

  // Guard against junk keys: the style must exist as an ITEM prompt template.
  const style = await prisma.promptTemplate.findFirst({
    where: { type: "ITEM", key: styleKey },
    select: { id: true },
  });
  if (!style) {
    res.status(404).json({ error: "style_not_found" });
    return;
  }

  await prisma.itemStyleFavorite.upsert({
    where: { userId_styleKey: { userId, styleKey } },
    create: { userId, styleKey },
    update: {},
  });
  res.json({ ok: true });
});

/** Remove an Item style from the current user's favorites (idempotent). */
catalogRouter.delete("/item-favorites/:styleKey", async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const styleKey = req.params.styleKey;
  if (typeof styleKey !== "string" || !styleKey) {
    res.status(400).json({ error: "styleKey_required" });
    return;
  }

  await prisma.itemStyleFavorite.deleteMany({ where: { userId, styleKey } });
  res.json({ ok: true });
});
