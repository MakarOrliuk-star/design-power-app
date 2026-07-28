/**
 * Фаза 0 (TASK «Визуальный паттерн email-баннера») — скрипт замера.
 *
 * Воспроизводит числа TASK §2 из файлов, чтобы «эталон» был измеримым, а не
 * оценкой на глаз. Все определения ниже — часть контракта: валидатор Фазы 4
 * обязан считать те же величины теми же правилами.
 *
 * Запуск:
 *   npx tsx scripts/measure-visual-pattern.ts                 # эталоны 1–5 + result.png
 *   npx tsx scripts/measure-visual-pattern.ts a.png b.png     # произвольные файлы
 *   npx tsx scripts/measure-visual-pattern.ts --json          # машинный вывод
 *
 * ОПРЕДЕЛЕНИЯ (фиксируются здесь, а не в голове):
 *
 *  - brightness(px) = (R+G+B)/3 по каналам, скомпонованным НА ЧЁРНОМ.
 *    Проверка: ядро свечения ex1 = (0,28,7) → 11.7 ≈ «12» из TASK §2.2.
 *  - «значимый пиксель»:
 *      · изображение БЕЗ альфы (эталоны, JPEG на чёрном) → brightness > 70;
 *      · изображение С альфой (автогенерат) → alpha >= 128.
 *    Разные правила вынужденно: у эталона фон вшит и отделяется только по
 *    яркости, у автогенерата фона нет и «значимость» = наличие пикселя.
 *  - компонент = связная область значимых пикселей (8-связность).
 *  - person  = bbox ВСЕХ значимых пикселей в полосе x >= 73% ширины;
 *    item    = то же для полосы x <= 27%.
 *    Именно объединение, а не связный компонент: тёмные части субъекта
 *    (волосы, чёрное платье, тёмная листва) не проходят порог яркости и рвут
 *    его на куски — компонентное определение даёт персонажа высотой 32% там,
 *    где дизайнер нарисовал 90%. Проверено на всех пяти эталонах, см.
 *    R-PLAN-email-visual-pattern.md §1.
 *  - декор   = связные компоненты площадью > 150 px, пересекающие полосу и не
 *    принадлежащие полосам субъектов.
 *  - вылет за край = доля пикселей крайнего столбца/строки холста, занятая
 *    компонентом, в % высоты (ширины) этой кромки.
 *  - фон: центр = средний RGB НЕзначимых пикселей в круге r = 10% ширины
 *    вокруг центра холста; края = средний RGB незначимых пикселей в рамке
 *    толщиной 3% от края; углы = средний RGB квадратов 2%×2% в четырёх углах.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ALPHA_THRESHOLD,
  BRIGHT_THRESHOLD,
  MIN_DECOR_AREA,
  bandCoveragePct,
  bandObjectCount,
  connectedComponents,
  croppedByEdgeCount,
  loadRaster,
  type Component,
  type Raster,
} from "../src/lib/patternMetrics.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.resolve(HERE, "../../figma/crm-bundle/examples");

// Пороги и примитивы живут в `src/lib/patternMetrics.ts` — тем же кодом
// пользуется валидатор Фазы 4, иначе коридоры разъедутся молча.
export { ALPHA_THRESHOLD, BRIGHT_THRESHOLD, MIN_DECOR_AREA, connectedComponents, loadRaster };
export type { Component, Raster };
/** Полоса, по которой TASK §2.2 считает декор. */
export const DECOR_BAND: [number, number] = [0.25, 0.72];
/** Ядро safe-зоны, где эталоны почти пусты. */
export const CORE_BAND: [number, number] = [0.4, 0.6];
/** Полосы субъектов: person справа, item слева (доли ширины). */
export const PERSON_BAND: [number, number] = [0.73, 1.0];
export const ITEM_BAND: [number, number] = [0, 0.27];

// ------------------------------------------------------------------
// Замеры
// ------------------------------------------------------------------

export interface SubjectMeasure {
  topPct: number;
  bottomPct: number;
  leftPct: number;
  rightPct: number;
  heightPct: number;
  /** Вылет за боковой край: % длины этой кромки, занятый субъектом. */
  edgeBleedPct: number;
  areaPct: number;
}

