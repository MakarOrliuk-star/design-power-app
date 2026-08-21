import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {
  editAsset,
  launchGeneration,
  listAiReferenceFormats,
  listBundleBrands,
  regenerateAsset,
} from "../services/bundle.service.js";
import { sendBundleToSmartico } from "../services/bundleSmartico.service.js";
import type { BundleTypeAsset } from "../services/bundle.service.js";
import { canApproveAsset } from "../services/bundleStatus.js";
import * as audit from "../lib/audit.js";
import type { BundleAssetStatus } from "../services/bundleStatus.js";
import { derivedAssetKeys, derivedAssetLabel } from "../services/aiReferencePipeline.js";
import { refCountsByBrand, MIN_REFS_FOR_GENERATION } from "../services/variationRefs.js";

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
  // Вариация для ai_reference (TASK ai-reference): обязательность проверяет
  // launchGeneration (preset_required), на черновике поле свободное.
  presetId: z.string().min(1).max(64).nullish(),
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  plannedSendAt: z.string().datetime({ offset: true }).nullable().optional(),
  neuralPrompt: z.string().max(MAX_PROMPT).optional(),
  brandNames: z.array(z.string().trim().min(1)).max(500).optional(),
  presetId: z.string().min(1).max(64).nullable().optional(),
});

/** presetId из запроса → существует ли активный пресет (404-гейт до записи). */
async function presetExists(presetId: string): Promise<boolean> {
  const preset = await prisma.neuralPromptPreset.findUnique({
    where: { id: presetId },
    select: { id: true },
  });
  return Boolean(preset);
}

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
      // allowText — только для показа режима в мастере (TASK no-baked-text):
      // менеджер видит, будет ли текст, но меняет настройку в админке.
      select: { id: true, title: true, text: true, allowText: true },
    }),
    listBundleBrands(),
  ]);
  res.json({ bundleTypes: types, presets, brands });
});

/**
 * Счётчики референсов вариации по базовым брендам (TASK ai-reference):
 * бейджи «7/15» и блокировка брендов с < min в мастере. Роут объявлен ДО
 * `/:id`, иначе его перехватит параметрический матч.
 *
 * TASK multiformat-promo (DI2-2): счётчики вложены по формату
 * (`{ [brand]: { [assetKey]: number } }`), а `formats` перечисляет форматы,
 * которые обязаны набрать минимум — бренд блокируется, если недобрал ХОТЯ БЫ
 * один из них.
 */
bundlesRouter.get("/ref-counts", async (req: Request, res: Response) => {
  const presetId = typeof req.query.presetId === "string" ? req.query.presetId.trim() : "";
  if (!presetId) {
    res.status(400).json({ error: "preset_id_required" });
    return;
  }
  const [counts, formats] = await Promise.all([
    refCountsByBrand(presetId),
    listAiReferenceFormats(),
  ]);
  res.json({ counts, formats, min: MIN_REFS_FOR_GENERATION });
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
  if (parsed.data.presetId && !(await presetExists(parsed.data.presetId))) {
    res.status(404).json({ error: "preset_not_found" });
    return;
  }
  const bundle = await prisma.bundle.create({
    data: {
      name: parsed.data.name,
      plannedSendAt: parsed.data.plannedSendAt ? new Date(parsed.data.plannedSendAt) : null,
      neuralPrompt: parsed.data.neuralPrompt ?? "",
      brandNames: parsed.data.brandNames ?? [],
      bundleTypeId: bundleType.id,
      presetId: parsed.data.presetId ?? null,
      createdById: req.user!.sub,
    },
    select: { id: true, name: true, status: true },
  });
  res.status(201).json({ bundle: { ...bundle, status: bundle.status.toLowerCase() } });
});

/** Composition metadata the CRM preview needs (TASK email-composition, Фаза 5).
 *  `BundleAsset.metadata` is free-form Json written by the engine, so the route
 *  projects a narrow, checked shape instead of forwarding raw rows; legacy
 *  assets (no engine render) simply get `null`. */
