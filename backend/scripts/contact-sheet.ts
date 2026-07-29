/**
 * Фаза 6 (TASK «Визуальный паттерн email-баннера») — контактный лист:
 * композиты движка РЯДОМ с эталонами дизайнеров 1–5, в одном масштабе
 * (требование TASK §1.3 Phase Gates и §6 Фазы 6).
 *
 * Два режима:
 *   - без аргументов — «сухой» лист: движок прогоняется на пяти синтетических
 *     брендах (те же, что в probe-engine-pattern), ключей не требует;
 *   - `--dir <папка>` — живой лист: берёт готовые PNG (скачанные из CRM
 *     рендеры) и кладёт их рядом с эталонами. Это режим приёмки после
 *     включения v3.
 *
 * Ассеты прозрачные (D-E5), поэтому каждый композит кладётся на тёмную
 * подложку письма (#0D0D0D) — так он читается как эталоны («чёрные углы»,
 * DV-A1). `--light` переключает на светлую (#F2F2F2).
 *
 * Запуск:  npx tsx scripts/contact-sheet.ts [--dir <папка>] [--light] [--out <файл>]
 * Выход:   figma/crm-bundle/contact-sheet.png (по умолчанию)
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { composeAsset, type EngineLayer } from "../src/lib/composeEngine.js";
import { EMAIL_HERO_V3, EMAIL_HERO_KEY } from "../src/services/layoutSpec.js";

const PNG = { compressionLevel: 9, adaptiveFiltering: false, palette: false } as const;

const ROOT = path.resolve(import.meta.dirname, "../..");
const EXAMPLES = path.join(ROOT, "figma/crm-bundle/examples");
const REFS = ["1.jfif", "2.jfif", "3.jfif", "4.jfif", "5.jfif"];

// Одна ячейка листа: 600×300 (аспект 2:1 эталонов и email) + плашка подписи.
const CELL_W = 600;
const CELL_H = 300;
const LABEL_H = 26;
const GAP = 10;

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

/** Непрозрачная «фигура» — синтетический заменитель вырезки (как в пробнике). */
async function blob(w: number, h: number, rgb: [number, number, number]): Promise<EngineLayer> {
  const buf = await sharp({
    create: { width: w, height: h, channels: 4, background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 } },
  })
    .png(PNG)
    .toBuffer();
  return { data: buf, width: w, height: h };
}

const BRANDS = [
  { name: "brandA", personAspect: 0.45, itemAspect: 0.6, pieces: 5 },
  { name: "brandB", personAspect: 0.55, itemAspect: 0.75, pieces: 4 },
  { name: "brandC", personAspect: 0.38, itemAspect: 0.5, pieces: 6 },
  { name: "brandD", personAspect: 0.62, itemAspect: 0.85, pieces: 3 },
  { name: "brandE", personAspect: 0.5, itemAspect: 0.66, pieces: 6 },
] as const;

/** Синтетические композиты v3 — «сухой» режим без ключей. */
async function renderSynthetic(): Promise<Array<{ label: string; png: Buffer }>> {
  const out: Array<{ label: string; png: Buffer }> = [];
  for (const b of BRANDS) {
    const personH = 900;
    const person = await blob(Math.round(personH * b.personAspect), personH, [200, 170, 120]);
    const itemH = 700;
    const pieces: EngineLayer[] = [await blob(Math.round(itemH * b.itemAspect), itemH, [220, 180, 60])];
    for (let i = 1; i < b.pieces; i++) {
      const s = 120 + i * 30;
      pieces.push(await blob(s, Math.round(s * 0.8), [230, 190, 70]));
    }
    const res = await composeAsset(
      EMAIL_HERO_V3,
      EMAIL_HERO_KEY,
      3,
      { person, itemPieces: pieces, campaignTokens: ["BIG WIN"] },
      b.name,
    );
    if (res.ok) out.push({ label: `engine v3 · ${b.name} (synthetic)`, png: res.scales[0]!.png });
    else console.warn(`⚠ ${b.name}: ${res.reason}`);
  }
  return out;
}

