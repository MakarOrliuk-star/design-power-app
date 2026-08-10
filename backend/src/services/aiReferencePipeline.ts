import { prisma } from "../lib/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { runPersonFal, runGptImage2Edit, runBriaRemoveBg } from "../lib/fal.js";
import { fitAndStoreAsset } from "../lib/assetFit.js";
import { nearestFalAspect } from "../lib/imageSize.js";
import { uploadFromUrl, withRetry } from "../lib/cloudinary.js";
import { fetchBuffer } from "./layerCache.js";
import { validateAiAsset } from "../lib/aiAssetValidator.js";
import { getLayoutGuideUrl, LAYOUT_GUIDE_INSTRUCTION } from "../lib/layoutGuide.js";
import { MAX_EDIT_REFS } from "./variationRefs.js";
import { reviewComposition, QA_REFS_SHOWN, qaThreshold } from "../lib/vlmReviewer.js";
import type { QaProfile } from "../lib/vlmReviewer.js";
import { describeCampaignStyle } from "../lib/styleAnchor.js";
import { healComposition } from "./aiHealing.js";
import type { AiRefAttempt } from "./aiHealing.js";
import { pickGenerationRefs } from "./variationRefs.js";
import { recomputeBundleStatus, stripGenderName } from "./bundle.service.js";

/**
 * Пайплайн ai_reference (TASK ai-reference, R-PLAN §1.1/§3): «одна вариация →
 * одна композиция на бренд» из 5–15 готовых email-баннеров-референсов.
 *
 * Цикл на ассет (DI-R10: 1 попытка + 2 ретрая):
 *   A. GPT Image 2 /edit (A-7; env-откат на nano-banana-2): референсы пары
 *      (вариация × базовый бренд) + схема-раскладка + бриф вариации +
 *      композиционный контракт «без текста» → точный канвас (GPT) либо
 *      16:9 + fitAndStoreAsset/Bria (banana) → ровно target-канвас.
 *   C. Техвалидация (aiAssetValidator): размер/резкость/рамки. Дешёвая и
 *      детерминированная, поэтому идёт ДО приёмщика — на явный брак VLM
 *      не тратится.
 *   B. Приемщик (vlmReviewer): вердикт {pass, score, reasons}.
 *   pass → выбираем; иначе ретрай; после третьей попытки — auto-healing
 *   (TASK safe-zone/auto-heal, aiHealing.ts): лучший кандидат лечится
 *   re-edit'ом по замечаниям приёмки (до 2 попыток, каждая — через тот же
 *   контур C+B). Если и лечение не прошло — лучший по score среди всех
 *   с пометкой qaPassed=false (warning-бейдж в CRM, B4).
 *
 * Выход — ОДНА строка BundleAsset (TASK safe-zone/auto-heal, A2): финальная
 * база прогоняется через runBriaRemoveBg (DI-R8: свечение/тени как есть) и
 * записывается в родительский ассет с metadata.transparent=true — CRM видит
 * только «Email — прозрачный фон» без текста. Текст-слой и строки
 * `_notext`/`_transparent` больше не создаются; провал removeBg теперь валит
 * ассет (это единственный результат). Хелперы производных ключей оставлены
 * для legacy-строк старых бандлов (подписи в API, Regenerate на производном).
 */

export const AI_REF_MAX_ATTEMPTS = 3;

/**
 * Модель композиции (A-7): GPT Image 2 — по A/B-тесту 2026-08-05 держит
 * safe-зону 96–97% против 89–93% у banana при том же стиле, и генерирует
 * сразу точный канвас. Откат на banana — env `AI_REF_IMAGE_MODEL`
 * = "fal-ai/nano-banana-2" (без деплоя кода, рестарт воркера).
 */
export const AI_REF_DEFAULT_MODEL = "openai/gpt-image-2";
export function aiRefImageModel(): string {
  return process.env.AI_REF_IMAGE_MODEL ?? AI_REF_DEFAULT_MODEL;
}

