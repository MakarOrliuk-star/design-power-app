/**
 * Живая сборка композиции email (Фаза 4): промпт → бриф → план → fal (слой
 * света + лист декора) → person/item бренда → рендер → майнер-валидация.
 *
 *   npx tsx scripts/try-composition.ts                          # последний вариант с готовыми слоями
 *   npx tsx scripts/try-composition.ts --brand "Betnella(Men)"  # конкретный бренд
 *   npx tsx scripts/try-composition.ts --person <url> --item <url>
 *   npx tsx scripts/try-composition.ts --seed my-seed --prompt "Weekend reload …"
 *
 * Требует `FAL_KEY` (свет + лист декора + BR) и `DATABASE_URL` (слои бренда,
 * если не заданы --person/--item). Cloudinary НЕ нужен: результат кладётся в
 * tmp/composition/, автосохранение библиотеки пропускается.
 *
 * Бриф здесь строится детерминированно (ключа nano-gpt в окружении нет), но
 * проходит через настоящий кламп — гарантии те же, что в проде.
 */

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/prisma.js";
import { runPersonFal, runBriaRemoveBg } from "../src/lib/fal.js";
import { hasUsefulAlpha, normalizeLayer } from "../src/lib/layerNormalize.js";
import { PERSON_LAYER_CONTRACT, ITEM_LAYER_CONTRACT } from "../src/queues/bundle.processor.js";
import { fetchBuffer } from "../src/services/layerCache.js";
import { nearestFalAspect } from "../src/lib/imageSize.js";
import { clampCreativeBrief, type CreativeBrief } from "../src/lib/creativeBrief.js";
import { buildScenePlan } from "../src/services/scenePlan.js";
import {
  renderScene,
  mergeSceneMetrics,
  STRUCTURAL_CHECK_KEYS,
  type RenderLayer,
} from "../src/lib/sceneRenderer.js";
import {
  keyLightLayer,
  normalizeLightLayer,
  enforceLightCorners,
  clampLightPeak,
  lightLayerHasObjects,
} from "../src/lib/lightLayer.js";
import { generateDecorSheetPieces } from "../src/services/decorIngest.js";
import {
  measure,
  checkAgainstSpec,
  renderOnCheckerboard,
  type PatternSpec,
} from "../src/lib/patternMiner.js";
import { mineCorpus } from "./mine-pattern.js";
import { EMAIL_HERO_V3 } from "../src/services/layoutSpec.js";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.resolve(HERE, "../../figma/crm-bundle/examples");
const OUT_DIR = path.resolve(HERE, "../tmp/composition");
const CANVAS = { w: 1200, h: 600 };

const DEFAULT_PROMPT =
  "Weekend reload promotion with bonus energy and action. Bright celebratory mood, " +
  "golden coins and glowing lights, high-energy casino excitement.";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/** Бриф без LLM: разбор PROMPT-CONTRACT §6.2, прогнанный через настоящий кламп. */
function offlineBrief(campaignPrompt: string): CreativeBrief {
  return clampCreativeBrief(
    {
      offer: { kind: "reload", headline: null, amount: null, extras: [], cta: null },
      mood: "celebration",
      season: null,
      decorConcepts: ["coin", "spark", "star", "chip"],
      paletteHint: "gold, warm amber",
      lightMood: "bright warm golden burst, high energy",
      captions: [],
      confidence: { offer: 0.9, scene: 0.8 },
    },
    { campaignPrompt },
  );
}

async function loadLayer(url: string, label: string): Promise<RenderLayer> {
  const buf = await fetchBuffer(url);
  if (!buf) throw new Error(`${label}: не скачался ${url}`);
  const meta = await sharp(buf).metadata();
  return { png: buf, width: meta.width ?? 0, height: meta.height ?? 0 };
}

