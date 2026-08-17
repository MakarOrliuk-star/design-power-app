import { runVisionQa } from "./fal.js";

/**
 * Системный промпт-«Приемщик» (TASK ai-reference, стадия B; DI-R9/R10, A-1).
 *
 * Отдельный VLM-агент смотрит на сгенерированную композицию рядом с
 * референсами бренда и выносит машинно-читаемый вердикт. Правило текста —
 * A-1 (утверждено 2026-08-04): в композиции допустимы только короткие
 * «казиношные» слова на пропсах (FS, SCATTER, BONUS, VIP…); любые фразы,
 * предложения, CTA-кнопки, логотипы и водяные знаки — брак.
 *
 * Транспортная ошибка VLM ≠ брак картинки: приёмка помечается пропущенной
 * (`skipped`), генерация не блокируется — тот же fail-open, что у
 * requestCreativeBrief (нейтральный фолбэк) в Задании 3. Неразобранный ответ
 * после ре-запроса — наоборот брак попытки (`qa-unparseable`): модель ответила,
 * но контракт JSON нарушен, доверять такому «да» нельзя.
 *
 * TASK multiformat-promo:
 *  - DI2-4: чек-лист зависит от ФОРМАТА. У якоря (email) центральная полоса
 *    обязана быть пустой — туда ляжет текст; у push/pop-up текста не будет,
 *    поэтому требование пустого центра снято, а вместо него добавлен пункт
 *    сверки стиля с якорной композицией кампании.
 *  - DI2-5: вердикт проходит ЧИСЛОВОЙ порог `AI_REF_QA_THRESHOLD` (дефолт 80).
 *    Раньше слабая, но формально `pass: true` картинка принималась и человек
 *    жал Regenerate руками; теперь она уходит в авто-ретрай/лечение.
 */

export interface QaVerdict {
  pass: boolean;
  /** 0–100; используется для best-of при исчерпании ретраев (DI-R10). */
  score: number;
  reasons: string[];
  /** true — приёмка не состоялась по транспортной причине (не мнение модели). */
  skipped?: boolean;
}

/** Сколько референсов показываем приёмщику рядом с результатом (первые по порядку). */
export const QA_REFS_SHOWN = 3;

/** Профиль чек-листа: якорь кампании (email) или зависимый формат (push/pop-up). */
export type QaProfile = "anchor" | "secondary";

export const DEFAULT_QA_THRESHOLD = 80;

/**
 * Порог приёмки (DI2-5): одно общее число на все форматы, ENV меняется без
 * деплоя кода. Мусорные значения игнорируются в пользу дефолта.
 */
export function qaThreshold(): number {
  const raw = Number.parseInt(process.env.AI_REF_QA_THRESHOLD ?? "", 10);
  if (!Number.isFinite(raw)) return DEFAULT_QA_THRESHOLD;
  return Math.max(0, Math.min(100, raw));
}

const COMMON_HEAD = [
  "You are a strict QA reviewer («Приемщик») for casino promo hero compositions.",
  "The FIRST image is the generated composition under review.",
];

const COMMON_TAIL = [
  'Respond with ONLY a JSON object, no prose, no markdown fences: {"pass": boolean, "score": number, "reasons": string[]}.',
  '"score" is 0-100 overall quality. "reasons" lists concrete failures (empty if pass). Write reasons in Russian.',
];

/**
 * Текстовое правило чек-листа (A-1) — одинаково для всех форматов, но зависит
 * от режима вариации (TASK no-baked-text, `NeuralPromptPreset.allowText`).
 *
 * Разрешающая ветка — прежняя редакция. Строгая ветка обязана быть здесь, а не
 * только в промпте генерации: до этой правки приёмщику прямым текстом велели
 * «never flag FS / FREE SPINS», поэтому второй контур контроля пропускал ровно
 * тот брак, на который жаловался заказчик.
 */
