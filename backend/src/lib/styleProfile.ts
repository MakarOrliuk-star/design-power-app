import { z } from "zod";
import { chatCompletion } from "./nanogpt.js";
import { TYPO_MATERIALS, MAX_TOKEN_CHARS } from "./typography3d.js";

/**
 * DV-E1 — «казино-дизайнер»: прослойка выбирает СТИЛЬ, а не геометрию.
 *
 * Модель смотрит на бриф кампании, бренд и слои и отдаёт style-profile —
 * ДАННЫЕ, которые движок волен применить только внутри коридоров спеки:
 *   - какие ассеты библиотеки декора уместны под кампанию;
 *   - hue плашки (перекрывает `colorSource: "auto-from-layers"` — и ТОЛЬКО
 *     его: `fixed` в спеке — явная воля админа и остаётся законом);
 *   - материал типографики (ключ из TYPO_MATERIALS);
 *   - токены надписей под оффер;
 *   - плотность рассыпки как доля 0..1 ВНУТРИ коридоров count спеки.
 *
 * Жёсткие ограничения (DECISIONS DV-E1, без них трек не принимается):
 *   1. Никаких координат — позицию определяет спека (D-E4, D-V5).
 *   2. Один вызов на brand-variant (stage A), результат сохраняется на
 *      варианте: повторный рендер бандла берёт сохранённый профиль.
 *   3. Выход зажимается в коридоры спеки (`clampStyleProfile`), значения вне
 *      диапазона клампятся или отбрасываются, а не принимаются.
 *   4. Ручной override в админке (`source: "manual"` — stage A его не трёт)
 *      и детерминированный фолбэк: нет ключа / сбой / мусор в ответе → null,
 *      то есть ровно сегодняшнее поведение движка без прослойки.
 *
 * Единство света прослойка НЕ даёт: rim light, тени и сведение hue — операции
 * движка над пикселями (П8/П10/П11). Прослойка выбирает, ЧТО положить в кадр.
 */

export const styleProfileSchema = z.object({
  /** Hue плашки, #RRGGBB. Перекрывает только auto-from-layers. */
  glowHex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  /** Ключ материала типографики; неизвестный ключ отбрасывается клампом. */
  typoMaterial: z.string().optional(),
  /** Токены надписей под оффер (КАПС, ≤ MAX_TOKEN_CHARS, ≤ 3). */
  tokens: z.array(z.string()).optional(),
  /** Плотность рассыпки: 0 = минимум коридора спеки, 1 = максимум. */
  density: z.number().optional(),
  /** Выбранные URL из библиотеки декора; чужие URL отбрасываются клампом. */
  decorUrls: z.array(z.string()).optional(),
  /** Кто автор профиля: модель или ручной override из админки. */
  source: z.enum(["model", "manual"]).optional(),
});

export type StyleProfile = z.infer<typeof styleProfileSchema>;

/** Токен приводится к виду надписи: КАПС, схлопнутые пробелы, обрезка по
 *  целым словам до MAX_TOKEN_CHARS — тот же предел, что у deriveTokens. */
function sanitizeToken(raw: string): string | null {
  const upper = raw.replace(/\s+/g, " ").trim().toUpperCase();
  if (!upper) return null;
  let token = upper;
  if (token.length > MAX_TOKEN_CHARS) {
    const parts = upper.split(" ");
    token = "";
    for (const part of parts) {
      const next = token ? `${token} ${part}` : part;
      if (next.length > MAX_TOKEN_CHARS) break;
      token = next;
    }
  }
  const alnum = token.replace(/[^\p{Lu}\p{N}]/gu, "");
  return alnum.length >= 2 ? token : null;
}

/**
 * Ограничение 3 DV-E1: всё, что пришло от модели (или руками из админки),
 * зажимается в коридоры. Мусор не роняет рендер — он отбрасывается, и поле
 * деградирует к сегодняшнему дефолту движка.
 */