/** Слои бренда: последний вариант бандла с готовыми нормализованными слоями. */
async function layersFromDb(brand: string | null): Promise<{
  person: RenderLayer;
  item: RenderLayer;
  brandName: string;
}> {
  const variant = await prisma.bundleBrandVariant.findFirst({
    where: {
      personLayerHash: { not: null },
      itemLayerHash: { not: null },
      ...(brand ? { brandName: brand } : {}),
    },
    orderBy: { bundle: { createdAt: "desc" } },
    select: { brandName: true, personLayerHash: true, itemLayerHash: true },
  });
  if (!variant) throw new Error(`нет варианта с готовыми слоями${brand ? ` для ${brand}` : ""}`);
  const rows = await prisma.normalizedLayer.findMany({
    where: { sourceHash: { in: [variant.personLayerHash!, variant.itemLayerHash!] } },
  });
  const personRow = rows.find((r) => r.sourceHash === variant.personLayerHash);
  const itemRow = rows.find((r) => r.sourceHash === variant.itemLayerHash);
  if (!personRow || !itemRow) throw new Error("NormalizedLayer не найден по хэшу");
  console.log(`слои бренда ${variant.brandName}: person ${personRow.width}×${personRow.height}, item ${itemRow.width}×${itemRow.height}`);
  return {
    person: await loadLayer(personRow.url, "person"),
    item: await loadLayer(itemRow.url, "item"),
    brandName: variant.brandName,
  };
}

/** Прозрачный нормализованный слой из генерации: BR-фолбэк без кэша БД. */
async function cutoutFromGeneration(url: string, label: string): Promise<RenderLayer> {
  let buf = await fetchBuffer(url);
  if (!buf) throw new Error(`${label}: не скачался`);
  if (!(await hasUsefulAlpha(buf))) {
    const br = await runBriaRemoveBg(url);
    if (!br.success || !br.imageUrl) throw new Error(`${label}: BR не сработал (${br.error})`);
    const cut = await fetchBuffer(br.imageUrl);
    if (!cut) throw new Error(`${label}: вырезка не скачалась`);
    buf = cut;
  }
  const norm = await normalizeLayer(buf);
  if (!norm.ok) throw new Error(`${label}: ${norm.reason}`);
  return { png: norm.png, width: norm.width, height: norm.height };
}

/**
 * Фолбэк без БД: person и item генерируются свежими по ТЕМ ЖЕ контрактам
 * слоёв, что в проде (`PERSON_LAYER_CONTRACT` / `ITEM_LAYER_CONTRACT`).
 * Отличие от прода одно: без брендовой обёртки `PromptTemplate` и референсов
 * `BrandNanoRef` — они живут в БД.
 */
async function generateHeroLayers(campaignPrompt: string): Promise<{
  person: RenderLayer;
  item: RenderLayer;
  brandName: string;
}> {
  console.log("  БД недоступна — person и item генерируются свежими по контрактам слоёв");
  const personGen = await runPersonFal(`${campaignPrompt}\n${PERSON_LAYER_CONTRACT}`.trim(), [], "3:4", null);
  if (!personGen.success || !personGen.imageUrl) throw new Error(`person: ${personGen.error}`);
  const person = await cutoutFromGeneration(personGen.imageUrl, "person");
  console.log(`  person: ${person.width}×${person.height}`);
  const itemGen = await runPersonFal(`${campaignPrompt} ${ITEM_LAYER_CONTRACT}`, [], "1:1", null);
  if (!itemGen.success || !itemGen.imageUrl) throw new Error(`item: ${itemGen.error}`);
  const item = await cutoutFromGeneration(itemGen.imageUrl, "item");
  console.log(`  item: ${item.width}×${item.height}`);
  return { person, item, brandName: "generated" };
}