function textRule(allowText: boolean): string {
  if (allowText) {
    return "TEXT: the ONLY lettering allowed is single short casino words organically placed on props (slot reels, chips, crates, medallions). The allowed list includes, non-exhaustively: FS, FREE SPINS, SCATTER, BONUS, VIP, WILD, 777, JACKPOT, MEGA WIN, RELOAD, SPIN. Never flag a word from this list or a similar single casino term. FAIL only for: phrases or sentences, headlines, CTA buttons, logos, brand names, watermarks.";
  }
  return "TEXT (zero tolerance): this creative must contain NO lettering of any kind. FAIL if you can see any letter, word, number, digit, logo, brand mark, watermark, caption, headline or CTA button anywhere in the frame — including tiny, blurred, cropped or partially hidden ones, and including single casino words such as FS, FREE SPINS, BONUS, VIP, WILD, JACKPOT or the digits 777 on a slot reel or a denomination number on a chip. THE ONLY EXCEPTION is a standard playing card showing its natural rank marks (A, K, Q, J, 10) and suit pips — those are part of the card object and must never be flagged. When you fail this item, quote the exact text you can read and say where it is.";
}

/** Прежняя константа: правило в строгом режиме (новый дефолт). */
const TEXT_RULE = textRule(false);

const ARTIFACTS_RULE =
  "ANATOMY/ARTIFACTS: no deformed faces or hands, no extra limbs, no duplicated or melted objects, no visible generation artifacts. Intentional depth-of-field blur and light motion blur on props are good design, NOT artifacts — a few soft or blurred props next to sharp ones are exactly what is asked for, and only a blurry HERO is a defect.";

/**
 * Пункт про руки (правка 2026-08-15, запрос заказчика: «чтобы на руке не было
 * 4 пальца, хотя должно быть 5»). Отдельным номером, а не строкой внутри
 * ARTIFACTS: пункт артефактов формулирует брак оценочно («no deformed hands»),
 * и приёмщик его пропускал — лишний палец он замечает, только когда ему прямо
 * велено ПОСЧИТАТЬ. Число берётся с референсов (у маскота-зверя это лапа, у
 * мультяшного героя может быть канонические четыре пальца), и лишь при
 * человекоподобном герое либо непонятных референсах жёстко равно пяти.
 *
 * Оговорка про скрытую кисть обязательна: без неё приёмщик бракует кадр, где
 * рука честно спрятана за пропсом, — и отправляет в ретрай нормальную работу.
 */
const ANATOMY_RULE =
  "HANDS & DIGITS: look closely at every VISIBLE hand of the hero and COUNT the digits. The reference banners " +
  "define what this character's hands are — human hands, gloved cartoon hands, animal paws with claws, hooves " +
  "or fins — and the generated hand must have the SAME structure and the SAME number of digits as the references " +
  "show for this character. If the hero is human or humanoid, or the references do not show the hands clearly, a " +
  "hand must have exactly five digits: four fingers and one thumb. FAIL if a hand shows four fingers where five " +
  "belong, six or more digits, fused, doubled, stumped or backwards-bent fingers, two hands with different digit " +
  "counts, a hand that does not actually grip the prop it holds, or extra/missing arms or legs. A hand hidden " +
  "behind a prop, behind the body or outside the crop is NOT a defect — judge only what is visible. When you fail " +
  "this item, say which hand is wrong and how many digits you counted. " +
  // Усиление 2026-08-17 (заказчик: брак по пальцам доходит до CRM). Приёмщик
  // «осматривал» руку целиком и на беглом взгляде принимал сломанную кисть.
  // Процедура с явным перечислением заставляет его обработать пальцы по
  // одному; запрет на «выглядит нормально» закрывает уход от ответа.
  "PROCEDURE for this item: for EACH visible hand, list the digits you can see one by one (thumb, index, middle, " +
  "ring, little) and state the total, then compare the two hands. Do not answer this item from a general " +
  "impression — a hand that 'looks fine' but has four fingers is exactly the defect that keeps reaching the " +
  "client. If a hand is too small or too blurred to count reliably, say so explicitly instead of passing it.";

const WHITE_BG_NOTE =
  "IMPORTANT: the composition is INTENTIONALLY rendered on a plain solid white background for later cut-out, even if the reference banners have scenic backgrounds. A white background is correct and must NEVER be reported as a style mismatch.";