interface AssetPreviewMeta {
  specKey: string;
  specVersion: number;
  /** null — у формата нет safe-зоны (push/pop-up без текста, DI2-4). */
  safeZonePct: { x: number; y: number; w: number; h: number } | null;
  recommendedTextColor: string | null;
  luminance: number | null;
  textContrast: { white: number; dark: number } | null;
  retinaUrl: string | null;
  validator: { passed: boolean; attempts: number } | null;
  /** Приёмка ai_reference (стадия B): бейдж «лучший из N» + причины (DI-R10).
   *  healing — итог auto-коррекции (TASK safe-zone/auto-heal): сколько попыток
   *  лечения было и стала ли вылеченная версия финальной. */
  qa: {
    passed: boolean;
    attempts: number;
    reasons: string[];
    healing: { attempts: number; used: boolean } | null;
    /** Оценка победителя и порог приёмки (TASK multiformat-promo, DI2-5). */
    score: number | null;
    threshold: number | null;
    /**
     * Текстовый гейт финального ассета (TASK no-baked-text). null — режим
     * «текст разрешён» либо legacy-ассет, сгенерированный до правки.
     * `clean: false` — надпись осталась после лечения: ассет отдан менеджеру
     * с предупреждением, а `found` содержит прочитанный текст (ТЗ на ретушь).
     */
    textGate: { clean: boolean; found: string; skipped: boolean } | null;
  } | null;
  /**
   * Проверка осмысленности свечения (правка 2026-08-17). Пятно света стоит в
   * фиксированной точке холста, поэтому на «широких» композициях горит мимо
   * объекта. `ok: false` — повод посмотреть глазами; картинку не блокирует.
   * null — свечение выключено, проверка не отработала или legacy-ассет.
   */
  glowCheck: { ok: boolean; coverage: number } | null;
}

function isPctBox(v: unknown): v is NonNullable<AssetPreviewMeta["safeZonePct"]> {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  return ["x", "y", "w", "h"].every((k) => typeof b[k] === "number" && Number.isFinite(b[k]));
}

export function assetPreviewMeta(raw: unknown): AssetPreviewMeta | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  // Safe-зона есть не у всех форматов (DI2-4): у push/pop-up она null, но
  // остальные метаданные (в первую очередь вердикт приёмки) нужны CRM.
  // Совсем чужая metadata (без specKey ai_reference/движка) — по-прежнему null.
  const hasSafeZone = isPctBox(m.safeZonePct);
  if (!hasSafeZone && typeof m.specKey !== "string") return null;
  const contrast = m.textContrast as Record<string, unknown> | null | undefined;
  const validator = m.validator as Record<string, unknown> | null | undefined;
  return {
    specKey: typeof m.specKey === "string" ? m.specKey : "",
    specVersion: typeof m.specVersion === "number" ? m.specVersion : 0,
    safeZonePct: hasSafeZone ? (m.safeZonePct as NonNullable<AssetPreviewMeta["safeZonePct"]>) : null,
    recommendedTextColor:
      typeof m.recommendedTextColor === "string" ? m.recommendedTextColor : null,
    luminance: typeof m.luminance === "number" ? m.luminance : null,
    textContrast:
      contrast && typeof contrast.white === "number" && typeof contrast.dark === "number"
        ? { white: contrast.white, dark: contrast.dark }
        : null,
    retinaUrl: typeof m.retinaUrl === "string" ? m.retinaUrl : null,
    validator:
      validator && typeof validator.passed === "boolean"
        ? {
            passed: validator.passed,
            attempts: typeof validator.attempts === "number" ? validator.attempts : 1,
          }
        : null,
    qa: projectQaMeta(m.qa),
    glowCheck: projectGlowCheck(m.effects),
  };
}

