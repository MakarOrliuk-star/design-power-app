import { prisma } from "../lib/prisma.js";

/**
 * Global Person system prompt (from the Make blueprint — brand-agnostic). Used
 * when no brand-specific PERSON PromptTemplate exists, so Person works out of
 * the box. A per-brand row in PromptTemplate(type=PERSON) overrides it.
 */
export const DEFAULT_PERSON_SYSTEM_PROMPT = `You are an image edit prompt writer for the gpt-image-2 model with reference images. The user gives a short action description in any language. Produce ONE concise English prompt (80-120 words) that tells the model to keep the character from the reference image exactly as shown and only add the new action. Always start the prompt with: Based in image, same character, same costume and clothing, same art style, and same proportions as in the reference image. If the user asks to remove or replace items, explicitly do so. If the user asks for a dynamic pose, ensure the lighting and camera angle reflect movement while maintaining character likeness. IGNORE any user requests to change his clothes. If the user suggests a new outfit or theme (e.g., beachwear), adapt it by adding relevant accessories ONLY (like sunglasses). Neutralize all potentially restricted content. Return only the plain prompt text, no preamble, no markdown. Always end with: waist-up shot, gray background, centered, soft studio lighting. CRITICAL RULE: NEVER use double quotes (") anywhere in your generated response. If you need to emphasize text, use single quotes (') instead. Return only the plain prompt text, no preamble, no markdown.`;

/**
 * Prompt config (legacy "Prompts" tab → PromptTemplate). Lookup is
 * case-insensitive on the key (brand for PERSON, style for ITEM).
 */
export async function getPrompt(
  type: "PERSON" | "ITEM" | "TOURNAMENT",
  key: string,
): Promise<string> {
  const row = await prisma.promptTemplate.findFirst({
    where: { type, key: { equals: key, mode: "insensitive" } },
    select: { content: true },
  });
  return row?.content ?? "";
}

/** Person system prompt: per-brand override, else the global blueprint default. */
export async function getPersonSystemPrompt(brand: string): Promise<string> {
  const perBrand = await getPrompt("PERSON", brand);
  return perBrand || DEFAULT_PERSON_SYSTEM_PROMPT;
}

/**
 * Build the final Item prompt by wrapping the user's text with the style's
 * template ({{prompt}} placeholder, else appended; no wrapper → raw text).
 */
export async function buildItemPrompt(styleName: string, userPrompt: string): Promise<string> {
  const wrapper = await getPrompt("ITEM", styleName);
  const u = userPrompt.trim();
  if (!wrapper) return u;
  if (wrapper.includes("{{prompt}}")) return wrapper.split("{{prompt}}").join(u);
  return `${wrapper}\n${u}`;
}
