import { runVisionQa } from "./fal.js";

/**
 * Стиль-якорь промо-кампании (TASK multiformat-promo, DI2-3 / R-PLAN §3.2).
 *
 * Email генерируется первым и становится эталоном кампании. Push и pop-up
 * получают (а) саму email-композицию первой картинкой в /edit и (б) её
 * ТЕКСТОВОЕ описание, снятое здесь одним vision-запросом: картинка задаёт
 * «как выглядит», текст фиксирует «что именно повторять» (палитра, персонаж,
 * семейство пропсов, свет, рендер) и не даёт модели скатиться в копирование
 * раскладки email.
 *
 * Fail-open (как requestCreativeBrief в Задании 3): недоступный VLM или
 * невалидный JSON → пустое описание, генерация зависимых форматов идёт на
 * одной картинке-якоре. Стиль от этого слабее, но кампания не встаёт.
 */

export interface CampaignStyleAnchor {
  palette: string;
  character: string;
  /**
   * Анатомия рук героя (правка 2026-08-15): тип кисти и число пальцев, снятые
   * с УТВЕРЖДЁННОГО email. Отдельным полем, а не внутри `character`: там
   * модель описывает образ и про пальцы не пишет, а зависимым форматам нужно
   * ровно это число — иначе у push и pop-up рука «своя». Пусто, если рук в
   * кадре не видно (тогда работает общее правило контракта: пять пальцев).
   */
  hands: string;
  props: string;
  /**
   * НАБОР предметов кампании (правка 2026-08-15, заказчик: «предметы не должны
   * быть рандомными, должна быть общая композиция промо»). В отличие от
   * `props` — это не семейство («золотые монеты, барабаны»), а перечисление
   * КОНКРЕТНЫХ объектов утверждённого email: 6–10 штук с материалом. Список
   * уходит в промпт push/pop-up как инвентарь кампании, из которого они
   * собирают свой кадр, и в чек-лист приёмщика.
   *
   * Сам email сгенерирован по референсам бренда и брифу вариации, поэтому
   * снятый с него список по построению и есть «на основании референсов и
   * промпта» — отдельного источника правды заводить не нужно.
   */
  propInventory: string;
  lighting: string;
  rendering: string;
}

/**
 * Системный промпт съёмщика стиля (TASK no-baked-text, правка 2026-08-17).
 *
 * Второй канал утечки текста после планировщика: `propInventory` снимается с
 * готового email и уходит в push/pop-up как набор кампании. Прежняя редакция
 * приводила в пример «volumetric golden FS letter», и если на якоре буква
 * всё-таки осталась, инвентарь её узаконивал — зависимые форматы получали
 * прямое указание эту букву нарисовать.
 */
export function buildStyleAnchorSystemPrompt(allowText = false): string {
  const inventoryExample = allowText
    ? "golden coin with a ruby inlay, red poker chip, volumetric golden FS letter, green palm leaf, purple gift box with a gold ribbon"
    : "golden coin with a ruby inlay, red poker chip, golden crown with red gems, green palm leaf, purple gift box with a gold ribbon";
  const letteringRule = allowText
    ? []
    : [
        'Never put lettering into "propInventory": no volumetric letters or words (FS, BONUS, WIN, VIP, 777), no signs, ' +
          "plates, labels or banners carrying an inscription, no logos. If such an object appears in the image, SKIP it " +
          "entirely — do not describe it and do not substitute a similar worded object. A standard playing card with its " +
          "rank marks is fine.",
      ];
  return [
    "You are an art director describing an approved casino promo creative so that other formats of the SAME campaign can be produced in an identical visual style.",
    "Look at the image and describe only what is reusable across formats — never its layout, framing or aspect ratio.",
    "Be concrete and visual: name actual colors, the character's look and outfit, the prop family, the light direction and the rendering technique.",
    'For "hands", state what kind of hands the character has (human hands, gloved cartoon hands, animal paws with claws, hooves) and how many digits one hand has, e.g. "human hands, five digits each" or "furry paws with four clawed toes". Use an empty string if no hand is visible.',
    `For "propInventory", list the CONCRETE objects that appear in this creative — 6 to 10 of them, comma-separated, each with its material or finish, e.g. "${inventoryExample}". Name individual objects, not groups or piles, and ignore the character itself. This list becomes the prop set of the whole campaign, so be specific and complete.`,
    ...letteringRule,
    "Ignore the plain white background — it is a production requirement, not part of the style.",
    'Respond with ONLY a JSON object, no prose, no markdown fences: {"palette": string, "character": string, "hands": string, "props": string, "propInventory": string, "lighting": string, "rendering": string}.',
    'Each value is one short English phrase (max ~20 words), except "propInventory", which is the comma-separated list described above. Use an empty string if something is absent from the image.',
  ].join("\n");
}

/** Обратная совместимость: промпт в строгом режиме (новый дефолт). */
export const STYLE_ANCHOR_SYSTEM_PROMPT = buildStyleAnchorSystemPrompt();

/**
 * Отсев позиций-надписей из снятого инвентаря (TASK no-baked-text). Список
 * плоский, через запятую, поэтому фильтруем по элементам. Логика и регулярка
 * намеренно совпадают с `propPlan.dropLetteringProps`: оба списка попадают в
 * одно и то же место промпта, и разные правила давали бы разный результат в
 * зависимости от того, сработал планировщик или фолбэк на съём с картинки.
 */
