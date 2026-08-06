/**
 * Живой прогон Creative Brief по корпусу тест-промптов (Фаза 2).
 *
 *   npx tsx scripts/try-brief.ts                 # весь корпус
 *   npx tsx scripts/try-brief.ts weekend-reload  # один промпт по id
 *   npx tsx scripts/try-brief.ts --raw "свой текст промпта"
 *
 * Требует `NANO_GPT_API_KEY`. Без ключа `chatCompletion` возвращает null, и
 * скрипт честно сообщает об этом, а не притворяется, что что-то проверил.
 *
 * Офлайновые гарантии клампа проверяет `tests/creativeBriefCorpus.test.ts`;
 * этот скрипт нужен для другого — увидеть, что модель РЕАЛЬНО отдаёт, и на
 * каких промптах её приходится дожимать.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_PROMPTS, type TestPrompt } from "../src/lib/creativeBriefCorpus.js";
import { requestCreativeBrief, type CreativeBrief } from "../src/lib/creativeBrief.js";

const BRAND = "Probe Brand";
const ASSET = "email";

function report(p: Pick<TestPrompt, "id" | "kind" | "prompt">, brief: CreativeBrief | null): void {
  console.log(`\n── [${p.kind}] ${p.id} ──`);
  console.log(`   промпт: ${p.prompt.slice(0, 110)}${p.prompt.length > 110 ? "…" : ""}`);
  if (!brief) {
    console.log("   ✗ модель не ответила (нет ключа, сбой сети или невалидный JSON)");
    return;
  }
  const o = brief.offer;
  console.log(`   kind=${o.kind} mood=${brief.mood} season=${brief.season ?? "—"}`);
  console.log(`   amount=${o.amount ?? "—"}  headline=${o.headline ?? "—"}  cta=${o.cta ?? "—"}`);
  console.log(`   captions=[${brief.captions.join(", ")}]`);
  console.log(`   decor=[${brief.decorConcepts.join(", ")}]  palette=${brief.paletteHint ?? "—"}`);
  console.log(`   light="${brief.lightMood || "(обнулён клампом)"}"`);
  console.log(`   confidence: offer=${brief.confidence.offer} scene=${brief.confidence.scene}`);
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === "--raw") {
    const prompt = argv.slice(1).join(" ");
    if (!prompt) {
      console.error("нужен текст промпта после --raw");
      process.exit(1);
    }
    const brief = await requestCreativeBrief({
      campaignPrompt: prompt,
      brandName: BRAND,
      assetKey: ASSET,
    });
    report({ id: "raw", kind: "edge", prompt }, brief);
    return;
  }

  const selected = argv.length > 0 ? TEST_PROMPTS.filter((p) => argv.includes(p.id)) : TEST_PROMPTS;
  if (selected.length === 0) {
    console.error(`не найдено промптов: ${argv.join(", ")}`);
    console.error(`доступные id: ${TEST_PROMPTS.map((p) => p.id).join(", ")}`);
    process.exit(1);
  }

  let answered = 0;
  const leaked: string[] = [];
  for (const p of selected) {
    const brief = await requestCreativeBrief({
      campaignPrompt: p.prompt,
      brandName: BRAND,
      assetKey: ASSET,
    });
    report(p, brief);
    if (!brief) continue;
    answered++;
    // Кламп уже отработал внутри requestCreativeBrief — если что-то всё же
    // просочилось, это дефект клампа, и его надо видеть сразу.
    if (!p.expectAmount && brief.offer.amount !== null) leaked.push(`${p.id}: сумма`);
    const extraCaptions = brief.captions.filter((c) => !p.expectCaptions.includes(c));
    if (extraCaptions.length > 0) leaked.push(`${p.id}: надписи ${extraCaptions.join("/")}`);
  }

  console.log(`\n───────────\nответов от модели: ${answered}/${selected.length}`);
  if (answered === 0) {
    console.log("NANO_GPT_API_KEY не задан или модель недоступна — проверено ничего не было.");
  } else if (leaked.length === 0) {
    console.log("утечек мимо клампа не обнаружено");
  } else {
    console.log(`УТЕЧКИ МИМО КЛАМПА (${leaked.length}):`);
    for (const l of leaked) console.log(`  · ${l}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
