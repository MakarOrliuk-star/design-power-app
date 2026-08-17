import { prisma } from "../lib/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { runPersonFal, runGptImage2Edit, runBriaRemoveBg } from "../lib/fal.js";
import { fitAndStoreAsset } from "../lib/assetFit.js";
import { nearestFalAspect } from "../lib/imageSize.js";
import { uploadBuffer, withRetry } from "../lib/cloudinary.js";
import {
  applyPromoEffects,
  recommendedTextColorFor,
  resolveEffectsConfig,
  zoneLuminanceOverWhite,
} from "../lib/promoEffects.js";
import type { EffectsToggle, PromoEffectsConfig } from "../lib/promoEffects.js";
import { pickGlowColor } from "../lib/glowColor.js";
import { keyWhiteBackground, mergeCutoutAlpha, cutoutMode } from "../lib/whiteKey.js";
import { fetchBuffer } from "./layerCache.js";
import { validateAiAsset, SIDE_FILL_MIN_RATIO } from "../lib/aiAssetValidator.js";
import {
  getLayoutGuideUrl,
  LAYOUT_GUIDE_INSTRUCTION,
  getPropsGuideUrl,
  PROPS_GUIDE_INSTRUCTION,
} from "../lib/layoutGuide.js";
import { MAX_EDIT_REFS } from "./variationRefs.js";
import { reviewComposition, QA_REFS_SHOWN, qaThreshold } from "../lib/vlmReviewer.js";
import type { QaProfile } from "../lib/vlmReviewer.js";
import { describeCampaignStyle } from "../lib/styleAnchor.js";
import { planCampaignProps } from "../lib/propPlan.js";
import { healComposition } from "./aiHealing.js";
import type { AiRefAttempt } from "./aiHealing.js";
import { scanImageUrl, newScanBudget } from "../lib/textScan.js";
import type { ScanBudget } from "../lib/textScan.js";
import { pickGenerationRefs } from "./variationRefs.js";
import { recomputeBundleStatus, stripGenderName, heroGenderFromBrand } from "./bundle.service.js";
import type { HeroGender } from "./bundle.service.js";

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

/**
 * Суффикс public id картинки С ЭФФЕКТАМИ (TASK glow-fade-density). В отличие
 * от двух суффиксов выше это НЕ assetKey и не строка в БД — только имя файла
 * в Cloudinary. Схема остаётся одноассетной: `_transparent` — чистый вырез
 * (источник), `_final` — он же со свечением и фейдом, и именно он попадает в
 * `BundleAsset.imageUrl`. Разделение даёт идемпотентность: пере-применение
 * эффектов всегда идёт от `_transparent`.
 */
export const AI_REF_SUFFIX_FINAL = "_final";

/** Версия схемы `metadata.effects` — на случай смены набора полей. */
export const AI_REF_EFFECTS_VERSION = 1;

/** Проекция эффектов в `metadata.effects` (её читают админка и скрипт). */
export interface AiRefEffectsMeta {
  applied: boolean;
  glowHex: string | null;
  /** «inherited» — цвет пришёл с якоря кампании (DI3-4), без своего запроса. */
  glowSource: "vlm" | "fallback" | "inherited" | null;
  glowReason: string | null;
  fadeHeightPct: number | null;
  /** Чистый вырез без эффектов — источник для пере-применения. */
  sourceUrl: string;
  version: number;
  /** Заполнено, если эффекты не легли: ассет остался чистым (fail-open). */
  error?: string;
}

export interface AiRefEffectsOutcome {
  /** Что записать в `BundleAsset.imageUrl`. */
  imageUrl: string;
  meta: AiRefEffectsMeta;
  /** Подсказка вёрстке для safe zone; null — зоны нет или эффекты не легли. */
  textColor: string | null;
}

/**
 * Наложение эффектов на готовый вырез и заливка результата (R-PLAN §3.3).
 * Вынесено отдельно и экспортировано: этой же функцией работает скрипт
 * пере-применения к старым бандлам (§3.6).
 *
 * FAIL-OPEN по построению: композиция уже прошла дорогую генерацию, приёмку и
 * (возможно) лечение. Сбой скачивания или заливки эффектов — повод отдать
 * чистый прозрачный ассет с пометкой в metadata, но не повод ронять ассет.
 */
export async function applyEffectsToAsset(opts: {
  /** Чистый вырез — источник и одновременно фолбэк-результат. */
  transparentUrl: string;
  /** Картинка для выбора цвета (белый фон, до removeBg). */
  colorSourceUrl: string;
  refUrls: string[];
  config: PromoEffectsConfig;
  /** Цвет якоря кампании; задан — свой запрос не делается (DI3-4). */
  inheritedGlowHex: string | null;
  publicId: string;
  folder: string;
  logTag: string;
  /** Safe zone формата в долях — только у якоря; null → текст-подсказки нет. */
  safeZone: { x: number; y: number; w: number; h: number } | null;
}): Promise<AiRefEffectsOutcome> {
  const meta: AiRefEffectsMeta = {
    applied: false,
    glowHex: null,
    glowSource: null,
    glowReason: null,
    fadeHeightPct: null,
    sourceUrl: opts.transparentUrl,
    version: AI_REF_EFFECTS_VERSION,
  };
  const skip = (error?: string): AiRefEffectsOutcome => ({
    imageUrl: opts.transparentUrl,
    meta: error ? { ...meta, error } : meta,
    textColor: null,
  });

  if (!opts.config.glow && !opts.config.fade) return skip();

  const buffer = await fetchBuffer(opts.transparentUrl);
  if (!buffer) {
    console.warn(`⚠ ${opts.logTag}: не удалось скачать вырез — эффекты пропущены`);
    return skip("download failed");
  }

  let glowHex: string | null = null;
  if (opts.config.glow) {
    if (opts.inheritedGlowHex) {
      glowHex = opts.inheritedGlowHex;
      meta.glowSource = "inherited";
      meta.glowReason = "цвет якоря кампании";
    } else {
      const picked = await pickGlowColor({
        imageUrl: opts.colorSourceUrl,
        refUrls: opts.refUrls,
        buffer,
      });
      glowHex = picked.hex;
      meta.glowSource = picked.source;
      meta.glowReason = picked.reason;
    }
    meta.glowHex = glowHex;
  }

  const rendered = await applyPromoEffects(buffer, { glowHex, config: opts.config });
  const up = await withRetry(
    () => uploadBuffer(rendered, opts.publicId, opts.folder),
    opts.logTag,
  );
  if (!up.success || !up.secure_url) {
    console.warn(`⚠ ${opts.logTag}: заливка не удалась (${up.error ?? "unknown"})`);
    return skip(`upload: ${up.error ?? "unknown"}`);
  }

  meta.applied = true;
  meta.fadeHeightPct = opts.config.fade ? opts.config.fade.heightPct : null;
  const textColor = opts.safeZone
    ? recommendedTextColorFor(await zoneLuminanceOverWhite(rendered, opts.safeZone))
    : null;
  return { imageUrl: up.secure_url, meta, textColor };
}

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
 * Анатомия персонажа (правка 2026-08-15, запрос заказчика: «чтобы на руке не
 * было 4 пальца, хотя должно быть 5»). Блок ОБЩИЙ для якоря и зависимых
 * форматов: герой во всех трёх один и тот же и ломается одинаково, а прежний
 * контракт про руки не говорил ничего — единственным упоминанием был пункт
 * артефактов у приёмщика («no deformed hands»), то есть брак ловился уже
 * постфактум и без счёта пальцев.
 *
 * Две части намеренно разделены:
 *  - СТРУКТУРА берётся с референсов бренда — у маскота может быть лапа, копыто
 *    или мультяшная перчатка с четырьмя пальцами, и это норма, а не брак;
 *  - КОЛИЧЕСТВО задаётся числом для человекоподобных героев: «нарисуй руки
 *    правильно» модель трактует как угодно, «ровно пять» — однозначно.
 *
 * Разрешение спрятать кисть — не поблажка, а рабочий приём: скрытая рука
 * всегда лучше сломанной. «За кадр» намеренно не предлагается — это
 * противоречило бы блоку EDGES обоих контрактов.
 */