/** Safe-зона DI-Q7 (27–73% ширины = 46%) в долях канваса. */
export const AI_REF_SAFE_ZONE = { x: 0.27, y: 0.04, w: 0.46, h: 0.92 };

/**
 * Зона «чистого центра» для техвалидации (A-3, email mask дизайнера):
 * текстовая часть центральной полосы — там на белом фоне не должно быть НИ
 * одного пропса/монетки. Нижняя часть центра исключена: по маске там
 * «область декора» (мелкие элементы у CTA допустимы).
 */
export const AI_REF_CENTER_CLEAR_ZONE = { x: 0.28, y: 0.08, w: 0.44, h: 0.62 };

// Производные ключи трёх-ассетной схемы (до TASK safe-zone/auto-heal):
// новые строки с ними НЕ создаются, хелперы обслуживают legacy-строки старых
// бандлов — подписи в routes/bundles.ts и Regenerate в bundle.processor.ts.
export const AI_REF_SUFFIX_NOTEXT = "_notext";
export const AI_REF_SUFFIX_TRANSPARENT = "_transparent";

export function derivedAssetKeys(parentKey: string): [string, string] {
  return [`${parentKey}${AI_REF_SUFFIX_NOTEXT}`, `${parentKey}${AI_REF_SUFFIX_TRANSPARENT}`];
}

/** "email_notext" → "email"; не-производный ключ → null. */
export function parentOfDerivedKey(assetKey: string): string | null {
  if (assetKey.endsWith(AI_REF_SUFFIX_NOTEXT))
    return assetKey.slice(0, -AI_REF_SUFFIX_NOTEXT.length);
  if (assetKey.endsWith(AI_REF_SUFFIX_TRANSPARENT))
    return assetKey.slice(0, -AI_REF_SUFFIX_TRANSPARENT.length);
  return null;
}

/** Подпись производного ассета для экрана результата. */
export function derivedAssetLabel(parentLabel: string, assetKey: string): string {
  if (assetKey.endsWith(AI_REF_SUFFIX_NOTEXT)) return `${parentLabel} — без текста`;
  if (assetKey.endsWith(AI_REF_SUFFIX_TRANSPARENT)) return `${parentLabel} — прозрачный фон`;
  return parentLabel;
}

/**
 * Композиционный контракт (аналог PERSON_LAYER_CONTRACT): зашит в код, чтобы
 * админский текст вариации отвечал за СМЫСЛ, а форма кадра была стабильной.
 * Правило текста — A-1: только короткие казино-слова на пропсах.
 */
export const AI_REF_COMPOSITION_CONTRACT =
  // A-2 (2026-08-05, по итогам первого живого прогона): фон — чисто-белый под
  // вырезание removeBg, центр канваса полностью пустой (там наш текст-слой),
  // раскладка «треугольником» + depth-of-field, ключевые объекты не у краёв.
  "Create ONE new cohesive casino email hero composition in the exact visual style of the " +
  "reference banners: same palette, lighting, rendering style, material quality and prop family. " +
  "Do not copy any reference verbatim — compose a NEW scene from the same visual language. " +
  "BACKGROUND: pure solid white (#FFFFFF), completely flat — no scenery, no gradients, no glow, " +
  "no bokeh, no light rays, no patterns and no cast shadows on the background; the artwork will " +
  "be cut out later, so every element needs clean crisp edges against the white. " +
  "CENTER: like every professional email hero banner, reserve a wide blank COPY SPACE in the " +
  "middle — the middle half of the banner is pure white negative space from top to bottom, where " +
  "a headline and a CTA button will be placed later; no plates, panels, frames, props, characters, " +
  "coins or sparkles may enter the copy space at any height (at most one or two tiny decor pieces " +
  "near its very bottom), it must stay COMPLETELY EMPTY. " +
  "COMPOSITION: THREE sections, like a magazine spread — the large anchor group of props fills " +
  "the LEFT quarter of the canvas, the main character with its details fills the RIGHT quarter, " +
  "and the wide copy space sits between them; small props stay tightly above their side groups, " +
  "never drifting toward the middle; foreground elements tack sharp, small distant props slightly " +
  "blurred for depth of field. " +
  "EDGES: the character and all key props stay fully inside the frame with a clear margin from the " +
  "canvas edges; only minor decorative props may approach the edges. " +
  "STRICTLY NO text, captions, headlines, CTA buttons, logos or watermarks anywhere; the only lettering " +
  "allowed is short casino words that naturally belong to props (slot reels, chips, medallions), such as " +
  "FS, SCATTER, BONUS, VIP, WILD or 777. Professional advertising quality, coherent lighting across " +
  "all elements.";

