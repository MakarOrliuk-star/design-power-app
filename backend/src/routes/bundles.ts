import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {
  editAsset,
  launchGeneration,
  listBundleBrands,
  regenerateAsset,
} from "../services/bundle.service.js";
import { sendBundleToSmartico } from "../services/bundleSmartico.service.js";
import type { BundleTypeAsset } from "../services/bundle.service.js";
import { canApproveAsset } from "../services/bundleStatus.js";
import type { BundleAssetStatus } from "../services/bundleStatus.js";

// Image Bundles API (TASK crm-bundle, R-PLAN §7). Mounted behind loadUser +
// requireAuth + requireCrmSuper (see index.ts) — CRM_SUPER / ADMIN / MANAGER
// only (D4). Statuses per D1: draft/generating/completed/failed, no Scheduled.
export const bundlesRouter: Router = Router();

const MAX_PROMPT = 1500;
const PAGE_SIZE = 8; // left panel shows "1–8 of 24"

const STATUS_FILTERS = ["all", "draft", "generating", "completed", "failed"] as const;

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  plannedSendAt: z.string().datetime({ offset: true }).nullish(),
  neuralPrompt: z.string().max(MAX_PROMPT).optional(),
  bundleTypeKey: z.string().optional(), // defaults to the first active type
  brandNames: z.array(z.string().trim().min(1)).max(500).optional(),
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  plannedSendAt: z.string().datetime({ offset: true }).nullable().optional(),
  neuralPrompt: z.string().max(MAX_PROMPT).optional(),
  brandNames: z.array(z.string().trim().min(1)).max(500).optional(),
});

const approveSchema = z.object({
  assetIds: z.array(z.string().min(1)).min(1).max(500),
  approved: z.boolean().default(true),
});

/** Express types params as string | string[] — narrow or 400 (house pattern). */
function paramId(req: Request, res: Response, name = "id"): string | null {
  const value = req.params[name];
  if (typeof value !== "string" || !value) {
    res.status(400).json({ error: `${name}_required` });
    return null;
  }
  return value;
}

/** Wizard metadata: active bundle types, prompt presets, grouped brands. */
bundlesRouter.get("/meta", async (_req: Request, res: Response) => {
  const [types, presets, brands] = await Promise.all([
    prisma.bundleType.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, key: true, title: true, description: true, assets: true },
    }),
    prisma.neuralPromptPreset.findMany({
      where: { isActive: true },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      select: { id: true, title: true, text: true },
    }),
    listBundleBrands(),
  ]);
  res.json({ bundleTypes: types, presets, brands });
});

/** Project list: search + status tabs + pagination + per-status counts. */
bundlesRouter.get("/", async (req: Request, res: Response) => {
  const statusRaw = typeof req.query.status === "string" ? req.query.status.toLowerCase() : "all";
  const status = (STATUS_FILTERS as readonly string[]).includes(statusRaw) ? statusRaw : "all";
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);

  const where = {
    ...(status !== "all" ? { status: status.toUpperCase() as never } : {}),
    ...(search ? { name: { contains: search, mode: "insensitive" as const } } : {}),
  };

  const [items, total, grouped] = await Promise.all([
    prisma.bundle.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        name: true,
        status: true,
        plannedSendAt: true,
        createdAt: true,
        brandNames: true,
        variants: { select: { displayName: true }, orderBy: { brandName: "asc" } },
      },
    }),
    prisma.bundle.count({ where }),
    prisma.bundle.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  const counts: Record<string, number> = { all: 0, draft: 0, generating: 0, completed: 0, failed: 0 };
  for (const g of grouped) {
    counts[g.status.toLowerCase()] = g._count._all;
    counts.all = (counts.all ?? 0) + g._count._all;
  }

  res.json({
    bundles: items.map((b) => ({
      id: b.id,
      name: b.name,
      status: b.status.toLowerCase(),
      plannedSendAt: b.plannedSendAt,
      createdAt: b.createdAt,
      // Card subtitle: expanded variants once generated, base names before.
      brandLabels: b.variants.length
        ? b.variants.map((v) => v.displayName)
        : ((b.brandNames as string[]) ?? []),
    })),
    total,
    page,
    pageSize: PAGE_SIZE,
    counts,
  });
});

