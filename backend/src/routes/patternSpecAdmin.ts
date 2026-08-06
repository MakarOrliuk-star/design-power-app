import { readFile, unlink } from "node:fs/promises";
import { Router } from "express";
import type { Request, Response } from "express";
import formidable from "formidable";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {
  minePatternFromBuffers,
  publishPatternSpec,
  PATTERN_SPEC_KEYS,
} from "../services/patternSpec.js";
import type { Corridor } from "../lib/patternMiner.js";

/**
 * Админка pattern-спек (Задание 3, Фаза 6): паттерн добывается ИЗ ЭТАЛОНОВ
 * прямо из админки — заливаете корпус ручных работ, майнер меряет каждый файл
 * и агрегирует коридоры, спека публикуется в БД и сразу активна. Ни одного
 * числового порога руками (`D-C1`): добавить шестой эталон = перезалить корпус,
 * получится следующая версия. Версии неизменяемы; откат — деактивация.
 *
 * Это тот же код, что CLI `scripts/mine-pattern.ts --publish`, — для прода,
 * где консоли нет, а корпус живёт у дизайн-команды.
 */

export const patternSpecAdminRouter = Router();

/** Пять эталонов — рабочий корпус TASK; больше — лучше (перцентили). */
export const MIN_CORPUS_FILES = 2;
export const MAX_CORPUS_FILES = 24;
export const MAX_CORPUS_BYTES = 12 * 1024 * 1024;

const keySchema = z
  .enum([PATTERN_SPEC_KEYS.email, PATTERN_SPEC_KEYS.push, PATTERN_SPEC_KEYS.popup])
  .default(PATTERN_SPEC_KEYS.email);

/** Компактная строка коридора для таблицы в админке. */
function corridorRow(key: string, c: Corridor) {
  return {
    key,
    direction: c.direction,
    lo: c.lo === null ? null : Math.round(c.lo * 100) / 100,
    hi: c.hi === null ? null : Math.round(c.hi * 100) / 100,
    outliers: c.outliers,
  };
}

/** Версии спек: без тела коридоров в списке — оно большое, отдаётся сводкой. */
patternSpecAdminRouter.get("/", async (_req: Request, res: Response) => {
  const rows = await prisma.patternSpec.findMany({
    orderBy: [{ key: "asc" }, { version: "desc" }],
  });
  res.json({
    specs: rows.map((r) => {
      const spec = r.spec as { corpus?: string[]; corridors?: Record<string, Corridor> };
      return {
        id: r.id,
        key: r.key,
        version: r.version,
        corpusHash: r.corpusHash.slice(0, 16),
        corpus: spec.corpus ?? [],
        corridorCount: Object.keys(spec.corridors ?? {}).length,
        isActive: r.isActive,
        createdAt: r.createdAt,
        createdBy: r.createdBy,
      };
    }),
    limits: { minFiles: MIN_CORPUS_FILES, maxFiles: MAX_CORPUS_FILES },
  });
});

/**
 * Прогнать майнер по загруженному корпусу и опубликовать спеку.
 * multipart: `files` (эталоны, 2–24 изображений) + опционально `key`.
 * Тот же корпус (по хэшам файлов) версий не плодит — вернётся существующая.
 */
patternSpecAdminRouter.post("/mine", async (req: Request, res: Response) => {
  const form = formidable({
    keepExtensions: true,
    maxFiles: MAX_CORPUS_FILES,
    maxFileSize: MAX_CORPUS_BYTES,
    filter: ({ mimetype }) => Boolean(mimetype?.startsWith("image/")),
  });

  const temps: string[] = [];
  try {
    const [fields, files] = await form.parse(req);
    const rawKey = Array.isArray(fields.key) ? fields.key[0] : fields.key;
    const parsedKey = keySchema.safeParse(rawKey || undefined);
    if (!parsedKey.success) {
      res.status(400).json({
        error: "invalid_key",
        hint: `key — один из: ${Object.values(PATTERN_SPEC_KEYS).join(", ")}`,
      });
      return;
    }

    const uploaded = Object.values(files)
      .flat()
      .filter((f): f is formidable.File => Boolean(f));
    if (uploaded.length < MIN_CORPUS_FILES) {
      res.status(400).json({
        error: "corpus_too_small",
        hint: `нужно минимум ${MIN_CORPUS_FILES} эталона (рабочий корпус TASK — 5)`,
      });
      return;
    }

    const buffers = [];
    for (const f of uploaded) {
      temps.push(f.filepath);
      buffers.push({ name: f.originalFilename ?? "ref", bytes: await readFile(f.filepath) });
    }

    const spec = await minePatternFromBuffers(buffers);
    const { row, created } = await publishPatternSpec(
      parsedKey.data,
      spec,
      req.user?.email ?? "admin UI",
    );

    res.status(created ? 201 : 200).json({
      created,
      spec: {
        id: row.id,
        key: row.key,
        version: row.version,
        corpusHash: row.corpusHash.slice(0, 16),
        corpus: spec.corpus,
        isActive: row.isActive,
      },
      // Полная таблица коридоров — чтобы админ видел, ЧТО добыто, а не «ок».
      corridors: Object.entries(spec.corridors).map(([k, c]) => corridorRow(k, c)),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Битый файл (не изображение, обрезанные байты) — причина в тексте sharp;
    // без неё непонятно, какой из пяти файлов пересохранить.
    res.status(400).json({ error: "mine_failed", details: message });
  } finally {
    await Promise.all(temps.map((p) => unlink(p).catch(() => undefined)));
  }
});

const toggleSchema = z.object({ isActive: z.boolean() });

/** Активировать/деактивировать версию. Рендер берёт старшую активную. */
patternSpecAdminRouter.patch("/:id", async (req: Request, res: Response) => {
  const parsed = toggleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", hint: "нужно { isActive: boolean }" });
    return;
  }
  const row = await prisma.patternSpec.findUnique({ where: { id: req.params.id as string } });
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await prisma.patternSpec.update({
    where: { id: row.id },
    data: { isActive: parsed.data.isActive },
  });
  res.json({ id: row.id, key: row.key, version: row.version, isActive: parsed.data.isActive });
});