export function clampStyleProfile(
  raw: unknown,
  opts: { libraryUrls: string[] },
): StyleProfile | null {
  const parsed = styleProfileSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  const out: StyleProfile = {};

  if (p.glowHex) out.glowHex = p.glowHex.toUpperCase();

  // Материал строго из пресетов: resolveMaterial молча падал бы в золото, а
  // кламп обязан отбрасывать невалидное явно (ограничение 3).
  if (p.typoMaterial && TYPO_MATERIALS[p.typoMaterial]) out.typoMaterial = p.typoMaterial;

  if (p.tokens) {
    const tokens: string[] = [];
    for (const t of p.tokens) {
      const clean = sanitizeToken(t);
      if (!clean) continue;
      if (tokens.some((x) => x === clean)) continue;
      tokens.push(clean);
      if (tokens.length >= 3) break;
    }
    if (tokens.length > 0) out.tokens = tokens;
  }

  if (p.density !== undefined && Number.isFinite(p.density)) {
    out.density = Math.min(1, Math.max(0, p.density));
  }

  // Только URL из НЫНЕШНЕЙ библиотеки слота: профиль сохранён надолго, а
  // библиотека правится в админке — устаревшие ссылки молча выпадают.
  // Пустое пересечение = «выбора нет» → берётся вся библиотека.
  if (p.decorUrls) {
    const chosen = opts.libraryUrls.filter((u) => p.decorUrls!.includes(u));
    if (chosen.length > 0) out.decorUrls = chosen;
  }

  if (p.source) out.source = p.source;
  return Object.keys(out).length > 0 ? out : null;
}

/** Имя файла из Cloudinary-URL — модели не нужны 120-символьные ссылки. */
function shortName(url: string): string {
  const tail = url.split("/").pop() ?? url;
  return tail.length > 40 ? tail.slice(0, 40) : tail;
}

const SYSTEM_PROMPT = [
  "You are an art director for casino marketing banners.",
  "Given a campaign brief, pick a STYLE for the banner scene. You do NOT place anything — geometry is fixed elsewhere.",
  "Answer with a single JSON object and nothing else (no markdown, no prose):",
  '{"glowHex": "#RRGGBB", "typoMaterial": "<key>", "tokens": ["..."], "density": 0..1, "decorIndices": [0, ...]}',
  "Rules:",
  "- glowHex: the glow color behind the scene; harmonize with the brand/campaign mood.",
  "- typoMaterial: one key from the provided list.",
  "- tokens: up to 3 SHORT ALL-CAPS offer captions (max 14 chars each) that fit the brief; [] if the brief implies none.",
  "- density: how busy the decor should feel, 0 = sparse, 1 = dense.",
  "- decorIndices: indices of decor assets that FIT the campaign theme; [] if all fit.",
  "Every field is optional — omit what you are not confident about.",
].join("\n");

/** Ответ модели: как styleProfile, но декор — индексами (URL длинные и модель
 *  их коверкает). Индексы мапятся в URL уже на нашей стороне. */
const modelReplySchema = styleProfileSchema
  .omit({ decorUrls: true, source: true })
  .extend({ decorIndices: z.array(z.number().int().min(0)).optional() });

export interface StyleProfileRequest {
  campaignPrompt: string;
  brandName: string;
  /** URL библиотеки декора слота (может быть пустой — поле тогда не предлагается). */
  libraryUrls: string[];
  /** Доминантный цвет слоёв, #RRGGBB — то, что видел бы движок в auto-режиме. */
  layerColorHex: string | null;
}

/**
 * Один вызов модели на brand-variant (ограничение 2 — вызывается из stage A,
 * результат сохраняется на варианте). Любой сбой → null: движок работает как
 * без прослойки, рендер не блокируется никогда.
 */
export async function requestStyleProfile(req: StyleProfileRequest): Promise<StyleProfile | null> {
  const materials = Object.keys(TYPO_MATERIALS).join(", ");
  const decorList =
    req.libraryUrls.length > 0
      ? req.libraryUrls.map((u, i) => `${i}: ${shortName(u)}`).join("\n")
      : "(no decor library)";
  const user = [
    `Campaign brief: ${req.campaignPrompt || "(empty)"}`,
    `Brand: ${req.brandName}`,
    `Dominant color of the generated layers: ${req.layerColorHex ?? "unknown"}`,
    `Typography materials: ${materials}`,
    `Decor assets:\n${decorList}`,
  ].join("\n\n");

  const text = await chatCompletion(SYSTEM_PROMPT, user, { temperature: 0, maxTokens: 400 });
  if (!text) return null;

  // Модели любят заворачивать JSON в ```‑ограду вопреки инструкции — снимаем.
  const bare = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bare);
  } catch {
    return null;
  }
  const reply = modelReplySchema.safeParse(parsed);
  if (!reply.success) return null;

  const { decorIndices, ...rest } = reply.data;
  const decorUrls = decorIndices
    ?.filter((i) => i < req.libraryUrls.length)
    .map((i) => req.libraryUrls[i]!);
  const clamped = clampStyleProfile(
    { ...rest, ...(decorUrls && decorUrls.length > 0 ? { decorUrls } : {}) },
    { libraryUrls: req.libraryUrls },
  );
  return clamped ? { ...clamped, source: "model" } : null;
}
