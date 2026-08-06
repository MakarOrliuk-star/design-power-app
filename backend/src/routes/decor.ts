import { readFile, unlink } from "node:fs/promises";
import { Router } from "express";
import type { Request, Response } from "express";
import formidable from "formidable";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { BundleTypeAsset } from "../services/bundle.service.js";
import {
  DECOR_FOLDER,
  MAX_DECOR_PER_SLOT,
  ingestDecorBuffer,
  attachEntriesToBrand,
} from "../services/decorIngest.js";
import {
  parseDecorEntries,
  serializeDecorEntries,
  decorEntryUrls,
} from "../lib/decorLibrary.js";

/**
 * Библиотека декора (Задание 2, Фаза 2; DV-C1/DV-C2).
 *
 * Эталоны требуют 6–11 объектов на кадр — монеты, купюры, проценты, фишки.
 * Сегодня их роль играют 3–5 обрезков ITEM-слоя, чего не хватает ни на
 * коридор V4/V5, ни на слой `back` (крупная размытая монета за верхним краем).
 * Библиотеку отдаёт заказчик; этот роутер — приёмник, чтобы файлы можно было
 * залить из админки, а не коммитом.
 *
 * Хранение — без отдельной таблицы (DV-C2), двумя уровнями (DV-C2′):
 *   - ОБЩАЯ библиотека: `BundleType.assets[].decorUrls` — фолбэк для брендов
 *     без своего набора;
 *   - библиотека БРЕНДА: `Brand.decorUrls` — непустая перекрывает общую для
 *     всех рендеров этого бренда.
 * Процессор рендера забирает эффективный список сам (нормализация и кэш по
 * хэшу работают с Фазы 2 Задания 1); перекраска под палитру кадра (П8)
 * применяется к обоим уровням одинаково.
 *
 * Приёмка файла строгая и с внятной причиной отказа: непрозрачный PNG или
 * JPEG молча превратился бы в прямоугольную плашку поверх сцены, и увидел бы
 * это уже дизайнер на готовом баннере.
 */

export const decorRouter = Router();

// Приём файла (альфа-гейт, нормализация, sha256-дедуп, потолки) живёт в
// services/decorIngest.ts — он общий с автосохранением нарезки листа декора
// (`D-N8'`), у которого админки нет. Здесь остаётся только HTTP.
export { DECOR_FOLDER, MAX_DECOR_PER_SLOT };

/** Потолок на файл: декор — мелкая вырезка, мегабайты тут означают ошибку. */
export const MAX_DECOR_BYTES = 8 * 1024 * 1024;
export const MAX_DECOR_FILES = 24;

export interface DecorUploadResult {
  name: string;
  ok: boolean;
  url?: string;
  width?: number;
  height?: number;
  reason?: string;
}

const assetKeysSchema = z.array(z.string().min(1).max(40)).min(1).max(8);

/** `Brand.decorUrls` — строки и тегированные записи (`D-N9'`) → только URL. */
export function brandDecorUrls(raw: unknown): string[] {
  return decorEntryUrls(parseDecorEntries(raw));
}

/** Библиотеки для экрана админки: общая (по слотам) + бренды (DV-C2′). */
decorRouter.get("/", async (_req: Request, res: Response) => {
  const types = await prisma.bundleType.findMany({ orderBy: { createdAt: "asc" } });
  const slots = types.flatMap((t) =>
    (t.assets as unknown as BundleTypeAsset[]).map((a) => ({
      bundleTypeKey: t.key,
      assetKey: a.key,
      label: a.label,
      decorUrls: a.decorUrls ?? [],
    })),
  );
  const brandRows = await prisma.brand.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, decorUrls: true },
  });
  const brands = brandRows.map((b) => ({
    id: b.id,
    name: b.name,
    decorUrls: brandDecorUrls(b.decorUrls),
  }));
  res.json({ slots, brands, limits: { perSlot: MAX_DECOR_PER_SLOT, maxFiles: MAX_DECOR_FILES } });
});

/**
 * Приём файлов. multipart: поле `files` (можно несколько) + цель:
 *   - `brandId` — библиотека БРЕНДА (DV-C2′), или
 *   - `assetKeys` (JSON-массив слотов) — общая библиотека.
 *
 * Дедупликация: public_id = sha256 нормализованных байтов. Один и тот же
 * ассет, залитый дважды, перезапишет сам себя и не размножит библиотеку.
 */