export const AI_REF_ANATOMY_CONTRACT =
  "CHARACTER ANATOMY (critical): draw the hero's hands and limbs correctly and completely. " +
  "First look at the reference banners to see WHAT this character's hands are — human hands, gloved cartoon " +
  "hands, animal paws with claws, hooves or fins — and reproduce that same structure with the SAME number of " +
  "digits the references show for this character. If the hero is human or humanoid, or the references do not " +
  "show the hands clearly, then every hand has exactly FIVE digits — four fingers plus one thumb — and every " +
  "foot five toes. Both hands must carry the same count. Never draw four fingers where five belong, never add " +
  "a sixth finger, never fuse, duplicate, stump or bend digits backwards, and never give the hero extra or " +
  "missing arms, legs, ears or tails. A hand that holds a prop must wrap around it with every finger in a " +
  "plausible place. If a pose makes a hand hard to draw, change the pose or let the hand be naturally hidden " +
  "behind a prop or behind the body — a hidden hand is fine, a malformed one ruins the whole creative.";

/**
 * Правило текста в промпте ГЕНЕРАЦИИ (TASK no-baked-text, 2026-08-17).
 *
 * До этой правки правило было захардкожено в обоих контрактах и звучало как
 * «STRICTLY NO text… the only lettering allowed is FS, SCATTER, BONUS, VIP,
 * WILD or 777». Заказчик жаловался, что модель «самовольно» пишет FS и
 * «Free spins», — на деле она исполняла наш собственный белый список, где FS
 * стоит первым словом. Теперь список живёт только в разрешающем режиме.
 *
 * Строгая редакция намеренно не ограничивается отрицаниями: «no text» без
 * позитивной альтернативы модель отрабатывает плохо, поэтому каждому носителю
 * надписи (барабан, фишка, ящик) сразу выдаётся замена — орнамент или символ.
 *
 * Исключение для игральных карт сформулировано как свойство ОБЪЕКТА, а не как
 * список разрешённых букв: перечисление «можно A, K, Q, J» модель читает как
 * лицензию на буквы вообще и переносит их на фишки и барабаны — ровно та
 * ошибка, что была в прежней редакции.
 */
export function textRuleForPrompt(allowText: boolean): string {
  if (allowText) {
    return (
      "STRICTLY NO text, captions, headlines, CTA buttons, logos or watermarks anywhere; the only lettering " +
      "allowed is short casino words that naturally belong to props (slot reels, chips, medallions), such as " +
      "FS, SCATTER, BONUS, VIP, WILD or 777."
    );
  }
  return (
    "ABSOLUTELY NO TEXT: the image must contain no letters, no words, no numbers, no digits, no logos, no " +
    "brand marks, no watermarks, no captions, no headlines and no CTA buttons — nowhere, at no size, not even " +
    "tiny, blurred or partially hidden ones. Every surface that would normally carry lettering stays clean: " +
    "slot reels show PICTORIAL symbols only (fruits, gems, bells, stars, crowns — never the digits 777 and " +
    "never a written word), casino chips are BLANK with no denomination numbers on them, crates, medallions, " +
    "coins, ribbons and banners carry ORNAMENT only — patterns, engraving, gems — never an inscription. " +
    "THE ONLY EXCEPTION is a standard playing card, which may show its natural rank marks and suit pips, " +
    "because those marks are part of the card object itself; nothing else in the frame may carry a symbol. " +
    // Референсы — это ГОТОВЫЕ баннеры, и текст на них есть почти всегда. Без
    // этой оговорки модель считает надписи частью визуального языка бренда,
    // который ей велено воспроизвести, и переносит их в новый кадр.
    "The reference banners you are given are finished advertisements and DO contain headlines and promo " +
    "wording — that wording is NOT part of the style you must reproduce. Copy their palette, lighting, " +
    "rendering and props, and leave every piece of their text behind."
  );
}

/**
 * Композиционный контракт (аналог PERSON_LAYER_CONTRACT): зашит в код, чтобы
 * админский текст вариации отвечал за СМЫСЛ, а форма кадра была стабильной.
 *
 * Правило текста — параметр (TASK no-baked-text): режим задаётся вариацией
 * (`NeuralPromptPreset.allowText`), дефолт — строгий запрет.
 */
export function buildCompositionContract(opts?: { allowText?: boolean }): string {
  return AI_REF_COMPOSITION_BODY + textRuleForPrompt(opts?.allowText ?? false) + AI_REF_COMPOSITION_TAIL;
}

/** Тело контракта якоря без правила текста (оно подставляется режимом). */
const AI_REF_COMPOSITION_BODY =
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
  // Правка 2026-08-13 (заказчик: «композиция стала пустой»): без явного
  // требования обилия модель ставит один пропс на сторону и кадр читается
  // как незаконченный. Числа держат обе стороны насыщенными, при этом центр
  // по-прежнему обязан остаться пустым — за этим следит детерминированный
  // чек `AI_REF_CENTER_CLEAR_ZONE`, поэтому «богато» не расползётся в copy space.
  "RICHNESS: both side sections must look abundant and expensive, never sparse — the left anchor " +
  "group is a generous pile of 5 to 8 overlapping props of different sizes, the right section adds " +
  "3 to 5 supporting props around the character, and 4 to 6 smaller props sit above the two side " +
  "groups. Fill the side quarters densely from top to bottom; empty space belongs ONLY in the middle " +
  "copy space, never in the side sections. " +
  // Правка 2026-08-13: без этого ограничения «богато» растёт В СТОРОНУ ЦЕНТРА
  // и валит детерминированный чек чистой зоны (90 % белого против порога 95 %).
  // Направление роста задаётся явно: наружу и вверх, не к середине.
  "GROWTH DIRECTION: make the side sections denser by growing them OUTWARD toward the left and right " +
  "edges and UPWARD toward the top, never inward toward the middle. Everything on the left must stay " +
  "within the leftmost quarter of the width, everything on the right within the rightmost quarter. " +
  "The middle half of the canvas stays untouched white — adding props there instead of stacking them " +
  "on the sides is the single worst mistake you can make in this layout. " +
  "EDGES: the character and all key props stay fully inside the frame with a clear margin from the " +
  "canvas edges; only minor decorative props may approach the edges. ";

/** Хвост контракта якоря — идёт СРАЗУ после правила текста. */
const AI_REF_COMPOSITION_TAIL =
  " Professional advertising quality, coherent lighting across all elements.";

/**
 * Обратная совместимость: контракт с дефолтным (строгим) режимом текста.
 * Тот же приём, что у `AI_REF_SECONDARY_CONTRACT` ниже.
 */
export const AI_REF_COMPOSITION_CONTRACT = buildCompositionContract();

/**
 * Сходство персонажа с референсами (правка 2026-08-13, запрос заказчика:
 * «у части брендов он должен быть один в один, а у части немного вариативный»).
 * Настраивается на бренде (`Brand.characterFidelity`), значение по умолчанию —
 * `variant`.
 *
 * Требование адресовано именно РЕФЕРЕНСАМ бренда. Единство персонажа ВНУТРИ
 * кампании (email → push → pop-up) им не затрагивается: там герой обязан
 * оставаться тем же во всех форматах, за это отвечает блок STYLE SOURCE.
 */
