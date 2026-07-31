import sharp from "sharp";
import { prisma } from "../lib/prisma.js";
import { uploadBuffer, withRetry } from "../lib/cloudinary.js";
import { runPersonFal } from "../lib/fal.js";
import { nearestFalAspect } from "../lib/imageSize.js";
import { mulberry32, seedToInt } from "../lib/composeEngine.js";
import { splitLayerPieces } from "../lib/layerSplit.js";
import { fetchBuffer, getOrCreateNormalizedLayer } from "./layerCache.js";
import { requestCreativeBrief, type CreativeBrief } from "../lib/creativeBrief.js";
import { buildScenePlan, type ScenePlan } from "./scenePlan.js";
import { renderScene, STRUCTURAL_CHECK_KEYS, type RenderLayer } from "../lib/sceneRenderer.js";
import {
  keyLightLayer,
  normalizeLightLayer,
  enforceLightCorners,
  clampLightPeak,
  lightLayerHasObjects,
} from "../lib/lightLayer.js";
import {
  parseDecorEntries,
  resolveDecorChain,
  selectDecorEntries,
} from "../lib/decorLibrary.js";
import { generateDecorSheetPieces, saveSheetPiecesToBrandLibrary } from "./decorIngest.js";
import { measure, checkAgainstSpec, type CorridorReport } from "../lib/patternMiner.js";
import { getActivePatternSpec, PATTERN_SPEC_KEYS } from "./patternSpec.js";
import type { Prisma } from "../../generated/prisma/client.js";

/**
 * Scene Pipeline — Задание 3, Фаза 6. Прод-обвязка нового пайплайна
 * «промпт → полная композиция», включается ФЛАГОМ в layout-спеке
 * (`scenePipeline: true`) — старый путь нетронут, откат — переключение
 * активной версии спеки из админки, без деплоя.
 *
 * Сквозной путь (живым прогоном доказан в Фазе 4, `DECISIONS.md` §11):
 *
 *   промпт → Creative Brief (LLM, фолбэк на нейтральный бриф) →
 *   scene-plan (коридоры активной PatternSpec + детерминированный seed) →
 *   слой света (fal + цепочка Enforce `D-N22`) →
 *   декор по цепочке `D-N7'` (библиотека → лист декора + автосохранение → куски ITEM) →
 *   renderScene → валидация ТЕМ ЖЕ майнером по композиту (`D-N20`) →
 *   пересев раскладки / перегенерация слоя света / FAILED с отчётом.
 *
 * Наблюдаемость (§9): в метаданные пишутся seed, версия pattern-спеки, хэш
 * корпуса, цепочка декора и полный отчёт валидатора — «почему у бренда
 * съехало» отвечает строка ассета, а не раскопки логов.
 */

export interface ScenePipelineJob {
  bundleId: string;
  variantId: string;
  assetId: string;
  assetKey: string;
  brandName: string;
  /** id бренда — для автосохранения нарезки листа (`D-N8'`); null = без кэша. */
  brandId: string | null;
  campaignPrompt: string;
  presetKey?: string | null;
  personLayerHash: string;
  itemLayerHash: string | null;
  canvas: { w: number; h: number };
  /** Поясной кроп из layout-спеки (`subjects.person.cropTopFraction`). */
  personCropTopFraction?: number;
  /** Json-колонки библиотек декора: бренд перекрывает общую (`D-N7'`). */
  brandDecorRaw: unknown;
  commonDecorRaw: unknown;
}

export type ScenePipelineResult =
  | { ok: true; imageUrl: string; metadata: Prisma.InputJsonValue }
  | { ok: false; reason: string; metadata?: Prisma.InputJsonValue };

/** Пересевы раскладки — лимит DI-Q13, как у старого движка. */
const MAX_RENDER_ATTEMPTS = 3;
/** Попыток слоя света: генерация + одна перегенерация. */
const LIGHT_ATTEMPTS = 2;
/** Сколько ассетов библиотеки скачивается под сцену (коридор объектов 7–17). */
const MAX_LIBRARY_PIECES = 12;

/**
 * Фолбэк брифа: LLM недоступна → рендер НЕ блокируется (правило
 * `styleProfile`, унаследованное брифом). Нейтральный бриф ничего не
 * выдумывает: оффер пуст, концептов нет (лист не генерируется — `D-N19`),
 * свет описан только светом.
 */