export function buildAiReferencePrompt(variationText: string): string {
  const brief = variationText.trim();
  return [brief ? `Campaign brief: ${brief}.` : "", AI_REF_COMPOSITION_CONTRACT]
    .filter(Boolean)
    .join(" ");
}

/**
 * Контракт зависимого формата (TASK multiformat-promo, DI2-3/DI2-4): push и
 * pop-up собираются ПОСЛЕ email и обязаны выглядеть как та же кампания.
 * Отличия от якорного контракта:
 *  - первой картинкой идёт утверждённая email-композиция (стиль-эталон), и
 *    её раскладку копировать запрещено — только палитру/героя/пропсы/свет;
 *  - copy space не резервируется: текста на этих форматах не будет (DI2-4),
 *    поэтому центр канваса можно занимать.
 */
export const AI_REF_SECONDARY_CONTRACT =
  "Create ONE new cohesive casino promo composition for this format, belonging to an EXISTING campaign. " +
  "STYLE SOURCE: the FIRST image is the APPROVED anchor creative of that same campaign — reproduce its palette, " +
  "character design and outfit, prop family, material quality, lighting and rendering EXACTLY; it is the same " +
  "campaign and the same hero. Do NOT copy its layout, crop or arrangement — compose a NEW scene that fits this canvas. " +
  "The remaining images are reference banners of this brand for THIS format — follow them for framing, prop density and scale. " +
  "BACKGROUND: pure solid white (#FFFFFF), completely flat — no scenery, no gradients, no glow, no bokeh, no light rays " +
  "and no cast shadows on the background; the artwork will be cut out later, so every element needs clean crisp edges. " +
  "COMPOSITION: fill the canvas with a clear focal hierarchy — the main character and the anchor prop group read " +
  "instantly at a glance, smaller props support them; there is NO reserved copy space in this format, the center may be occupied. " +
  "EDGES: the character and all key props stay fully inside the frame with a clear margin from the canvas edges. " +
  "STRICTLY NO text, captions, headlines, CTA buttons, logos or watermarks anywhere; the only lettering allowed is short " +
  "casino words that naturally belong to props (slot reels, chips, medallions), such as FS, SCATTER, BONUS, VIP, WILD or 777. " +
  "Professional advertising quality, coherent lighting across all elements.";

/** Соотношение сторон в человекочитаемом виде («1024×512 (2:1)»). */
function aspectLabel(w: number, h: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(w, h) || 1;
  return `${Math.round(w / d)}:${Math.round(h / d)}`;
}

/** Подсказка геометрии формата — модель не видит размеров канваса из промпта. */
export function formatGeometryHint(label: string, w: number, h: number): string {
  const ratio = w / h;
  // 4:3 (pop-up 800×600) читается как «почти квадрат», а не как баннер —
  // граница между horizontal и nearly square стоит выше 1.33.
  const shape =
    ratio >= 1.6
      ? "wide horizontal banner"
      : ratio >= 1.4
        ? "horizontal banner"
        : ratio > 0.9
          ? "nearly square banner"
          : "vertical banner";
  return `Target format: ${label} — a ${shape}, ${w}×${h} px (${aspectLabel(w, h)}).`;
}