export type CharacterFidelity = "exact" | "variant";

export const DEFAULT_CHARACTER_FIDELITY: CharacterFidelity = "variant";

export function characterFidelityOf(raw?: string | null): CharacterFidelity {
  return raw === "exact" ? "exact" : DEFAULT_CHARACTER_FIDELITY;
}

export function characterFidelityInstruction(fidelity: CharacterFidelity): string {
  if (fidelity === "exact") {
    return (
      "CHARACTER LIKENESS: the hero is this brand's established mascot — reproduce the character from " +
      "the reference banners EXACTLY: the same species or person, the same face and facial features, " +
      "the same body proportions, the same outfit, colors and accessories. Treat the character as a " +
      "fixed asset that may only be re-posed and re-lit, never redesigned or restyled."
    );
  }
  return (
    "CHARACTER LIKENESS: keep the hero clearly recognisable as the same brand character from the " +
    "reference banners — the same species or type, the same art style, rendering and overall design " +
    "language, the same wardrobe style and palette — but give this particular creative its own take: " +
    "vary the pose, the expression and the small details of the face and outfit. It must read as the " +
    "same character in a new shot, not as a copy of a reference and not as a different character."
  );
}

/**
 * Требование пола героя (правка 2026-08-13). Формулировка намеренно
 * повторяет пол трижды и запрещает противоположный: короткое «male character»
 * модель теряет, когда сочиняет сцену по женским по большей части референсам.
 */
export function heroGenderInstruction(gender: HeroGender | null): string {
  if (!gender) return "";
  const [noun, opposite] =
    gender === "male" ? ["a MAN", "a woman"] : ["a WOMAN", "a man"];
  return (
    `HERO GENDER (mandatory): the main character is ${noun}. ` +
    `Render ${noun} — never ${opposite}, and never replace the hero with a character of the ` +
    `opposite gender even if some reference banners show one.`
  );
}

/**
 * Промпт якорного формата (email). Заказчик 2026-08-15: «email сам всё ок по
 * генерации» — поэтому набор предметов и правила композиции пропсов сюда НЕ
 * добавляются, они существуют только у зависимых форматов.
 */
