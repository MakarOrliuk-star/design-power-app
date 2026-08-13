import sharp from "sharp";
import { runVisionQa } from "./fal.js";

/**
 * Выбор цвета центрального свечения (TASK glow-fade-density, DI3-2:
 * «авто, как дизайнер — исходя из композиции и из референсов»).
 *
 * Эталоны показывают, что цвет НЕ выводится арифметикой: в `ok1` (тропики,
 * жёлтая рубашка, розовый фламинго, коричневый кокос) выбрана бирюза зонтика,
 * в `ok2` — мятная зелень долларов, в `ok3` — золото монет. Это решение
 * арт-директора «какой цвет поддержит сцену», а не «какого цвета в кадре
 * больше». Поэтому основной путь — vision-модель, та же, что судит приёмку.
 *
 * Три уровня защиты от недетерминированности VLM (R-P3):
 *  1. вопрос узкий — один hex, строгий JSON;
 *  2. ЛЮБОЙ результат (и модели, и фолбэка) проходит `normalizeGlowHex` —
 *     кислотный, чёрный и грязный цвета становятся пастелью, пригодной под
 *     заголовок в safe zone (R-I1);
 *  3. сбой транспорта или неразобранный ответ → детерминированный фолбэк по
 *     гистограмме кадра. Fail-open, как `describeCampaignStyle`.
 *
 * Цвет считается ОДИН раз на якорном формате и наследуется push/pop-up
 * (DI3-4: «свечение одинаковое»).
 */

/**
 * Коридоры цвета сняты с эталонов: #2FCDD1 (S 0.64, L 0.50), #04AE60
 * (S 0.96, L 0.35), #FFB70E (S 1.00, L 0.53). Дизайнер кладёт в свечение
 * ЧИСТЫЙ насыщенный тон, а мягким оно выглядит из-за альфы 0.38, а не из-за
 * бледности цвета. Поэтому нормализация не осветляет — она лишь удерживает
 * тон в коридоре эталонов и защищает от вырожденных ответов модели.
 */
export const GLOW_MIN_L = 0.4;
export const GLOW_MAX_L = 0.62;
/** Ниже — цвет выглядит грязным пятном, а не свечением. */
export const GLOW_MIN_S = 0.55;
export const GLOW_MAX_S = 1.0;
/** Ниже этой насыщенности вход считается ахроматичным (hue недостоверен). */
const ACHROMATIC_S = 0.08;
/** Тёплый нейтральный — тот же ориентир, что у `dominantColor` в движке. */
const NEUTRAL_HUE = 30;

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round(Math.max(0, Math.min(255, (rgb[0] + m) * 255))),
    Math.round(Math.max(0, Math.min(255, (rgb[1] + m) * 255))),
    Math.round(Math.max(0, Math.min(255, (rgb[2] + m) * 255))),
  ];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** `#RGB` / `#RRGGBB` / без решётки → `[r,g,b]`; мусор → null. */
export function parseHex(raw: string): [number, number, number] | null {
  const hex = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return [
      parseInt(hex[0]! + hex[0]!, 16),
      parseInt(hex[1]! + hex[1]!, 16),
      parseInt(hex[2]! + hex[2]!, 16),
    ];
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  return null;
}

/** Цвет по умолчанию — тёплое золото, как в эталоне `ok3` (#FFB70E). */
const NEUTRAL_GLOW = toHex(hslToRgb(NEUTRAL_HUE, 0.9, 0.52));

/**
 * Приведение цвета к коридору эталонов. Тон сохраняется — именно он несёт
 * «настроение кампании»; зажимаются только светлота и насыщенность, чтобы
 * почти-чёрный или выцветший ответ модели не превратил свечение в грязь.
 *
 * Ахроматический вход (серый, белый, чёрный) тона не имеет — брать его hue
 * бессмысленно (получился бы бледно-красный), поэтому идёт нейтральный.
 */
export function normalizeGlowHex(raw: string): string {
  const rgb = parseHex(raw);
  if (!rgb) return NEUTRAL_GLOW;
  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  if (s < ACHROMATIC_S) return NEUTRAL_GLOW;
  const sat = Math.max(GLOW_MIN_S, Math.min(GLOW_MAX_S, s));
  const lum = Math.max(GLOW_MIN_L, Math.min(GLOW_MAX_L, l));
  return toHex(hslToRgb(h, sat, lum));
}

/**
 * Детерминированный фолбэк: акцентный тон кадра по гистограмме.
 *
 * Считается по НЕПРОЗРАЧНЫМ пикселям с весом `saturation × value`, а не по
 * площади: усреднение по площади всегда выигрывает крупный тёмный объект
 * (костюм героя, чёрный кейс), и свечение выходило бы грязным. Вес по
 * насыщенности выбирает то, что дизайнер и назвал бы акцентом.
 */
