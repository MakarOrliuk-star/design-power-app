/**
 * A/B-тест позиционирования (вопрос Пользователя 2026-08-05): одинаковые
 * референсы + текущий боевой промпт → nano-banana-2 против GPT Image 2.
 * Метрика — доля белого в чистой зоне (тот же чек, что в Стадии C).
 *
 * Локальная БД недоступна, поэтому референсы — corgi-баннеры из
 * figma/crm-bundle/ai-reference-results (готовые баннеры с заполненным
 * центром, как и боевые рефы), заливаются в fal storage.
 *
 * Запуск: npx tsx scripts/ab-position-test.ts
 * Пишет кадры в figma/crm-bundle/ai-reference-results/ab-test/.
 */
import "../src/env.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { runPersonFal } from "../src/lib/fal.js";
import { validateAiAsset } from "../src/lib/aiAssetValidator.js";
import {
  buildAiReferencePrompt,
  AI_REF_CENTER_CLEAR_ZONE,
} from "../src/services/aiReferencePipeline.js";

const RUNS_PER_MODEL = 2;
// cwd = backend (скрипты запускаются из backend, как остальные npm-скрипты).
const RESULTS_DIR = path.resolve(process.cwd(), "../figma/crm-bundle/ai-reference-results");
const OUT_DIR = path.join(RESULTS_DIR, "ab-test");
const REF_FILES = ["corgi_result_1.jfif", "corgi_result_2_transperant.jfif", "corgi_result_3.jfif"];
const BRIEF = "Weekend Reload — celebratory casino weekend promo, corgi mascot, gold coins and slot props";

async function uploadToFalStorage(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  const init = await fetch("https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3", {
    method: "POST",
    headers: {
      Authorization: `Key ${process.env.FAL_KEY ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file_name: path.basename(filePath), content_type: "image/jpeg" }),
  });
  if (!init.ok) throw new Error(`storage initiate: HTTP ${init.status} ${await init.text()}`);
  const { upload_url, file_url } = (await init.json()) as { upload_url: string; file_url: string };
  const put = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
    body: new Uint8Array(bytes),
  });
  if (!put.ok) throw new Error(`storage put: HTTP ${put.status}`);
  return file_url;
}

async function callGptImage2(prompt: string, imageUrls: string[]): Promise<string> {
  const res = await fetch("https://fal.run/openai/gpt-image-2/edit", {
    method: "POST",
    headers: {
      Authorization: `Key ${process.env.FAL_KEY ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      image_urls: imageUrls,
      image_size: { width: 1200, height: 600 },
      quality: "high",
      num_images: 1,
      output_format: "png",
    }),
  });
  if (!res.ok) throw new Error(`gpt-image-2: HTTP ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { images?: Array<{ url?: string }> };
  const url = json.images?.[0]?.url;
  if (!url) throw new Error(`gpt-image-2: пустой ответ ${JSON.stringify(json).slice(0, 300)}`);
  return url;
}

async function centerWhite(buffer: Buffer): Promise<number> {
  const meta = await sharp(buffer).metadata();
  const report = await validateAiAsset(buffer, meta.width ?? 0, meta.height ?? 0, {
    centerClearZone: AI_REF_CENTER_CLEAR_ZONE,
  });
  const center = report.checks.find((c) => c.key === "center");
  const m = center?.detail.match(/(\d+)%/);
  return m ? Number(m[1]) : -1;
}

async function main() {
  console.log("Заливка референсов в fal storage…");
  const refUrls: string[] = [];
  for (const f of REF_FILES) refUrls.push(await uploadToFalStorage(path.join(RESULTS_DIR, f)));
  console.log(`Рефов: ${refUrls.length}`);

  const prompt = buildAiReferencePrompt(BRIEF);
  await mkdir(OUT_DIR, { recursive: true });
  const rows: Array<{ model: string; run: number; white: number }> = [];

  for (let i = 1; i <= RUNS_PER_MODEL; i++) {
    const gen = await runPersonFal(prompt, refUrls, "16:9", null);
    if (!gen.success || !gen.imageUrl) {
      console.log(`banana #${i}: FAIL ${gen.error}`);
      continue;
    }
    const buf = Buffer.from(await (await fetch(gen.imageUrl)).arrayBuffer());
    await writeFile(path.join(OUT_DIR, `banana_${i}.png`), buf);
    const white = await centerWhite(buf);
    rows.push({ model: "nano-banana-2", run: i, white });
    console.log(`banana #${i}: центр ${white}% белого`);
  }

  for (let i = 1; i <= RUNS_PER_MODEL; i++) {
    try {
      const url = await callGptImage2(prompt, refUrls);
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      await writeFile(path.join(OUT_DIR, `gpt-image-2_${i}.png`), buf);
      const white = await centerWhite(buf);
      rows.push({ model: "gpt-image-2", run: i, white });
      console.log(`gpt-image-2 #${i}: центр ${white}% белого`);
    } catch (err) {
      console.log(`gpt-image-2 #${i}: FAIL ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("\n=== ИТОГ (порог боевого чека: 95%) ===");
  for (const r of rows)
    console.log(`${r.model} #${r.run}: ${r.white}% → ${r.white >= 95 ? "PASS" : "fail"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