export const NEUTRAL_BRIEF: CreativeBrief = {
  offer: { kind: "welcome", headline: null, amount: null, extras: [], cta: null },
  mood: "celebration",
  season: null,
  decorConcepts: [],
  paletteHint: null,
  lightMood: "soft warm ambient glow",
  captions: [],
  confidence: { offer: 0, scene: 0 },
};

/**
 * Слой света: генерация по промпту плана → Enforce «нет объектов» → кейинг →
 * нормировка центра в нижнюю половину коридора → виньет углов (только вниз) →
 * кламп пиков потолком max(centerBgLum) корпуса. Вся цепочка — в размере
 * холста (`D-N22`: даунскейл Lanczos на зерне даёт овершут поверх клампа).
 * null — сцена соберётся без света, валидатор скажет об этом метриками.
 */
export async function generateLightLayer(plan: ScenePlan): Promise<Buffer | null> {
  const aspect = nearestFalAspect(plan.canvas.w, plan.canvas.h);
  const [lumLo, lumHi] = plan.background.targetCenterLum;
  for (let attempt = 1; attempt <= LIGHT_ATTEMPTS; attempt++) {
    const gen = await runPersonFal(plan.background.lightPrompt, [], aspect, null);
    if (!gen.success || !gen.imageUrl) {
      console.warn(`⚠️ light layer: генерация не удалась (${gen.error ?? "unknown"})`);
      continue;
    }
    const raw = await fetchBuffer(gen.imageUrl);
    if (!raw) continue;
    if (await lightLayerHasObjects(raw)) {
      console.warn(`♻️ light layer: Enforce нашёл объекты (попытка ${attempt}) — перегенерация`);
      continue;
    }
    const sized = await sharp(raw)
      .resize(plan.canvas.w, plan.canvas.h, { fit: "fill" })
      .png()
      .toBuffer();
    const keyed = await keyLightLayer(sized);
    const centered = await normalizeLightLayer(keyed, { centerLum: [lumLo, (lumLo + lumHi) / 2] });
    const cornered = await enforceLightCorners(centered, {
      cornerLum: plan.background.targetCornerLum,
    });
    return clampLightPeak(cornered, lumHi);
  }
  return null;
}

/** Слой по хэшу из кэша нормализованных слоёв (тот же путь, что у движка). */
async function loadLayerByHash(hash: string, label: string): Promise<RenderLayer> {
  const row = await prisma.normalizedLayer.findUnique({ where: { sourceHash: hash } });
  if (!row) throw new Error(`${label}: normalized layer missing — regenerate the bundle`);
  const buf = await fetchBuffer(row.url);
  if (!buf) throw new Error(`${label}: layer download failed`);
  return { png: buf, width: row.width, height: row.height };
}

/**
 * Декор по цепочке `D-N7'`: библиотека (бренд ⊃ общая) → лист декора с
 * автосохранением в библиотеку бренда (`D-N8'`, кэш не роняет рендер) →
 * куски слоя ITEM как последний рубеж. Отбор из библиотеки сидирован.
 */
async function resolveDecorLayers(
  job: ScenePipelineJob,
  brief: CreativeBrief,
  seed: string,
  itemLayer: RenderLayer,
): Promise<{ layers: RenderLayer[]; steps: string[]; generatedConcepts: string[] }> {
  const brandEntries = parseDecorEntries(job.brandDecorRaw);
  const commonEntries = parseDecorEntries(job.commonDecorRaw);
  const chain = resolveDecorChain({
    brandEntries,
    commonEntries,
    concepts: brief.decorConcepts,
  });

  const layers: RenderLayer[] = [];
  const rand = mulberry32(seedToInt(`${seed}:decor`));

  if (chain.entries.length > 0) {
    const picked = selectDecorEntries(chain.entries, {
      concepts: brief.decorConcepts,
      season: brief.season,
      count: MAX_LIBRARY_PIECES,
      rand,
    });
    for (const [i, entry] of picked.entries()) {
      const norm = await getOrCreateNormalizedLayer(entry.url, `scene-decor${i}#${job.assetKey}`);
      if (!norm.ok) {
        console.warn(`⚠️ scene decor[${i}]: ${norm.reason} — ассет пропущен`);
        continue;
      }
      const buf = await fetchBuffer(norm.url);
      if (!buf) continue;
      layers.push({ png: buf, width: norm.width, height: norm.height });
    }
  }

  let generatedConcepts: string[] = [];
  if (chain.steps.includes("generated:sheet")) {
    const sheet = await generateDecorSheetPieces(
      chain.conceptsToGenerate,
      `${job.assetKey}#${job.assetId}`,
    );
    if (sheet.ok) {
      generatedConcepts = chain.conceptsToGenerate;
      layers.push(...sheet.pieces.map((p) => ({ png: p.png, width: p.width, height: p.height })));
      // Библиотека — кэш (`D-N8'`): следующий рендер бренда возьмёт готовое и
      // не заплатит за генерацию. Сбой кэша рендер не роняет.
      if (job.brandId) {
        try {
          const saved = await saveSheetPiecesToBrandLibrary({
            brandId: job.brandId,
            pieces: sheet.pieces,
            concepts: chain.conceptsToGenerate,
            season: brief.season,
          });
          console.log(
            `🗃️ decor cache ${job.brandName}: +${saved.saved.length} (отказов ${saved.failed}, за потолком ${saved.skipped})`,
          );
        } catch (err) {
          console.warn(`⚠️ decor cache: ${err instanceof Error ? err.message : err}`);
        }
      }
    } else {
      console.warn(`⚠️ decor sheet: ${sheet.reason} — цепочка идёт дальше`);
    }
  }

  // Последний рубеж — куски ITEM (текущее поведение движка). Если сработал он,
  // недобор по площади и медиане валидатор покажет как причину, а не загадку.
  if (layers.length === 0) {
    const pieces = await splitLayerPieces(itemLayer.png, {});
    layers.push(
      ...pieces.slice(1).map((p) => ({ png: p.png, width: p.width, height: p.height })),
    );
  }

  return { layers, steps: chain.steps, generatedConcepts };
}