export function stripLetteringFromInventory(inventory: string): string {
  const re =
    /\b(letter|letters|lettering|word|words|text|typography|caption|headline|inscription|logo|signage|sign board|signboard|nameplate|name plate|label)\b|\b(fs|vip|win|bonus|jackpot|scatter|wild|777)\b/i;
  return inventory
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && (/\bplaying card\b/i.test(p) || !re.test(p)))
    .join(", ");
}

export const STYLE_ANCHOR_PROMPT =
  "Describe the reusable visual style of this approved campaign creative. Answer with the JSON object only.";

/**
 * Бриф кампании в запросе описания (правка 2026-08-15). Картинка уже сделана
 * по брифу, но названия предметов модель выбирает свободно — с брифом перед
 * глазами она называет их в терминах кампании («золотая подкова удачи», а не
 * «металлическая деталь») и не пропускает объекты, которые бриф считает
 * главными. Пустой бриф ничего не добавляет.
 */
export function buildStyleAnchorPrompt(variationText?: string): string {
  const brief = (variationText ?? "").trim();
  return brief
    ? `Campaign brief: ${brief}.\n${STYLE_ANCHOR_PROMPT}`
    : STYLE_ANCHOR_PROMPT;
}

const FIELDS: Array<keyof CampaignStyleAnchor> = [
  "palette",
  "character",
  "hands",
  "props",
  "propInventory",
  "lighting",
  "rendering",
];

/** Перечисление объектов длиннее короткой фразы — свой потолок обрезки. */
const FIELD_LIMIT: Partial<Record<keyof CampaignStyleAnchor, number>> = {
  propInventory: 600,
};

/** Разбор ответа VLM: берём первый {...} блок (модель любит обрамлять fences). */
export function parseStyleAnchor(text: string): CampaignStyleAnchor | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    const anchor = {} as CampaignStyleAnchor;
    let filled = 0;
    for (const field of FIELDS) {
      const limit = FIELD_LIMIT[field] ?? 300;
      const value = typeof raw[field] === "string" ? (raw[field] as string).trim().slice(0, limit) : "";
      anchor[field] = value;
      if (value) filled++;
    }
    // Пустой объект бесполезен как якорь — считаем разбор неуспешным.
    return filled > 0 ? anchor : null;
  } catch {
    return null;
  }
}

/** Абзац для промпта зависимых форматов; пустой якорь → пустая строка. */
export function formatStyleAnchor(anchor: CampaignStyleAnchor | null): string {
  if (!anchor) return "";
  const parts: string[] = [];
  if (anchor.palette) parts.push(`Palette: ${anchor.palette}`);
  if (anchor.character) parts.push(`Character: ${anchor.character}`);
  // Явное «Hands: …» уходит в промпт push/pop-up: тип кисти и число пальцев
  // кампании фиксируются утверждённым email, а не пересочиняются форматом.
  if (anchor.hands) parts.push(`Hands (reproduce exactly): ${anchor.hands}`);
  // `propInventory` в этот абзац НЕ идёт: перечисление объектов уходит
  // отдельным блоком контракта (PROP CHOICE), где сказано, что с ним делать.
  // Здесь оно дублировалось бы и размывало описание стиля.
  if (anchor.props) parts.push(`Props: ${anchor.props}`);
  if (anchor.lighting) parts.push(`Lighting: ${anchor.lighting}`);
  if (anchor.rendering) parts.push(`Rendering: ${anchor.rendering}`);
  return parts.length > 0 ? `Campaign style to reproduce — ${parts.join("; ")}.` : "";
}

export interface StyleAnchorResult {
  /** Готовый абзац для промпта; "" — описание не получено (fail-open). */
  text: string;
  /** Набор предметов кампании; "" — не распознан (тогда работает старая логика). */
  propInventory: string;
  anchor: CampaignStyleAnchor | null;
  /** Причина, по которой описания нет (для metadata/логов). */
  error?: string;
}

/**
 * Снимает описание стиля и набор предметов с финальной композиции якоря.
 * `variationText` — бриф кампании (правка 2026-08-15): тем же ОДНИМ запросом,
 * без дополнительной платы, список предметов получается в терминах брифа.
 */
export async function describeCampaignStyle(
  imageUrl: string,
  variationText?: string,
  /** Режим текста вариации (TASK no-baked-text); дефолт — строгий запрет. */
  allowText = false,
): Promise<StyleAnchorResult> {
  const res = await runVisionQa({
    prompt: buildStyleAnchorPrompt(variationText),
    imageUrls: [imageUrl],
    systemPrompt: buildStyleAnchorSystemPrompt(allowText),
  });
  if (!res.success || !res.output) {
    return { text: "", propInventory: "", anchor: null, error: res.error ?? "vision недоступен" };
  }
  const parsed = parseStyleAnchor(res.output);
  if (!parsed) {
    return { text: "", propInventory: "", anchor: null, error: "style-anchor-unparseable" };
  }
  // Тот же детерминированный отсев, что у планировщика: инвентарь уходит в
  // зависимые форматы приказом «строй кадр из ЭТИХ объектов», и одна
  // пропущенная надпись даёт буквы во всех push и pop-up кампании.
  const anchor = allowText
    ? parsed
    : { ...parsed, propInventory: stripLetteringFromInventory(parsed.propInventory) };
  return { text: formatStyleAnchor(anchor), propInventory: anchor.propInventory, anchor };
}
