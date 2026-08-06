/**
 * Печатает каноническую спеку из кода в JSON — чтобы вставить её в админку
 * как новую версию (нужно, когда номер версии из сида занят правками админки
 * и create-only сид не смог её записать).
 *
 * Запуск: npx tsx scripts/print-spec.ts [email|push|popup] [--out <файл>]
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { EMAIL_HERO_V3, PUSH_HERO_V1, POPUP_HERO_V1 } from "../src/services/layoutSpec.js";

const which = process.argv[2] ?? "email";
const spec =
  which === "push" ? PUSH_HERO_V1 : which === "popup" ? POPUP_HERO_V1 : EMAIL_HERO_V3;

const json = JSON.stringify(spec, null, 2);
const outIdx = process.argv.indexOf("--out");
if (outIdx >= 0 && process.argv[outIdx + 1]) {
  const out = path.resolve(process.argv[outIdx + 1]!);
  writeFileSync(out, json);
  console.log(`✅ ${which} → ${out} (${json.length} байт)`);
} else {
  console.log(json);
}