export async function renderSceneAsset(job: ScenePipelineJob): Promise<ScenePipelineResult> {
  // 1) Активная pattern-спека — источник ВСЕХ числовых коридоров (`D-C1`).
  const patternKey =
    PATTERN_SPEC_KEYS[job.assetKey as keyof typeof PATTERN_SPEC_KEYS] ?? `pattern.${job.assetKey}`;
  const patternRow = await getActivePatternSpec(patternKey);
  if (!patternRow) {
    return {
      ok: false,
      reason:
        `scene pipeline: нет активной pattern-спеки "${patternKey}" — ` +
        `прогоните майнер по корпусу (npx tsx scripts/mine-pattern.ts --publish) и активируйте версию`,
    };
  }
  const spec = patternRow.spec;

  // 2) Creative Brief: один вызов LLM; сбой → нейтральный бриф, рендер идёт.
  const brief =
    (await requestCreativeBrief({
      campaignPrompt: job.campaignPrompt,
      presetKey: job.presetKey ?? null,
      brandName: job.brandName,
      assetKey: job.assetKey,
      availableConcepts: [
        ...new Set(
          [...parseDecorEntries(job.brandDecorRaw), ...parseDecorEntries(job.commonDecorRaw)].flatMap(
            (e) => e.concepts,
          ),
        ),
      ],
    })) ?? NEUTRAL_BRIEF;

  // 3) Слои героев — из кэша нормализованных слоёв варианта.
  let person: RenderLayer;
  let item: RenderLayer;
  try {
    person = await loadLayerByHash(job.personLayerHash, "person");
    if (!job.itemLayerHash) return { ok: false, reason: "scene pipeline: item layer hash missing" };
    item = await loadLayerByHash(job.itemLayerHash, "item");
  } catch (err) {
    return { ok: false, reason: String(err instanceof Error ? err.message : err) };
  }

  // 4) Детерминированный seed (`D-N5`): повтор рендера того же бандла даёт
  //    тот же план. Версия спеки в seed — новая спека законно меняет кадр.
  const baseSeed = `${job.bundleId}:${job.variantId}:${job.assetKey}:pv${patternRow.version}`;

  // 5) Декор по цепочке — не зависит от seed рендера (кэш и лист общие).
  const decor = await resolveDecorLayers(job, brief, baseSeed, item);

  // 6) Свет: один слой на все пересевы — метрики света от seed не зависят.
  const basePlan = buildScenePlan({
    brief,
    patternSpec: spec,
    seed: baseSeed,
    canvas: job.canvas,
    brandDecor: parseDecorEntries(job.brandDecorRaw),
    commonDecor: parseDecorEntries(job.commonDecorRaw),
  });
  let light = await generateLightLayer(basePlan);
  let lightRetries = 1;

  // 7) Рендер + валидация тем же майнером; пересев лечит только раскладку.
  let lastReport: CorridorReport | null = null;
  let attempts = 0;
  for (let attempt = 0; attempt < MAX_RENDER_ATTEMPTS; attempt++) {
    const seed = attempt === 0 ? baseSeed : `${baseSeed}:r${attempt}`;
    const plan =
      attempt === 0
        ? basePlan
        : buildScenePlan({
            brief,
            patternSpec: spec,
            seed,
            canvas: job.canvas,
            brandDecor: parseDecorEntries(job.brandDecorRaw),
            commonDecor: parseDecorEntries(job.commonDecorRaw),
          });

    const rendered = await renderScene(plan, {
      person,
      item,
      light,
      decor: decor.layers,
      ...(job.personCropTopFraction !== undefined
        ? { personCropTopFraction: job.personCropTopFraction }
        : {}),
    });
    attempts = attempt + 1;

    // `D-N20`: ассет с альфой меряется по композиту «на чёрном» — той же
    // маской яркости, что эталоны. Замер по альфе склеил бы свечение в один
    // компонент на весь холст.
    const composite = await sharp(rendered.png)
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .png()
      .toBuffer();
    const { metrics } = await measure(composite);
    const keys = light
      ? [...STRUCTURAL_CHECK_KEYS, "cornerLum", "centerBgLum"]
      : STRUCTURAL_CHECK_KEYS;
    const report = checkAgainstSpec(metrics, spec, keys);
    lastReport = report;

    console.log(
      `🎬 scene ${job.assetKey}#${job.assetId}: seed=${seed} spec=${patternKey}@v${patternRow.version} ` +
        `decor=${decor.layers.length} chain=[${decor.steps.join("→")}] light=${light ? "yes" : "no"} ` +
        `validator=${report.passed ? "passed" : report.failedKeys.join(",")}`,
    );

    if (report.passed) {
      const publicId = `${job.variantId}_${job.assetKey}_scene_v${patternRow.version}`;
      const up = await withRetry(
        () => uploadBuffer(rendered.png, publicId, `bundles/${job.bundleId}`),
        `scene#${job.assetId}`,
      );
      if (!up.success || !up.secure_url) {
        return { ok: false, reason: `scene upload: ${up.error ?? "unknown"}` };
      }
      const sz = plan.textOverlay.safeZone;
      const personBox = rendered.placed.find((p) => p.id === "hero-person");
      const itemBox = rendered.placed.find((p) => p.id === "hero-item");
      return {
        ok: true,
        imageUrl: up.secure_url,
        metadata: {
          scenePipeline: true,
          patternSpecKey: patternKey,
          patternSpecVersion: patternRow.version,
          corpusHash: patternRow.corpusHash,
          seed,
          canvas: job.canvas,
          // Контракт метаданных прежний (D-E1/Smartico): safe-зона в процентах;
          // luminance/contrast null — фон под текстом принадлежит письму (D-E5).
          safeZonePct: {
            x: Math.round(sz.x * 1000) / 10,
            y: Math.round(sz.y * 1000) / 10,
            w: Math.round(sz.w * 1000) / 10,
            h: Math.round(sz.h * 1000) / 10,
          },
          luminance: null,
          luminanceStd: null,
          textContrast: null,
          recommendedTextColor: null,
          layers: {
            person: personBox ?? null,
            item: itemBox ?? null,
            decorPlaced: rendered.placed.filter(
              (p) => p.id !== "hero-person" && p.id !== "hero-item",
            ).length,
          },
          scene: {
            decorChain: decor.steps,
            generatedConcepts: decor.generatedConcepts,
            light: Boolean(light),
            briefSource: brief === NEUTRAL_BRIEF ? "fallback" : "model",
          },
          validator: { passed: true, attempts, checks: report.checks },
        } as unknown as Prisma.InputJsonValue,
      };
    }

    // Провал по свету — перегенерация слоя света, seed не тратится.
    const lightFailed = report.failedKeys.some((k) => k === "cornerLum" || k === "centerBgLum");
    if (lightFailed && lightRetries > 0) {
      lightRetries--;
      console.warn(`♻️ scene ${job.assetKey}#${job.assetId}: провал по свету — перегенерация слоя`);
      light = await generateLightLayer(basePlan);
      attempt--;
      continue;
    }
  }

  const details = (lastReport?.checks ?? [])
    .filter((c) => !c.passed)
    .map((c) => `${c.key}: ${c.detail}`)
    .join("; ");
  return {
    ok: false,
    reason: `scene validation failed — ${details || "unknown"}`,
    metadata: {
      scenePipeline: true,
      validator: { passed: false, attempts, checks: lastReport?.checks ?? [] },
    } as unknown as Prisma.InputJsonValue,
  };
}
