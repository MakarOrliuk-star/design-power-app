/**
 * Живой прогон листа декора (Фаза 3, D-N7' шаг 3 / D-N8').
 *
 *   npx tsx scripts/try-decor-sheet.ts coin chip spark        # генерация + нарезка
 *   npx tsx scripts/try-decor-sheet.ts coin chip --save br1   # + автосохранение в библиотеку бренда
 *
 * Требует `FAL_KEY` (генерация + BR-фолбэк); `--save` дополнительно требует
 * Cloudinary и БД. Куски складываются в `tmp/decor-sheet/` для глаз — офлайн
 * гарантия нарезки проверяется тестами, этот скрипт нужен, чтобы увидеть,
 * ЧТО реально рисует модель по контракту листа и сколько кусков выживает.
 */

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildDecorSheetPrompt, MIN_SHEET_PIECES } from "../src/lib/decorSheet.js";
import { generateDecorSheetPieces, saveSheetPiecesToBrandLibrary } from "../src/services/decorIngest.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, "../tmp/decor-sheet");

async function main() {
  const argv = process.argv.slice(2);
  const saveIdx = argv.indexOf("--save");
  const brandId = saveIdx >= 0 ? argv[saveIdx + 1] : null;
  const concepts = argv.filter((a, i) => a !== "--save" && i !== saveIdx + 1);

  if (concepts.length === 0) {
    console.error("нужны концепты: npx tsx scripts/try-decor-sheet.ts coin chip spark [--save <brandId>]");
    process.exit(1);
  }
  if (saveIdx >= 0 && !brandId) {
    console.error("--save требует brandId");
    process.exit(1);
  }

  console.log(`промпт листа:\n${buildDecorSheetPrompt(concepts)}\n`);
  const res = await generateDecorSheetPieces(concepts, "try-decor-sheet");
  if (!res.ok) {
    console.error(`✗ лист не получился: ${res.reason}`);
    console.error("(нет FAL_KEY? сбой провайдера? контракт листа нарушен дважды?)");
    process.exit(1);
  }

  await mkdir(OUT_DIR, { recursive: true });
  for (const [i, p] of res.pieces.entries()) {
    const file = path.join(OUT_DIR, `piece-${String(i).padStart(2, "0")}_${p.width}x${p.height}.png`);
    await writeFile(file, p.png);
  }
  console.log(`✓ ${res.pieces.length} кусков (минимум ${MIN_SHEET_PIECES}) → ${OUT_DIR}`);
  console.log(
    res.pieces
      .map((p, i) => `  ${String(i).padStart(2, "0")}: ${p.width}×${p.height}, area=${p.area}px`)
      .join("\n"),
  );

  if (brandId) {
    const saved = await saveSheetPiecesToBrandLibrary({ brandId, pieces: res.pieces, concepts });
    console.log(
      `\n✓ библиотека бренда ${brandId}: сохранено ${saved.saved.length}, ` +
        `отказов ${saved.failed}, за потолком ${saved.skipped}`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