export function buildAiReferencePrompt(
  variationText: string,
  gender: HeroGender | null = null,
  fidelity: CharacterFidelity = DEFAULT_CHARACTER_FIDELITY,
  /** Режим текста вариации (TASK no-baked-text); дефолт — строгий запрет. */
  allowText = false,
): string {
  const brief = variationText.trim();
  return [
    brief ? `Campaign brief: ${brief}.` : "",
    buildCompositionContract({ allowText }),
    characterFidelityInstruction(fidelity),
    AI_REF_ANATOMY_CONTRACT,
    heroGenderInstruction(gender),
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Плотность предметов на зависимых форматах (TASK glow-fade-density, DI3-9):
 * верхняя граница нормы «герой + 0–1 крупный пропс в руках + 4–8 мелких».
 * Настраивается в админке на формат (`BundleTypeAsset.maxProps`, DI3-14) —
 * калибруется по логам без деплоя.
 */
export const DEFAULT_MAX_PROPS = 14;
/**
 * Нижняя граница нормы. Была 4 — по живому прогону 2026-08-13 заказчик
 * сообщил, что кадр вышел пустым: коридор 4–8 боролся с перегрузом
 * `pop-up not ok2`, но перелетел в другую крайность. Перегруз там создавали
 * не мелкие предметы, а КРУПНЫЕ объекты на земле (слот-машина, сундуки,
 * стопки денег) — их запрет остаётся, а мелких парящих можно вдвое больше.
 */
export const MIN_PROPS = 8;

/** Потолок коридора: выше кадр физически не читается (проверено на not-ok2). */
export const PROPS_HARD_CAP = 24;

export function clampMaxProps(value?: number | null): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_PROPS;
  return Math.max(MIN_PROPS, Math.min(PROPS_HARD_CAP, Math.round(value)));
}

/**
 * Нижняя граница коридора из админки (правка 2026-08-15, заказчик: «предметы
 * должны быть настроены с админки, то есть минимум 8»). Раньше низ был
 * константой в коде, а в /admin выводился только потолок.
 *
 * `MIN_PROPS` остаётся жёстким полом: ниже восьми кадр выходил пустым — это
 * уже проверено живым прогоном 2026-08-13, и повторять эту ошибку через
 * настройку незачем. Перевёрнутый коридор (низ выше верха) чиним молча в
 * пользу низа: настройку правит человек, и ронять из-за опечатки генерацию,
 * которая уже прошла половину пайплайна, неправильно.
 */
export function clampMinProps(value?: number | null, cap = DEFAULT_MAX_PROPS): number {
  const upper = clampMaxProps(cap);
  if (typeof value !== "number" || !Number.isFinite(value)) return Math.min(MIN_PROPS, upper);
  return Math.max(MIN_PROPS, Math.min(upper, Math.round(value)));
}

/**
 * Контракт зависимого формата (TASK multiformat-promo, DI2-3/DI2-4): push и
 * pop-up собираются ПОСЛЕ email и обязаны выглядеть как та же кампания.
 * Отличия от якорного контракта:
 *  - первой картинкой идёт утверждённая email-композиция (стиль-эталон), и
 *    её раскладку копировать запрещено — только палитру/героя/пропсы/свет;
 *  - copy space не резервируется: текста на этих форматах не будет (DI2-4),
 *    поэтому центр канваса можно занимать.
 *
 * TASK glow-fade-density (задание 3, DI3-9/DI3-11): прежняя редакция сама
 * провоцировала перегруз — она требовала «the main character AND the anchor
 * prop group» и «fill the canvas», а первой картинкой отдавала плотный
 * email-якорь. Теперь состав кадра задан числом, крупные объекты на переднем
 * плане перечислены поимённо как запрет, и явно сказано, что у якоря
 * наследуется стиль, но НЕ плотность (R-P2). Семейство пропсов при этом
 * по-прежнему берётся с референсов формата — меняем количество и калибр,
 * а не стилистику предметов (DI3-11).
 */
export function buildSecondaryContract(opts?: {
  /** Верх коридора предметов из админки. */
  maxProps?: number;
  /** Низ коридора предметов из админки (не ниже MIN_PROPS). */
  minProps?: number;
  /**
   * Широкий формат (push, ~2:1). Логика ПРЕДМЕТОВ у него другая, чем у
   * почти квадратного pop-up: по эталонам `push1/push2 ok` дизайнер ставит
   * несколько КРУПНЫХ объектов (объёмные золотые буквы во всю треть высоты,
   * листва, реквизит), сильно обрезанных краями, и часть из них уходит ЗА
   * персонажа. Сборку кадра заказчик оставил как есть — различается только
   * калибр и глубина предметов.
   */
  wide?: boolean;
  /**
   * Набор предметов кампании (правка 2026-08-15): спланированный по
   * референсам бренда и брифу либо снятый с утверждённого email. Пусто —
   * старое поведение «подбери свои»: legacy-бандлы и fail-open.
   */
  propInventory?: string;
  /** Режим текста вариации (TASK no-baked-text); дефолт — строгий запрет. */
  allowText?: boolean;
}): string {
  const cap = clampMaxProps(opts?.maxProps);
  const min = clampMinProps(opts?.minProps, cap);
  const wide = opts?.wide ?? false;
  const allowText = opts?.allowText ?? false;
  const propInventory = opts?.propInventory ?? "";
  // Крупный объект широкого формата (push). До TASK no-baked-text здесь стояли
  // «объёмные буквы FS, BONUS, VIP, 777 как полноценный пропс» — это был третий
  // и самый прямой источник надписей на push: белый список из общего правила
  // текста тут ещё и подкреплялся требованием сделать буквы КРУПНЫМИ. В строгом
  // режиме место крупного объекта занимают объёмные предметы без единого знака.
  const bigPiece = allowText
    ? "oversized volumetric casino lettering (FS, BONUS, VIP, 777) works as a full-blown prop, not as a caption"
    : "oversized volumetric objects work as full-blown props — a giant gem, crown, coin, star, gift box, " +
      "trophy cup or treasure medallion, all of them WITHOUT any letters or numbers on them";
  const scale = wide
    ? "SCALE (wide format): the props are BIG — the largest ones stand as tall as a third of the canvas " +
      `height, and ${bigPiece}. Mix two or three of these large pieces with the smaller ones; a frame built only ` +
      "from small props reads as empty in this aspect ratio. "
    : "SCALE: keep the props clearly smaller than the character, mixing a few medium ones near the hero " +
      "with smaller ones further out. "
  const depth = wide
    ? "DEPTH: a few large decorative pieces — foliage, fabric, ribbons" +
      (allowText ? ", oversized lettering" : ", oversized gems and ornaments") +
      " — may sit BEHIND the hero and run off the canvas edges, framing the character and giving the shot " +
      "depth. Keep them softer and lower in contrast than the hero so they stay background. "
    : "";
  // Набор предметов кампании (правка 2026-08-15, заказчик: «предметы не должны
  // быть рандомными — общая композиция промо по референсам и промпту»).
  //
  // Прежняя редакция («подбери свои объекты, как дизайнер») была ответом на
  // другую жалобу — «push выглядит как переставленный email». Она эту задачу
  // решила, но ценой разброса: набор предметов каждый раз сочинялся заново, и
  // три формата переставали читаться как одна акция. Здесь разделены ЧТО и
  // КАК: инвентарь кампании фиксирован (он снят с утверждённого email, то есть
  // выведен из референсов бренда и брифа вариации), а компоновка по-прежнему
  // своя — «та же кампания, другой кадр», а не копия якоря.
  //
  // Повтор объектов разрешён намеренно: в списке 6–10 позиций, а в кадре нужно
  // 8–14 предметов, и без разрешения повторять модель начнёт добирать разницу
  // выдуманными объектами — ровно тем, что мы убираем.
  const propChoice = propInventory.trim()
    ? "PROP CHOICE: this placement belongs to a campaign whose prop set is already approved, so the objects are " +
      `NOT yours to invent. The campaign prop set is: ${propInventory.trim()}. Build the scene from THESE objects: ` +
      "pick the ones that suit this canvas and its aspect ratio, and repeat some of them at different sizes, angles " +
      "and distances to reach the required count. You may add AT MOST TWO extra objects, and only if they belong to " +
      "the same visual family and the campaign brief calls for them. Objects unrelated to the prop set or to the " +
      "brief are wrong. What must differ from the anchor creative is the ARRANGEMENT, not the inventory: same " +
      "campaign objects, new shot composed for this format. "
    : // Fail-open: описание якоря не снялось (или бандл сделан до этой правки) —
      // остаётся прежнее поведение, иначе зависимый формат встал бы вовсе.
      "PROP CHOICE: do NOT reproduce the anchor creative's set of objects. Pick your OWN props for this format, " +
      "the way a designer would when drawing the next piece of the same campaign: they must belong to the same visual " +
      "family as the brand's reference banners (same materials, finish and level of detail) and suit the campaign theme, " +
      "but the specific objects and their arrangement are yours to choose. The result should look like the same campaign " +
      "drawn by the same hand for a different placement — not like the anchor rearranged. ";
  return (
    "Create ONE new cohesive casino promo composition for this format, belonging to an EXISTING campaign. " +
    "STYLE SOURCE: the FIRST image is the APPROVED anchor creative of that same campaign — reproduce its palette, " +
    "character design and outfit, prop family, material quality, lighting and rendering EXACTLY; it is the same " +
    "campaign and the same hero. Do NOT copy its layout, crop or arrangement — compose a NEW scene that fits " +
    "this canvas and its aspect ratio. " +
    "The remaining images are reference banners of this brand for THIS format — follow them for framing, prop choice and scale. " +
    "BACKGROUND: pure solid white (#FFFFFF), completely flat — no scenery, no gradients, no glow, no bokeh, no light rays " +
    "and no cast shadows on the background; the artwork will be cut out later, so every element needs clean crisp edges. " +
    "COMPOSITION: a rich but well-organised scene made of exactly two things. " +
    "(1) THE HERO: the character large and close-up, filling most of the canvas height, holding AT MOST ONE larger prop in their hands. " +
    // Логика ПРЕДМЕТОВ снята с эталонов дизайнера `pop-up ok1/ok2` (правка
    // 2026-08-13). Сборку кадра заказчик оставил как есть — трогаем только
    // то, как подбираются и раскладываются сами items.
    `(2) FLOATING PROPS: between ${min} and ${cap} props float in the air around the hero. ` +
    // Правка 2026-08-15 (заказчик: «предметы будто просто поставлены и без
    // смысла»). Прежняя редакция буквально просила равномерность («spread
    // roughly evenly», «into all four corners»), и модель её исполняла: ровный
    // ковёр одинаково важных объектов. Дизайнер так не делает — он строит
    // группы, иерархию и направление. Логика берётся с референсов ФОРМАТА,
    // а принципы ниже — словарь на случай, если модель их не прочитает.
    "PROP COMPOSITION: look at how the props are ARRANGED in the reference banners of this format — how they " +
    "group, how they overlap each other and the hero, which one dominates, where the designer left empty space — " +
    "and compose this frame by the same logic, with the campaign's own objects. Concretely: " +
    "(a) HIERARCHY — one or two KEY props are clearly the largest and sharpest and sit next to the hero's hands " +
    "or face, a few medium props support them, the rest are small accents; never make all props the same size; " +
    "(b) GROUPS — the props form two or three tight clusters of overlapping objects rather than an even sprinkle; " +
    "inside a cluster objects touch and overlap each other, between clusters there is clean empty space; " +
    "(c) FLOW — the clusters follow a diagonal or an arc that leads the eye toward the hero's face and the key " +
    "prop, as if the objects were caught mid-flight around them; a symmetric ring or a mirrored left-right layout is wrong; " +
    "(d) RHYTHM — uneven spacing and varied tilt angles: some props nearly touching, some alone; nothing lined up " +
    "on a grid, in a row or at equal distances. " +
    // Правка 2026-08-13 (заказчик: «то блюрены то обычные, как будто дизайнер
    // делает»): по эталонам push1/push2 часть пропсов идёт в расфокусе или
    // смазе, и именно это отличает кадр дизайнера от плоской раскладки
    // наклеек. Требуем явно — «some softer» модель игнорировала.
    "FOCUS: shoot the scene with a real lens. Two or three props must be visibly OUT OF FOCUS — soft and " +
    "slightly blurred, as if closer to or further from the camera than the hero — and one or two may carry a " +
    "light motion blur, as if caught mid-flight. The rest stay tack sharp with crisp edges, and the hero is " +
    "always the sharpest element. A frame where every prop is equally sharp looks like flat stickers, not " +
    "like a designed composition. " +
    scale +
    depth +
    `The frame must feel abundant, not empty: fewer than ${min} floating props is wrong, more than ${cap} is wrong too. ` +
    propChoice +
    "FORBIDDEN: no slot machines, no fortune wheels, no roulette wheels, no treasure chests, no open suitcases or crates, " +
    "no stacks of banknotes, no piles or heaps of coins or chips, no props standing on the ground or piled up around the " +
    // Правка 2026-08-15: прежнее «stay separated» противоречило требованию
    // групп — оно и давало ровно расставленные одиночные объекты. Запрещаем
    // не перекрытие, а неразличимую массу.
    "hero's feet, no second character. Props may overlap each other inside a group, but each object must stay " +
    "readable as a separate thing — never let them melt into one solid unreadable mass. " +
    "There is NO reserved copy space in this format, the center may be occupied by the character. " +
    "EDGES: the character and the prop in their hands stay fully inside the frame. Small floating props, on the contrary, may " +
    "run past the canvas edges and be partly cropped — that is how the reference layouts breathe; just never crop them so " +
    "much that they become unreadable. " +
    textRuleForPrompt(allowText) +
    " Professional advertising quality, coherent lighting across all elements."
  );
}

/** Обратная совместимость: константа = контракт с дефолтным лимитом. */
export const AI_REF_SECONDARY_CONTRACT = buildSecondaryContract();

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
  /** Верх коридора предметов (DI3-9); не задан — дефолт. */
  maxProps?: number;
  /** Низ коридора предметов из админки; не задан — MIN_PROPS. */
  minProps?: number;
  /** Пол героя из тон-варианта бренда; null — бренд без вариантов. */
  gender?: HeroGender | null;
  /** Сходство персонажа с референсами бренда (Brand.characterFidelity). */
  fidelity?: CharacterFidelity;
  /** Набор предметов кампании с якоря; пусто — модель подбирает сама. */
  propInventory?: string;
  /** Режим текста вариации (TASK no-baked-text); дефолт — строгий запрет. */
  allowText?: boolean;
}): string {
  const brief = opts.variationText.trim();
  // Широкий формат определяем по геометрии, а не по ключу ассета: ключи
  // задаются в админке и у каждого клиента свои.
  const base = buildSecondaryContract({
    maxProps: clampMaxProps(opts.maxProps),
    ...(opts.minProps !== undefined ? { minProps: opts.minProps } : {}),
    wide: opts.targetW / opts.targetH >= 1.6,
    propInventory: opts.propInventory ?? "",
    allowText: opts.allowText ?? false,
  });
  const contract = opts.hasAnchor
    ? base
    : // Без якоря первая картинка — обычный референс формата: убираем блок
      // «STYLE SOURCE», иначе модель примет за эталон случайный баннер.
      base.replace(
        /STYLE SOURCE:.*?The remaining images are reference banners/s,
        "The images are reference banners",
      );
  return [
    brief ? `Campaign brief: ${brief}.` : "",
    formatGeometryHint(opts.formatLabel, opts.targetW, opts.targetH),
    opts.styleText,
    contract,
    characterFidelityInstruction(opts.fidelity ?? DEFAULT_CHARACTER_FIDELITY),
    // Тот же блок анатомии, что у якоря (правка 2026-08-15): герой кампании
    // один, и число пальцев обязано совпадать во всех трёх форматах.
    AI_REF_ANATOMY_CONTRACT,
    heroGenderInstruction(opts.gender ?? null),
  ]
    .filter(Boolean)
    .join(" ");
}