/** metadata.effects.glowCheck → узкая проверенная проекция для CRM. */
function projectGlowCheck(raw: unknown): AssetPreviewMeta["glowCheck"] {
  if (typeof raw !== "object" || raw === null) return null;
  const check = (raw as Record<string, unknown>).glowCheck as Record<string, unknown> | null | undefined;
  if (!check || typeof check.ok !== "boolean") return null;
  return {
    ok: check.ok,
    coverage: typeof check.coverage === "number" ? check.coverage : 0,
  };
}

/** reasons произвольной попытки из metadata.qa → проверенный string[]. */
function attemptReasons(row: unknown): string[] {
  if (!row || typeof row !== "object") return [];
  const reasons = (row as Record<string, unknown>).reasons;
  return Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === "string") : [];
}

/** metadata.qa пайплайна ai_reference → узкая проверенная проекция для CRM. */
function projectQaMeta(raw: unknown): AssetPreviewMeta["qa"] {
  if (typeof raw !== "object" || raw === null) return null;
  const q = raw as Record<string, unknown>;
  if (typeof q.qaPassed !== "boolean") return null;
  const attempts = Array.isArray(q.attempts) ? q.attempts : [];
  const healingRaw = q.healing as Record<string, unknown> | null | undefined;
  const healingAttempts =
    healingRaw && Array.isArray(healingRaw.attempts) ? healingRaw.attempts : null;
  const healing = healingAttempts
    ? { attempts: healingAttempts.length, used: healingRaw!.used === true }
    : null;
  // Причины — у фактического победителя: вылеченная попытка, если финал —
  // результат лечения, иначе выбранная попытка генерации.
  const chosen =
    healing?.used && typeof healingRaw!.chosenAttempt === "number"
      ? (healingAttempts![healingRaw!.chosenAttempt] as unknown)
      : typeof q.chosenAttempt === "number"
        ? (attempts[q.chosenAttempt] as unknown)
        : null;
  const chosenScore =
    chosen && typeof chosen === "object" && typeof (chosen as Record<string, unknown>).score === "number"
      ? ((chosen as Record<string, unknown>).score as number)
      : null;
  const gate = q.textGate as Record<string, unknown> | null | undefined;
  return {
    passed: q.qaPassed,
    attempts: attempts.length,
    reasons: attemptReasons(chosen),
    healing,
    score: chosenScore,
    threshold: typeof q.threshold === "number" ? q.threshold : null,
    textGate:
      gate && typeof gate.clean === "boolean"
        ? {
            clean: gate.clean,
            found: typeof gate.found === "string" ? gate.found : "",
            skipped: gate.skipped === true,
          }
        : null,
  };
}