/** Промпт зависимого формата: бриф + геометрия + стиль-якорь + контракт. */
export function buildSecondaryPrompt(opts: {
  variationText: string;
  /** Текстовое описание стиля якоря (пусто при fail-open, DI2-3). */
  styleText: string;
  /** false — якорной картинки нет (legacy-бандл): контракт про «FIRST image» снимается. */
  hasAnchor: boolean;
  formatLabel: string;
  targetW: number;
  targetH: number;
}): string {
  const brief = opts.variationText.trim();
  const contract = opts.hasAnchor
    ? AI_REF_SECONDARY_CONTRACT
    : // Без якоря первая картинка — обычный референс формата: убираем блок
      // «STYLE SOURCE», иначе модель примет за эталон случайный баннер.
      AI_REF_SECONDARY_CONTRACT.replace(
        /STYLE SOURCE:.*?The remaining images are reference banners/s,
        "The images are reference banners",
      );
  return [
    brief ? `Campaign brief: ${brief}.` : "",
    formatGeometryHint(opts.formatLabel, opts.targetW, opts.targetH),
    opts.styleText,
    contract,
  ]
    .filter(Boolean)
    .join(" ");
}

// Тип попытки (генерации и лечения) живёт в aiHealing.ts; ре-экспорт
// сохраняет прежний импорт для тестов и соседних модулей.
export type { AiRefAttempt } from "./aiHealing.js";

interface ChosenAttempt {
  index: number;
  imageUrl: string;
  pass: boolean;
}

/**
 * Стиль-якорь кампании для зависимых форматов (DI2-3): композиция якорного
 * ассета ДО removeBg (белый фон — прозрачный PNG модель отрендерит на чём
 * попало) + текстовое описание её стиля.
 */
export interface AiRefAnchorContext {
  imageUrl: string;
  styleText: string;
  /** true — взят imageUrl готового ассета вместо qa.baseUrl (старый бандл). */
  fallback?: boolean;
}

/** Результат прогона: процессор ставит зависимые форматы только после ok. */
export interface AiRefResult {
  ok: boolean;
  /** База (до removeBg) — становится якорем для зависимых форматов. */
  baseUrl?: string;
  /** Описание стиля, снятое с якоря (только для якорного ассета). */
  styleText?: string;
}

/**
 * Контекст якоря из уже сгенерированного ассета — нужен, когда зависимый
 * формат перегенерируют отдельно (DI2-9: Regenerate push не трогает email).
 * Бандлы, сделанные до этой фичи, не имеют `qa.baseUrl` — берём готовую
 * картинку ассета с пометкой fallback (она прозрачная, стиль слабее).
 */
export async function loadAnchorContext(
  variantId: string,
  anchorKey: string,
): Promise<AiRefAnchorContext | null> {
  const anchor = await prisma.bundleAsset.findUnique({
    where: { variantId_assetKey: { variantId, assetKey: anchorKey } },
    select: { status: true, imageUrl: true, metadata: true },
  });
  if (!anchor || anchor.status !== "DONE") return null;
  const meta = anchor.metadata as { styleAnchor?: unknown; qa?: { baseUrl?: unknown } } | null;
  const styleText = typeof meta?.styleAnchor === "string" ? meta.styleAnchor : "";
  const baseUrl = typeof meta?.qa?.baseUrl === "string" ? meta.qa.baseUrl : "";
  if (baseUrl) return { imageUrl: baseUrl, styleText };
  if (anchor.imageUrl) return { imageUrl: anchor.imageUrl, styleText, fallback: true };
  return null;
}

/** safeZonePct в процентах — контракт метаданных движка (composeEngine E-P5.1). */
function safeZonePct(): { x: number; y: number; w: number; h: number } {
  const z = AI_REF_SAFE_ZONE;
  return {
    x: Math.round(z.x * 1000) / 10,
    y: Math.round(z.y * 1000) / 10,
    w: Math.round(z.w * 1000) / 10,
    h: Math.round(z.h * 1000) / 10,
  };
}