/** Слой света: генерация по промпту плана → Enforce → кейинг → нормировка. */
async function makeLightLayer(plan: ReturnType<typeof buildScenePlan>): Promise<Buffer | null> {
  const aspect = nearestFalAspect(CANVAS.w, CANVAS.h);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const gen = await runPersonFal(plan.background.lightPrompt, [], aspect, null);
    if (!gen.success || !gen.imageUrl) {
      console.warn(`  свет: генерация не удалась (${gen.error ?? "unknown"})`);
      continue;
    }
    const raw = await fetchBuffer(gen.imageUrl);
    if (!raw) continue;
    if (await lightLayerHasObjects(raw)) {
      console.warn(`  свет: Enforce нашёл объекты в слое (попытка ${attempt}) — перегенерация`);
      continue;
    }
    // Вся цепочка — В РАЗМЕРЕ ХОЛСТА. Ресайз после клампа пиков всё ломает:
    // Lanczos на зерне даёт овершут, и яркие зёрна пробивают порог маски
    // содержимого уже в кадре.
    const sized = await sharp(raw).resize(CANVAS.w, CANVAS.h, { fit: "fill" }).png().toBuffer();
    const keyed = await keyLightLayer(sized);
    // Центр целится в НИЖНЮЮ половину коридора: сверх света в text-core
    // ляжет ambience-декор, и его вклад не должен выбить композит за потолок.
    const [lumLo, lumHi] = plan.background.targetCenterLum;
    const centered = await normalizeLightLayer(keyed, {
      centerLum: [lumLo, (lumLo + lumHi) / 2],
    });
    // Enforce углов и пиков: «PURE BLACK corners» модель соблюдает на глаз, а
    // валидатор меряет числа — гарантия, а не надежда (вариант C, шаг [5]).
    // Пики ярче порога маски содержимого сжимаются: свет остаётся фоном.
    const cornered = await enforceLightCorners(centered, {
      cornerLum: plan.background.targetCornerLum,
    });
    // Потолок пиков — верх коридора centerBgLum: свет нигде не ярче
    // максимума фоновой яркости корпуса, и ореолам декора остаётся запас
    // до порога маски содержимого.
    return clampLightPeak(cornered, lumHi);
  }
  console.warn("  свет: не получился за 2 попытки — сцена соберётся без него");
  return null;
}