decorRouter.post("/", async (req: Request, res: Response) => {
  const form = formidable({
    keepExtensions: true,
    maxFiles: MAX_DECOR_FILES,
    maxFileSize: MAX_DECOR_BYTES,
    filter: ({ mimetype }) => mimetype === "image/png" || mimetype === "image/webp",
  });

  const temps: string[] = [];
  try {
    const [fields, files] = await form.parse(req);

    const rawBrandId = Array.isArray(fields.brandId) ? fields.brandId[0] : fields.brandId;
    const brandId = typeof rawBrandId === "string" && rawBrandId.trim() ? rawBrandId.trim() : null;

    const rawKeys = Array.isArray(fields.assetKeys) ? fields.assetKeys[0] : fields.assetKeys;
    let assetKeys: string[] = [];
    if (!brandId) {
      try {
        assetKeys = assetKeysSchema.parse(JSON.parse(rawKeys ?? "[]"));
      } catch {
        res.status(400).json({
          error: "invalid_asset_keys",
          hint: 'нужен brandId (библиотека бренда) или assetKeys — JSON-массив, например ["email"]',
        });
        return;
      }
    }

    // Цель проверяется ДО обработки файлов: заливать 20 картинок ради 404 глупо.
    if (brandId) {
      const brand = await prisma.brand.findUnique({ where: { id: brandId }, select: { id: true } });
      if (!brand) {
        res.status(404).json({ error: "brand_not_found" });
        return;
      }
    }

    const uploaded = Object.values(files)
      .flat()
      .filter((f): f is formidable.File => Boolean(f));
    if (uploaded.length === 0) {
      res.status(400).json({
        error: "no_files",
        hint: "принимаются только PNG или WebP с прозрачностью",
      });
      return;
    }

    const results: DecorUploadResult[] = [];
    for (const file of uploaded) {
      temps.push(file.filepath);
      const name = file.originalFilename ?? "decor";
      const raw = await readFile(file.filepath);
      // Общий приёмник (services/decorIngest.ts): альфа-гейт с внятной
      // причиной отказа, нормализация тем же кодом, что слои героев,
      // sha256-дедуп — тот же путь, что у автосохранения нарезки листа.
      const ingested = await ingestDecorBuffer(raw, name);
      if (!ingested.ok) {
        results.push({ name, ok: false, reason: ingested.reason });
        continue;
      }
      results.push({
        name,
        ok: true,
        url: ingested.url,
        width: ingested.width,
        height: ingested.height,
      });
    }

    const newUrls = results.filter((r) => r.ok && r.url).map((r) => r.url!);
    let slotUpdates: Array<{ assetKey: string; total: number; skipped: number }> = [];
    let brandUpdate: { brandId: string; total: number; skipped: number } | null = null;
    if (newUrls.length > 0) {
      // Ручная заливка остаётся безымянной (`D-N9'`): теги проставляет только
      // автосохранение нарезки, у которого есть концепты брифа.
      if (brandId)
        brandUpdate = await attachEntriesToBrand(
          brandId,
          newUrls.map((url) => ({ url, concepts: [], season: null })),
        );
      else slotUpdates = await attachToSlots(assetKeys, newUrls);
    }

    res.status(201).json({ results, slots: slotUpdates, brand: brandUpdate });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // formidable сообщает о превышениях своим текстом — прокидываем как есть,
    // иначе «что-то пошло не так» на 20 файлах не диагностируется.
    res.status(400).json({ error: "upload_failed", details: message });
  } finally {
    await Promise.all(temps.map((p) => unlink(p).catch(() => undefined)));
  }
});

const detachSchema = z
  .object({
    assetKey: z.string().min(1).max(40).optional(),
    brandId: z.string().min(1).max(64).optional(),
    url: z.string().url(),
  })
  .refine((v) => Boolean(v.assetKey) !== Boolean(v.brandId), {
    message: "нужен ровно один адресат: assetKey (общая библиотека) или brandId (бренд)",
  });

/** Убрать ассет из слота или из библиотеки бренда. Файл в Cloudinary остаётся —
 *  он может быть в других библиотеках, а удаление чужих байтов по одной
 *  отвязке было бы сюрпризом. */
decorRouter.delete("/", async (req: Request, res: Response) => {
  const parsed = detachSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }
  const { assetKey, brandId, url } = parsed.data;

  if (brandId) {
    const brand = await prisma.brand.findUnique({
      where: { id: brandId },
      select: { id: true, decorUrls: true },
    });
    if (!brand) {
      res.status(404).json({ error: "brand_not_found" });
      return;
    }
    // Отвязка по URL с сохранением тегов остальных записей (`D-N9'`).
    const current = parseDecorEntries(brand.decorUrls);
    const next = current.filter((e) => e.url !== url);
    if (next.length !== current.length) {
      await prisma.brand.update({
        where: { id: brandId },
        data: { decorUrls: serializeDecorEntries(next) as unknown as Prisma.InputJsonValue },
      });
    }
    res.json({ removed: current.length - next.length });
    return;
  }

  const types = await prisma.bundleType.findMany();
  let removed = 0;
  for (const t of types) {
    const assets = t.assets as unknown as BundleTypeAsset[];
    let touched = false;
    const next = assets.map((a) => {
      if (a.key !== assetKey || !a.decorUrls?.includes(url)) return a;
      touched = true;
      removed++;
      return { ...a, decorUrls: a.decorUrls.filter((u) => u !== url) };
    });
    if (touched) {
      await prisma.bundleType.update({
        where: { id: t.id },
        data: { assets: next as unknown as object },
      });
    }
  }
  res.json({ removed });
});

/**
 * Дописывает URL-ы в `decorUrls` указанных слотов, без дублей и с потолком.
 * Порядок сохраняется: раскладка сидирована, но список ассетов — вход, и его
 * перетасовка меняла бы картинку у уже собранных бандлов.
 */
async function attachToSlots(
  assetKeys: string[],
  urls: string[],
): Promise<Array<{ assetKey: string; total: number; skipped: number }>> {
  const types = await prisma.bundleType.findMany();
  const summary = new Map<string, { assetKey: string; total: number; skipped: number }>();

  for (const t of types) {
    const assets = t.assets as unknown as BundleTypeAsset[];
    let touched = false;
    const next = assets.map((a) => {
      if (!assetKeys.includes(a.key)) return a;
      const current = a.decorUrls ?? [];
      const merged = [...current];
      let skipped = 0;
      for (const u of urls) {
        if (merged.includes(u)) continue; // тот же файл уже прицеплен
        if (merged.length >= MAX_DECOR_PER_SLOT) {
          skipped++;
          continue;
        }
        merged.push(u);
      }
      touched = true;
      summary.set(a.key, { assetKey: a.key, total: merged.length, skipped });
      return { ...a, decorUrls: merged };
    });
    if (touched) {
      await prisma.bundleType.update({
        where: { id: t.id },
        data: { assets: next as unknown as object },
      });
    }
  }
  return [...summary.values()];
}
