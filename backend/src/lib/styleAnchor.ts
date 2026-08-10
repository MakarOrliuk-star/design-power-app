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
  props: string;
  lighting: string;
  rendering: string;
}

export const STYLE_ANCHOR_SYSTEM_PROMPT = [
  "You are an art director describing an approved casino promo creative so that other formats of the SAME campaign can be produced in an identical visual style.",
  "Look at the image and describe only what is reusable across formats — never its layout, framing or aspect ratio.",
  "Be concrete and visual: name actual colors, the character's look and outfit, the prop family, the light direction and the rendering technique.",
  "Ignore the plain white background — it is a production requirement, not part of the style.",
  'Respond with ONLY a JSON object, no prose, no markdown fences: {"palette": string, "character": string, "props": string, "lighting": string, "rendering": string}.',
  "Each value is one short English phrase (max ~20 words). Use an empty string if something is absent from the image.",
].join("\n");

export const STYLE_ANCHOR_PROMPT =
  "Describe the reusable visual style of this approved campaign creative. Answer with the JSON object only.";

const FIELDS: Array<keyof CampaignStyleAnchor> = [
  "palette",
  "character",
  "props",
  "lighting",
  "rendering",
];

/** Разбор ответа VLM: берём первый {...} блок (модель любит обрамлять fences). */
export function parseStyleAnchor(text: string): CampaignStyleAnchor | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    const anchor = {} as CampaignStyleAnchor;
    let filled = 0;
    for (const field of FIELDS) {
      const value = typeof raw[field] === "string" ? (raw[field] as string).trim().slice(0, 300) : "";
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
  if (anchor.props) parts.push(`Props: ${anchor.props}`);
  if (anchor.lighting) parts.push(`Lighting: ${anchor.lighting}`);
  if (anchor.rendering) parts.push(`Rendering: ${anchor.rendering}`);
  return parts.length > 0 ? `Campaign style to reproduce — ${parts.join("; ")}.` : "";
}

export interface StyleAnchorResult {
  /** Готовый абзац для промпта; "" — описание не получено (fail-open). */
  text: string;
  anchor: CampaignStyleAnchor | null;
  /** Причина, по которой описания нет (для metadata/логов). */
  error?: string;
}

/** Снимает описание стиля с финальной композиции якорного ассета. */
export async function describeCampaignStyle(imageUrl: string): Promise<StyleAnchorResult> {
  const res = await runVisionQa({
    prompt: STYLE_ANCHOR_PROMPT,
    imageUrls: [imageUrl],
    systemPrompt: STYLE_ANCHOR_SYSTEM_PROMPT,
  });
  if (!res.success || !res.output) {
    return { text: "", anchor: null, error: res.error ?? "vision недоступен" };
  }
  const anchor = parseStyleAnchor(res.output);
  if (!anchor) return { text: "", anchor: null, error: "style-anchor-unparseable" };
  return { text: formatStyleAnchor(anchor), anchor };
}
