import sharp from "sharp";

/**
 * Пост-обработка промо-ассетов ai_reference (TASK glow-fade-density, задания
 * 1–2; R-PLAN §3, Фаза 1).
 *
 * Два эффекта поверх готового вырезанного PNG:
 *  - «Центральное акцентное свечение» — эллиптический радиальный градиент,
 *    ложится ФОНОМ, строго под все объекты (DI3-1);
 *  - «Фейд» — растворение нижней кромки, применяется поверх всего (DI3-5).
 *
 * Оба шага детерминированы (D2): чистые функции от байтов и конфига, без
 * обращений к моделям. Приёмщик VLM судит композицию ДО них — контракт «фон
 * чисто белый, без градиентов» остаётся в силе для генерации.
 *
 * Фейд сделан ПО АЛЬФЕ, а не заливкой цветом (DI3-5): пипетить цвет неоткуда —
 * фон композиции по контракту чисто белый и вырезается removeBg, а светло-серый
 * оттенок эталонов принадлежит письму, а не картинке. Умножение альфы на фоне
 * письма выглядит идентично заливке и при этом работает на любом фоне.
 */

/** Геометрия свечения в долях холста. Замеры по эталонам `ok1–ok3 email`. */
export interface GlowConfig {
  cxPct: number;
  cyPct: number;
  rxPct: number;
  ryPct: number;
  /** Пиковая непрозрачность в центре (0–1). Свечение обязано остаться фоном. */
  peakAlpha: number;
}

/** Геометрия фейда: доля высоты холста, на которой альфа гаснет до нуля. */
export interface FadeConfig {
  heightPct: number;
}

export interface PromoEffectsConfig {
  glow: GlowConfig | null;
  fade: FadeConfig | null;
}

/**
 * Числа свечения сняты с эталонов `ok1–ok3 email` (1200×600), а не подобраны
 * на глаз: у всех трёх альфа в центре 95–98, спад по вертикали вчетверо
 * быстрее, чем по горизонтали, а по краям и в углах строго ноль.
 *
 * Профиль подогнан к замерам (доля высоты → альфа): 10 %→16, 20 %→46,
 * 30 %→80, 40 %→98, 60 %→72, 70 %→35, 80 %→10, 90 %→0. Отсюда центр по
 * вертикали 0.45 и `ryPct` вдвое меньше `rxPct`: свечение — широкая
 * горизонтальная полоса, а не круг.
 *
 * `peakAlpha` берётся из эталона как есть; цвет при этом НЕ осветляется
 * (см. `glowColor.normalizeGlowHex`) — у дизайнера в центре чистый
 * насыщенный тон (#2FCDD1 / #04AE60 / #FFB70E), а пастельным он выглядит
 * именно из-за альфы. Осветлять цвет И гасить альфой значит осветлить дважды.
 */
export const DEFAULT_GLOW: GlowConfig = {
  cxPct: 0.5,
  cyPct: 0.45,
  rxPct: 1.0,
  ryPct: 0.52,
  peakAlpha: 0.38,
};

/**
 * Фейд снят с эталонов `pop-up ok1/ok2` (доля высоты → альфа): 80 %→254,
 * 85 %→192, 88 %→72, 90 %→38, 92 %→20, 94 %→8, 96 %→1. Полоса начинается на
 * ~83 % высоты, то есть занимает примерно шестую часть кадра.
 */
export const DEFAULT_FADE: FadeConfig = { heightPct: 0.17 };

export const DEFAULT_EFFECTS: PromoEffectsConfig = {
  glow: DEFAULT_GLOW,
  fade: DEFAULT_FADE,
};

/** Эффекты выключены целиком — ассет остаётся тем же, чем был до задания. */
export const NO_EFFECTS: PromoEffectsConfig = { glow: null, fade: null };

/** Галки формата в админке (`BundleTypeAsset.effects`, DI3-15). */
export interface EffectsToggle {
  glow?: boolean;
  fade?: boolean;
}

/** Глобальный киль-свитч: `AI_REF_EFFECTS=off` гасит эффекты без деплоя. */
export function effectsGloballyOff(): boolean {
  return (process.env.AI_REF_EFFECTS ?? "").trim().toLowerCase() === "off";
}

