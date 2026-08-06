/**
 * Демонстрация «до/после» на живом рендере: берёт готовый ПРОЗРАЧНЫЙ ассет
 * (собранный старой спекой v2), режет его на связные альфа-компоненты тем же
 * `layerSplit`, что и прод, и пересобирает ТЕ ЖЕ слои сценой `email.hero` v3.
 *
 * Персонаж = крупный компонент с центром в правой трети (в v2 он всегда
 * справа), крупнейший из остальных = item, мелочь = реквизит. Это ровно те
 * входы, которые v3 получила бы от пайплайна, — поэтому картинка честно
 * показывает, что даст включение v3 на текущих генерациях.
 *
 * Ограничения демо (в проде их закрывают файлы заказчика):
 *   - библиотека декора пуста → кольцо наполняется только кусками ассета;
 *   - шрифта в сборке нет → надписи рисуются дефолтным шрифтом libvips.
 *
 * Запуск: npx tsx scripts/recompose-v3.ts <вход.png> [--out <файл>] [--dark]
 */

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { composeAsset, type EngineLayer } from "../src/lib/composeEngine.js";
import { splitLayerPieces } from "../src/lib/layerSplit.js";
import { EMAIL_HERO_V3, EMAIL_HERO_KEY } from "../src/services/layoutSpec.js";

const PNG = { compressionLevel: 9, adaptiveFiltering: false, palette: false } as const;

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input || !existsSync(input)) {
    console.error("Использование: npx tsx scripts/recompose-v3.ts <вход.png> [--out <файл>] [--dark]");
    process.exitCode = 1;
    return;
  }

  const src = await sharp(input).ensureAlpha().png(PNG).toBuffer();
  const meta = await sharp(src).metadata();
  const W = meta.width ?? 0;

  // Тот же нож, что в проде (D-E6): связные альфа-компоненты, крупнейший первым.
  const pieces = await splitLayerPieces(src, { maxPieces: 24 });
  if (pieces.length < 2) {
    console.error(`Компонентов найдено ${pieces.length} — на person+item не хватает (нет альфы?).`);
    process.exitCode = 1;
    return;
  }

  // Персонаж: самый ВЫСОКИЙ компонент с центром правее 55% ширины (v2 всегда
  // ставит его справа). Не нашёлся — крупнейший компонент вообще.
  const withPos = pieces.map((p) => ({ p, cx: p.left + p.width / 2 }));
  const right = withPos.filter((x) => x.cx > W * 0.55);
  const personPick =
    (right.length > 0 ? right : withPos).sort((a, b) => b.p.height - a.p.height)[0]!;
  const rest = withPos.filter((x) => x !== personPick).map((x) => x.p);

  const toLayer = (p: (typeof pieces)[number]): EngineLayer => ({
    data: p.png,
    width: p.width,
    height: p.height,
  });

  const person = toLayer(personPick.p);
  const itemPieces = rest.map(toLayer); // крупнейший встанет в зону item, мелочь — реквизит

  console.log(
    `✂️ компонентов: ${pieces.length} → person ${person.width}×${person.height} ` +
      `(центр x=${Math.round((personPick.cx / W) * 100)}%), item+реквизит: ${itemPieces.length}`,
  );

  const res = await composeAsset(
    EMAIL_HERO_V3,
    EMAIL_HERO_KEY,
    3,
    { person, itemPieces, campaignTokens: ["BIG WIN"] },
    `recompose:${path.basename(input)}`,
  );
  if (!res.ok) {
    console.error(`Сцена не собралась: ${res.reason}`);
    process.exitCode = 1;
    return;
  }

  const out =
    argValue("--out") ?? path.join(path.dirname(input), `${path.parse(input).name}-v3.png`);
  let png = Buffer.from(res.scales[0]!.png);
  if (process.argv.includes("--dark")) {
    // Подложка тёмного письма — так кадр читается как эталоны 1–5 (DV-A1).
    png = await sharp({
      create: {
        width: res.scales[0]!.width,
        height: res.scales[0]!.height,
        channels: 4,
        background: "#0D0D0D",
      },
    })
      .composite([{ input: png, left: 0, top: 0 }])
      .png(PNG)
      .toBuffer();
  }
  writeFileSync(out, png);
  const s = res.metadata.scene;
  console.log(
    `✅ ${out}\n   glow=${s?.glowColor} подрезано краем=${s?.croppedByEdge} ` +
      `back-за-верхом=${s?.backCropsTop} надписей=${s?.typographyTokens} ` +
      `декора размещено=${res.metadata.layers.decorPlaced}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
