import { runVisionQa } from "./fal.js";

/**
 * План предметов кампании (правка 2026-08-15, заказчик: «предметы сами
 * сгенерировать на основании рефов которые есть и подстроить под промпт и
 * выдержать стилистику email / push / pop-up»).
 *
 * Зачем отдельный шаг. Набор предметов раньше не существовал как сущность:
 * email сочинял объекты сам, а push и pop-up сочиняли свои — три формата
 * получались из одной палитры, но из разного реквизита, и предметы читались
 * «просто поставленными». Снимать набор постфактум с готового email тоже
 * недостаточно: туда попадает то, что модель случайно нарисовала, включая
 * выдуманное мимо референсов.
 *
 * Поэтому набор планируется ДО первой генерации и по двум источникам сразу:
 *  - референсы бренда — словарь реквизита, который у бренда реально есть;
 *  - бриф вариации — что именно рекламирует эта акция.
 * Результат — один список на кампанию, который получают все три формата
 * (`metadata.styleAnchorProps` якоря → loadAnchorContext → push/pop-up).
 *
 * Fail-open, как у styleAnchor и creativeBrief: недоступный VLM или битый
 * JSON → null, и пайплайн откатывается на прежнее поведение («подбери свои»).
 * Прослойка, роняющая генерацию из-за недоступной модели, хуже её отсутствия.
 */

export interface CampaignPropPlan {
  /** Весь реквизит кампании: 6–10 конкретных объектов с материалом. */
  props: string[];
  /**
   * 1–2 ГЛАВНЫХ предмета — те, о чём акция (их герой держит/на них смотрит,
   * они крупнее и резче прочих). Без явного выделения главного кадр выходит
   * «ровным ковром» из одинаково важных объектов — ровно та жалоба, с которой
   * правка начиналась.
   */
  keyProps: string[];
}

/** Сколько референсов показываем планировщику: словарь реквизита, не стиль. */
export const PROP_PLAN_REFS_SHOWN = 5;

/** Границы списка: меньше 4 объектов не покрывают кадр, больше 10 — не набор. */
const MIN_PLAN_PROPS = 4;
const MAX_PLAN_PROPS = 10;
const MAX_KEY_PROPS = 2;

export const PROP_PLAN_SYSTEM_PROMPT = [
  "You are an art director assembling the prop list for a new casino promo campaign.",
  "The images are approved reference banners of this brand — they show the prop vocabulary this brand actually uses: the kinds of objects, their materials, finish and level of detail.",
  "Your job: choose the set of objects this ONE campaign will be built from. The same set will be used across every format of the campaign (email, push, pop-up), so it must work both in a wide banner and in a nearly square one.",
  "Rules for the set:",
  "- every object must belong to the world of the reference banners — same materials and finish; do not invent objects from another brand or another genre;",
  "- the set must express the campaign brief: if the brief is about free spins, cashback, a tournament or a holiday, the objects must say so at a glance;",
  "- name CONCRETE single objects with their material, e.g. \"golden coin with a ruby inlay\", \"volumetric golden FS letter\", \"red poker chip with gold rim\" — never groups, piles, stacks or scenery;",
  "- objects must be able to FLOAT in the air around a character: no slot machines, no fortune wheels, no treasure chests, no furniture, no banknote stacks;",
  `- pick ${MIN_PLAN_PROPS} to ${MAX_PLAN_PROPS} objects in total, varied in size and shape (a few large statement pieces, several medium ones, a few small accents);`,
  `- additionally mark 1 to ${MAX_KEY_PROPS} of them as the KEY objects — the ones the campaign is really about, which the hero can hold or look at.`,
  'Respond with ONLY a JSON object, no prose, no markdown fences: {"props": string[], "keyProps": string[]}.',
  '"keyProps" must repeat entries from "props" verbatim. Write everything in English.',
].join("\n");

export function buildPropPlanPrompt(brandName: string, variationText: string): string {
  return [
    `Brand: ${brandName}.`,
    `Campaign brief: ${variationText.trim() || "(not specified)"}`,
    "Assemble the prop set for this campaign and answer with the JSON object only.",
  ].join("\n");
}

/** Нормализация строки объекта: без пустых, без переносов, без длинных полотен. */
function cleanProp(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.replace(/\s+/g, " ").trim().slice(0, 80);
  return value.length >= 3 ? value : null;
}

/**
 * Разбор ответа планировщика. Пустой или однопозиционный список считаем
 * неудачей: набор из одного объекта хуже отсутствия набора — он загонит все
 * форматы в один и тот же предмет, повторённый десять раз.
 */
export function parsePropPlan(text: string): CampaignPropPlan | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    const props = Array.isArray(raw.props)
      ? raw.props
          .map(cleanProp)
          .filter((p): p is string => p !== null)
          .slice(0, MAX_PLAN_PROPS)
      : [];
    if (props.length < 2) return null;
    // keyProps сверяем со списком: модель иногда сочиняет «главный» объект,
    // которого в наборе нет, и он утекал бы в промпт мимо инвентаря.
    const lower = new Set(props.map((p) => p.toLowerCase()));
    const keyProps = (Array.isArray(raw.keyProps) ? raw.keyProps : [])
      .map(cleanProp)
      .filter((p): p is string => p !== null && lower.has(p.toLowerCase()))
      .slice(0, MAX_KEY_PROPS);
    // Главный не распознан — берём первый по списку: планировщик перечисляет
    // от крупного к мелкому, и «нет главного» хуже, чем «главный выбран нами».
    return { props, keyProps: keyProps.length > 0 ? keyProps : [props[0]!] };
  } catch {
    return null;
  }
}

/**
 * Текст набора для промптов и чек-листа приёмки. Один формат на все места —
 * промпт генерации, приёмщик и лечение обязаны видеть один и тот же список,
 * иначе приёмка бракует то, что сама же генерация и просила.
 */
export function formatPropPlan(plan: CampaignPropPlan | null): string {
  if (!plan || plan.props.length === 0) return "";
  const key = plan.keyProps.length > 0 ? ` KEY objects of the campaign: ${plan.keyProps.join(", ")}.` : "";
  return `${plan.props.join(", ")}.${key}`;
}

export interface PropPlanResult {
  /** Готовая строка набора; "" — план не получен (fail-open). */
  text: string;
  plan: CampaignPropPlan | null;
  error?: string;
}

/** Планирует набор предметов кампании по референсам бренда и брифу вариации. */
export async function planCampaignProps(opts: {
  refUrls: string[];
  variationText: string;
  brandName: string;
}): Promise<PropPlanResult> {
  const imageUrls = opts.refUrls.slice(0, PROP_PLAN_REFS_SHOWN);
  if (imageUrls.length === 0) return { text: "", plan: null, error: "нет референсов" };

  const res = await runVisionQa({
    prompt: buildPropPlanPrompt(opts.brandName, opts.variationText),
    imageUrls,
    systemPrompt: PROP_PLAN_SYSTEM_PROMPT,
  });
  if (!res.success || !res.output) {
    return { text: "", plan: null, error: res.error ?? "vision недоступен" };
  }
  const plan = parsePropPlan(res.output);
  if (!plan) return { text: "", plan: null, error: "prop-plan-unparseable" };
  return { text: formatPropPlan(plan), plan };
}