/** Чек-лист якорного формата (email 1200×600), A-2/A-3 + правки 2026-08-13. */
const anchorChecklist = (
  gender?: QaHeroGender | null,
  fidelity: QaFidelity = "variant",
  allowText = false,
): string[] => [
  "The remaining images are reference banners of the same brand — the ground truth for style.",
  WHITE_BG_NOTE,
  "Evaluate the generated composition against this checklist:",
  `1. STYLE: palette, prop family, lighting and rendering quality must match the reference banners. Ignore background differences (see above). ${fidelityRule(fidelity)}`,
  "2. BRIEF: the composition must express the campaign brief provided in the user prompt.",
  "3. BACKGROUND & CENTER: the background must be plain solid white with no scenery, gradients, glow or bokeh. The central band (the middle ~46% of the width, top to bottom) must be COMPLETELY EMPTY: any plate, oval, panel, frame, character part — and even a single small floating coin, gem, sparkle or particle — inside that band is a FAIL. The only exception is one or two tiny decorative props near the very bottom edge of the band. A headline and CTA will be overlaid there later.",
  `4. ${textRule(allowText)}`,
  `5. ${ARTIFACTS_RULE}`,
  `6. ${ANATOMY_RULE}`,
  "7. EMAIL HERO FITNESS: a clear designer-grade focal hierarchy (a large anchor group of props in a lower corner, the main character on the opposite side, smaller props around); the character and key props fully inside the frame, not cut by the canvas edges.",
  // Правка 2026-08-13 (заказчик: «композиция пустая»): раньше проверялся
  // только перебор в центре, из-за чего разреженный кадр с одиноким пропсом
  // на сторону проходил приёмку.
  "8. RICHNESS: the two side sections must look abundant — the anchor side holds a generous group of overlapping props, the character side has supporting props around the hero, and smaller props float above them. A sparse composition with only one or two props per side, or large empty white areas inside the SIDE sections, is a FAIL. This does NOT apply to the central band, which must stay empty (see item 3).",
  ...(genderRule(gender) ? [`9. ${genderRule(gender)}`] : []),
];

/**
 * Дефолтный лимит мелких предметов зависимого формата (DI3-9). Дублировать
 * константу из пайплайна нельзя — это дало бы цикл импорта (пайплайн уже
 * импортирует приёмщика), а число обязано совпадать с тем, что ушло в промпт
 * генерации, и приходит сюда параметром.
 */
export const DEFAULT_QA_MAX_PROPS = 14;

/** Дефолтный низ коридора — та же причина дублирования, что у потолка. */
export const DEFAULT_QA_MIN_PROPS = 8;

/** Пол героя тон-варианта — дублирует тип из bundle.service (цикл импорта). */
export type QaHeroGender = "male" | "female";

/** Сходство персонажа с референсами — дублирует тип пайплайна (цикл импорта). */
export type QaFidelity = "exact" | "variant";

/**
 * Пункт про сходство персонажа (правка 2026-08-13). Без него приёмщик судил
 * всех одинаково — по формулировке «character style must match», из-за чего
 * вариативный персонаж мог быть забракован, а точная копия принята у бренда,
 * которому нужна вариативность.
 */
function fidelityRule(fidelity: QaFidelity): string {
  return fidelity === "exact"
    ? "CHARACTER LIKENESS: this brand's mascot is fixed. The hero must be the SAME character as in the reference banners — same species or person, same facial features, same proportions, same outfit and accessories. A redesigned or restyled character is a FAIL; a new pose or camera angle is fine."
    : "CHARACTER LIKENESS: this brand allows a variation of its character. The hero must stay clearly recognisable as the same brand character (same species or type, same art style and rendering, same wardrobe style and palette), but a different pose, expression and slightly different facial or outfit details are INTENDED and must never be reported as a defect. Only a character that reads as a DIFFERENT character, or one drawn in a different art style, is a FAIL.";
}

/**
 * Пункт про пол героя (правка 2026-08-13). Пол задаётся именем тон-варианта
 * («Fridayroll(Men)»), но до этой правки нигде не проверялся: модель меняла
 * пол героя, и брак уходил человеку. Теперь несовпадение = FAIL, то есть
 * авто-ретрай. Бренд без суффикса пола пункт не получает.
 */
function genderRule(gender: QaHeroGender | null | undefined): string | null {
  if (!gender) return null;
  const [must, wrong] = gender === "male" ? ["a MAN", "a woman"] : ["a WOMAN", "a man"];
  return (
    `HERO GENDER: the main character must be ${must}. If the hero is ${wrong}, this is an ` +
    "immediate FAIL regardless of how good the rest of the composition is — say so explicitly in the reasons."
  );
}