/** Живой режим: PNG из папки (скачанные из CRM рендеры). */
function loadDir(dir: string): Array<{ label: string; file: string }> {
  return readdirSync(dir)
    .filter((f) => /\.(png|webp|jpg|jpeg|jfif)$/i.test(f))
    .sort()
    .map((f) => ({ label: `render · ${f}`, file: path.join(dir, f) }));
}

/** Ячейка: картинка на подложке письма + плашка подписи. Один масштаб для
 *  всех — эталон и композит смотрятся в одинаковом окне (TASK §1.3). */
async function cell(input: Buffer, label: string, backdrop: string): Promise<Buffer> {
  const img = await sharp(input)
    .resize(CELL_W, CELL_H, { fit: "contain", background: backdrop })
    .png(PNG)
    .toBuffer();
  const esc = label.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const labelSvg = Buffer.from(
    `<svg width="${CELL_W}" height="${LABEL_H}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="100%" height="100%" fill="#1a1a1a"/>` +
      `<text x="8" y="${LABEL_H - 8}" font-size="13" fill="#e8e8e8" font-family="sans-serif">${esc}</text>` +
      `</svg>`,
  );
  return sharp({
    create: { width: CELL_W, height: CELL_H + LABEL_H, channels: 4, background: backdrop },
  })
    .composite([
      { input: img, left: 0, top: 0 },
      { input: await sharp(labelSvg).png().toBuffer(), left: 0, top: CELL_H },
    ])
    .png(PNG)
    .toBuffer();
}

async function main(): Promise<void> {
  const dir = argValue("--dir");
  const backdrop = process.argv.includes("--light") ? "#F2F2F2" : "#0D0D0D";
  const out = argValue("--out") ?? path.join(ROOT, "figma/crm-bundle/contact-sheet.png");

  // Левая колонка — эталоны 1–5; правая — композиты (синтетика или живые).
  const refs: Array<{ label: string; file: string }> = REFS.filter((f) =>
    existsSync(path.join(EXAMPLES, f)),
  ).map((f) => ({ label: `эталон · ${f}`, file: path.join(EXAMPLES, f) }));
  if (refs.length === 0) {
    console.error(`Эталоны не найдены в ${EXAMPLES} — лист собирать не из чего.`);
    process.exitCode = 1;
    return;
  }

  const renders = dir
    ? await Promise.all(
        loadDir(dir).map(async (r) => ({
          label: r.label,
          png: await sharp(r.file).png(PNG).toBuffer(),
        })),
      )
    : await renderSynthetic();
  if (renders.length === 0) {
    console.error("Композитов нет (папка пуста или рендеры упали).");
    process.exitCode = 1;
    return;
  }

  const rows = Math.max(refs.length, renders.length);
  const cellH = CELL_H + LABEL_H;
  const sheetW = CELL_W * 2 + GAP * 3;
  const sheetH = rows * cellH + GAP * (rows + 1);

  const composites: sharp.OverlayOptions[] = [];
  for (let i = 0; i < rows; i++) {
    const y = GAP + i * (cellH + GAP);
    const ref = refs[i];
    if (ref) {
      const refPng = await sharp(ref.file).png(PNG).toBuffer();
      composites.push({ input: await cell(refPng, ref.label, backdrop), left: GAP, top: y });
    }
    const ren = renders[i];
    if (ren) {
      composites.push({
        input: await cell(ren.png, ren.label, backdrop),
        left: GAP * 2 + CELL_W,
        top: y,
      });
    }
  }

  const sheet = await sharp({
    create: { width: sheetW, height: sheetH, channels: 4, background: "#333333" },
  })
    .composite(composites)
    .png(PNG)
    .toBuffer();

  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, sheet);
  console.log(
    `✅ контактный лист: ${out}\n   эталонов: ${refs.length}, композитов: ${renders.length} ` +
      `(${dir ? "живые рендеры" : "синтетика"}), подложка ${backdrop}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
