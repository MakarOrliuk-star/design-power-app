/**
 * Фаза 0 (TASK «Визуальный паттерн email-баннера») — доказательство, что
 * дефекты `result.png` СИСТЕМНЫЕ, а не брак одной генерации.
 *
 * Прогоняет НАСТОЯЩИЙ движок (`composeAsset` + сидовая спека `email.hero` v2)
 * на пяти синтетических «брендах»: слои разной пропорции и разного числа
 * кусков, разные сиды. Ключей fal/Cloudinary не требует — движок чистый
 * (буферы на вход, буферы на выход), поэтому эксперимент воспроизводим кем
 * угодно и когда угодно.
 *
 * Каждый результат прогоняется через тот же замер, что и эталоны
 * (`measure-visual-pattern.ts`), и сверяется с коридорами TASK §2.2.
 *
 * Запуск: npx tsx scripts/probe-engine-pattern.ts [--keep <dir>]
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { composeAsset, type EngineLayer } from "../src/lib/composeEngine.js";
import { validateComposedAsset } from "../src/lib/assetValidator.js";
import { EMAIL_HERO_V2, EMAIL_HERO_V3, EMAIL_HERO_KEY } from "../src/services/layoutSpec.js";
import { measure } from "./measure-visual-pattern.js";

const PNG = { compressionLevel: 9, adaptiveFiltering: false, palette: false } as const;

/** Непрозрачная «фигура» заданной пропорции — заменитель вырезки со слоя. */
async function blob(w: number, h: number, rgb: [number, number, number]): Promise<EngineLayer> {
  const buf = await sharp({
    create: { width: w, height: h, channels: 4, background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 } },
  })
    .png(PNG)
    .toBuffer();
  return { data: buf, width: w, height: h };
}

interface Brand {
  name: string;
  /** Пропорция вырезки персонажа (w/h) — у каждого бренда своя. */
  personAspect: number;
  itemAspect: number;
  pieces: number;
}

const BRANDS: Brand[] = [
  { name: "brandA", personAspect: 0.45, itemAspect: 0.6, pieces: 5 },
  { name: "brandB", personAspect: 0.55, itemAspect: 0.75, pieces: 4 },
  { name: "brandC", personAspect: 0.38, itemAspect: 0.5, pieces: 6 },
  { name: "brandD", personAspect: 0.62, itemAspect: 0.85, pieces: 3 },
  { name: "brandE", personAspect: 0.5, itemAspect: 0.66, pieces: 6 },
];

async function main(): Promise<void> {
  const keepIdx = process.argv.indexOf("--keep");
  const outDir =
    keepIdx >= 0 && process.argv[keepIdx + 1]
      ? path.resolve(process.argv[keepIdx + 1]!)
      : mkdtempSync(path.join(tmpdir(), "engine-probe-"));
  mkdirSync(outDir, { recursive: true });

  const rows: string[] = [];
  const verdicts: string[] = [];

  for (const b of BRANDS) {
    const personH = 900;
    const person = await blob(Math.round(personH * b.personAspect), personH, [200, 170, 120]);
    const itemH = 700;
    const pieces: EngineLayer[] = [await blob(Math.round(itemH * b.itemAspect), itemH, [220, 180, 60])];
    for (let i = 1; i < b.pieces; i++) {
      const s = 120 + i * 30;
      pieces.push(await blob(s, Math.round(s * 0.8), [230, 190, 70]));
    }

    // `--v2` прогоняет старую спеку — тем же кодом, чтобы сравнение «до/после»
    // отличалось только спекой, а не путём исполнения.
    const useV2 = process.argv.includes("--v2");
    const spec = useV2 ? EMAIL_HERO_V2 : EMAIL_HERO_V3;
    const res = await composeAsset(spec, EMAIL_HERO_KEY, useV2 ? 2 : 3, { person, itemPieces: pieces }, b.name);
    if (!res.ok) {
      rows.push(`| ${b.name} | ОШИБКА: ${res.reason} |`);
      continue;
    }
    const file = path.join(outDir, `${b.name}.png`);
    writeFileSync(file, res.scales[0]!.png);
    const m = await measure(file);

    // Проверки берём у НАСТОЯЩЕГО валидатора Фазы 4, а не дублируем здесь:
    // иначе пробник и прод расходятся, и он начинает врать (так и вышло на
    // первом прогоне — он держал буквальные V2/V3 из TASK, которые Фаза 0
    // заменила на V2′/V3′).
    const report = await validateComposedAsset(spec, {
      scales: res.scales,
      metadata: res.metadata,
      overlayMask: res.overlayMask,
    });
    const failed = report.failedKeys;
    const L = res.metadata.layers;
    rows.push(
      `| ${b.name} | ${m.person?.heightPct ?? "—"} | ${m.item?.heightPct ?? "—"} | ` +
        `${m.person?.bottomPct ?? "—"} | ${m.decorCount} | ${m.decorCoveragePct} | ` +
        `${m.totalCoveragePct} | ${m.croppedByEdge} | ${L.decorPlaced}/${L.decorPlaced + L.decorSkipped} |`,
    );
    const detail = report.checks
      .filter((c) => !c.passed)
      .map((c) => `    · ${c.key} — ${c.detail}`)
      .join("\n");
    verdicts.push(
      `- **${b.name}** — ` +
        (report.passed
          ? "ПРОШЁЛ"
          : `провалено ${failed.length}/${report.checks.length}:\n${detail}`),
    );
  }

  process.stdout.write(
    [
      `Композиты: ${outDir}`,
      "",
      "| бренд | person h,% | item h,% | person низ,% | декор шт | декор % | покрытие холста % | подрезано краем | размещено |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...rows,
      "",
      "Вердикт даёт валидатор Фазы 4 (`validateComposedAsset`) — тот же код, что в проде.",
      "",
      ...verdicts,
      "",
    ].join("\n"),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