/** Create a draft (wizard step 1). */
bundlesRouter.post("/", async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const bundleType = parsed.data.bundleTypeKey
    ? await prisma.bundleType.findFirst({ where: { key: parsed.data.bundleTypeKey, isActive: true } })
    : await prisma.bundleType.findFirst({ where: { isActive: true }, orderBy: { createdAt: "asc" } });
  if (!bundleType) {
    res.status(400).json({ error: "unknown_bundle_type" });
    return;
  }
  const bundle = await prisma.bundle.create({
    data: {
      name: parsed.data.name,
      plannedSendAt: parsed.data.plannedSendAt ? new Date(parsed.data.plannedSendAt) : null,
      neuralPrompt: parsed.data.neuralPrompt ?? "",
      brandNames: parsed.data.brandNames ?? [],
      bundleTypeId: bundleType.id,
      createdById: req.user!.sub,
    },
    select: { id: true, name: true, status: true },
  });
  res.status(201).json({ bundle: { ...bundle, status: bundle.status.toLowerCase() } });
});

/** Bundle details for the Result screen (variants + assets + summary). */
bundlesRouter.get("/:id", async (req: Request, res: Response) => {
  const id = paramId(req, res);
  if (!id) return;
  const bundle = await prisma.bundle.findUnique({
    where: { id },
    include: {
      bundleType: { select: { key: true, title: true, assets: true } },
      variants: {
        orderBy: { brandName: "asc" },
        include: { assets: { orderBy: { assetKey: "asc" } } },
      },
    },
  });
  if (!bundle) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const typeAssets = bundle.bundleType.assets as unknown as BundleTypeAsset[];
  const orderOf = new Map(typeAssets.map((a, i) => [a.key, i]));
  const labelOf = new Map(typeAssets.map((a) => [a.key, a.label]));

  let assetTotal = 0;
  let assetDone = 0;
  let approvedCount = 0;
  const variants = bundle.variants.map((v) => {
    const assets = [...v.assets]
      .sort((a, b) => (orderOf.get(a.assetKey) ?? 99) - (orderOf.get(b.assetKey) ?? 99))
      .map((a) => {
        assetTotal += 1;
        if (a.status === "DONE") assetDone += 1;
        if (a.approved) approvedCount += 1;
        return {
          id: a.id,
          assetKey: a.assetKey,
          label: labelOf.get(a.assetKey) ?? a.assetKey,
          width: a.width,
          height: a.height,
          imageUrl: a.imageUrl,
          status: a.status.toLowerCase(),
          approved: a.approved,
          errorMessage: a.errorMessage,
        };
      });
    return {
      id: v.id,
      brandName: v.brandName,
      displayName: v.displayName,
      assets,
      approvedCount: assets.filter((a) => a.approved).length,
    };
  });

  res.json({
    bundle: {
      id: bundle.id,
      name: bundle.name,
      status: bundle.status.toLowerCase(),
      plannedSendAt: bundle.plannedSendAt,
      neuralPrompt: bundle.neuralPrompt,
      brandNames: (bundle.brandNames as string[]) ?? [],
      createdAt: bundle.createdAt,
      updatedAt: bundle.updatedAt,
      bundleType: bundle.bundleType,
      variants,
      summary: {
        variantCount: variants.length,
        assetTotal,
        assetDone,
        approvedCount,
      },
    },
  });
});

/** Edit name / planned date / prompt any time; brands only while DRAFT. */
bundlesRouter.patch("/:id", async (req: Request, res: Response) => {
  const id = paramId(req, res);
  if (!id) return;
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const bundle = await prisma.bundle.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!bundle) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (parsed.data.brandNames !== undefined && bundle.status !== "DRAFT") {
    // The variant expansion is snapshotted at first launch — changing brands
    // afterwards would desync variants/assets (create a new bundle instead).
    res.status(409).json({ error: "brands_locked" });
    return;
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.plannedSendAt !== undefined)
    data.plannedSendAt = parsed.data.plannedSendAt ? new Date(parsed.data.plannedSendAt) : null;
  if (parsed.data.neuralPrompt !== undefined) data.neuralPrompt = parsed.data.neuralPrompt;
  if (parsed.data.brandNames !== undefined) data.brandNames = parsed.data.brandNames;

  const updated = await prisma.bundle.update({
    where: { id: bundle.id },
    data,
    select: { id: true, name: true, status: true, plannedSendAt: true, neuralPrompt: true, brandNames: true },
  });
  res.json({ bundle: { ...updated, status: updated.status.toLowerCase() } });
});