/**
 * Чек-лист зависимого формата (push / pop-up, DI2-4): текста на нём не будет,
 * поэтому пустой центр не требуется; зато добавлена сверка с якорем кампании.
 *
 * TASK glow-fade-density (задание 3, DI3-12): добавлен числовой пункт про
 * плотность — перегруженная композиция уходит в авто-ретрай, а не к человеку.
 * Формулировка «not more than N» вместо «too many» намеренная: VLM надёжно
 * считает предметы, когда у него есть точное число, и плавает на оценочных
 * определениях. Пункт про раскладку якоря расширен упоминанием плотности
 * (R-P2) — иначе два требования конфликтуют: «повтори стиль якоря» против
 * «будь проще якоря».
 */
function buildSecondaryChecklist(
  maxProps: number,
  minProps: number,
  gender?: QaHeroGender | null,
  fidelity: QaFidelity = "variant",
  propInventory = "",
  allowText = false,
): string[] {
  const gr = genderRule(gender);
  // Набор предметов кампании (правка 2026-08-15). Пункт 3 менялся дважды и
  // теперь зависит от того, есть ли утверждённый инвентарь: без него прежняя
  // формулировка («другие объекты — это правильно») остаётся верной, с ним
  // она прямо противоречит требованию единой промо-композиции.
  const set = propInventory.trim();
  const propSetRule = set
    ? `CAMPAIGN PROP SET: the objects of this campaign are fixed: ${set}. Nearly every prop in the frame must be one ` +
      "of these objects (repeats at different sizes and angles are fine and expected); up to two extra objects of the " +
      "same visual family are tolerated. It is a FAIL if the frame is built from objects unrelated to this set or to " +
      "the campaign brief — list the foreign objects in the reasons. Note: a DIFFERENT ARRANGEMENT from the anchor " +
      "creative is CORRECT and required — judge the inventory, never the layout."
    : "DIFFERENT OBJECTS are also CORRECT and intended: this placement is drawn with its own props chosen for the format, " +
      "and reusing the anchor's exact set is NOT required — judge the family and the craftsmanship, not the inventory.";
  return [
    "The SECOND image is the approved anchor creative of the SAME promo campaign (another format). The remaining images are reference banners of the same brand for this format.",
    WHITE_BG_NOTE,
    "Evaluate the generated composition against this checklist:",
    `1. STYLE: palette, prop family, lighting and rendering quality must match the reference banners. Ignore background differences (see above). ${fidelityRule(fidelity)}`,
    "2. BRIEF: the composition must express the campaign brief provided in the user prompt — not only the character, but the choice of props must fit what the brief is about.",
    `3. CAMPAIGN STYLE MATCH: it must read as the SAME campaign as the anchor creative — same palette, same character design and outfit, same prop family and material language, same lighting and rendering. A different character, a different color scheme or a different rendering technique is a FAIL. Note: a different layout, crop or aspect ratio is CORRECT and must never be reported. ${propSetRule}`,
    "4. BACKGROUND: the background must be plain solid white with no scenery, gradients, glow, bokeh or cast shadows. There is NO required empty copy space in this format — props and the character may occupy the center freely.",
    // Правка 2026-08-13: пункт стал двусторонним — заказчик сообщил, что
    // прежний односторонний лимит увёл кадры в пустоту. Перегруз по-прежнему
    // определяется КРУПНЫМИ объектами на земле, а не числом мелких.
    `5. PROP DENSITY: count the props around the character. The composition should contain the hero, at most ONE larger prop held in their hands, and between ${minProps} and ${maxProps} props floating in the air. It is a FAIL if: there are fewer than ${minProps} floating props and the frame looks empty; or there are more than ${maxProps}; or any large object rests on the ground or is stacked behind the character (slot machine, fortune or roulette wheel, treasure chest, open suitcase or crate, stacks of banknotes, piles or heaps of coins or chips); or the props melt into one unreadable mass; or the left and right thirds of the canvas are visibly empty while everything sits in the middle. Report the counted number in the reasons when you fail this item.`,
    // Правка 2026-08-15 (заказчик: «предметы будто просто проставлены, не
    // похоже на единую композицию»): до неё приёмка считала предметы и мерила
    // резкость, но про РАСКЛАДКУ не спрашивала ничего — ровный ковёр из
    // одинаковых по важности объектов проходил её без замечаний.
    "6. PROP COMPOSITION: the props must look composed by a designer, not scattered. Check all four: HIERARCHY — one or two props are clearly the largest and sharpest and sit near the hero's hands or face, the rest are visibly smaller supporting and accent pieces; GROUPS — the props form two or three clusters of overlapping objects with clean empty space between the clusters, not an even sprinkle across the canvas; FLOW — the clusters follow a diagonal or an arc that leads the eye to the hero, not a symmetric ring or a mirrored left-right layout; RHYTHM — spacing and tilt angles vary, nothing is lined up in a row, on a grid or at equal distances. It is a FAIL if the props are all roughly the same size, evenly spaced like stickers, or arranged symmetrically — say which of the four is broken.",
    "7. FOCUS VARIETY: the props must sit on different focal planes — a couple of them softly out of focus or lightly motion-blurred, the rest sharp, with the hero sharpest. A frame where every prop is equally sharp and flat is a FAIL.",
    `8. ${textRule(allowText)}`,
    `9. ${ARTIFACTS_RULE}`,
    `10. ${ANATOMY_RULE}`,
    // Правка 2026-08-15: «rather than clustered on one side» читалось как
    // запрет групп вообще и спорило с новым пунктом 6. Речь всегда шла о
    // перекосе на одну сторону — так и сформулировано.
    "11. FORMAT FITNESS: the composition must read well in its own aspect ratio — a clear focal hierarchy, the character and the prop in their hands fully inside the frame, nothing important cut off. Both sides of the canvas must carry props: groups are correct, but everything piled on one side while the other is empty is a FAIL. Small floating props partly cropped by the canvas edges are CORRECT and must never be reported; only a cropped character, a cropped hand-held prop, or a prop cropped so heavily it is unrecognisable is a FAIL.",
    ...(gr ? [`12. ${gr}`] : []),
  ];
}