// Тип попытки (генерации и лечения) живёт в aiHealing.ts; ре-экспорт
// сохраняет прежний импорт для тестов и соседних модулей.
export type { AiRefAttempt } from "./aiHealing.js";

/** Вердикт текстового гейта по одному кандидату (TASK no-baked-text). */
export interface TextGateVerdict {
  clean: boolean;
  /** Что прочитал детектор («FS», «Free spins»); пусто, когда чисто. */
  found: string;
  /** true — детектор недоступен: вердикта нет, кандидат пропущен как есть. */
  skipped: boolean;
}

/** Кандидат текстового гейта: уже сгенерированная и сохранённая картинка. */
export interface TextGateCandidate {
  index: number;
  imageUrl: string;
}

export interface TextGateOutcome {
  /** Индекс выбранного кандидата в `attempts`. */
  index: number;
  verdict: TextGateVerdict;
  /** Сколько картинок реально просканировано (контроль расходов). */
  scanned: number;
}

/**
 * Ленивый выбор кандидата без запечённого текста (TASK no-baked-text, Спор 1
 * R-Plan).
 *
 * Кандидаты приходят в порядке предпочтения (принятые приёмкой и с бо́льшим
 * score — первыми). Сканируем по одному и возвращаем ПЕРВОГО чистого: в норме
 * это один дешёвый vision-вызов, а уже сгенерированная чистая картинка всегда
 * дешевле, чем вызов gpt-image-2/edit ради ретуши.
 *
 * Детектор недоступен (нет ключа, бюджет исчерпан, транспорт лёг) →
 * `skipped: true` и кандидат считается пригодным: сбой провайдера не имеет
 * права ронять генерацию — это тот же принцип best-effort, на котором стоит
 * весь textScan и приёмка.
 */
export async function pickTextCleanCandidate(
  candidates: TextGateCandidate[],
  budget: ScanBudget,
): Promise<TextGateOutcome> {
  const first = candidates[0];
  // Вызывающий гарантирует непустой список; пустой — программная ошибка,
  // но ронять из-за неё генерацию нельзя.
  if (!first) return { index: -1, verdict: { clean: true, found: "", skipped: true }, scanned: 0 };

  let scanned = 0;
  let firstVerdict: TextGateVerdict | null = null;

  for (const candidate of candidates) {
    const scan = await scanImageUrl(candidate.imageUrl, budget, "strict");
    if (!scan) {
      // Транспорт/бюджет: дальше сканировать бессмысленно — та же причина
      // повторится на каждом следующем кандидате.
      const verdict: TextGateVerdict = { clean: true, found: "", skipped: true };
      return { index: firstVerdict ? first.index : candidate.index, verdict: firstVerdict ?? verdict, scanned };
    }
    scanned += 1;
    // approvedOk — ручной whitelist «пометить ок» из админки: если человек уже
    // посмотрел эти байты и признал их нормальными, вердикт модели не спорит.
    const clean = !scan.hasText || scan.approvedOk;
    const verdict: TextGateVerdict = { clean, found: clean ? "" : scan.text, skipped: false };
    if (clean) return { index: candidate.index, verdict, scanned };
    firstVerdict ??= verdict;
  }

  // Чистых нет: возвращаем лучшего по приёмке с его замечанием — оно уйдёт
  // в лечение готовым ТЗ («сотри надпись FS»).
  return {
    index: first.index,
    verdict: firstVerdict ?? { clean: true, found: "", skipped: true },
    scanned,
  };
}

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
  /**
   * Цвет свечения кампании (DI3-4: «свечение одинаковое»). Считается один раз
   * на якоре; пусто — якорь сделан до задания либо эффекты были выключены,
   * тогда зависимый формат посчитает цвет сам.
   */
  glowHex?: string;
  /**
   * Набор предметов кампании (правка 2026-08-15). Наследуется тем же путём,
   * что и цвет свечения: снимается один раз на якоре и переживает одиночную
   * регенерацию push спустя недели. Пусто — legacy-бандл или fail-open.
   */
  propInventory?: string;
}

