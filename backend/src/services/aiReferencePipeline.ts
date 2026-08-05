import sharp from "sharp";
import { prisma } from "../lib/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { runPersonFal, runBriaRemoveBg } from "../lib/fal.js";
import { fitAndStoreAsset } from "../lib/assetFit.js";
import { nearestFalAspect } from "../lib/imageSize.js";
import { uploadFromUrl, uploadBuffer, withRetry } from "../lib/cloudinary.js";
import { fetchBuffer } from "./layerCache.js";
import { validateAiAsset } from "../lib/aiAssetValidator.js";
import type { AiTechReport } from "../lib/aiAssetValidator.js";
import { getLayoutGuideUrl, LAYOUT_GUIDE_INSTRUCTION } from "../lib/layoutGuide.js";
import { MAX_EDIT_REFS } from "./variationRefs.js";
import { reviewComposition, QA_REFS_SHOWN } from "../lib/vlmReviewer.js";
import {
  renderToken,
  deriveTokens,
  resolveMaterial,
  MAX_TOKEN_CHARS,
} from "../lib/typography3d.js";
import { pickGenerationRefs } from "./variationRefs.js";
import { recomputeBundleStatus, stripGenderName } from "./bundle.service.js";

/**
 * Пайплайн ai_reference (TASK ai-reference, R-PLAN §1.1/§3): «одна вариация →
 * одна композиция на бренд» из 5–15 готовых email-баннеров-референсов.
 *
 * Цикл на ассет (DI-R10: 1 попытка + 2 ретрая):
 *   A. nano-banana-2 /edit: первые ≤14 референсов пары (вариация × базовый
 *      бренд) + бриф вариации + композиционный контракт «без текста» →
 *      16:9 → fitAndStoreAsset (Bria bleed-expand) → ровно target-канвас.
 *   C. Техвалидация (aiAssetValidator): размер/резкость/рамки. Дешёвая и
 *      детерминированная, поэтому идёт ДО приёмщика — на явный брак VLM
 *      не тратится.
 *   B. Приемщик (vlmReviewer): вердикт {pass, score, reasons}.
 *   pass → выбираем; иначе ретрай; после третьей попытки — лучшая по score
 *   с пометкой qaPassed=false (бейдж в CRM).
 *
 * Выход — ТРИ строки BundleAsset (DI-R11, TASK §4):
 *   `<key>`             — родитель: композиция + текст-слой (казино-слово, A-1);
 *   `<key>_notext`      — композиция как сгенерирована;
 *   `<key>_transparent` — runBriaRemoveBg от базы (DI-R8: свечение/тени как есть).
 * Родительская строка создаётся launchGeneration из BundleType.assets;
 * производные создаёт/обновляет пайплайн (идемпотентно по [variantId, assetKey]).
 */

export const AI_REF_MAX_ATTEMPTS = 3;

/** Safe-зона DI-Q7 (27–73% ширины = 46%) в долях канваса. */
export const AI_REF_SAFE_ZONE = { x: 0.27, y: 0.04, w: 0.46, h: 0.92 };

/**
 * Зона «чистого центра» для техвалидации (A-3, email mask дизайнера):
 * текстовая часть центральной полосы — там на белом фоне не должно быть НИ
 * одного пропса/монетки. Нижняя часть центра исключена: по маске там
 * «область декора» (мелкие элементы у CTA допустимы).
 */
export const AI_REF_CENTER_CLEAR_ZONE = { x: 0.28, y: 0.08, w: 0.44, h: 0.62 };

/** Плейсхолдер текст-слоя, когда в брифе нет КАПС-токенов (A-1). */
export const DEFAULT_OVERLAY_TOKEN = "BONUS";

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

/** Казино-слово для текст-слоя: первый КАПС-токен брифа, иначе BONUS (A-1). */
export function pickOverlayToken(variationText: string): string {
  const token = deriveTokens(variationText, 1)[0];
  if (token && token.length <= MAX_TOKEN_CHARS) return token;
  return DEFAULT_OVERLAY_TOKEN;
}

/** Одна попытка генерации в metadata.qa.attempts (что видел админ/CRM). */
export interface AiRefAttempt {
  imageUrl: string | null;
  score: number;
  pass: boolean;
  reasons: string[];
  tech: AiTechReport | null;
  /** Приёмка пропущена по транспортной причине (vision недоступен). */
  qaSkipped?: boolean;
}