/**
 * Параметры чек-листа. Собраны в объект (правка 2026-08-15): позиционных
 * аргументов стало шесть, и на такой сигнатуре легко перепутать местами
 * `fidelity` с набором предметов — ошибка, которую тайпчекер не поймает,
 * потому что оба строки.
 */
export interface QaPromptOptions {
  /** Верх коридора предметов — ровно тот, что ушёл в промпт генерации. */
  maxProps?: number;
  /** Низ коридора предметов — ровно тот, что ушёл в промпт генерации. */
  minProps?: number;
  gender?: QaHeroGender | null;
  fidelity?: QaFidelity;
  /** Набор предметов кампании; только у зависимых форматов. */
  propInventory?: string;
  /**
   * Режим текста вариации (TASK no-baked-text). Обязан совпадать с тем, что
   * ушёл в промпт генерации: иначе приёмщик забракует то, что сам же промпт
   * разрешил, — или наоборот пропустит запрещённое.
   */
  allowText?: boolean;
}

export function buildQaSystemPrompt(
  profile: QaProfile = "anchor",
  opts: QaPromptOptions = {},
): string {
  const fidelity = opts.fidelity ?? "variant";
  const allowText = opts.allowText ?? false;
  const checklist =
    profile === "secondary"
      ? buildSecondaryChecklist(
          opts.maxProps ?? DEFAULT_QA_MAX_PROPS,
          opts.minProps ?? DEFAULT_QA_MIN_PROPS,
          opts.gender,
          fidelity,
          opts.propInventory ?? "",
          allowText,
        )
      : anchorChecklist(opts.gender, fidelity, allowText);
  return [...COMMON_HEAD, ...checklist, ...COMMON_TAIL].join("\n");
}

/** Обратная совместимость: прежняя константа = чек-лист якорного формата. */
export const QA_SYSTEM_PROMPT = buildQaSystemPrompt("anchor", {});

/** Пользовательский промпт: бриф вариации + напоминание формата. */
export function buildQaPrompt(variationText: string, brandName: string, formatLabel?: string): string {
  return [
    `Brand: ${brandName}.`,
    ...(formatLabel ? [`Format: ${formatLabel}.`] : []),
    `Campaign brief: ${variationText.trim() || "(not specified)"}`,
    "Review the first image against the checklist and answer with the JSON object only.",
  ].join("\n");
}

/**
 * Разбор вердикта: модель иногда заворачивает JSON в ```fences``` или добавляет
 * слова вокруг — берём первый {...} блок. null → вызывающий делает один
 * ре-запрос «верни только JSON» (контракт R-2 из R-PLAN).
 */
