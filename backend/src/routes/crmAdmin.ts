import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { Router } from "express";
import type { Request, Response } from "express";
import formidable from "formidable";
import sharp from "sharp";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { uploadBuffer, deleteAsset, withRetry } from "../lib/cloudinary.js";
import { listBundleBrands, listAiReferenceFormats } from "../services/bundle.service.js";
import {
  MAX_REFS_PER_PAIR,
  MIN_REFS_FOR_GENERATION,
  DEFAULT_REF_ASSET_KEY,
  listRefs,
  refsFolder,
  refCountsByBrand,
} from "../services/variationRefs.js";

/**
 * CRM-админка (TASK ai-reference, DI-R12): управление вариациями (промпт-
 * пресетами) и их референсами доступно роли CRM_SUPER, а не только ADMIN.
 * Монтируется за loadUser + requireAuth + requireCrmSuper (CRM_SUPER / ADMIN /
 * MANAGER — тот же гейт, что /api/bundles). `/api/admin/*` не трогаем — там
 * остаётся полная админка.
 *
 * Роуты:
 *   GET/POST/PATCH/DELETE /prompt-presets      — зеркало admin.ts (D8)
 *   GET    /ref-formats                        — форматы с ai_reference (DI2-1)
 *   GET    /bundle-refs?presetId=&brandName=&assetKey= — референсы тройки + счётчики
 *   POST   /bundle-refs (multipart)            — загрузка 1..15 баннеров формата
 *   POST   /bundle-refs/reorder                — порядок = приоритет (DI-R5)
 *   DELETE /bundle-refs/:id                    — строка БД + best-effort Cloudinary
 *
 * TASK multiformat-promo (DI2-1/2): у email, push и pop-up разная стилистика,
 * поэтому референсы живут в разрезе ФОРМАТА (`assetKey`), лимиты 5..15
 * считаются по тройке «вариация × бренд × формат».
 */

export const crmAdminRouter = Router();

// ---------------------------------------------------------------------------
// Вариации (prompt-presets) — та же валидация, что в admin.ts.
// ---------------------------------------------------------------------------

const promptPresetSchema = z.object({
  title: z.string().min(1).max(120),
  text: z.string().min(1).max(1500),
  order: z.number().int().min(0).max(10_000).optional(),
  isActive: z.boolean().optional(),
});

crmAdminRouter.get("/prompt-presets", async (_req: Request, res: Response) => {
  const presets = await prisma.neuralPromptPreset.findMany({
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
  res.json({ presets });
});

crmAdminRouter.post("/prompt-presets", async (req: Request, res: Response) => {
  const parsed = promptPresetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const created = await prisma.neuralPromptPreset.create({
    data: {
      title: parsed.data.title,
      text: parsed.data.text,
      order: parsed.data.order ?? 0,
      isActive: parsed.data.isActive ?? true,
    },
  });
  res.status(201).json({ preset: created });
});

crmAdminRouter.patch("/prompt-presets/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "id_required" });
    return;
  }
  const parsed = promptPresetSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const data: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) data.title = parsed.data.title;
  if (parsed.data.text !== undefined) data.text = parsed.data.text;
  if (parsed.data.order !== undefined) data.order = parsed.data.order;
  if (parsed.data.isActive !== undefined) data.isActive = parsed.data.isActive;
  try {
    const updated = await prisma.neuralPromptPreset.update({ where: { id }, data });
    res.json({ preset: updated });
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});