/**
 * Итоговый конфиг формата. Приоритет: ENV-рубильник → галки формата →
 * включено. Поле не задано = включено: эффекты нужны на всех трёх форматах
 * (DI3-4/DI3-7), а существующие записи `BundleType.assets` его не содержат.
 */
export function resolveEffectsConfig(toggle?: EffectsToggle | null): PromoEffectsConfig {
  if (effectsGloballyOff()) return NO_EFFECTS;
  return {
    glow: (toggle?.glow ?? true) ? DEFAULT_GLOW : null,
    fade: (toggle?.fade ?? true) ? DEFAULT_FADE : null,
  };
}

/**
 * Профиль спада — гауссиана `exp(−k·t²)`, разложенная по стопам SVG.
 *
 * Трёх стоп (центр/середина/край) не хватило: на пустом белом фоне излом
 * производной в средней стопе виден как концентрическое кольцо. Шесть стоп по
 * гауссиане дают спад без видимых колец и совпадают по форме с эталонами.
 */
const GLOW_FALLOFF_K = 4;
const GLOW_STOPS = [0, 0.2, 0.4, 0.6, 0.8, 1];

function glowStops(hex: string, peak: number): string {
  return GLOW_STOPS.map((t) => {
    // Край принудительно в ноль: exp(−4) ≈ 0.018 оставил бы видимую кромку
    // эллипса на границе холста.
    const opacity = t >= 1 ? 0 : peak * Math.exp(-GLOW_FALLOFF_K * t * t);
    return `<stop offset="${t}" stop-color="${hex}" stop-opacity="${opacity.toFixed(4)}"/>`;
  }).join("");
}

/**
 * Слой свечения как отдельный RGBA-буфер размером с холст. SVG-градиент через
 * sharp — приём, уже используемый движком композиции (`renderContactShadow`).
 */
export async function renderGlowLayer(
  width: number,
  height: number,
  hex: string,
  config: GlowConfig = DEFAULT_GLOW,
): Promise<Buffer> {
  const cx = config.cxPct * width;
  const cy = config.cyPct * height;
  const rx = Math.max(1, config.rxPct * width);
  const ry = Math.max(1, config.ryPct * height);
  const peak = Math.max(0, Math.min(1, config.peakAlpha));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<defs><radialGradient id="glow">${glowStops(hex, peak)}</radialGradient></defs>` +
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#glow)"/></svg>`;
  return sharp(Buffer.from(svg))
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .png()
    .toBuffer();
}

/**
 * Показатель кривой фейда. Замеры эталонов ложатся на `t³`, а не на `t²`:
 * при квадрате середина полосы держит вдвое больше альфы, чем у дизайнера
 * (0.35 против 0.15 на 90 % высоты), и низ выглядит «подрезанным», а не
 * растворённым.
 */
const FADE_EXPONENT = 3;

/**
 * Кривая гашения альфы по вертикали. `1` выше полосы фейда, `0` строго на
 * последней строке холста. Нелинейная: линейный ramp глаз читает как обрыв —
 * он чувствителен к производной прозрачности у верхней границы полосы, а не
 * к самой прозрачности.
 */
export function fadeFactor(y: number, height: number, config: FadeConfig): number {
  const band = Math.round(Math.max(0, Math.min(1, config.heightPct)) * height);
  if (band < 2) return 1;
  const start = height - band;
  if (y < start) return 1;
  // Нормировка на (band - 1), а не на band: иначе последняя строка холста
  // осталась бы с ненулевой альфой и низ выглядел бы обрезанным.
  const t = 1 - (y - start) / (band - 1);
  const clamped = Math.max(0, Math.min(1, t));
  return Math.pow(clamped, FADE_EXPONENT);
}

