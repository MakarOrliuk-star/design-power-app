import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { measure, aggregate, type PatternSpec } from "../lib/patternMiner.js";

/**
 * Доступ к добытым коридорам паттерна (Задание 3, Фаза 1).
 *
 * Устроено по образцу `services/layoutSpec.ts`: версии неизменяемы, активная
 * одна, старые бандлы рендерятся своей. Разница в источнике: layout-спеку
 * пишет человек, pattern-спеку ПРОИЗВОДИТ майнер по корпусу (`D-C1`).
 * Поэтому здесь нет ни одной константы-коридора — только чтение и запись.
 */

export const PATTERN_SPEC_KEYS = {
  email: "pattern.email",
  push: "pattern.push",
  popup: "pattern.popup",
} as const;

/** Версия методики замера — меняется только вместе с METHOD майнера. */
export const MINER_SPEC_VERSION = "pattern.email.v1";

/**
 * Корпус эталонов (байты файлов из админки) → спека коридоров. Тот же код,
 * что у CLI `mine-pattern`: файлы сортируются по имени (вклад каждого эталона
 * в коридор подписан именем), спека детерминирована — тот же корпус даёт
 * побайтово тот же JSON и тот же `corpusHash`.
 */
export async function minePatternFromBuffers(
  files: Array<{ name: string; bytes: Buffer }>,
  specVersion: string = MINER_SPEC_VERSION,
): Promise<PatternSpec> {
  if (files.length === 0) throw new Error("minePatternFromBuffers: пустой корпус");
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const samples = [];
  for (const f of sorted) {
    const { metrics } = await measure(f.bytes);
    samples.push({
      name: f.name,
      hash: createHash("sha256").update(f.bytes).digest("hex"),
      metrics,
    });
  }
  return aggregate(specVersion, samples);
}

export interface PatternSpecRow {
  id: string;
  key: string;
  version: number;
  spec: PatternSpec;
  corpusHash: string;
  isActive: boolean;
  createdAt: Date;
}

function toRow(row: {
  id: string;
  key: string;
  version: number;
  spec: unknown;
  corpusHash: string;
  isActive: boolean;
  createdAt: Date;
}): PatternSpecRow {
  return { ...row, spec: row.spec as PatternSpec };
}

/** Активная версия для ключа — путь рендера и валидации. */
export async function getActivePatternSpec(key: string): Promise<PatternSpecRow | null> {
  const row = await prisma.patternSpec.findFirst({
    where: { key, isActive: true },
    orderBy: { version: "desc" },
  });
  return row ? toRow(row) : null;
}

/** Точная версия — перерендер уже собранного бандла своей спекой. */
export async function getPatternSpecVersion(
  key: string,
  version: number,
): Promise<PatternSpecRow | null> {
  const row = await prisma.patternSpec.findUnique({ where: { key_version: { key, version } } });
  return row ? toRow(row) : null;
}

/**
 * Записать результат прогона майнера следующей версией.
 *
 * Если корпус не изменился, новая версия НЕ создаётся: майнер по тому же
 * корпусу даёт побайтово тот же JSON, и плодить версии-близнецы значило бы
 * терять смысл `corpusHash`. Возвращается существующая строка.
 */
export async function publishPatternSpec(
  key: string,
  spec: PatternSpec,
  createdBy?: string,
): Promise<{ row: PatternSpecRow; created: boolean }> {
  const existing = await prisma.patternSpec.findFirst({
    where: { key, corpusHash: spec.corpusHash },
    orderBy: { version: "desc" },
  });
  if (existing) return { row: toRow(existing), created: false };

  const last = await prisma.patternSpec.findFirst({
    where: { key },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const row = await prisma.patternSpec.create({
    data: {
      key,
      version: (last?.version ?? 0) + 1,
      spec: spec as unknown as object,
      corpusHash: spec.corpusHash,
      createdBy: createdBy ?? null,
    },
  });
  return { row: toRow(row), created: true };
}
