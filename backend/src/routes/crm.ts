import { Router } from "express";
import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";

// Mounted behind loadUser + requireAuth + requireZone("CRM") (see index.ts).
// Per-user favorite CRM services. Services are a static list (not DB rows), so
// favorites are keyed by a string serviceKey validated against this allowlist.
// Only services with real logic are favoritable — "soon" tiles are excluded.
//
// IMPORTANT: keep this set in sync with the non-`soon` service keys in
// frontend/app/pages/crm.vue (SERVICES). A working tile that is missing here
// can't be favorited — its star silently reverts (400 invalid_service_key).
export const crmRouter: Router = Router();

const VALID_SERVICE_KEYS = new Set([
  "calculator",
  "bonuscalc",
  "auditor",
  "smartico",
  "chrome_extensions",
  "prioritycalc",
  // Image Bundles (TASK crm-bundle). Favoriting is allowed for any CRM-zone
  // user, but the tile itself is role-gated on the FE and the /api/bundles
  // router by requireCrmSuper — a favorite alone grants nothing.
  "bundles",
]);

/** Current user's favorite service keys. */
crmRouter.get("/favorites", async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const favorites = await prisma.crmServiceFavorite.findMany({
    where: { userId },
    select: { serviceKey: true },
  });
  res.json({ favorites: favorites.map((f) => f.serviceKey) });
});

/** Add a service to the current user's favorites (idempotent). */
crmRouter.post("/favorites/:serviceKey", async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const serviceKey = req.params.serviceKey;
  if (typeof serviceKey !== "string" || !VALID_SERVICE_KEYS.has(serviceKey)) {
    res.status(400).json({ error: "invalid_service_key" });
    return;
  }

  await prisma.crmServiceFavorite.upsert({
    where: { userId_serviceKey: { userId, serviceKey } },
    create: { userId, serviceKey },
    update: {},
  });
  res.json({ ok: true });
});

/** Remove a service from the current user's favorites (idempotent). */
crmRouter.delete("/favorites/:serviceKey", async (req: Request, res: Response) => {
  const userId = req.user!.sub;
  const serviceKey = req.params.serviceKey;
  if (typeof serviceKey !== "string" || !serviceKey) {
    res.status(400).json({ error: "serviceKey_required" });
    return;
  }

  await prisma.crmServiceFavorite.deleteMany({ where: { userId, serviceKey } });
  res.json({ ok: true });
});