/** Bundle details for the Result screen (variants + assets + summary). */
bundlesRouter.get("/:id", async (req: Request, res: Response) => {
  const id = paramId(req, res);
  if (!id) return;
  const bundle = await prisma.bundle.findUnique({
    where: { id },
    include: {
      bundleType: { select: { key: true, title: true, assets: true } },
      preset: { select: { id: true, title: true } },
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
  // Производные ключи семейства ai_reference идут сразу за родителем:
  // email → email_notext → email_transparent (порядок экрана результата).
  const orderOf = new Map<string, number>();
  const labelOf = new Map<string, string>();
  typeAssets.forEach((a, i) => {
    orderOf.set(a.key, i * 10);
    labelOf.set(a.key, a.label);
    if (a.composeMode === "ai_reference") {
      derivedAssetKeys(a.key).forEach((key, j) => {
        orderOf.set(key, i * 10 + j + 1);
        labelOf.set(key, derivedAssetLabel(a.label, key));
      });
    }
  });

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
        // Одно-ассетный ai_reference (TASK safe-zone/auto-heal): результат —
        // прозрачная версия, подпись уточняется по metadata.transparent без
        // правки конфига BundleType.
        const isTransparent =
          typeof a.metadata === "object" &&
          a.metadata !== null &&
          (a.metadata as Record<string, unknown>).transparent === true;
        const baseLabel = labelOf.get(a.assetKey) ?? a.assetKey;
        return {
          id: a.id,
          assetKey: a.assetKey,
          label: isTransparent ? `${baseLabel} — прозрачный фон` : baseLabel,
          width: a.width,
          height: a.height,
          imageUrl: a.imageUrl,
          status: a.status.toLowerCase(),
          approved: a.approved,
          errorMessage: a.errorMessage,
          // Engine renders carry the safe-zone/luminance metadata the CRM
          // preview overlays; ai-mode and pre-engine assets carry null.
          meta: assetPreviewMeta(a.metadata),
        };
      });
    return {
      id: v.id,
      brandName: v.brandName,
      displayName: v.displayName,
      // Style-profile «казино-дизайнера» (DV-E1) — данные стиля, не координаты.
      // Отдаётся как есть: редактор в CRM (админ) показывает и правит его же.
      styleProfile: v.styleProfile ?? null,
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
      presetId: bundle.presetId,
      presetTitle: bundle.preset?.title ?? null,
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

  if (parsed.data.presetId && !(await presetExists(parsed.data.presetId))) {
    res.status(404).json({ error: "preset_not_found" });
    return;
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.plannedSendAt !== undefined)
    data.plannedSendAt = parsed.data.plannedSendAt ? new Date(parsed.data.plannedSendAt) : null;
  if (parsed.data.neuralPrompt !== undefined) data.neuralPrompt = parsed.data.neuralPrompt;
  if (parsed.data.brandNames !== undefined) data.brandNames = parsed.data.brandNames;
  if (parsed.data.presetId !== undefined) data.presetId = parsed.data.presetId;

  const updated = await prisma.bundle.update({
    where: { id: bundle.id },
    data,
    select: {
      id: true,
      name: true,
      status: true,
      plannedSendAt: true,
      neuralPrompt: true,
      brandNames: true,
      presetId: true,
    },
  });
  res.json({ bundle: { ...updated, status: updated.status.toLowerCase() } });
});

/** Delete a bundle (cascade removes variants/assets/sends). */
bundlesRouter.delete("/:id", async (req: Request, res: Response) => {
  const id = paramId(req, res);
  if (!id) return;
  try {
    // Bundles are shared across CRM_SUPER / ADMIN / MANAGER by design: the list
    // endpoint shows everyone everything, so anyone in those roles can delete
    // anyone's work. That is the intended workflow — but until now it left no
    // record at all, which made "where did the bundle go" unanswerable.
    const removed = await prisma.bundle.delete({ where: { id } });
    await audit.record({
      action: audit.AuditAction.SHARED_DELETED,
      actorId: req.user!.sub,
      actorEmail: req.user!.email,
      targetId: removed.id,
      targetLabel: removed.name,
      details: { entity: "Bundle", createdById: removed.createdById },
      req,
    });
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
    const codes = {
      already_generating: 409,
      no_brands: 400,
      queue_unavailable: 503,
      preset_required: 400,
      refs_missing: 422,
    } as const;
    res
      .status(codes[result.error])
      .json({ error: result.error, ...(result.missingRefs ? { missingRefs: result.missingRefs } : {}) });
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
    const codes = {
      already_generating: 409,
      no_brands: 400,
      queue_unavailable: 503,
      preset_required: 400,
      refs_missing: 422,
    } as const;
    res
      .status(codes[result.error])
      .json({ error: result.error, ...(result.missingRefs ? { missingRefs: result.missingRefs } : {}) });
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
    // 409 — конфликт состояния (ассет не готов / зависимые форматы в работе),
    // 503 — недоступна очередь. Код ошибки уходит в тело: фронт показывает по
    // нему конкретное сообщение вместо общего «действие не выполнено».
    const conflict = result.error === "not_editable" || result.error === "dependents_in_flight";
    res.status(conflict ? 409 : 503).json({ error: result.error });
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