export interface Measurement {
  file: string;
  width: number;
  height: number;
  maskRule: "alpha" | "brightness";
  person: SubjectMeasure | null;
  item: SubjectMeasure | null;
  /** Пустой горизонтальный разрыв между item и person, % ширины. */
  gapPct: number | null;
  decorCount: number;
  decorCoveragePct: number;
  coreBrightPct: number;
  totalCoveragePct: number;
  background: {
    centerLuma: number;
    centerRgb: [number, number, number];
    edgeLuma: number;
    cornerRgb: [number, number, number];
  };
  /** Компоненты, подрезанные краем холста (приём П4 «bleed»). */
  croppedByEdge: number;
}

/**
 * Субъект = bbox всех значимых пикселей полосы. `edgeBleedPct` — доля крайнего
 * столбца холста (x=0 или x=W-1), занятая значимыми пикселями: именно она
 * показывает, подрезан ли субъект рамкой (приём П4).
 */
function measureBand(r: Raster, band: [number, number], side: "left" | "right"): SubjectMeasure | null {
  const { width: W, height: H, mask } = r;
  const x0b = Math.floor(band[0] * W);
  const x1b = Math.ceil(band[1] * W);
  let y0 = H;
  let y1 = -1;
  let x0 = W;
  let x1 = -1;
  let area = 0;
  let edgeHits = 0;
  const edgeX = side === "right" ? W - 1 : 0;
  for (let y = 0; y < H; y++) {
    for (let x = x0b; x < x1b; x++) {
      if (mask[y * W + x] !== 1) continue;
      area++;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (x === edgeX) edgeHits++;
    }
  }
  if (y1 < 0) return null;
  return {
    topPct: pct(y0 / H),
    bottomPct: pct((y1 + 1) / H),
    leftPct: pct(x0 / W),
    rightPct: pct((x1 + 1) / W),
    heightPct: pct((y1 - y0 + 1) / H),
    edgeBleedPct: pct(edgeHits / H),
    areaPct: pct(area / (W * H)),
  };
}

const pct = (v: number) => Math.round(v * 1000) / 10;

export async function measure(file: string): Promise<Measurement> {
  const r = await loadRaster(readFileSync(file));
  const { width: W, height: H } = r;
  const comps = connectedComponents(r);

  const person = measureBand(r, PERSON_BAND, "right");
  const item = measureBand(r, ITEM_BAND, "left");

  // Декор в полосе: компоненты > MIN_DECOR_AREA, чей bbox пересекает полосу.
  // Субъекты вычитать не нужно — в эталонах ни персонаж, ни item в полосу
  // 25–72% не заходят, а если зайдут, это и есть нарушение (V6).
  const bandX0 = Math.floor(DECOR_BAND[0] * W);
  const bandX1 = Math.ceil(DECOR_BAND[1] * W);
  const decor = comps.filter((c) => c.area > MIN_DECOR_AREA && c.x1 >= bandX0 && c.x0 < bandX1);

  let bandHit = 0;
  let bandTotal = 0;
  let coreHit = 0;
  let coreTotal = 0;
  let totalHit = 0;
  const coreX0 = Math.floor(CORE_BAND[0] * W);
  const coreX1 = Math.ceil(CORE_BAND[1] * W);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const on = r.mask[y * W + x] === 1;
      if (on) totalHit++;
      if (x >= bandX0 && x < bandX1) {
        bandTotal++;
        if (on) bandHit++;
      }
      if (x >= coreX0 && x < coreX1) {
        coreTotal++;
        if (on) coreHit++;
      }
    }
  }

  const gapPct =
    person && item && person.leftPct > item.rightPct
      ? Math.round((person.leftPct - item.rightPct) * 10) / 10
      : null;

  return {
    file: path.basename(file),
    width: W,
    height: H,
    maskRule: r.hasAlpha ? "alpha" : "brightness",
    person,
    item,
    gapPct,
    decorCount: decor.length,
    decorCoveragePct: pct(bandHit / bandTotal),
    coreBrightPct: pct(coreHit / coreTotal),
    totalCoveragePct: pct(totalHit / (W * H)),
    background: backgroundProfile(r),
    croppedByEdge: croppedByEdgeCount(comps),
  };
}

