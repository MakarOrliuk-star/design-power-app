import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { Router } from "express";
import type { Request, Response } from "express";
import formidable from "formidable";
import { z } from "zod";
import { uploadBuffer, withRetry } from "../lib/cloudinary.js";
import { hasUsefulAlpha, normalizeLayer } from "../lib/layerNormalize.js";
import { prisma } from "../lib/prisma.js";
import type { BundleTypeAsset } from "../services/bundle.service.js";

/**
 * Библиотека декора (Задание 2, Фаза 2; DV-C1/DV-C2).
 *
 * Эталоны требуют 6–11 объектов на кадр — монеты, купюры, проценты, фишки.
 * Сегодня их роль играют 3–5 обрезков ITEM-слоя, чего не хватает ни на
 * коридор V4/V5, ни на слой `back` (крупная размытая монета за верхним краем).
 * Библиотеку отдаёт заказчик; этот роутер — приёмник, чтобы файлы можно было
 * залить из админки, а не коммитом.
 *
 * Хранение — по решению DV-C2: отдельная таблица не заводится, URL-ы лежат в
 * `BundleType.assets[].decorUrls`, откуда их уже забирает процессор рендера
 * (нормализация и кэш по хэшу там работают с Фазы 2 Задания 1).
 *
 * Приёмка файла строгая и с внятной причиной отказа: непрозрачный PNG или
 * JPEG молча превратился бы в прямоугольную плашку поверх сцены, и увидел бы
 * это уже дизайнер на готовом баннере.
 */

export const decorRouter = Router();

/** Куда в Cloudinary складываются ассеты библиотеки. */
export const DECOR_FOLDER = "crm-bundle/decor";
/** Потолок на файл: декор — мелкая вырезка, мегабайты тут означают ошибку. */
export const MAX_DECOR_BYTES = 8 * 1024 * 1024;
export const MAX_DECOR_FILES = 24;
/** Столько URL-ов принимает слот (совпадает со схемой bundle-types). */
export const MAX_DECOR_PER_SLOT = 20;

export interface DecorUploadResult {
  name: string;
  ok: boolean;
  url?: string;
  width?: number;
  height?: number;
  reason?: string;
}

const assetKeysSchema = z.array(z.string().min(1).max(40)).min(1).max(8);

/** Куски `decorUrls` всех слотов типа бандла — для экрана библиотеки. */
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
  res.json({ slots, limits: { perSlot: MAX_DECOR_PER_SLOT, maxFiles: MAX_DECOR_FILES } });
});

/**
 * Приём файлов. multipart: поле `files` (можно несколько) + поле `assetKeys`
 * с JSON-массивом слотов, куда прицепить результат.
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

    const rawKeys = Array.isArray(fields.assetKeys) ? fields.assetKeys[0] : fields.assetKeys;
    let assetKeys: string[];
    try {
      assetKeys = assetKeysSchema.parse(JSON.parse(rawKeys ?? "[]"));
    } catch {
      res.status(400).json({ error: "invalid_asset_keys", hint: 'ожидается JSON-массив, например ["email"]' });
      return;
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

      // Без альфы объект встанет на сцену прямоугольником — отказываем сразу
      // и объясняем, что делать, вместо порчи баннера.
      if (!(await hasUsefulAlpha(raw))) {
        results.push({
          name,
          ok: false,
          reason: "нет прозрачного фона — вырежьте объект и сохраните PNG с альфа-каналом",
        });
        continue;
      }
      // Тот же нормализатор, что и для слоёв персонажа/item: чистка ореолов
      // и обрезка по фактическому bbox, иначе масштаб в раскладке врёт.
      const norm = await normalizeLayer(raw);
      if (!norm.ok) {
        results.push({ name, ok: false, reason: norm.reason });
        continue;
      }

      const publicId = createHash("sha256").update(norm.png).digest("hex").slice(0, 32);
      const up = await withRetry(
        () => uploadBuffer(norm.png, publicId, DECOR_FOLDER),
        `decor ${name}`,
      );
      if (!up.success || !up.secure_url) {
        results.push({ name, ok: false, reason: up.error ?? "загрузка в Cloudinary не удалась" });
        continue;
      }
      results.push({ name, ok: true, url: up.secure_url, width: norm.width, height: norm.height });
    }

    const newUrls = results.filter((r) => r.ok && r.url).map((r) => r.url!);
    const slotUpdates = newUrls.length > 0 ? await attachToSlots(assetKeys, newUrls) : [];

    res.status(201).json({ results, slots: slotUpdates });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // formidable сообщает о превышениях своим текстом — прокидываем как есть,
    // иначе «что-то пошло не так» на 20 файлах не диагностируется.
    res.status(400).json({ error: "upload_failed", details: message });
  } finally {
    await Promise.all(temps.map((p) => unlink(p).catch(() => undefined)));
  }
});

const detachSchema = z.object({
  assetKey: z.string().min(1).max(40),
  url: z.string().url(),
});

/** Убрать ассет из слота. Файл в Cloudinary остаётся — он может быть в других
 *  слотах, а удаление чужих байтов по одной отвязке было бы сюрпризом. */
decorRouter.delete("/", async (req: Request, res: Response) => {
  const parsed = detachSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { assetKey, url } = parsed.data;
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
