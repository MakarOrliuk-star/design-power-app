/**
 * Проверка, что 3D-типографика (`lib/typography3d.ts`) реально найдёт шрифт.
 *
 * librsvg при отсутствии шрифта НЕ падает — он молча рисует пустоту. На
 * Railway (сборка RAILPACK, системных шрифтов может не быть) это означает
 * баннеры без надписей, замеченные уже дизайнером. Скрипт ловит это на деплое.
 *
 * Запуск:  npm run check:fonts
 * Код возврата ≠ 0 → шрифт не резолвится, см. assets/fonts/README.md
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertFontAvailable,
  DEFAULT_FONT_STACK,
  detectFontSubstitution,
  renderToken,
  TYPO_MATERIALS,
} from "../src/lib/typography3d.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.resolve(HERE, "../assets/fonts");

async function main(): Promise<void> {
  const lines: string[] = [];
  lines.push(`FONTCONFIG_PATH = ${process.env.FONTCONFIG_PATH ?? "(не задан — берутся системные шрифты)"}`);

  const vendored = existsSync(FONT_DIR)
    ? readdirSync(FONT_DIR).filter((f) => /\.(ttf|otf|ttc)$/i.test(f))
    : [];
  lines.push(
    vendored.length > 0
      ? `Вендоренные шрифты (${FONT_DIR}): ${vendored.join(", ")}`
      : `Вендоренных шрифтов нет (${FONT_DIR} пуст) — на контейнере без системных шрифтов текст не отрисуется`,
  );
  lines.push(`TYPO_FONT_STACK = ${DEFAULT_FONT_STACK}`);
  lines.push("");

  // Каждое семейство проверяем поодиночке И на подстановку: fontconfig на
  // любое неизвестное имя молча отдаёт замену, поэтому «отрисовалось» ещё не
  // значит «шрифт есть». Без второй проверки отчёт был бы враньём.
  const families = DEFAULT_FONT_STACK.split(",").map((s) => s.trim());
  let anyReal = false;
  for (const family of families) {
    const res = await assertFontAvailable(family);
    const sub = res.ok ? await detectFontSubstitution(family) : { substituted: true, reason: "" };
    if (res.ok && !sub.substituted) anyReal = true;
    const mark = !res.ok ? "✗" : sub.substituted ? "~" : "✓";
    lines.push(`  ${mark} ${family} — ${res.ok ? sub.reason : res.reason}`);
  }
  lines.push("");
  lines.push(
    anyReal
      ? "Хотя бы одно семейство стека найдено по-настоящему."
      : "⚠ Ни одно семейство стека не найдено — всё уходит в fallback. " +
          "Положите шрифт в assets/fonts и задайте FONTCONFIG_PATH (см. README).",
  );
  lines.push("");

  const stack = await assertFontAvailable();
  lines.push(`Стек целиком: ${stack.ok ? "✓ OK" : "✗ ПРОВАЛ"} — ${stack.reason}`);

  if (stack.ok) {
    const sample = await renderToken({
      token: "BIG WIN",
      fontSizePx: 96,
      material: TYPO_MATERIALS.gold!,
      skewDeg: 0,
      rotateDeg: 0,
      bevel: true,
      specular: true,
      ownShadow: true,
    });
    lines.push(`Контрольный рендер «BIG WIN»: ${sample.width}×${sample.height} px`);
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  if (!stack.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
