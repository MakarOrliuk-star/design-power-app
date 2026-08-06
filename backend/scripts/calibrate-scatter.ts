/**
 * Фаза 1 — калибровка раскладки декора по эталонам (TASK §6 Фаза 1:
 * «методом подгонки под замеры, а не подбором на глаз»).
 *
 * Достаёт из эталонов 1–5 все объекты декора, переводит их центры в
 * нормированные координаты холста и считает, на каком расстоянии от центра и
 * под какими углами они лежат. Выход — параметры `scatter.ring` для спеки
 * `email.hero` v3.
 *
 * Модель раскладки. TASK §5 предлагает `arc {from, to, bulge}`, но что такое
 * bulge — не определено. Здесь используется эквивалентная и однозначная
 * модель: **нормированное эллиптическое кольцо**. Точка холста (x, y)
 * переводится в (u, v) = ((x/W − 0.5)·2, (y/H − 0.5)·2), то есть в квадрат
 * [−1,1]², где холст любой пропорции становится единичным. Радиус r = |(u,v)|,
 * угол θ = atan2(v, u) в градусах, 0° — вправо, 90° — ВНИЗ (экранная система).
 * Декор кладётся в кольцо r ∈ [rMin, rMax] — центр пустеет сам собой, а не по
 * запрету (приём П3).
 *
 * Запуск: npx tsx scripts/calibrate-scatter.ts [--json]
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connectedComponents, loadRaster, METHOD } from "../src/lib/patternMiner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.resolve(HERE, "../../figma/crm-bundle/examples");
const REFS = ["1.jfif", "2.jfif", "3.jfif", "4.jfif", "5.jfif"];

/**
 * Декор — это всё, кроме двух героев. Субъекты отсекаются по высоте: по
 * замерам Фазы 0 person и item занимают 78–91% высоты холста, а самый крупный
 * элемент декора в эталонах — 40% (слой `back`). Порог 45% разделяет их с
 * запасом и не зависит от того, в какой полосе объект оказался.
 */
const SUBJECT_MIN_HEIGHT = 0.45;

export interface DecorSample {
  file: string;
  /** Центр в нормированном квадрате [−1,1]². */
  u: number;
  v: number;
  /** Радиус в том же квадрате и угол, градусы, 0°=вправо, 90°=вниз. */
  r: number;
  thetaDeg: number;
  /** Высота объекта, доля высоты холста. */
  sizePct: number;
  /** Объект подрезан краем холста. */
  cropped: boolean;
}

export async function sampleDecor(file: string): Promise<DecorSample[]> {
  const raster = await loadRaster(readFileSync(file));
  const { width: W, height: H } = raster;
  const comps = connectedComponents(raster);
  const out: DecorSample[] = [];
  for (const c of comps) {
    const h = c.y1 - c.y0 + 1;
    if (c.area <= METHOD.minComponentArea) continue;
    if (h >= SUBJECT_MIN_HEIGHT * H) continue; // это субъект, не декор
    const cx = (c.x0 + c.x1 + 1) / 2;
    const cy = (c.y0 + c.y1 + 1) / 2;
    const u = (cx / W - 0.5) * 2;
    const v = (cy / H - 0.5) * 2;
    out.push({
      file: path.basename(file),
      u: round(u),
      v: round(v),
      r: round(Math.hypot(u, v)),
      thetaDeg: Math.round((Math.atan2(v, u) * 180) / Math.PI),
      sizePct: round((h / H) * 100),
      // У майнера кромка — булев признак «bbox дошёл до края с допуском
      // 0.4 % холста» (§3.1), а не счётчик пикселей на самой кромке, как было
      // в прежнем patternMetrics. Смысл тот же: объект подрезан краем.
      cropped: c.cropped.left || c.cropped.right || c.cropped.top || c.cropped.bottom,
    });
  }
  return out;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const all: DecorSample[] = [];
  const perFile: Array<{ file: string; count: number }> = [];
  for (const f of REFS) {
    const s = await sampleDecor(path.join(EXAMPLES, f));
    all.push(...s);
    perFile.push({ file: f, count: s.length });
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(all, null, 2)}\n`);
    return;
  }

  const radii = all.map((s) => s.r).sort((a, b) => a - b);
  const sizes = all.map((s) => s.sizePct).sort((a, b) => a - b);
  const croppedShare = all.filter((s) => s.cropped).length / all.length;

  // Гистограмма радиусов: показывает, кольцо это или равномерное облако.
  const bins = 10;
  const hist = new Array(bins).fill(0);
  const maxR = 1.415; // |(1,1)| — угол нормированного квадрата
  for (const s of all) hist[Math.min(bins - 1, Math.floor((s.r / maxR) * bins))]++;

  // Углы: 0°=вправо, 90°=вниз. Считаем по секторам 45°.
  const sectors = new Array(8).fill(0);
  for (const s of all) sectors[Math.floor(((s.thetaDeg + 360) % 360) / 45)]++;
  const sectorNames = ["→ право", "↘ низ-право", "↓ низ", "↙ низ-лево", "← лево", "↖ верх-лево", "↑ верх", "↗ верх-право"];

  const lines = [
    `Объектов декора: ${all.length} из ${REFS.length} эталонов ` +
      `(${perFile.map((p) => `${p.file}:${p.count}`).join(", ")})`,
    "",
    "РАДИУС в нормированном квадрате [-1,1]²  (0 = центр холста)",
    ...hist.map((n, i) => {
      const lo = ((i * maxR) / bins).toFixed(2);
      const hi = (((i + 1) * maxR) / bins).toFixed(2);
      return `  ${lo}–${hi}  ${"█".repeat(n)} ${n}`;
    }),
    `  p05=${quantile(radii, 0.05).toFixed(2)}  p25=${quantile(radii, 0.25).toFixed(2)}  ` +
      `median=${quantile(radii, 0.5).toFixed(2)}  p75=${quantile(radii, 0.75).toFixed(2)}  ` +
      `p95=${quantile(radii, 0.95).toFixed(2)}`,
    "",
    "УГОЛ (сектора по 45°, 0°=вправо, 90°=вниз — экранная система)",
    ...sectors.map((n, i) => `  ${sectorNames[i]!.padEnd(12)} ${"█".repeat(n)} ${n}`),
    "",
    "РАЗМЕР, % высоты холста",
    `  p05=${quantile(sizes, 0.05).toFixed(1)}  median=${quantile(sizes, 0.5).toFixed(1)}  ` +
      `p95=${quantile(sizes, 0.95).toFixed(1)}  max=${sizes[sizes.length - 1]!.toFixed(1)}`,
    "",
    `Подрезано краем холста: ${(croppedShare * 100).toFixed(0)}% объектов`,
    "",
    "→ Предлагаемые параметры scatter.ring для email.hero v3:",
    `   rMin ${quantile(radii, 0.05).toFixed(2)}, rMax ${quantile(radii, 0.95).toFixed(2)}`,
    `   sizePct ${quantile(sizes, 0.05).toFixed(0)}–${quantile(sizes, 0.95).toFixed(0)}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