/**
 * Stage B процессора для composeMode "ai_reference": полный цикл (генерация →
 * приёмка → auto-healing → removeBg) + запись результата в родительский
 * BundleAsset + recomputeBundleStatus. Логический брак не бросает — ассет
 * переводится в FAILED с причиной (домашний паттерн: Regenerate — путь ретрая).
 */
export async function processAiReferenceAsset(opts: {
  bundleId: string;
  variantId: string;
  assetId: string;
  assetKey: string;
  /** Тон-вариант бренда ("Betnella(Men)") — референсы ищутся по БАЗОВОМУ имени. */
  brandName: string;
  targetW: number;
  targetH: number;
  /**
   * Якорь кампании (DI2-3). true (дефолт) — email: схема-раскладки, чистый
   * центр, снятие стиля для остальных форматов. false — push/pop-up: стиль
   * приходит готовым в `anchor`.
   */
  isAnchor?: boolean;
  /** Подпись формата для промпта и приёмки («Push», «Pop-up»). */
  formatLabel?: string;
  /** Контекст якоря — обязателен по смыслу для зависимых форматов. */
  anchor?: AiRefAnchorContext | null;
}): Promise<AiRefResult> {
  const { bundleId, variantId, assetId, assetKey, targetW, targetH } = opts;
  const isAnchor = opts.isAnchor ?? true;
  const profile: QaProfile = isAnchor ? "anchor" : "secondary";
  const formatLabel = opts.formatLabel ?? assetKey;
  const anchorUrl = isAnchor ? null : (opts.anchor?.imageUrl ?? null);
  // Чистый центр — требование ТОЛЬКО якорного формата (DI2-4): на push/pop-up
  // текста не будет, и пустая середина там читается как дыра в композиции.
  const centerZone = isAnchor ? AI_REF_CENTER_CLEAR_ZONE : undefined;
  const [notextKey, transparentKey] = derivedAssetKeys(assetKey);

  // Legacy-строки трёх-ассетной схемы (старые бандлы): любой новый прогон —
  // успешный или проваленный — сносит их, в CRM остаётся один ассет (A2).
  const dropLegacyDerived = async () => {
    await prisma.bundleAsset.deleteMany({
      where: { variantId, assetKey: { in: [notextKey, transparentKey] } },
    });
  };

  const fail = async (reason: string, metadata?: Prisma.InputJsonValue) => {
    await prisma.bundleAsset.update({
      where: { id: assetId },
      data: {
        status: "FAILED",
        errorMessage: reason,
        ...(metadata !== undefined ? { metadata } : {}),
      },
    });
    await dropLegacyDerived();
    await recomputeBundleStatus(bundleId);
  };

  const bundle = await prisma.bundle.findUnique({
    where: { id: bundleId },
    select: {
      neuralPrompt: true,
      presetId: true,
      preset: { select: { title: true, text: true } },
    },
  });
  if (!bundle) return { ok: false }; // bundle удалён — no-op
  if (!bundle.presetId || !bundle.preset) {
    await fail("ai_reference: у бандла не выбрана вариация (preset)");
    return { ok: false };
  }

  const baseBrand = stripGenderName(opts.brandName);
  let refs;
  try {
    // Референсы — строго своего формата (DI2-2): у email, push и pop-up
    // разная стилистика, фолбэка на чужой ФОРМАТ нет. По тону наоборот:
    // сначала пул конкретного варианта ("Betnella(Men)"), и только если он
    // пуст — общий пул бренда (DI2-10).
    refs = await pickGenerationRefs(bundle.presetId, opts.brandName, assetKey, baseBrand);
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
    return { ok: false };
  }
  const refUrls = refs.map((r) => r.imageUrl);

  // Бриф: текст бандла (мастер заполняет его из вариации, но может уточнить);
  // пустой — сам текст вариации.
  const variationText = bundle.neuralPrompt.trim() || bundle.preset.text;

  let genUrls: string[];
  let prompt: string;
  if (isAnchor) {
    // A-6: последним референсом уходит схема-раскладка — позиционирование
    // модели показывается картинкой, под неё резервируется один слот из
    // MAX_EDIT_REFS. Best-effort: без схемы генерация не блокируется.
    genUrls = refUrls.slice(0, MAX_EDIT_REFS);
    let guideInstruction = "";
    try {
      const guideUrl = await getLayoutGuideUrl();
      genUrls = [...refUrls.slice(0, MAX_EDIT_REFS - 1), guideUrl];
      guideInstruction = ` ${LAYOUT_GUIDE_INSTRUCTION}`;
    } catch (err) {
      console.warn(`⚠ ai-ref layout-guide#${assetId}: ${err instanceof Error ? err.message : err}`);
    }
    prompt = buildAiReferencePrompt(variationText) + guideInstruction;
  } else {
    // DI2-3: первым слотом идёт якорная композиция кампании, дальше —
    // референсы своего формата. Схема-раскладки у зависимых нет (DI2-4),
    // освободившийся слот отдан референсам.
    genUrls = anchorUrl
      ? [anchorUrl, ...refUrls.slice(0, MAX_EDIT_REFS - 1)]
      : refUrls.slice(0, MAX_EDIT_REFS);
    if (!anchorUrl) {
      console.warn(`⚠ ai-ref#${assetId} (${assetKey}): нет якоря кампании — генерация без стиля email`);
    }
    prompt = buildSecondaryPrompt({
      variationText,
      styleText: opts.anchor?.styleText ?? "",
      hasAnchor: Boolean(anchorUrl),
      formatLabel,
      targetW,
      targetH,
    });
  }
  const aspect = nearestFalAspect(targetW, targetH);
  const folder = `bundles/${bundleId}`;

  const attempts: AiRefAttempt[] = [];
  let chosen: ChosenAttempt | null = null;
  let bestCandidate: ChosenAttempt | null = null;
  let bestScore = -1;

  for (let attempt = 1; attempt <= AI_REF_MAX_ATTEMPTS && !chosen; attempt++) {
    // Модель — GPT Image 2 (A-7, ей не нужен aspect: канвас точный);
    // env-откат на nano-banana-2 → путь 16:9 + Bria-достройка, как раньше.
    // Брендовый override (grok) для этого режима не имеет смысла.
    const gen =
      aiRefImageModel() === "fal-ai/nano-banana-2"
        ? await runPersonFal(prompt, genUrls, aspect, null)
        : await runGptImage2Edit({
            prompt,
            imageUrls: genUrls,
            width: targetW,
            height: targetH,
          });
    if (!gen.success || !gen.imageUrl) {
      attempts.push({
        imageUrl: null,
        score: 0,
        pass: false,
        reasons: [`generate: ${gen.error ?? "unknown"}`],
        tech: null,
      });
      continue;
    }

    const fitted = await fitAndStoreAsset(
      gen.imageUrl,
      targetW,
      targetH,
      `${variantId}_${assetKey}_try${attempt}`,
      folder,
      `ai-ref#${assetId}@${attempt}`,
    );
    if (!fitted.ok) {
      attempts.push({
        imageUrl: null,
        score: 0,
        pass: false,
        reasons: [fitted.reason],
        tech: null,
      });
      continue;
    }

    const buffer = await fetchBuffer(fitted.url);
    if (!buffer) {
      attempts.push({
        imageUrl: fitted.url,
        score: 0,
        pass: false,
        reasons: ["download: не удалось прочитать сохранённый ассет"],
        tech: null,
      });
      continue;
    }

    // Кадр banana НЕ модифицируется (A-6: пост-обработка A-4/A-5 отменена
    // Пользователем — композиция модели устраивает как есть).
    // Стадия C ДО стадии B: детерминированные проверки бесплатны, VLM — нет.
    const tech = await validateAiAsset(buffer, targetW, targetH, {
      ...(centerZone ? { centerClearZone: centerZone } : {}),
    });
    if (!tech.passed) {
      attempts.push({
        imageUrl: fitted.url,
        score: 0,
        pass: false,
        reasons: tech.checks.filter((c) => !c.passed).map((c) => `${c.key}: ${c.detail}`),
        tech,
      });
      continue;
    }

    // Стадия B: приемщик (DI-R9). Транспортный сбой = приёмка пропущена,
    // попытка засчитывается как прошедшая (fail-open, причина в metadata).
    const verdict = await reviewComposition({
      imageUrl: fitted.url,
      refUrls: refUrls.slice(0, QA_REFS_SHOWN),
      variationText,
      brandName: baseBrand,
      profile,
      anchorUrl,
      formatLabel,
    });
    const attemptRow: AiRefAttempt = {
      imageUrl: fitted.url,
      score: Math.max(0, verdict.score),
      pass: verdict.pass,
      reasons: verdict.reasons,
      tech,
      ...(verdict.skipped ? { qaSkipped: true } : {}),
    };
    attempts.push(attemptRow);

    const candidate: ChosenAttempt = {
      index: attempts.length - 1,
      imageUrl: fitted.url,
      pass: verdict.pass,
    };
    if (verdict.pass) {
      chosen = candidate;
    } else if (attemptRow.score > bestScore) {
      bestScore = attemptRow.score;
      bestCandidate = candidate;
    }
  }

  // Ни одной пригодной попытки (все упали до приёмки) — лечить нечего.
  if (!chosen && !bestCandidate) {
    const lastReason = attempts.at(-1)?.reasons[0] ?? "все попытки провалились";
    await fail(`ai_reference: ${lastReason} (${attempts.length} попыток)`, {
      qa: { attempts, qaPassed: false, threshold: qaThreshold() },
    } as unknown as Prisma.InputJsonValue);
    return { ok: false };
  }

  // metadata.qa хранит tech-отчёт в виде списка проверок (без буферов).
  const attemptRows = (rows: AiRefAttempt[]) =>
    rows.map((a) => ({ ...a, tech: a.tech ? a.tech.checks : null }));

  // DI-R10 → auto-healing (B1): все попытки провалили приёмку — лучший
  // кандидат уходит на re-edit по замечаниям приёмщика (aiHealing.ts).
  // Победитель лечения (или исходник, если лучше не стало) — финальная база.
  const finalPick = (chosen ?? bestCandidate)!;
  let finalUrl = finalPick.imageUrl;
  let qaPassed = finalPick.pass;
  let healingMeta: {
    attempts: ReturnType<typeof attemptRows>;
    used: boolean;
    chosenAttempt: number | null;
  } | null = null;

  if (!chosen && bestCandidate) {
    const bestAttempt = attempts[bestCandidate.index]!;
    const heal = await healComposition({
      source: {
        imageUrl: bestCandidate.imageUrl,
        score: bestAttempt.score,
        reasons: bestAttempt.reasons,
      },
      targetW,
      targetH,
      publicIdBase: `${variantId}_${assetKey}`,
      folder,
      logTag: `ai-ref#${assetId}`,
      refUrls,
      variationText,
      brandName: baseBrand,
      // Лечим в том же контуре, в котором генерировали: у зависимых форматов
      // ни чека центра, ни требования пустой середины в промпте (DI2-4).
      ...(centerZone ? { centerClearZone: centerZone } : {}),
      profile,
      anchorUrl,
      formatLabel,
    });
    finalUrl = heal.winner.imageUrl;
    qaPassed = heal.winner.pass;
    healingMeta = {
      attempts: attemptRows(heal.attempts),
      used: heal.winner.healingIndex !== null,
      chosenAttempt: heal.winner.healingIndex,
    };
  }

  // Стиль-якорь (DI2-3): снимается ТОЛЬКО с якорного ассета и только когда
  // финальная база уже выбрана — описывать промежуточную попытку смысла нет.
  // Fail-open: без описания зависимые форматы поедут на одной картинке.
  let styleText = "";
  if (isAnchor) {
    const style = await describeCampaignStyle(finalUrl);
    styleText = style.text;
    if (style.error) {
      console.warn(`⚠ ai-ref style-anchor#${assetId}: ${style.error}`);
    }
  }

  const qaMeta = {
    attempts: attemptRows(attempts),
    chosenAttempt: finalPick.index,
    qaPassed,
    threshold: qaThreshold(),
    // База ДО removeBg: она уходит стиль-якорем в push/pop-up и в каскадные
    // регенерации зависимых форматов (DI2-3/DI2-9).
    baseUrl: finalUrl,
    ...(healingMeta ? { healing: healingMeta } : {}),
  };
  const baseMeta = {
    specKey: "ai_reference",
    specVersion: 1,
    // Safe-зона есть только у якорного формата — на push/pop-up текст не
    // накладывается, и превью зоны там показывать нечего (DI2-4).
    safeZonePct: isAnchor ? safeZonePct() : null,
    recommendedTextColor: null,
    luminance: null,
    textContrast: null,
    retinaUrl: null,
    validator: { passed: qaPassed, attempts: attempts.length },
    presetTitle: bundle.preset.title,
    qa: qaMeta,
    ...(isAnchor
      ? { styleAnchor: styleText, isStyleAnchor: true }
      : {
          // Чем именно наследовался стиль — видно в метаданных ассета.
          campaignAnchorUrl: anchorUrl,
          styleAnchorUsed: Boolean(anchorUrl),
          ...(opts.anchor?.fallback ? { styleAnchorFallback: true } : {}),
        }),
  };

  // Финал (A2): removeBg от финальной базы (DI-R8: свечение/тени как отдаст
  // модель) → единственная картинка ассета. Прозрачная версия — единственный
  // результат, поэтому её провал валит ассет (раньше — только производную
  // строку). Детерминированный public id: повторный запуск перезаписывает.
  const removed = await runBriaRemoveBg(finalUrl);
  if (!removed.success || !removed.imageUrl) {
    await fail(
      `removeBg: ${removed.error ?? "unknown"}`,
      baseMeta as unknown as Prisma.InputJsonValue,
    );
    return { ok: false };
  }
  const trUp = await withRetry(
    () =>
      uploadFromUrl(
        removed.imageUrl!,
        `${variantId}_${assetKey}${AI_REF_SUFFIX_TRANSPARENT}`,
        folder,
      ),
    `ai-ref-transparent#${assetId}`,
  );
  if (!trUp.success || !trUp.secure_url) {
    await fail(
      `transparent upload: ${trUp.error ?? "unknown"}`,
      baseMeta as unknown as Prisma.InputJsonValue,
    );
    return { ok: false };
  }

  await prisma.bundleAsset.update({
    where: { id: assetId },
    data: {
      status: "DONE",
      imageUrl: trUp.secure_url,
      errorMessage: null,
      // transparent — сигнал API добавить к подписи «— прозрачный фон» (A1/A2).
      metadata: { ...baseMeta, transparent: true } as unknown as Prisma.InputJsonValue,
    },
  });
  await dropLegacyDerived();

  console.log(
    `🧩 ai-ref ${assetKey}#${assetId}: ${isAnchor ? "anchor" : "secondary"} refs=${refs.length} ` +
      `attempts=${attempts.length}` +
      (healingMeta ? ` heal=${healingMeta.attempts.length} healed=${healingMeta.used}` : "") +
      ` qaPassed=${qaPassed}`,
  );
  await recomputeBundleStatus(bundleId);
  return { ok: true, baseUrl: finalUrl, styleText };
}