async function main() {
  const campaignPrompt = arg("prompt") ?? DEFAULT_PROMPT;
  const seedBase = arg("seed") ?? "try-composition";
  const personUrl = arg("person");
  const itemUrl = arg("item");
  const brand = arg("brand");

  console.log("── 1/6 паттерн: майнер по корпусу эталонов");
  const spec: PatternSpec = (await mineCorpus(EXAMPLES)).spec;

  console.log("── 2/6 бриф (детерминированный, через кламп)");
  const brief = offlineBrief(campaignPrompt);
  console.log(`  decor=[${brief.decorConcepts.join(", ")}] light="${brief.lightMood}"`);

  console.log("── 3/6 слои бренда");
  let heroes: { person: RenderLayer; item: RenderLayer; brandName: string };
  if (personUrl && itemUrl) {
    heroes = {
      person: await loadLayer(personUrl, "person"),
      item: await loadLayer(itemUrl, "item"),
      brandName: brand ?? "manual",
    };
  } else {
    try {
      heroes = await layersFromDb(brand);
    } catch (e) {
      console.warn(`  слои из БД не взялись (${e instanceof Error ? e.message.split("\n")[0] : e})`);
      heroes = await generateHeroLayers(campaignPrompt);
    }
  }

  console.log("── 4/6 fal: лист декора");
  const sheet = await generateDecorSheetPieces(brief.decorConcepts, "try-composition");
  if (!sheet.ok) throw new Error(`лист декора: ${sheet.reason}`);
  const decor: RenderLayer[] = sheet.pieces.map((p) => ({ png: p.png, width: p.width, height: p.height }));

  await mkdir(OUT_DIR, { recursive: true });

  // Пересев раскладки — тот же лимит, что у движка (DI-Q13): свет и декор не
  // перегенерируются, меняется только seed рендера. Отдельно — прод-рецепт
  // «перегенерация проблемного СЛОЯ»: тёмный низ item-арта или тёмный правый
  // край персонажа не лечатся ни пересевом, ни повтором рендера.
  const MAX_ATTEMPTS = 3;
  const HERO_KEYS = new Set([
    "itemClusterHeightPct",
    "personClusterHeightPct",
    "personTopPct",
    "croppedRight",
  ]);
  let heroRetries = personUrl && itemUrl ? 0 : 2; // слои по URL не перегенерируешь
  let lightRetries = 2;
  let light: Buffer | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const seed = attempt === 0 ? seedBase : `${seedBase}:r${attempt}`;
    console.log(`── 5/6 план + рендер (seed=${seed})`);
    const plan = buildScenePlan({ brief, patternSpec: spec, seed, canvas: CANVAS });
    if (attempt === 0) {
      console.log(`  light prompt: ${plan.background.lightPrompt.slice(0, 120)}…`);
      light = await makeLightLayer(plan);
    }
    const renderInputs = {
      ...heroes,
      decor,
      personCropTopFraction: EMAIL_HERO_V3.subjects.person.cropTopFraction,
    };
    const rendered = await renderScene(plan, { ...renderInputs, light });

    console.log("── 6/6 валидация тем же майнером");
    // Ответ β на вопрос 0 (`D-N6`, следствие): ассет с альфой меряется по
    // КОМПОЗИТУ «ассет над фоном письма» — как эталоны, маской яркости L>70.
    // Замер файла по альфе засчитал бы полупрозрачное свечение содержимым и
    // склеил весь холст в один компонент.
    const composite = await sharp(rendered.png)
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .png()
      .toBuffer();
    const lumMeasure = await measure(composite);
    // `D-N27`: кластеры героев — по альфе (рендер без света): маска яркости
    // не видит тёмного брендового персонажа.
    const alphaPass = await renderScene(plan, { ...renderInputs, light: null });
    const alphaMeasure = await measure(alphaPass.png);
    const metrics = mergeSceneMetrics(lumMeasure.metrics, alphaMeasure.metrics);
    const keys = light ? [...STRUCTURAL_CHECK_KEYS, "cornerLum", "centerBgLum"] : STRUCTURAL_CHECK_KEYS;
    const report = checkAgainstSpec(metrics, spec, keys);

    const stem = path.join(OUT_DIR, `${heroes.brandName.replace(/[^\w-]+/g, "_")}_${seed.replace(/[^\w-]+/g, "_")}`);
    await writeFile(`${stem}.png`, rendered.png);
    await writeFile(`${stem}_preview.png`, await renderOnCheckerboard(rendered.png));

    for (const c of report.checks) {
      console.log(`  ${c.passed ? "✓" : "✗"} ${c.key}: ${c.detail}`);
    }
    console.log(`\n${report.passed ? "✅ PASSED" : `❌ ${report.failedKeys.length} провалов`} → ${stem}.png`);
    if (report.passed) return;
    // Провал слоя героя (тёмная часть арта не видна маске) — перегенерация
    // слоя, не пересев: раскладка тут ни при чём.
    if (report.failedKeys.some((k) => HERO_KEYS.has(k)) && heroRetries > 0) {
      heroRetries--;
      console.log("провал по кластеру героя — перегенерация person/item");
      heroes = await generateHeroLayers(campaignPrompt);
      attempt--; // попытка рендера не потрачена: слой другой, seed тот же
      continue;
    }
    // Метрики света от seed не зависят — при их провале перегенерируется
    // сам слой света (та же логика «перегенерация проблемного слоя»).
    const lightFailed = report.failedKeys.some((k) => ["cornerLum", "centerBgLum"].includes(k));
    if (lightFailed) {
      if (lightRetries <= 0) {
        console.log("свет провален и попытки исчерпаны");
        return;
      }
      lightRetries--;
      console.log("провал по свету — перегенерация слоя света");
      const plan0 = buildScenePlan({ brief, patternSpec: spec, seed: seedBase, canvas: CANVAS });
      light = await makeLightLayer(plan0);
      attempt--;
      continue;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