/** Результат прогона: процессор ставит зависимые форматы только после ok. */
export interface AiRefResult {
  ok: boolean;
  /** База (до removeBg) — становится якорем для зависимых форматов. */
  baseUrl?: string;
  /** Описание стиля, снятое с якоря (только для якорного ассета). */
  styleText?: string;
  /** Набор предметов кампании, снятый с якоря (только для якорного ассета). */
  propInventory?: string;
  /** Цвет свечения кампании, выбранный на якоре (DI3-4). */
  glowHex?: string;
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
  const meta = anchor.metadata as {
    styleAnchor?: unknown;
    styleAnchorProps?: unknown;
    qa?: { baseUrl?: unknown };
    effects?: { glowHex?: unknown };
  } | null;
  const styleText = typeof meta?.styleAnchor === "string" ? meta.styleAnchor : "";
  // Набор предметов кампании (правка 2026-08-15): у бандлов, сделанных до неё,
  // поля нет — зависимый формат откатывается на «подбери свои» (fail-open).
  const propInventory =
    typeof meta?.styleAnchorProps === "string" ? meta.styleAnchorProps : "";
  const withProps = propInventory ? { propInventory } : {};
  const baseUrl = typeof meta?.qa?.baseUrl === "string" ? meta.qa.baseUrl : "";
  // Цвет свечения кампании (DI3-4): зависимые форматы обязаны взять ТОТ ЖЕ
  // цвет, что уже утверждён на якоре, — в том числе при одиночной
  // регенерации push спустя недели после email.
  const glowHex = typeof meta?.effects?.glowHex === "string" ? meta.effects.glowHex : "";
  const withGlow = glowHex ? { glowHex } : {};
  if (baseUrl) return { imageUrl: baseUrl, styleText, ...withProps, ...withGlow };
  if (anchor.imageUrl)
    return { imageUrl: anchor.imageUrl, styleText, fallback: true, ...withProps, ...withGlow };
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
  /**
   * Верх коридора предметов зависимого формата (DI3-9/DI3-14, задание 3).
   * У якоря игнорируется: плотность email не трогаем (DI3-10).
   */
  maxProps?: number;
  /** Низ коридора предметов из админки (правка 2026-08-15); не ниже MIN_PROPS. */
  minProps?: number;
  /** Галки эффектов формата из админки (DI3-15); не заданы — включены. */
  effects?: EffectsToggle | null;
}): Promise<AiRefResult> {
  const { bundleId, variantId, assetId, assetKey, targetW, targetH } = opts;
  const isAnchor = opts.isAnchor ?? true;
  const profile: QaProfile = isAnchor ? "anchor" : "secondary";
  const formatLabel = opts.formatLabel ?? assetKey;
  const anchorUrl = isAnchor ? null : (opts.anchor?.imageUrl ?? null);
  // Лимит предметов существует только у зависимых форматов и обязан быть
  // одинаковым в промпте генерации, чек-листе приёмки и промпте лечения.
  const maxProps = isAnchor ? undefined : clampMaxProps(opts.maxProps);
  const minProps = isAnchor ? undefined : clampMinProps(opts.minProps, maxProps);
  const effectsConfig = resolveEffectsConfig(opts.effects);
  // Набор предметов кампании (правка 2026-08-15). У якоря его нет по смыслу:
  // он этот набор и задаёт, снимая его со своей утверждённой композиции.
  const propInventory = isAnchor ? "" : (opts.anchor?.propInventory ?? "");
  // Пол героя из имени тон-варианта (правка 2026-08-13): раньше его задавали
  // только референсы, и модель их «переигрывала» — у (Men) выходила женщина.
  const heroGender = heroGenderFromBrand(opts.brandName);
  // Сходство персонажа — настройка БРЕНДА (правка 2026-08-13). Читаем по
  // точному имени тон-варианта: у "Betnella(Men)" и "Betnella(Women)" это
  // разные строки Brand, и настройка у них может отличаться.
  const brandRow = await prisma.brand.findUnique({
    where: { name: opts.brandName },
    select: { characterFidelity: true },
  });
  const fidelity = characterFidelityOf(brandRow?.characterFidelity);
  // Чистый центр — требование ТОЛЬКО якорного формата (DI2-4): на push/pop-up
  // текста не будет, и пустая середина там читается как дыра в композиции.
  const centerZone = isAnchor ? AI_REF_CENTER_CLEAR_ZONE : undefined;
  // Зеркальное требование для зависимых форматов (правка 2026-08-13): у них
  // центр занят героем, а пустовать не должны БОКА — там живут предметы.
  const minSideFill = isAnchor ? undefined : SIDE_FILL_MIN_RATIO;
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
      // allowText — режим текста кампании (TASK no-baked-text). Живёт на
      // вариации, а не на бандле: заказчик выбрал именно этот уровень.
      preset: { select: { title: true, text: true, allowText: true } },
    },
  });
  if (!bundle) return { ok: false }; // bundle удалён — no-op
  if (!bundle.presetId || !bundle.preset) {
    await fail("ai_reference: у бандла не выбрана вариация (preset)");
    return { ok: false };
  }

  const baseBrand = stripGenderName(opts.brandName);
  let picked;
  try {
    // Референсы — строго своего формата (DI2-2): у email, push и pop-up
    // разная стилистика, фолбэка на чужой ФОРМАТ нет. По тону наоборот:
    // сначала пул конкретного варианта ("Betnella(Men)"), и только если он
    // пуст — общий пул бренда (DI2-10).
    picked = await pickGenerationRefs(bundle.presetId, opts.brandName, assetKey, baseBrand);
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
    return { ok: false };
  }
  const refs = picked.refs;
  const refUrls = refs.map((r) => r.imageUrl);
  // Второй канал утечки пола (правка 2026-08-13): у варианта с полом в имени
  // пул может быть пуст ДЛЯ ЭТОГО ФОРМАТА, и тогда фолбэк берёт общий —
  // смешанный по полу. Промпт теперь пол удержит, но админ должен видеть,
  // что рефы формата не залиты.
  if (picked.fellBackToBase && heroGender) {
    console.warn(
      `⚠ ai-ref#${assetId} (${assetKey}): у "${opts.brandName}" нет своих референсов ` +
        `формата — взят общий пул "${picked.poolName}" (смешанный по полу)`,
    );
  }

  // Бриф: текст бандла (мастер заполняет его из вариации, но может уточнить);
  // пустой — сам текст вариации.
  const variationText = bundle.neuralPrompt.trim() || bundle.preset.text;
  // Режим текста кампании (TASK no-baked-text). Один и тот же флаг обязан уйти
  // в промпт генерации, в чек-лист приёмки, в детектор и в промпт лечения —
  // расхождение любых двух даёт петлю «сгенерировали → забраковали → вылечили
  // обратно».
  const allowText = bundle.preset.allowText;

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
    prompt = buildAiReferencePrompt(variationText, heroGender, fidelity, allowText) + guideInstruction;
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
    // Схема предметов последней картинкой (правка 2026-08-14). На якоре тот
    // же приём (A-6) уже показал, что раскладку модель считывает с картинки
    // надёжнее, чем с процентов в тексте. Best-effort: без схемы генерация
    // не блокируется, один слот референсов отдаётся под неё.
    let propsGuideInstruction = "";
    try {
      const guideUrl = await getPropsGuideUrl(targetW, targetH);
      genUrls = [...genUrls.slice(0, MAX_EDIT_REFS - 1), guideUrl];
      propsGuideInstruction = ` ${PROPS_GUIDE_INSTRUCTION}`;
    } catch (err) {
      console.warn(`⚠ ai-ref props-guide#${assetId}: ${err instanceof Error ? err.message : err}`);
    }
    prompt = buildSecondaryPrompt({
      variationText,
      styleText: opts.anchor?.styleText ?? "",
      hasAnchor: Boolean(anchorUrl),
      formatLabel,
      targetW,
      targetH,
      ...(maxProps !== undefined ? { maxProps } : {}),
      ...(minProps !== undefined ? { minProps } : {}),
      gender: heroGender,
      fidelity,
      propInventory,
      allowText,
    }) + propsGuideInstruction;
  }
  const aspect = nearestFalAspect(targetW, targetH);
  const folder = `bundles/${bundleId}`;

  const attempts: AiRefAttempt[] = [];
  let chosen: ChosenAttempt | null = null;
  let bestCandidate: ChosenAttempt | null = null;
  let bestScore = -1;
  /** Лучший кадр среди проваливших ТЕХВАЛИДАЦИЮ — сырьё для лечения. */
  let techFallback: {
    index: number;
    imageUrl: string;
    ratio: number;
    reasons: string[];
  } | null = null;

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
      ...(minSideFill !== undefined ? { minSideFill } : {}),
    });
    if (!tech.passed) {
      const reasons = tech.checks.filter((c) => !c.passed).map((c) => `${c.key}: ${c.detail}`);
      attempts.push({ imageUrl: fitted.url, score: 0, pass: false, reasons, tech });
      // Лучший среди ЗАБРАКОВАННЫХ техникой (правка 2026-08-13): раньше такие
      // кадры никуда не записывались, и провал всех трёх попыток по центру
      // ронял ассет, хотя лечение «убери объекты из центра» — ровно тот
      // случай, для которого auto-healing и делался. Ранжируем по чистоте
      // центра: 90 % белого лечится, 40 % — почти наверняка нет.
      const ratio = tech.centerRatio ?? 0;
      if (!techFallback || ratio > techFallback.ratio) {
        techFallback = { index: attempts.length - 1, imageUrl: fitted.url, ratio, reasons };
      }
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
      ...(maxProps !== undefined ? { maxProps } : {}),
      ...(minProps !== undefined ? { minProps } : {}),
      gender: heroGender,
      fidelity,
      ...(propInventory ? { propInventory } : {}),
      allowText,
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

  // Ни одной пригодной попытки И ни одного кадра вообще — лечить нечего.
  if (!chosen && !bestCandidate && !techFallback) {
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
  // Порядок предпочтения: принятая приёмкой → забракованная приёмкой →
  // забракованная техникой (её лечим ниже, DI-R10 + правка 2026-08-13).
  let finalPick: ChosenAttempt =
    chosen ??
    bestCandidate ?? {
      index: techFallback!.index,
      imageUrl: techFallback!.imageUrl,
      pass: false,
    };

  // ── Текстовый гейт (TASK no-baked-text) ───────────────────────────────────
  // Третий эшелон после промпта и приёмки. Нужен именно отдельным детектором:
  // приёмщик оценивает композицию целиком и одну мелкую надпись легко
  // «прощает» ради высокого score, а этот вопрос бинарный.
  //
  // Гейт может ПЕРЕВЫБРАТЬ победителя: если лучший кандидат с текстом, а
  // второй чистый — берём второй. Кандидаты, не прошедшие техвалидацию, в
  // список не попадают: продвинуть такой значило бы обойти проверку чистой
  // зоны ради чистоты от букв.
  let textGateMeta: {
    allowText: boolean;
    clean: boolean;
    found: string;
    skipped: boolean;
    scanned: number;
  } | null = null;
  let textBudget: ScanBudget | null = null;
  if (!allowText) {
    textBudget = newScanBudget();
    const ranked = attempts
      .map((a, index) => ({ index, imageUrl: a.imageUrl, score: a.score, pass: a.pass, ok: a.tech?.passed === true }))
      .filter((c): c is { index: number; imageUrl: string; score: number; pass: boolean; ok: boolean } =>
        Boolean(c.imageUrl) && c.ok,
      )
      // Принятые приёмкой вперёд, внутри группы — по убыванию score.
      .sort((a, b) => Number(b.pass) - Number(a.pass) || b.score - a.score);

    if (ranked.length > 0) {
      const gate = await pickTextCleanCandidate(
        ranked.map(({ index, imageUrl }) => ({ index, imageUrl })),
        textBudget,
      );
      textGateMeta = {
        allowText,
        clean: gate.verdict.clean,
        found: gate.verdict.found,
        skipped: gate.verdict.skipped,
        scanned: gate.scanned,
      };
      const picked = attempts[gate.index];
      if (picked?.imageUrl) {
        finalPick = { index: gate.index, imageUrl: picked.imageUrl, pass: picked.pass };
      }
      if (!gate.verdict.clean) {
        console.warn(
          `⚠ ai-ref#${assetId} (${assetKey}): запечённый текст «${gate.verdict.found}» ` +
            `на всех ${gate.scanned} кандидатах — уходим в лечение`,
        );
      }
    }
  }

  // Текст найден на всех кандидатах — лечим, даже если приёмка была пройдена:
  // для этого правила высокий score не индульгенция.
  const textDirty = Boolean(textGateMeta && !textGateMeta.clean);
  const textReason = textDirty
    ? `на изображении есть запечённый текст «${textGateMeta!.found}» — сотри надпись полностью`
    : null;

  let finalUrl = finalPick.imageUrl;
  let qaPassed = finalPick.pass;
  let healingMeta: {
    attempts: ReturnType<typeof attemptRows>;
    used: boolean;
    chosenAttempt: number | null;
  } | null = null;

  if (!finalPick.pass || textDirty) {
    // Источник лечения — тот самый кадр, что выбран финальным: забракованный
    // приёмкой кандидат, наименее испорченный по техвалидации, либо принятый
    // приёмкой, но с запечённым текстом (TASK no-baked-text).
    //
    // Замечание про текст идёт ПЕРВЫМ: buildHealingPrompt берёт максимум 10
    // замечаний, и это должно остаться в списке при любом их количестве.
    const sourceRow = attempts[finalPick.index];
    const source = {
      imageUrl: finalPick.imageUrl,
      score: sourceRow?.score ?? 0,
      reasons: [...(textReason ? [textReason] : []), ...(sourceRow?.reasons ?? techFallback?.reasons ?? [])],
      // Без этого признака лечение считало бы исходник чистым, и правило
      // «чистая версия побеждает независимо от score» не сработало бы: ретушь
      // с меньшим score, но без надписи, проиграла бы исходнику с «FS».
      textClean: !textDirty,
    };
    const heal = await healComposition({
      source,
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
      ...(minSideFill !== undefined ? { minSideFill } : {}),
      profile,
      anchorUrl,
      formatLabel,
      ...(maxProps !== undefined ? { maxProps } : {}),
      ...(minProps !== undefined ? { minProps } : {}),
      gender: heroGender,
      fidelity,
      ...(propInventory ? { propInventory } : {}),
      allowText,
      ...(textBudget ? { textBudget } : {}),
    });
    finalUrl = heal.winner.imageUrl;
    qaPassed = heal.winner.pass;
    healingMeta = {
      attempts: attemptRows(heal.attempts),
      used: heal.winner.healingIndex !== null,
      chosenAttempt: heal.winner.healingIndex,
    };
    // Итог гейта пересчитываем по победителю лечения: в metadata должно
    // лежать состояние ФИНАЛЬНОГО ассета, а не забракованного исходника.
    if (textGateMeta) {
      textGateMeta = {
        ...textGateMeta,
        clean: heal.winner.textClean ?? textGateMeta.clean,
        found: heal.winner.textClean ? "" : (heal.winner.textFound ?? textGateMeta.found),
        scanned: textGateMeta.scanned + (heal.textScanned ?? 0),
      };
    }
  }

  // Стиль-якорь (DI2-3): снимается ТОЛЬКО с якорного ассета и только когда
  // финальная база уже выбрана — описывать промежуточную попытку смысла нет.
  // Fail-open: без описания зависимые форматы поедут на одной картинке.
  let styleText = "";
  let anchorPropInventory = "";
  if (isAnchor) {
    // Бриф уходит в тот же запрос (правка 2026-08-15): набор предметов
    // называется в терминах кампании, а не «металлическая деталь».
    const style = await describeCampaignStyle(finalUrl, variationText);
    styleText = style.text;
    anchorPropInventory = style.propInventory;
    // Планировщик набора (правка 2026-08-15, заказчик: «предметы сами
    // сгенерировать на основании рефов которые есть и подстроить под промпт»).
    // Он смотрит на референсы БРЕНДА и на бриф, поэтому его список надёжнее
    // снятого с картинки: в кадр могло попасть выдуманное мимо референсов, а
    // главные объекты акции он ещё и помечает — на них строится иерархия
    // композиции у зависимых форматов. Список с картинки остаётся фолбэком.
    const plan = await planCampaignProps({ refUrls, variationText, brandName: baseBrand });
    if (plan.text) {
      anchorPropInventory = plan.text;
    } else if (plan.error) {
      console.warn(`⚠ ai-ref prop-plan#${assetId}: ${plan.error}`);
    }
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
    // Итог текстового гейта по ФИНАЛЬНОМУ ассету (TASK no-baked-text).
    // `clean: false` — ассет всё равно отдаётся человеку (Спор 2 R-Plan), но
    // с прочитанным текстом: это готовое ТЗ дизайнеру на ретушь.
    ...(textGateMeta ? { textGate: textGateMeta } : {}),
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
      ? {
          styleAnchor: styleText,
          isStyleAnchor: true,
          // Набор предметов кампании — отдельным полем рядом с описанием
          // стиля: его читает loadAnchorContext при генерации push/pop-up и
          // при их одиночной регенерации (DI2-9).
          styleAnchorProps: anchorPropInventory,
        }
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
  // Вырезание фона (правка 2026-08-14). Bria — ML-сегментация «главного
  // объекта»: она стирала парящие пропсы, которые в кадре ЕСТЬ (заказчик
  // сравнил `_push_try1` и `_transparent`), и требование FOCUS усугубляло это —
  // расфокусный предмет она тем более считает фоном. Фон же по контракту
  // чисто белый, поэтому кей по СВЯЗНОМУ с краями белому решает задачу без
  // всякой сегментации и по построению не может потерять предмет.
  // Гибрид: альфа = max(Bria, кей) — у Bria лучше сложная кромка (шерсть,
  // листва), кей возвращает стёртые ею объекты. Откат — env AI_REF_CUTOUT.
  const mode = cutoutMode();
  let keyed: Buffer | null = null;
  if (mode !== "bria") {
    const srcBuffer = await fetchBuffer(finalUrl);
    if (srcBuffer) {
      try {
        keyed = await keyWhiteBackground(srcBuffer);
      } catch (err) {
        console.warn(`⚠ ai-ref white-key#${assetId}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  let cutout: Buffer | null = mode === "white" ? keyed : null;
  let cutoutSource: string = mode === "white" ? "white-key" : "bria";
  if (mode !== "white") {
    const removed = await runBriaRemoveBg(finalUrl);
    if (removed.success && removed.imageUrl) {
      const briaBuffer = await fetchBuffer(removed.imageUrl);
      if (briaBuffer) {
        if (keyed) {
          try {
            cutout = await mergeCutoutAlpha(briaBuffer, keyed);
            cutoutSource = "hybrid";
          } catch (err) {
            console.warn(`⚠ ai-ref merge#${assetId}: ${err instanceof Error ? err.message : err}`);
            cutout = briaBuffer;
          }
        } else {
          cutout = briaBuffer;
        }
      }
    }
    // Bria недоступна или её результат не скачался: кей — полноценная замена,
    // а не деградация, поэтому ассет из-за этого больше не падает.
    if (!cutout && keyed) {
      cutout = keyed;
      cutoutSource = "white-key (bria failed)";
      console.warn(`⚠ ai-ref cutout#${assetId}: Bria недоступна — вырезано кеем по белому`);
    }
    if (!cutout) {
      await fail(
        `removeBg: ${removed.error ?? "результат не скачался"}`,
        baseMeta as unknown as Prisma.InputJsonValue,
      );
      return { ok: false };
    }
  }
  if (!cutout) {
    await fail("cutout: не удалось вырезать фон", baseMeta as unknown as Prisma.InputJsonValue);
    return { ok: false };
  }

  const trUp = await withRetry(
    () => uploadBuffer(cutout!, `${variantId}_${assetKey}${AI_REF_SUFFIX_TRANSPARENT}`, folder),
    `ai-ref-transparent#${assetId}`,
  );
  if (!trUp.success || !trUp.secure_url) {
    await fail(
      `transparent upload: ${trUp.error ?? "unknown"}`,
      baseMeta as unknown as Prisma.InputJsonValue,
    );
    return { ok: false };
  }

  // Эффекты (TASK glow-fade-density, задания 1–2). Чистый вырез остаётся в
  // Cloudinary под `_transparent` и служит ИСТОЧНИКОМ: пере-применение с
  // другими параметрами, выключение эффектов и обработка старых бандлов идут
  // от него, а не от готовой картинки (иначе свечение легло бы на свечение).
  const effects = await applyEffectsToAsset({
    transparentUrl: trUp.secure_url,
    // Цвет выбирается по композиции ДО removeBg: у неё гарантированно
    // корректный белый фон, а прозрачный PNG vision-модель отрендерит на чём
    // попало. Гистограмма фолбэка считает по вырезанным пикселям.
    colorSourceUrl: finalUrl,
    refUrls,
    config: effectsConfig,
    inheritedGlowHex: isAnchor ? null : (opts.anchor?.glowHex ?? null),
    publicId: `${variantId}_${assetKey}${AI_REF_SUFFIX_FINAL}`,
    folder,
    logTag: `ai-ref-effects#${assetId}`,
    safeZone: isAnchor ? AI_REF_SAFE_ZONE : null,
  });

  await prisma.bundleAsset.update({
    where: { id: assetId },
    data: {
      status: "DONE",
      imageUrl: effects.imageUrl,
      errorMessage: null,
      metadata: {
        ...baseMeta,
        // Свечение — фоновая заливка, но она полупрозрачная и по краям сходит
        // в ноль: ассет остаётся вырезанным, подпись «— прозрачный фон» верна.
        transparent: true,
        ...(effects.textColor ? { recommendedTextColor: effects.textColor } : {}),
        effects: effects.meta,
      } as unknown as Prisma.InputJsonValue,
    },
  });
  await dropLegacyDerived();

  console.log(
    `🧩 ai-ref ${assetKey}#${assetId}: ${isAnchor ? "anchor" : "secondary"} refs=${refs.length} ` +
      `attempts=${attempts.length}` +
      (healingMeta ? ` heal=${healingMeta.attempts.length} healed=${healingMeta.used}` : "") +
      (maxProps !== undefined ? ` maxProps=${maxProps}` : "") +
      // Видно, поехал ли формат по набору кампании или по старому «свои
      // предметы» — первый вопрос при разборе «предметы не те».
      (isAnchor ? "" : ` propSet=${propInventory ? "campaign" : "free"}`) +
      ` qaPassed=${qaPassed} fidelity=${fidelity}` +
      ` cutout=${cutoutSource}` +
      (effects.meta.applied
        ? ` glow=${effects.meta.glowHex}(${effects.meta.glowSource})`
        : ` effects=off${effects.meta.error ? `(${effects.meta.error})` : ""}`),
  );
  await recomputeBundleStatus(bundleId);
  return {
    ok: true,
    baseUrl: finalUrl,
    styleText,
    ...(anchorPropInventory ? { propInventory: anchorPropInventory } : {}),
    ...(effects.meta.glowHex ? { glowHex: effects.meta.glowHex } : {}),
  };
}