crmAdminRouter.delete("/prompt-presets/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "id_required" });
    return;
  }
  try {
    // Референсы уходят каскадом (onDelete: Cascade); байты в Cloudinary
    // остаются — best-effort чистка при удалении вариации не стоит риска
    // потерять пресет из-за сетевой ошибки стораджа.
    await prisma.neuralPromptPreset.delete({ where: { id } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});

// ---------------------------------------------------------------------------
// Референсы вариаций (DI-R3/R5).
// ---------------------------------------------------------------------------

/** Потолок файла: референс — готовый email-баннер, не постер для печати. */
export const MAX_REF_BYTES = 10 * 1024 * 1024;

const refsQuerySchema = z.object({
  presetId: z.string().min(1).max(64),
  brandName: z.string().min(1).max(120),
  // Формат (DI2-1). Отсутствует → "email": совместимость со старыми клиентами
  // и с @default("email") в схеме.
  assetKey: z.string().min(1).max(40).default(DEFAULT_REF_ASSET_KEY),
});

/** Формат должен быть включён в ai_reference хотя бы в одном активном типе. */
async function isKnownRefFormat(assetKey: string): Promise<boolean> {
  const formats = await listAiReferenceFormats();
  return formats.some((f) => f.key === assetKey);
}

export interface RefUploadResult {
  name: string;
  ok: boolean;
  id?: string;
  url?: string;
  reason?: string;
}

/** Базовый бренд должен существовать среди активных (те же ключи, что в мастере). */
async function isKnownBaseBrand(brandName: string): Promise<boolean> {
  const groups = await listBundleBrands();
  return groups.some((g) => g.key === brandName);
}

/**
 * Форматы для вкладок RefsManager: те, у которых в активных типах бандлов
 * включён режим ai_reference (DI2-1). Пустой список = режим нигде не включён,
 * фронт покажет подсказку вместо вкладок.
 */
crmAdminRouter.get("/ref-formats", async (_req: Request, res: Response) => {
  res.json({
    formats: await listAiReferenceFormats(),
    limits: { min: MIN_REFS_FOR_GENERATION, max: MAX_REFS_PER_PAIR },
  });
});

crmAdminRouter.get("/bundle-refs", async (req: Request, res: Response) => {
  const parsed = refsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { presetId, brandName, assetKey } = parsed.data;
  const [refs, counts] = await Promise.all([
    listRefs(presetId, brandName, assetKey),
    refCountsByBrand(presetId),
  ]);
  res.json({
    refs,
    // counts: { [brandName]: { [assetKey]: number } } — фронт рисует счётчики
    // сразу на всех вкладках формата, не дёргая API по каждой.
    counts,
    limits: { min: MIN_REFS_FOR_GENERATION, max: MAX_REFS_PER_PAIR },
  });
});

crmAdminRouter.post("/bundle-refs", async (req: Request, res: Response) => {
  const form = formidable({
    keepExtensions: true,
    maxFiles: MAX_REFS_PER_PAIR,
    maxFileSize: MAX_REF_BYTES,
    filter: ({ mimetype }) =>
      mimetype === "image/png" || mimetype === "image/jpeg" || mimetype === "image/webp",
  });

  const temps: string[] = [];
  try {
    const [fields, files] = await form.parse(req);
    const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
    const parsed = refsQuerySchema.safeParse({
      presetId: first(fields.presetId),
      brandName: first(fields.brandName),
      ...(first(fields.assetKey) !== undefined ? { assetKey: first(fields.assetKey) } : {}),
    });
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const { presetId, brandName, assetKey } = parsed.data;

    // Адресат проверяется ДО обработки файлов (паттерн decor.ts).
    const preset = await prisma.neuralPromptPreset.findUnique({
      where: { id: presetId },
      select: { id: true },
    });
    if (!preset) {
      res.status(404).json({ error: "preset_not_found" });
      return;
    }
    if (!(await isKnownBaseBrand(brandName))) {
      res.status(404).json({ error: "brand_not_found", hint: "ожидается БАЗОВОЕ имя бренда" });
      return;
    }
    // Формат должен быть реально включён в ai_reference — иначе загруженные
    // байты стали бы сиротами, которых никто не увидит (вкладок для них нет).
    if (!(await isKnownRefFormat(assetKey))) {
      res.status(404).json({
        error: "format_not_found",
        hint: "включите режим ai_reference для этого ассета в /admin",
      });
      return;
    }

    const uploaded = Object.values(files)
      .flat()
      .filter((f): f is formidable.File => Boolean(f));
    if (uploaded.length === 0) {
      res.status(400).json({ error: "no_files", hint: "PNG, JPEG или WebP до 10 МБ" });
      return;
    }

    const existing = await listRefs(presetId, brandName, assetKey);
    let slots = MAX_REFS_PER_PAIR - existing.length;
    let nextOrder = existing.reduce((m, r) => Math.max(m, r.sortOrder), -1) + 1;
    const knownIds = new Set(existing.map((r) => r.publicId));
    const folder = refsFolder(presetId, brandName, assetKey);

    const results: RefUploadResult[] = [];
    for (const file of uploaded) {
      temps.push(file.filepath);
      const name = file.originalFilename ?? "reference";
      if (slots <= 0) {
        results.push({
          name,
          ok: false,
          reason: `лимит ${MAX_REFS_PER_PAIR} на формат исчерпан`,
        });
        continue;
      }
      const raw = await readFile(file.filepath);
      let width = 0;
      let height = 0;
      try {
        const meta = await sharp(raw).metadata();
        width = meta.width ?? 0;
        height = meta.height ?? 0;
      } catch {
        results.push({ name, ok: false, reason: "файл не читается как изображение" });
        continue;
      }
      if (!width || !height) {
        results.push({ name, ok: false, reason: "не удалось определить размеры" });
        continue;
      }

      // public_id = sha256 байтов: повторная заливка того же баннера
      // перезаписывает свой файл и ловится уникальным индексом, а не плодится.
      const hash = createHash("sha256").update(raw).digest("hex");
      const up = await withRetry(() => uploadBuffer(raw, hash, folder), `ref ${name}`);
      if (!up.success || !up.secure_url || !up.public_id) {
        results.push({ name, ok: false, reason: up.error ?? "upload_failed" });
        continue;
      }
      if (knownIds.has(up.public_id)) {
        results.push({ name, ok: false, reason: "дубликат — этот баннер уже загружен" });
        continue;
      }

      const row = await prisma.variationReference.create({
        data: {
          presetId,
          brandName,
          assetKey,
          imageUrl: up.secure_url,
          publicId: up.public_id,
          width,
          height,
          sortOrder: nextOrder++,
          createdById: req.user?.sub ?? null,
        },
      });
      knownIds.add(up.public_id);
      slots--;
      results.push({ name, ok: true, id: row.id, url: row.imageUrl });
    }

    const counts = await refCountsByBrand(presetId);
    res.status(201).json({ results, counts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // formidable сообщает о превышениях своим текстом — прокидываем как есть.
    res.status(400).json({ error: "upload_failed", details: message });
  } finally {
    await Promise.all(temps.map((p) => unlink(p).catch(() => undefined)));
  }
});

const reorderSchema = refsQuerySchema.extend({
  ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_REFS_PER_PAIR),
});

/** Drag-n-drop порядок: индекс в `ids` становится sortOrder (первые 14 → в модель). */
crmAdminRouter.post("/bundle-refs/reorder", async (req: Request, res: Response) => {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { presetId, brandName, assetKey, ids } = parsed.data;
  const refs = await listRefs(presetId, brandName, assetKey);
  const known = new Set(refs.map((r) => r.id));
  if (ids.length !== refs.length || ids.some((id) => !known.has(id))) {
    res.status(400).json({ error: "ids_mismatch", hint: "нужен полный список id формата" });
    return;
  }
  await prisma.$transaction(
    ids.map((id, index) =>
      prisma.variationReference.update({ where: { id }, data: { sortOrder: index } }),
    ),
  );
  res.json({ refs: await listRefs(presetId, brandName, assetKey) });
});

crmAdminRouter.delete("/bundle-refs/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "id_required" });
    return;
  }
  const ref = await prisma.variationReference.findUnique({ where: { id } });
  if (!ref) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await prisma.variationReference.delete({ where: { id } });
  // Байты чистим best-effort ПОСЛЕ строки БД: осиротевший файл безвреден,
  // висячая ссылка в БД — нет.
  const destroyed = await deleteAsset(ref.publicId);
  if (!destroyed.success) {
    console.warn(`⚠️ bundle-refs: destroy ${ref.publicId} failed: ${destroyed.error}`);
  }
  const counts = await refCountsByBrand(ref.presetId);
  res.json({ ok: true, counts });
});
