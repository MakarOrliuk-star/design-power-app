import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { composeAsset, type EngineLayer } from "../src/lib/composeEngine.js";
import { ssim } from "../src/lib/assetValidator.js";
import { EMAIL_HERO_V3, EMAIL_HERO_KEY } from "../src/services/layoutSpec.js";

/**
 * Фаза 6 — golden-регресс на структурное совпадение (TASK §6: «Golden-набор
 * в репозитории + регресс»). Детерминированный рендер сцены v3 на фиксированных
 * синтетических слоях сверяется с закоммиченным golden-композитом по SSIM.
 *
 * Ловит то, что юнит-тесты не видят: дрейф раскладки/блюра/плашки после правок
 * движка или бампа sharp/libvips (риск R4 родительского плана). Порог 0.995 —
 * структурное равенство с допуском на монтаж библиотеки, побайтовое равенство
 * намеренно не требуется.
 *
 * Типографика в golden-сцене ВЫКЛЮЧЕНА: шрифты в сборке не резолвятся (F2-2),
 * и до вендоренного .ttf рендер токенов зависит от машины. Детерминизм
 * типографики закрыт своим тестом в typography3d.test.ts.
 *
 * Обновить эталон осознанно: UPDATE_GOLDEN=1 npx vitest run tests/goldenScene.test.ts
 */

const GOLDEN_DIR = path.resolve(__dirname, "golden");
const GOLDEN_FILE = path.join(GOLDEN_DIR, "email-hero-v3.golden.png");
const PNG = { compressionLevel: 9, adaptiveFiltering: false, palette: false } as const;

async function blob(w: number, h: number, rgb: [number, number, number]): Promise<EngineLayer> {
  const buf = await sharp({
    create: { width: w, height: h, channels: 4, background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 } },
  })
    .png(PNG)
    .toBuffer();
  return { data: buf, width: w, height: h };
}

async function renderGoldenScene(): Promise<Buffer> {
  // Без типографики — единственной машинно-зависимой части (см. шапку).
  const spec = { ...EMAIL_HERO_V3, typography3d: undefined };
  const person = await blob(405, 900, [200, 170, 120]);
  const pieces = [
    await blob(420, 700, [220, 180, 60]),
    await blob(150, 120, [230, 190, 70]),
    await blob(180, 144, [230, 190, 70]),
    await blob(210, 168, [230, 190, 70]),
    await blob(240, 192, [230, 190, 70]),
  ];
  const res = await composeAsset(spec, EMAIL_HERO_KEY, 3, { person, itemPieces: pieces }, "golden-v3");
  if (!res.ok) throw new Error(`golden render failed: ${res.reason}`);
  return Buffer.from(res.scales[0]!.png);
}

describe("golden-регресс сцены email.hero v3", () => {
  it("рендер структурно совпадает с закоммиченным golden (SSIM ≥ 0.995)", async () => {
    const current = await renderGoldenScene();

    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(GOLDEN_FILE)) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(GOLDEN_FILE, current);
      // Первая генерация / осознанное обновление: файл записан, сравнивать
      // не с чем. Упасть здесь нельзя — иначе тест не пройдёт на чистом
      // чекауте без артефакта, а его создание и есть цель прогона.
      console.warn(`🟡 golden записан: ${GOLDEN_FILE} — закоммить его в репозиторий`);
      return;
    }

    const golden = readFileSync(GOLDEN_FILE);
    const [gm, cm] = await Promise.all([sharp(golden).metadata(), sharp(current).metadata()]);
    expect(`${cm.width}×${cm.height}`).toBe(`${gm.width}×${gm.height}`);

    const value = await ssim(current, golden);
    expect(
      value,
      `SSIM ${value.toFixed(4)} < 0.995 — раскладка/плашка/блюр сцены уехали. ` +
        `Если изменение НАМЕРЕННОЕ (правка спеки/движка) — перегенерируй эталон: ` +
        `UPDATE_GOLDEN=1 npx vitest run tests/goldenScene.test.ts и закоммить файл.`,
    ).toBeGreaterThanOrEqual(0.995);
  });
});