export function parseVerdict(text: string): QaVerdict | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof raw.pass !== "boolean") return null;
    const score =
      typeof raw.score === "number" && Number.isFinite(raw.score)
        ? Math.max(0, Math.min(100, Math.round(raw.score)))
        : raw.pass
          ? 70
          : 0;
    const reasons = Array.isArray(raw.reasons)
      ? raw.reasons.filter((r): r is string => typeof r === "string").slice(0, 10)
      : [];
    return { pass: raw.pass, score, reasons };
  } catch {
    return null;
  }
}

/**
 * Порог DI2-5: вердикт модели «принято» отменяется, если score ниже порога.
 * Причина дописывается человекочитаемо — она уходит и в бейдж CRM, и в промпт
 * коррекции auto-healing.
 */
export function applyThreshold(verdict: QaVerdict, threshold = qaThreshold()): QaVerdict {
  if (!verdict.pass || verdict.score >= threshold) return verdict;
  return {
    ...verdict,
    pass: false,
    reasons: [
      `оценка приёмки ${verdict.score} ниже порога ${threshold}`,
      ...verdict.reasons,
    ].slice(0, 10),
  };
}

/**
 * Стадия B: вердикт приёмщика по сгенерированной композиции.
 * `refUrls` — референсы формата (передаются первые QA_REFS_SHOWN);
 * `anchorUrl` — якорная композиция кампании, показывается зависимым форматам
 * ВТОРОЙ картинкой (порядок описан в SECONDARY_CHECKLIST).
 */
export async function reviewComposition(opts: {
  imageUrl: string;
  refUrls: string[];
  variationText: string;
  brandName: string;
  profile?: QaProfile;
  anchorUrl?: string | null;
  formatLabel?: string;
  /** Верх коридора предметов — ровно тот, что ушёл в генерацию. */
  maxProps?: number;
  /** Низ коридора предметов — ровно тот, что ушёл в генерацию. */
  minProps?: number;
  /** Пол героя тон-варианта — тот же, что ушёл в генерацию. */
  gender?: QaHeroGender | null;
  /** Сходство персонажа с референсами — то же, что ушло в генерацию. */
  fidelity?: QaFidelity;
  /** Набор предметов кампании — тот же, что ушёл в генерацию. */
  propInventory?: string;
  /** Режим текста вариации — тот же, что ушёл в генерацию (TASK no-baked-text). */
  allowText?: boolean;
}): Promise<QaVerdict> {
  const profile: QaProfile = opts.profile ?? "anchor";
  const systemPrompt = buildQaSystemPrompt(profile, {
    ...(opts.maxProps !== undefined ? { maxProps: opts.maxProps } : {}),
    ...(opts.minProps !== undefined ? { minProps: opts.minProps } : {}),
    ...(opts.gender !== undefined ? { gender: opts.gender } : {}),
    ...(opts.fidelity !== undefined ? { fidelity: opts.fidelity } : {}),
    ...(opts.propInventory !== undefined ? { propInventory: opts.propInventory } : {}),
    ...(opts.allowText !== undefined ? { allowText: opts.allowText } : {}),
  });
  const anchorPart = profile === "secondary" && opts.anchorUrl ? [opts.anchorUrl] : [];
  const imageUrls = [opts.imageUrl, ...anchorPart, ...opts.refUrls.slice(0, QA_REFS_SHOWN)];
  const prompt = buildQaPrompt(opts.variationText, opts.brandName, opts.formatLabel);

  const first = await runVisionQa({ prompt, imageUrls, systemPrompt });
  if (!first.success || !first.output) {
    return {
      pass: true,
      score: -1,
      reasons: [`qa-skipped: ${first.error ?? "vision недоступен"}`],
      skipped: true,
    };
  }
  const verdict = parseVerdict(first.output);
  if (verdict) return applyThreshold(verdict);

  // Один ре-запрос со строгим напоминанием формата (R-2).
  const retry = await runVisionQa({
    prompt: `${prompt}\nYour previous answer was not valid JSON. Respond with ONLY the JSON object.`,
    imageUrls,
    systemPrompt,
  });
  if (retry.success && retry.output) {
    const second = parseVerdict(retry.output);
    if (second) return applyThreshold(second);
  }
  return { pass: false, score: 0, reasons: ["qa-unparseable: приёмщик не вернул валидный JSON"] };
}