/** Умножение альфы на вертикальный ramp (raw-проход, как в `lightLayer`). */
export async function applyBottomFade(
  input: Buffer,
  config: FadeConfig = DEFAULT_FADE,
): Promise<Buffer> {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const out = Buffer.from(data);
  for (let y = 0; y < height; y++) {
    const k = fadeFactor(y, height, config);
    if (k >= 1) continue;
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = rowStart + x * 4 + 3;
      out[i] = Math.round(out[i]! * k);
    }
  }
  return sharp(out, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Полный проход эффектов над вырезанным PNG.
 *
 * Порядок слоёв — требование ТЗ: свечение фоном под объектами, фейд поверх
 * всего. Оба эффекта выключены → возвращается ИСХОДНЫЙ буфер без
 * перекодирования: включение/выключение не должно менять байты зря.
 *
 * Функция чистая относительно входа, поэтому пере-применение всегда идёт от
 * сохранённого «чистого» PNG (`metadata.effects.sourceUrl`), а не от готового
 * результата — иначе свечение легло бы поверх свечения.
 */
export async function applyPromoEffects(
  input: Buffer,
  opts: {
    /** Цвет свечения `#RRGGBB`; отсутствует → слой свечения пропускается. */
    glowHex?: string | null;
    config?: PromoEffectsConfig;
  } = {},
): Promise<Buffer> {
  const config = opts.config ?? DEFAULT_EFFECTS;
  const wantGlow = Boolean(config.glow && opts.glowHex);
  const wantFade = Boolean(config.fade);
  if (!wantGlow && !wantFade) return input;

  let current = input;
  if (wantGlow) {
    const meta = await sharp(input).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width > 0 && height > 0) {
      const glow = await renderGlowLayer(width, height, opts.glowHex!, config.glow!);
      // Свечение — БАЗА композита, объекты кладутся поверх: слой обязан
      // остаться строго под монетами, персонажем и слотами (задание 1).
      current = await sharp(glow)
        .composite([{ input: await sharp(current).ensureAlpha().png().toBuffer(), blend: "over" }])
        .png({ compressionLevel: 9 })
        .toBuffer();
    }
  }
  if (wantFade) {
    current = await applyBottomFade(current, config.fade!);
  }
  return current;
}

/**
 * Средняя относительная яркость зоны, какой её увидит получатель письма:
 * ассет прозрачный, поэтому композитим над белым фоном письма. Нужна для
 * `recommendedTextColor` — свечение садится ровно под заголовок email (R-I1),
 * и вёрстке нужно число, а не обещание, что контраст «в порядке».
 *
 * Зона задаётся долями холста (как `AI_REF_SAFE_ZONE`).
 */
export async function zoneLuminanceOverWhite(
  input: Buffer,
  zone: { x: number; y: number; w: number; h: number },
): Promise<number> {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const x0 = Math.max(0, Math.floor(zone.x * width));
  const y0 = Math.max(0, Math.floor(zone.y * height));
  const x1 = Math.min(width, Math.ceil((zone.x + zone.w) * width));
  const y1 = Math.min(height, Math.ceil((zone.y + zone.h) * height));
  if (x1 <= x0 || y1 <= y0) return 1;

  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3]! / 255;
      // Композит над белым: c = c_src·a + 255·(1−a).
      const r = data[i]! * a + 255 * (1 - a);
      const g = data[i + 1]! * a + 255 * (1 - a);
      const b = data[i + 2]! * a + 255 * (1 - a);
      sum += 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      n++;
    }
  }
  return n > 0 ? sum / n : 1;
}

/** Тёмный текст вёрстки — то же значение, что у движка композиции. */
export const DARK_TEXT = "#111111";
const WHITE_L = 1.0;
const DARK_L = 0.0056; // относительная яркость #111111

function contrastRatio(l1: number, l2: number): number {
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Цвет заголовка, который вёрстка положит поверх свечения (R-I1). Свечение
 * пастельное, поэтому практически всегда выигрывает тёмный текст — но число
 * считается, а не предполагается: сменят `peakAlpha` или цвет — подсказка
 * поедет следом.
 */
export function recommendedTextColorFor(luminance: number): string {
  return contrastRatio(WHITE_L, luminance) >= contrastRatio(DARK_L, luminance)
    ? "#FFFFFF"
    : DARK_TEXT;
}
