/**
 * Добыча паттерна: корпус эталонов → `pattern-spec.json` (TASK §4.1, шаги [1]–[7]).
 *
 *   npx tsx scripts/mine-pattern.ts                     # печатает таблицу и спеку
 *   npx tsx scripts/mine-pattern.ts --out spec.json     # пишет спеку в файл
 *   npx tsx scripts/mine-pattern.ts --check result.png  # прогнать выход через коридоры
 *
 * Добавили шестой эталон — перезапустили скрипт. Правки кода не требуется:
 * это и есть `D-C1` «паттерн добывается кодом».
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregate,
  checkAgainstSpec,
  measure,
  type Metrics,
  type PatternSpec,
} from "../src/lib/patternMiner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.resolve(HERE, "../../figma/crm-bundle/examples");
/** Файлы корпуса — ручные работы дизайнеров. Всё прочее в папке не эталон. */
const CORPUS_PATTERN = /^[1-5]\.(jfif|png|jpg|jpeg)$/i;
const SPEC_VERSION = "pattern.email.v1";

/** Подписи строк для таблицы; порядок повторяет TASK §3.2. */
const LABELS: Array<[keyof Metrics, string]> = [
  ["transparentPct", "Прозрачных пикселей, %"],
  ["cornerLum", "Яркость углов"],
  ["centerBgLum", "Яркость фона в центре"],
  ["bandCoverage", "Покрытие полосы 25–72 %"],
  ["bandTopThird", "└ scene-top"],
  ["bandMidThird", "└ text-core"],
  ["bandBottomThird", "└ scene-bottom"],
  ["componentCount", "Компонентов ≥150px"],
  ["decorCount", "Объектов декора"],
  ["decorAreaPct", "Площадь декора, %"],
  ["decorMedianAreaPct", "Медианный размер декора, %"],
  ["sharpnessSpread", "Разброс резкости p90/p10"],
  ["sharpnessSpreadMaxMin", "└ max/min (сверка §3.2)"],
  ["croppedTop", "Подрезано верхом"],
  ["croppedTopLargestAreaPct", "└ площадь крупнейшего, %"],
  ["croppedTopLargestCx", "└ его центр по X"],
  ["croppedLeft", "Подрезано левым краем"],
  ["croppedRight", "Подрезано правым краем"],
  ["croppedBottom", "Подрезано низом"],
  ["contentBottomPct", "Низ контента, %"],
  ["itemClusterHeightPct", "Высота item-кластера, %"],
  ["personClusterHeightPct", "Высота person-кластера, %"],
  ["personTopPct", "Верх персонажа, %"],
];

export async function mineCorpus(dir = CORPUS_DIR): Promise<{
  spec: PatternSpec;
  samples: Array<{ name: string; metrics: Metrics }>;
}> {
  const files = (await readdir(dir)).filter((f) => CORPUS_PATTERN.test(f)).sort();
  if (files.length === 0) throw new Error(`корпус пуст: ${dir}`);

  const samples = [];
  for (const name of files) {
    const bytes = await readFile(path.join(dir, name));
    const { metrics } = await measure(bytes);
    samples.push({
      name,
      hash: createHash("sha256").update(bytes).digest("hex"),
      metrics,
    });
  }
  return { spec: aggregate(SPEC_VERSION, samples), samples };
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const outAt = argv.indexOf("--out");
  const checkAt = argv.indexOf("--check");
  const publish = argv.includes("--publish");

  const { spec, samples } = await mineCorpus();

  const W1 = 30;
  const WC = 9;
  const names = samples.map((s) => s.name.replace(/\.[^.]+$/, ""));
  console.log("");
  console.log(
    "Метрика".padEnd(W1) + names.map((n) => n.padStart(WC)).join("") + "  коридор (с допуском)",
  );
  console.log("-".repeat(W1 + WC * names.length + 24));
  for (const [key, label] of LABELS) {
    const c = spec.corridors[key];
    if (!c) continue;
    const row = samples.map((s) => fmt(s.metrics[key]).padStart(WC)).join("");
    const band =
      c.direction === "info"
        ? "  (сверка)"
        : c.lo === null
          ? `  ≤ ${fmt(c.hi!)}`
          : c.hi === null
            ? `  ≥ ${fmt(c.lo)}`
            : `  ${fmt(c.lo)}…${fmt(c.hi)}`;
    console.log(label.padEnd(W1) + row + band + (c.outliers.length ? ` ⚠ ${c.outliers.join(",")}` : ""));
  }
  console.log("");
  console.log(`corpusHash: ${spec.corpusHash.slice(0, 16)}…  корпус: ${spec.corpus.join(", ")}`);

  if (outAt >= 0 && argv[outAt + 1]) {
    const dest = path.resolve(argv[outAt + 1]!);
    await writeFile(dest, JSON.stringify(spec, null, 2) + "\n", "utf8");
    console.log(`спека записана: ${dest}`);
  }

  // Фаза 6: публикация спеки в БД — scene-пайплайн читает активную версию.
  // Тот же корпус → та же версия (дедуп по corpusHash), плодить близнецы нельзя.
  if (publish) {
    const { publishPatternSpec, PATTERN_SPEC_KEYS } = await import("../src/services/patternSpec.js");
    const { prisma } = await import("../src/lib/prisma.js");
    try {
      const { row, created } = await publishPatternSpec(
        PATTERN_SPEC_KEYS.email,
        spec,
        "mine-pattern CLI",
      );
      console.log(
        created
          ? `опубликована ${row.key}@v${row.version} (активна)`
          : `корпус не менялся — остаётся ${row.key}@v${row.version}`,
      );
    } finally {
      await prisma.$disconnect();
    }
  }

  if (checkAt >= 0 && argv[checkAt + 1]) {
    const target = path.resolve(argv[checkAt + 1]!);
    const { metrics } = await measure(await readFile(target));
    const report = checkAgainstSpec(metrics, spec);
    console.log("");
    console.log(`── проверка ${path.basename(target)} ──`);
    for (const c of report.checks) {
      console.log(`  ${c.passed ? "✓" : "✗"} ${c.key.padEnd(26)} ${c.detail}`);
    }
    console.log(
      report.passed
        ? "  ИТОГ: проходит все коридоры"
        : `  ИТОГ: не проходит ${report.failedKeys.length} — ${report.failedKeys.join(", ")}`,
    );
  }
}

// Запуск только как CLI: при импорте из тестов main() не должен срабатывать.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