export async function fallbackGlowHex(input: Buffer): Promise<string> {
  const { data, info } = await sharp(input)
    .resize(64, 64, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const BUCKETS = 24; // корзины по 15°
  const weights = new Array<number>(BUCKETS).fill(0);
  const sums: Array<[number, number, number]> = Array.from({ length: BUCKETS }, () => [0, 0, 0]);
  const n = info.width * info.height;
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3]!;
    if (a < 128) continue;
    const r = data[i * 4]!;
    const g = data[i * 4 + 1]!;
    const b = data[i * 4 + 2]!;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === 0) continue;
    const sat = (max - min) / max;
    const val = max / 255;
    if (sat < ACHROMATIC_S) continue;
    const [h] = rgbToHsl(r, g, b);
    const bucket = Math.min(BUCKETS - 1, Math.floor(h / (360 / BUCKETS)));
    const w = sat * val;
    weights[bucket] = weights[bucket]! + w;
    const s = sums[bucket]!;
    s[0] += r * w;
    s[1] += g * w;
    s[2] += b * w;
  }
  let best = -1;
  let bestW = 0;
  for (let i = 0; i < BUCKETS; i++) {
    if (weights[i]! > bestW) {
      bestW = weights[i]!;
      best = i;
    }
  }
  // Кадр без насыщенных пикселей (например, чёрно-белая сцена) — тона нет.
  if (best < 0 || bestW <= 0) return NEUTRAL_GLOW;
  const s = sums[best]!;
  return normalizeGlowHex(
    toHex([Math.round(s[0] / bestW), Math.round(s[1] / bestW), Math.round(s[2] / bestW)]),
  );
}

export const GLOW_COLOR_SYSTEM_PROMPT = [
  "You are an art director choosing the color of a soft central glow for a casino promo email hero.",
  "The FIRST image is the final cut-out artwork (rendered on white for production). The remaining images are approved reference banners of the same brand — they show how this brand's glows usually look.",
  "The glow is a wide, soft radial gradient behind all objects. It must support the scene's mood and pick up an accent color that is actually present in the artwork (a prop, an outfit detail, the brand palette).",
  "Rules: choose ONE hue that harmonizes with the artwork and never competes with the character; avoid grey, avoid pure white, avoid near-black, avoid a hue that clashes with the main props.",
  "A headline will later be placed on top of this glow, so prefer a light, airy tint over a deep saturated color.",
  'Respond with ONLY a JSON object, no prose, no markdown fences: {"hex": "#RRGGBB", "reason": "<max 12 words>"}.',
].join("\n");

export const GLOW_COLOR_PROMPT =
  "Choose the central glow color for this artwork. Answer with the JSON object only.";

/** Сколько референсов показываем арт-директору (первые по порядку). */
export const GLOW_REFS_SHOWN = 3;

export interface GlowColorResult {
  /** Нормализованный `#RRGGBB` — всегда валиден. */
  hex: string;
  source: "vlm" | "fallback";
  /** Обоснование модели или причина фолбэка (для metadata и логов админки). */
  reason: string;
}

/** Разбор ответа арт-директора; берём первый {...} блок (модель любит fences). */
export function parseGlowAnswer(text: string): { hex: string; reason: string } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof raw.hex !== "string") return null;
    if (!parseHex(raw.hex)) return null;
    const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 120) : "";
    return { hex: raw.hex, reason };
  } catch {
    return null;
  }
}

/**
 * Цвет свечения для композиции. `buffer` — байты той же картинки: нужны
 * фолбэку, чтобы не скачивать её повторно.
 */
export async function pickGlowColor(opts: {
  imageUrl: string;
  refUrls: string[];
  buffer: Buffer;
}): Promise<GlowColorResult> {
  const fallback = async (reason: string): Promise<GlowColorResult> => ({
    hex: await fallbackGlowHex(opts.buffer),
    source: "fallback",
    reason,
  });

  const res = await runVisionQa({
    prompt: GLOW_COLOR_PROMPT,
    imageUrls: [opts.imageUrl, ...opts.refUrls.slice(0, GLOW_REFS_SHOWN)],
    systemPrompt: GLOW_COLOR_SYSTEM_PROMPT,
  });
  if (!res.success || !res.output) return fallback(res.error ?? "vision недоступен");
  const parsed = parseGlowAnswer(res.output);
  if (!parsed) return fallback("glow-color-unparseable");
  return {
    hex: normalizeGlowHex(parsed.hex),
    source: "vlm",
    reason: parsed.reason || "выбор арт-директора",
  };
}
