import sharp from "sharp";

/**
 * Стадия C: техническая валидация AI-композиции (TASK ai-reference).
 *
 * Детерминированные проверки без нейронок. Валидатор Заданий 1–3
 * (assetValidator.ts) не подходит: его коридоры/SSIM заточены под
 * детерминированную послойную компоновку и требуют alpha-маску оверлеев,
 * которой у цельной AI-композиции нет. Здесь проверяется только то, что
 * осмысленно для «цельного» кадра: точный размер, резкость, отсутствие
 * рамок/леттербокса.
 */

export interface AiTechCheck {
  key: "size" | "sharpness" | "borders" | "center" | "sides";
  passed: boolean;
  detail: string;
}

/** Зона канваса в долях [0..1] — для проверки «чистого центра». */
export interface FractionZone {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AiTechReport {
  passed: boolean;
  checks: AiTechCheck[];
  /**
   * Доля почти-белых пикселей в зоне чистого центра (0..1); отсутствует, если
   * чек не выполнялся. Нужна пайплайну, чтобы при провале ВСЕХ попыток выбрать
   * наименее испорченный кадр и отдать его на auto-healing, а не ронять ассет.
   */
  centerRatio?: number;
}

/**
 * Порог дисперсии лапласиана на грейскейле 0..255. Калибровка по порядку
 * величин: резкие рекламные рендеры дают сотни, мыло — единицы. 25 —
 * консервативный нижний гейт (ловим откровенный брак фокуса, не «мягкий свет»).
 */
export const SHARPNESS_MIN_VARIANCE = 25;

/** Анализ резкости на уменьшенной копии: дешевле, а мыло остаётся мылом. */
const SHARPNESS_PROBE_WIDTH = 600;

/** Толщина краевой полосы для детекта рамок, px исходного размера. */
const BORDER_STRIP = 4;

/**
 * Полоса считается «рамкой», если она почти однотонная и почти ЧЁРНАЯ.
 * Белые края — норма: контракт A-2 требует чисто-белый фон под вырезание,
 * поэтому светлые монотонные полосы больше не считаются леттербоксом.
 */
const BORDER_STD_MAX = 3;
const BORDER_DARK_MEAN = 10;

/**
 * «Чистый центр» (A-3, по email mask дизайнера): на белом фоне центральная
 * текстовая зона обязана оставаться белой — любой пропс/монетка в ней ловится
 * детерминированно, без VLM. Пиксель считается фоном при люме >= порога
 * (допуск на jpeg-артефакты и лёгкое свечение). Порог доли белого 0.95:
 * лёгкое залезание item сбоку принято Пользователем как допустимое (A-5/A-6).
 * Чек только судит попытку (ретрай/best-of) — кадр banana НЕ модифицируется.
 */
export const CENTER_BG_MIN_LUMA = 235;

/**
 * Минимальная заполненность боковых третей для push/pop-up (правка
 * 2026-08-13: «иногда не генерирует предметы», «в одном бренде в push есть
 * предметы, во втором нет»). Замеры эталонов дизайнера (доля не-белых
 * пикселей в трети): push1 24.6/49.4, push2 35.3/46.5, pop-up ok1 21.8/27.4,
 * pop-up ok2 30.4/35.2. Порог 12 % берёт худший эталон почти вдвое с запасом —
 * чек ловит именно ПУСТОЙ бок (герой в центре и белые поля), а не «чуть
 * скромнее эталона».
 *
 * Проверка детерминированная и бесплатная, поэтому она надёжнее промпта и
 * VLM: провал уводит попытку в ретрай, а исчерпание ретраев — в auto-healing.
 */
export const SIDE_FILL_MIN_RATIO = 0.12;
export const CENTER_CLEAR_MIN_RATIO = 0.95;

/** Дисперсия лапласиана (4-соседний) по грейскейл-байтам. */
export function laplacianVariance(gray: Uint8Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v =
        4 * gray[i]! - gray[i - 1]! - gray[i + 1]! - gray[i - width]! - gray[i + width]!;
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

function meanStd(values: Uint8Array): { mean: number; std: number } {
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let sq = 0;
  for (const v of values) sq += (v - mean) * (v - mean);
  return { mean, std: Math.sqrt(sq / values.length) };
}

/** Срез краевой полосы из грейскейл-буфера. */
function edgeStrip(
  gray: Uint8Array,
  width: number,
  height: number,
  side: "top" | "bottom" | "left" | "right",
  strip: number,
): Uint8Array {
  const out: number[] = [];
  if (side === "top" || side === "bottom") {
    const y0 = side === "top" ? 0 : height - strip;
    for (let y = y0; y < y0 + strip; y++)
      for (let x = 0; x < width; x++) out.push(gray[y * width + x]!);
  } else {
    const x0 = side === "left" ? 0 : width - strip;
    for (let y = 0; y < height; y++)
      for (let x = x0; x < x0 + strip; x++) out.push(gray[y * width + x]!);
  }
  return Uint8Array.from(out);
}

/**
 * Полный отчёт стадии C по байтам сохранённого ассета.
 * Ошибка чтения буфера = непройденный size-чек, не исключение: логический брак
 * не должен ронять джобу (домашний паттерн процессора).
 */
export async function validateAiAsset(
  buffer: Buffer,
  targetW: number,
  targetH: number,
  opts?: {
    /** Зона, обязанная быть чисто-белой (доли канваса); без неё чек не выполняется. */
    centerClearZone?: FractionZone;
    /**
     * Минимальная доля не-белых пикселей в каждой боковой трети (0..1); без
     * неё чек не выполняется. Ставится только зависимым форматам — у email
     * своя раскладка, там боковые секции сторожит приёмщик.
     */
    minSideFill?: number;
  },
): Promise<AiTechReport> {
  const checks: AiTechCheck[] = [];
  let centerRatio: number | undefined;

  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    meta = await sharp(buffer).metadata();
  } catch (err) {
    return {
      passed: false,
      checks: [
        { key: "size", passed: false, detail: `файл не читается: ${err instanceof Error ? err.message : String(err)}` },
      ],
    };
  }

  const sizeOk = meta.width === targetW && meta.height === targetH;
  checks.push({
    key: "size",
    passed: sizeOk,
    detail: sizeOk
      ? `${targetW}×${targetH}`
      : `получено ${meta.width ?? "?"}×${meta.height ?? "?"}, нужно ${targetW}×${targetH}`,
  });

  // Грейскейл для резкости и рамок. flatten: альфы у композиции быть не должно,
  // но если есть — меряем по видимому кадру, а не по нулям под прозрачностью.
  const probe = await sharp(buffer)
    .flatten({ background: "#808080" })
    .resize({ width: SHARPNESS_PROBE_WIDTH, withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const gray = new Uint8Array(probe.data.buffer, probe.data.byteOffset, probe.data.length);
  const { width: pw, height: ph } = probe.info;

  const variance = laplacianVariance(gray, pw, ph);
  const sharpOk = variance >= SHARPNESS_MIN_VARIANCE;
  checks.push({
    key: "sharpness",
    passed: sharpOk,
    detail: `laplacian variance ${Math.round(variance)} (порог ${SHARPNESS_MIN_VARIANCE})`,
  });

  // Рамки/леттербокс: почти однотонная ЧЁРНАЯ полоса на ПАРЕ противоположных
  // краёв — типичный леттербокс от модели. Белые монотонные края легальны
  // (контракт A-2: чисто-белый фон под вырезание removeBg).
  const stripPx = Math.max(2, Math.round((BORDER_STRIP * pw) / Math.max(targetW, 1)));
  const flat = (side: "top" | "bottom" | "left" | "right") => {
    const { mean, std } = meanStd(edgeStrip(gray, pw, ph, side, stripPx));
    return std <= BORDER_STD_MAX && mean <= BORDER_DARK_MEAN;
  };
  const letterboxed = (flat("top") && flat("bottom")) || (flat("left") && flat("right"));
  checks.push({
    key: "borders",
    passed: !letterboxed,
    detail: letterboxed ? "тёмные рамки/леттербокс по противоположным краям" : "чисто",
  });

  // Чистый центр (A-3): доля почти-белых пикселей в переданной зоне.
  if (opts?.centerClearZone) {
    const z = opts.centerClearZone;
    const x0 = Math.max(0, Math.floor(z.x * pw));
    const y0 = Math.max(0, Math.floor(z.y * ph));
    const x1 = Math.min(pw, Math.ceil((z.x + z.w) * pw));
    const y1 = Math.min(ph, Math.ceil((z.y + z.h) * ph));
    let bg = 0;
    let total = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        if (gray[y * pw + x]! >= CENTER_BG_MIN_LUMA) bg++;
        total++;
      }
    const ratio = total > 0 ? bg / total : 1;
    const centerOk = ratio >= CENTER_CLEAR_MIN_RATIO;
    checks.push({
      key: "center",
      passed: centerOk,
      detail: `чистая зона: ${Math.round(ratio * 100)}% белого (порог ${Math.round(CENTER_CLEAR_MIN_RATIO * 100)}%)`,
    });
    centerRatio = ratio;
  }

  // Заполненность боков (зависимые форматы): герой занимает центр, предметы
  // обязаны жить по краям — именно их отсутствие заказчик видит как «пусто».
  if (opts?.minSideFill !== undefined) {
    const third = Math.max(1, Math.floor(pw / 3));
    const sideFill = (x0: number, x1: number) => {
      let ink = 0;
      let total = 0;
      for (let y = 0; y < ph; y++)
        for (let x = x0; x < x1; x++) {
          if (gray[y * pw + x]! < CENTER_BG_MIN_LUMA) ink++;
          total++;
        }
      return total > 0 ? ink / total : 0;
    };
    const left = sideFill(0, third);
    const right = sideFill(pw - third, pw);
    const worst = Math.min(left, right);
    const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;
    checks.push({
      key: "sides",
      passed: worst >= opts.minSideFill,
      detail: `предметы по краям: слева ${pct(left)}, справа ${pct(right)} (минимум ${pct(opts.minSideFill)})`,
    });
  }

  return {
    passed: checks.every((c) => c.passed),
    checks,
    ...(centerRatio !== undefined ? { centerRatio } : {}),
  };
}