/** Профиль фона: считается ТОЛЬКО по незначимым пикселям (сцена исключена). */
function backgroundProfile(r: Raster): Measurement["background"] {
  const { width: W, height: H, rgb, mask } = r;
  const centerX = W / 2;
  const centerY = H / 2;
  const radius = 0.1 * W;
  // 15% — калибровка по эталонам: ring 3% даёт 1–6 (мерит уже почти чистый
  // чёрный), ring 15% воспроизводит коридор TASK §2.2 «7–12».
  const border = Math.max(1, Math.round(0.15 * Math.min(W, H)));
  const cornerW = Math.max(1, Math.round(0.02 * W));
  const cornerH = Math.max(1, Math.round(0.02 * H));

  const acc = () => ({ r: 0, g: 0, b: 0, n: 0 });
  const add = (a: ReturnType<typeof acc>, i: number) => {
    a.r += rgb[i * 3]!;
    a.g += rgb[i * 3 + 1]!;
    a.b += rgb[i * 3 + 2]!;
    a.n++;
  };
  const mean = (a: ReturnType<typeof acc>): [number, number, number] =>
    a.n === 0 ? [0, 0, 0] : [Math.round(a.r / a.n), Math.round(a.g / a.n), Math.round(a.b / a.n)];

  const center = acc();
  const edge = acc();
  const corner = acc();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask[i] === 1) continue; // сцену в профиль фона не пускаем
      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy <= radius * radius) add(center, i);
      if (x < border || x >= W - border || y < border || y >= H - border) add(edge, i);
      if ((x < cornerW || x >= W - cornerW) && (y < cornerH || y >= H - cornerH)) add(corner, i);
    }
  }
  const centerRgb = mean(center);
  const edgeRgb = mean(edge);
  return {
    centerLuma: Math.round(((centerRgb[0] + centerRgb[1] + centerRgb[2]) / 3) * 10) / 10,
    centerRgb,
    edgeLuma: Math.round(((edgeRgb[0] + edgeRgb[1] + edgeRgb[2]) / 3) * 10) / 10,
    cornerRgb: mean(corner),
  };
}

// ------------------------------------------------------------------
// CLI
// ------------------------------------------------------------------

const DEFAULT_FILES = ["1.jfif", "2.jfif", "3.jfif", "4.jfif", "5.jfif", "result.png"].map((f) =>
  path.join(EXAMPLES, f),
);

function row(label: string, values: Array<string | number>): string {
  return `| ${label} | ${values.join(" | ")} |`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const files = args.filter((a) => !a.startsWith("--"));
  const targets = files.length > 0 ? files.map((f) => path.resolve(f)) : DEFAULT_FILES;

  const results: Measurement[] = [];
  for (const f of targets) results.push(await measure(f));

  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }

  const names = results.map((m) => m.file.replace(/\.(jfif|png|jpg|jpeg|webp)$/i, ""));
  const lines = [
    row("Метрика", names),
    row("---", names.map(() => "---")),
    row("холст", results.map((m) => `${m.width}×${m.height}`)),
    row("правило маски", results.map((m) => m.maskRule)),
    row("person: верх, % H", results.map((m) => m.person?.topPct ?? "—")),
    row("person: низ, % H", results.map((m) => m.person?.bottomPct ?? "—")),
    row("person: высота, % H", results.map((m) => m.person?.heightPct ?? "—")),
    row("person: вылет вправо, % кромки", results.map((m) => m.person?.edgeBleedPct ?? "—")),
    row("item: высота, % H", results.map((m) => m.item?.heightPct ?? "—")),
    row("item: вылет влево, % кромки", results.map((m) => m.item?.edgeBleedPct ?? "—")),
    row("разрыв item↔person, % W", results.map((m) => m.gapPct ?? "—")),
    row("декор 25–72%: объектов", results.map((m) => m.decorCount)),
    row("декор 25–72%: покрытие, %", results.map((m) => m.decorCoveragePct)),
    row("ядро 40–60%: значимых, %", results.map((m) => m.coreBrightPct)),
    row("покрытие холста, %", results.map((m) => m.totalCoveragePct)),
    row("фон: центр, яркость", results.map((m) => m.background.centerLuma)),
    row("фон: центр, RGB", results.map((m) => m.background.centerRgb.join(","))),
    row("фон: края, яркость", results.map((m) => m.background.edgeLuma)),
    row("фон: углы, RGB", results.map((m) => m.background.cornerRgb.join(","))),
    row("объектов подрезано краем", results.map((m) => m.croppedByEdge)),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

// Запуск как скрипт (а не импорт из теста). pathToFileURL нужен ради Windows:
// там argv[1] — «D:\...», а import.meta.url — «file:///D:/...».
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