/** Delete a bundle (cascade removes variants/assets/sends). */
bundlesRouter.delete("/:id", async (req: Request, res: Response) => {
  const id = paramId(req, res);
  if (!id) return;
  try {
    await prisma.bundle.delete({ where: { id } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});

/** Launch generation (wizard "Generate bundle") / full re-run. */
bundlesRouter.post("/:id/generate", async (req: Request, res: Response) => {
  const id = paramId(req, res);
  if (!id) return;
  const result = await launchGeneration(id);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (!result.ok) {
    const codes = { already_generating: 409, no_brands: 400, queue_unavailable: 503 } as const;
    res.status(codes[result.error]).json({ error: result.error });
    return;
  }
  res.status(202).json({ ok: true, variantCount: result.variantCount, assetCount: result.assetCount });
});

/** Regenerate all = the same full re-run as generate (R-PLAN §6). */
bundlesRouter.post("/:id/regenerate-all", async (req: Request, res: Response) => {
  const id = paramId(req, res);
  if (!id) return;
  const result = await launchGeneration(id);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (!result.ok) {
    const codes = { already_generating: 409, no_brands: 400, queue_unavailable: 503 } as const;
    res.status(codes[result.error]).json({ error: result.error });
    return;
  }
  res.status(202).json({ ok: true });
});

/** Regenerate a single asset (stage B only — reuses the variant's person/item). */
bundlesRouter.post("/:id/assets/:assetId/regenerate", async (req: Request, res: Response) => {
  const id = paramId(req, res);
  if (!id) return;
  const assetId = paramId(req, res, "assetId");
  if (!assetId) return;
  const result = await regenerateAsset(id, assetId);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (!result.ok) {
    res.status(result.error === "in_flight" ? 409 : 503).json({ error: result.error });
    return;
  }
  res.status(202).json({ ok: true });
});

const editSchema = z.object({ prompt: z.string().trim().min(1).max(MAX_PROMPT) });

/** Text-prompt Edit of a finished asset (D9) — replaces it in place. */
bundlesRouter.post("/:id/assets/:assetId/edit", async (req: Request, res: Response) => {
  const id = paramId(req, res);
  if (!id) return;
  const assetId = paramId(req, res, "assetId");
  if (!assetId) return;
  const parsed = editSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const result = await editAsset(id, assetId, parsed.data.prompt);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (!result.ok) {
    res.status(result.error === "not_editable" ? 409 : 503).json({ error: result.error });
    return;
  }
  res.status(202).json({ ok: true });
});

/** Approve / unapprove assets (single or batch). Only DONE assets count. */
bundlesRouter.post("/:id/assets/approve", async (req: Request, res: Response) => {
  const id = paramId(req, res);
  if (!id) return;
  const parsed = approveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const assets = await prisma.bundleAsset.findMany({
    where: { id: { in: parsed.data.assetIds }, bundleId: id },
    select: { id: true, status: true },
  });
  const eligible = assets
    .filter((a) => canApproveAsset(a.status as BundleAssetStatus))
    .map((a) => a.id);
  if (eligible.length > 0) {
    await prisma.bundleAsset.updateMany({
      where: { id: { in: eligible } },
      data: { approved: parsed.data.approved },
    });
  }
  res.json({ ok: true, updated: eligible.length, skipped: parsed.data.assetIds.length - eligible.length });
});

/**
 * Send to Smartico (Phase 6, D6): approved assets → smartico/<namespace>
 * Cloudinary folder (MD5 dedup, idempotent re-send) + paste-ready JS function
 * snippets, grouped into Men/Women tone buckets (D14). Synchronous — the
 * images are already hosted, only small re-uploads happen here.
 */
bundlesRouter.post("/:id/send-smartico", async (req: Request, res: Response) => {
  const id = paramId(req, res);
  if (!id) return;
  const result = await sendBundleToSmartico(id);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (!result.ok) {
    const codes = { no_approved_assets: 400, cloudinary_not_configured: 503 } as const;
    res.status(codes[result.error]).json({ error: result.error });
    return;
  }
  res.json({ ok: true, sendId: result.sendId, outputs: result.outputs, stats: result.stats });
});

/** Send history (latest first) — lets the user re-open past snippets. */
bundlesRouter.get("/:id/sends", async (req: Request, res: Response) => {
  const id = paramId(req, res);
  if (!id) return;
  const sends = await prisma.bundleSend.findMany({
    where: { bundleId: id },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, status: true, outputs: true, stats: true, createdAt: true },
  });
  res.json({ sends });
});