interface ChosenAttempt {
  index: number;
  imageUrl: string;
  buffer: Buffer;
  pass: boolean;
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
 * Stage B процессора для composeMode "ai_reference": полный цикл + все записи
 * BundleAsset (родитель + производные) + recomputeBundleStatus. Логический
 * брак не бросает — семейство ассетов переводится в FAILED с причиной
 * (домашний паттерн: Regenerate — путь ретрая).
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
}): Promise<void> {
  const { bundleId, variantId, assetId, assetKey, targetW, targetH } = opts;
  const [notextKey, transparentKey] = derivedAssetKeys(assetKey);

  const upsertDerived = async (
    key: string,
    data: {
      status: "DONE" | "FAILED";
      imageUrl?: string | null;
      errorMessage?: string | null;
      metadata?: Prisma.InputJsonValue;
    },
  ) => {
    await prisma.bundleAsset.upsert({
      where: { variantId_assetKey: { variantId, assetKey: key } },
      create: {
        bundleId,
        variantId,
        assetKey: key,
        width: targetW,
        height: targetH,
        status: data.status,
        imageUrl: data.imageUrl ?? null,
        errorMessage: data.errorMessage ?? null,
        ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
      },
      update: {
        width: targetW,
        height: targetH,
        status: data.status,
        approved: false,
        imageUrl: data.imageUrl ?? null,
        errorMessage: data.errorMessage ?? null,
        ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
      },
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
    // Производные прошлого запуска не должны пережить проваленный новый:
    // семейство падает целиком, иначе в CRM останется «свежий» notext от
    // старой композиции рядом с FAILED родителем.
    await prisma.bundleAsset.updateMany({
      where: { variantId, assetKey: { in: [notextKey, transparentKey] } },
      data: { status: "FAILED", errorMessage: `родительский ассет: ${reason}`, approved: false },
    });
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
  if (!bundle) return; // bundle удалён — no-op
  if (!bundle.presetId || !bundle.preset) {
    await fail("ai_reference: у бандла не выбрана вариация (preset)");
    return;
  }

  const baseBrand = stripGenderName(opts.brandName);
  let refs;
  try {
    refs = await pickGenerationRefs(bundle.presetId, baseBrand);
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
    return;
  }
  const refUrls = refs.map((r) => r.imageUrl);

  // A-6: последним референсом уходит схема-раскладка — позиционирование
  // модели показывается картинкой, под неё резервируется один слот из
  // MAX_EDIT_REFS. Best-effort: без схемы генерация не блокируется.
  let genUrls = refUrls.slice(0, MAX_EDIT_REFS);
  let guideInstruction = "";
  try {
    const guideUrl = await getLayoutGuideUrl();
    genUrls = [...refUrls.slice(0, MAX_EDIT_REFS - 1), guideUrl];
    guideInstruction = ` ${LAYOUT_GUIDE_INSTRUCTION}`;
  } catch (err) {
    console.warn(`⚠ ai-ref layout-guide#${assetId}: ${err instanceof Error ? err.message : err}`);
  }

  // Бриф: текст бандла (мастер заполняет его из вариации, но может уточнить);
  // пустой — сам текст вариации.
  const variationText = bundle.neuralPrompt.trim() || bundle.preset.text;
  const prompt = buildAiReferencePrompt(variationText) + guideInstruction;
  const aspect = nearestFalAspect(targetW, targetH);
  const folder = `bundles/${bundleId}`;

  const attempts: AiRefAttempt[] = [];
  let chosen: ChosenAttempt | null = null;
  let bestCandidate: ChosenAttempt | null = null;
  let bestScore = -1;

  for (let attempt = 1; attempt <= AI_REF_MAX_ATTEMPTS && !chosen; attempt++) {
    // Модель — ВСЕГДА дефолтный nano-banana-2 (TASK: генерация «через
    // nano-banana-2»); брендовый override (grok режет референсы до 3) для
    // этого режима не имеет смысла.
    const gen = await runPersonFal(prompt, genUrls, aspect, null);
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
      centerClearZone: AI_REF_CENTER_CLEAR_ZONE,
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
      buffer,
      pass: verdict.pass,
    };
    if (verdict.pass) {
      chosen = candidate;
    } else if (attemptRow.score > bestScore) {
      bestScore = attemptRow.score;
      bestCandidate = candidate;
    }
  }

  // DI-R10: ни одна не прошла — показываем лучшую по score с пометкой.
  const finalPick = chosen ?? bestCandidate;
  if (!finalPick) {
    const lastReason = attempts.at(-1)?.reasons[0] ?? "все попытки провалились";
    await fail(`ai_reference: ${lastReason} (${attempts.length} попыток)`, {
      qa: { attempts, qaPassed: false },
    } as unknown as Prisma.InputJsonValue);
    return;
  }
  const qaPassed = finalPick.pass;

  const qaMeta = {
    attempts: attempts.map((a) => ({ ...a, tech: a.tech ? a.tech.checks : null })),
    chosenAttempt: finalPick.index,
    qaPassed,
  };
  const baseMeta = {
    specKey: "ai_reference",
    specVersion: 1,
    safeZonePct: safeZonePct(),
    recommendedTextColor: null,
    luminance: null,
    textContrast: null,
    retinaUrl: null,
    validator: { passed: qaPassed, attempts: attempts.length },
    presetTitle: bundle.preset.title,
    qa: qaMeta,
  };

  // 1) Без текста — база как сгенерирована. Детерминированный public id:
  //    повторный запуск перезаписывает, не плодя файлов.
  const notextUp = await withRetry(
    () => uploadFromUrl(finalPick.imageUrl, `${variantId}_${assetKey}${AI_REF_SUFFIX_NOTEXT}`, folder),
    `ai-ref-notext#${assetId}`,
  );
  if (!notextUp.success || !notextUp.secure_url) {
    await fail(`notext upload: ${notextUp.error ?? "unknown"}`);
    return;
  }
  await upsertDerived(notextKey, {
    status: "DONE",
    imageUrl: notextUp.secure_url,
    metadata: { ...baseMeta, derivedFrom: assetKey } as unknown as Prisma.InputJsonValue,
  });

  // 2) Прозрачный фон (DI-R8): removeBg от базы, свечение/тени — как отдаст
  //    модель. Провал НЕ валит семейство — только эту строку.
  const removed = await runBriaRemoveBg(finalPick.imageUrl);
  if (removed.success && removed.imageUrl) {
    const trUp = await withRetry(
      () =>
        uploadFromUrl(
          removed.imageUrl!,
          `${variantId}_${assetKey}${AI_REF_SUFFIX_TRANSPARENT}`,
          folder,
        ),
      `ai-ref-transparent#${assetId}`,
    );
    if (trUp.success && trUp.secure_url) {
      await upsertDerived(transparentKey, {
        status: "DONE",
        imageUrl: trUp.secure_url,
        metadata: { ...baseMeta, derivedFrom: assetKey } as unknown as Prisma.InputJsonValue,
      });
    } else {
      await upsertDerived(transparentKey, {
        status: "FAILED",
        errorMessage: `upload: ${trUp.error ?? "unknown"}`,
      });
    }
  } else {
    await upsertDerived(transparentKey, {
      status: "FAILED",
      errorMessage: `removeBg: ${removed.error ?? "unknown"}`,
    });
  }

  // 3) Родитель — композиция + текст-слой (A-1: одно казино-слово нашим
  //    рендером в safe-зоне). Провал оверлея деградирует к базе без текста
  //    (в metadata остаётся причина), а не роняет DONE-семейство.
  const token = pickOverlayToken(variationText);
  let parentUrl = notextUp.secure_url;
  let overlayError: string | null = null;
  try {
    const rendered = await renderToken({
      token,
      fontSizePx: Math.round(targetH * 0.3),
      material: resolveMaterial(undefined),
      skewDeg: 8,
      rotateDeg: -4,
      bevel: true,
      specular: true,
      ownShadow: true,
    });
    // Вписываем в safe-зону с полями: ширина ≤ 90% зоны, высота ≤ 42% канваса.
    const maxW = Math.round(targetW * AI_REF_SAFE_ZONE.w * 0.9);
    const maxH = Math.round(targetH * 0.42);
    const scale = Math.min(1, maxW / rendered.width, maxH / rendered.height);
    const w = Math.max(1, Math.round(rendered.width * scale));
    const h = Math.max(1, Math.round(rendered.height * scale));
    const overlay =
      scale < 1
        ? await sharp(Buffer.from(rendered.png)).resize(w, h).png().toBuffer()
        : Buffer.from(rendered.png);
    const cx = AI_REF_SAFE_ZONE.x + AI_REF_SAFE_ZONE.w / 2;
    const cy = AI_REF_SAFE_ZONE.y + AI_REF_SAFE_ZONE.h / 2;
    const left = Math.max(0, Math.round(targetW * cx - w / 2));
    const top = Math.max(0, Math.round(targetH * cy - h / 2));
    const withText = await sharp(finalPick.buffer)
      .composite([{ input: overlay, left, top }])
      .png()
      .toBuffer();
    const textUp = await withRetry(
      () => uploadBuffer(withText, `${variantId}_${assetKey}_text`, folder),
      `ai-ref-text#${assetId}`,
    );
    if (textUp.success && textUp.secure_url) parentUrl = textUp.secure_url;
    else overlayError = textUp.error ?? "upload failed";
  } catch (err) {
    overlayError = err instanceof Error ? err.message : String(err);
  }

  await prisma.bundleAsset.update({
    where: { id: assetId },
    data: {
      status: "DONE",
      imageUrl: parentUrl,
      errorMessage: null,
      metadata: {
        ...baseMeta,
        overlayToken: token,
        overlayError,
        derivedKeys: [notextKey, transparentKey],
      } as unknown as Prisma.InputJsonValue,
    },
  });

  console.log(
    `🧩 ai-ref ${assetKey}#${assetId}: refs=${refs.length} attempts=${attempts.length} ` +
      `qaPassed=${qaPassed} token=${token}${overlayError ? ` overlayError=${overlayError}` : ""}`,
  );
  await recomputeBundleStatus(bundleId);
}
