import sharp from "sharp";

/**
 * П7 — брендовая 3D-типографика как объект сцены (Задание 2, Фаза 2).
 *
 * `FS`, `SCATTER`, `BIG WIN` присутствуют в 5/5 эталонов и выполнены как
 * объёмные объекты: фаска, металлический градиент, блик, собственная тень,
 * перспектива. Рисуем их САМИ, а не просим у генератора:
 *
 *  - точный текст — модель искажает буквы, а токен приходит из конфига бренда;
 *  - ноль дополнительных вызовов fal;
 *  - побайтовый детерминизм при фиксированной версии sharp.
 *
 * Инструмент — librsvg, который есть в сборке sharp 0.35.3 (проверено в
 * Фазе 0: librsvg 2.62.3, pango 1.57.1, harfbuzz, freetype, fontconfig).
 *
 * ⚠️ Шрифт. librsvg резолвит семейство через fontconfig; на голом контейнере
 * системных шрифтов нет, и текст молча отрисуется чем попало или пустотой.
 * Поэтому семейство задаётся явно, а `assertFontAvailable` проверяет, что
 * запрошенный шрифт реально нашёлся. См. `backend/assets/fonts/README.md` и
 * `scripts/check-fonts.ts`.
 */

type Bytes = Buffer<ArrayBufferLike>;

const PNG_OPTS = { compressionLevel: 9, adaptiveFiltering: false, palette: false } as const;

/** Материал надписи: вертикальный градиент + цвет фаски и обводки. */
export interface TypoMaterial {
  /** Остановки градиента сверху вниз, 3 цвета: блик → тело → тень. */
  stops: [string, string, string];
  /** Цвет фаски/обводки по контуру букв. */
  edge: string;
  /** Цвет собственной тени под объектом. */
  shadow: string;
}

/** Пресеты из эталонов: золото (ex2/ex4/ex5), неон (ex4), глянец (ex1). */
export const TYPO_MATERIALS: Record<string, TypoMaterial> = {
  gold: { stops: ["#FFF3B0", "#E0A526", "#8A5A0B"], edge: "#5A3A05", shadow: "#000000" },
  neon: { stops: ["#FFE3FB", "#FF4FD8", "#7A1B8F"], edge: "#3B0A45", shadow: "#000000" },
  gloss: { stops: ["#FFFFFF", "#BFD9FF", "#3C6DA8"], edge: "#1E3A5C", shadow: "#000000" },
  silver: { stops: ["#FFFFFF", "#C9D2DA", "#6B767F"], edge: "#3A4247", shadow: "#000000" },
};

export const DEFAULT_MATERIAL_KEY = "gold";

/**
 * Семейство по умолчанию. Список, а не одно имя: fontconfig берёт первое
 * доступное, поэтому локальная разработка (Windows/macOS) и контейнер
 * (вендоренный шрифт) работают из одного конфига.
 */
export const DEFAULT_FONT_STACK =
  process.env.TYPO_FONT_STACK ?? "Design Power Display, Arial Black, DejaVu Sans, sans-serif";

export interface RenderTokenOptions {
  /** Текст надписи: FS / SCATTER / BIG WIN / что угодно из конфига бренда. */
  token: string;
  /** Высота КЕГЛЯ в пикселях; итоговый PNG чуть выше за счёт тени и фаски. */
  fontSizePx: number;
  material: TypoMaterial;
  /** Наклон в перспективе, градусы (эталоны: буквы лежат под углом). */
  skewDeg: number;
  /** Поворот всего объекта, градусы. */
  rotateDeg: number;
  bevel: boolean;
  specular: boolean;
  ownShadow: boolean;
  fontStack?: string;
}

export interface RenderedToken {
  png: Bytes;
  width: number;
  height: number;
}

const escapeXml = (s: string): string =>
  s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Обобщённые семейства CSS — их квотировать нельзя, иначе перестанут работать. */
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
]);

/**
 * Приводит стек к валидному CSS: имена с пробелами или цифрами обязаны быть
 * в кавычках, иначе librsvg считает декларацию невалидной и рисует чем угодно
 * — тихо, без ошибки.
 */
export function formatFontStack(stack: string): string {
  return stack
    .split(",")
    .map((raw) => raw.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean)
    .map((name) => (GENERIC_FAMILIES.has(name.toLowerCase()) ? name : `'${name.replace(/'/g, "")}'`))
    .join(", ");
}

/**
 * Собирает SVG надписи. Отдельная функция от рендера — чтобы юнит-тесты могли
 * проверять разметку без вызова libvips, а результат оставался читаемым при
 * отладке (SVG можно открыть в браузере).
 */
export function buildTokenSvg(opts: RenderTokenOptions): string {
  const {
    token,
    fontSizePx: fs,
    material,
    skewDeg,
    rotateDeg,
    bevel,
    specular,
    ownShadow,
  } = opts;
  const fontStack = formatFontStack(opts.fontStack ?? DEFAULT_FONT_STACK);

  // Холст с запасом: наклон, фаска и тень выходят за габарит кегля. Точный
  // bbox всё равно снимет alpha-trim после рендера, так что запас безвреден.
  const approxW = Math.ceil(fs * 0.72 * token.length + fs);
  const w = Math.ceil(approxW * 1.4);
  const h = Math.ceil(fs * 2.2);
  const cx = w / 2;
  const cy = h / 2 + fs * 0.34; // базовая линия ≈ центр по оптике

  const bevelWidth = bevel ? Math.max(2, fs * 0.045) : 0;
  const shadowDy = ownShadow ? Math.max(2, fs * 0.05) : 0;
  const shadowBlur = ownShadow ? Math.max(2, fs * 0.03) : 0;

  const text = (fill: string, extra = "") =>
    `<text x="${cx}" y="${cy}" font-family="${fontStack}" font-size="${fs}" ` +
    `font-weight="900" text-anchor="middle" fill="${fill}" ${extra}>${escapeXml(token)}</text>`;

  const layers: string[] = [];
  // Собственная тень — отдельная копия под объектом (П8 «контактная тень»).
  if (ownShadow) {
    layers.push(
      `<g transform="translate(0 ${shadowDy})" filter="url(#soft)" opacity="0.55">` +
        text(material.shadow) +
        `</g>`,
    );
  }
  // Фаска = толстая обводка тем же контуром ПОД заливкой: даёт объём без 3D.
  if (bevel) {
    layers.push(
      text(material.edge, `stroke="${material.edge}" stroke-width="${bevelWidth * 2}" stroke-linejoin="round"`),
    );
  }
  layers.push(text("url(#body)"));
  // Блик — узкая светлая полоса по верхней трети букв.
  if (specular) {
    layers.push(`<g clip-path="url(#topThird)" opacity="0.55">${text("#FFFFFF")}</g>`);
  }

  // Определения выпускаем только под включённые приёмы: мёртвый clipPath или
  // фильтр с нулевым радиусом librsvg всё равно разбирает, а читать отладочный
  // SVG с ними труднее.
  const defs = [
    `<linearGradient id="body" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0" stop-color="${material.stops[0]}"/>`,
    `<stop offset="0.52" stop-color="${material.stops[1]}"/>`,
    `<stop offset="1" stop-color="${material.stops[2]}"/>`,
    `</linearGradient>`,
  ];
  if (ownShadow) {
    defs.push(
      `<filter id="soft" x="-30%" y="-30%" width="160%" height="160%">`,
      `<feGaussianBlur stdDeviation="${shadowBlur}"/>`,
      `</filter>`,
    );
  }
  if (specular) {
    defs.push(
      `<clipPath id="topThird">`,
      `<rect x="0" y="${cy - fs}" width="${w}" height="${fs * 0.42}"/>`,
      `</clipPath>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<defs>`,
    ...defs,
    `</defs>`,
    // Перспектива = сдвиг + поворот вокруг центра: эталоны кладут буквы «в стол».
    `<g transform="rotate(${rotateDeg} ${cx} ${cy}) skewX(${-skewDeg})" transform-origin="${cx} ${cy}">`,
    ...layers,
    `</g>`,
    `</svg>`,
  ].join("");
}

/**
 * Рендерит надпись в PNG с альфой, обрезанный по фактическому bbox.
 * Детерминировано: SVG строится без случайности, кодек PNG зафиксирован.
 */
export async function renderToken(opts: RenderTokenOptions): Promise<RenderedToken> {
  const svg = buildTokenSvg(opts);
  const raw = await sharp(Buffer.from(svg), { density: 96 })
    .png(PNG_OPTS)
    .toBuffer();
  // Обрезаем прозрачные поля запаса — движку нужен точный bbox, как и у
  // остальных слоёв (тот же контракт, что даёт normalizeLayer).
  const trimmed = await sharp(raw)
    .trim({ threshold: 1 })
    .png(PNG_OPTS)
    .toBuffer({ resolveWithObject: true });
  return { png: trimmed.data, width: trimmed.info.width, height: trimmed.info.height };
}

/**
 * Токены надписей из брифа кампании (поправка заказчика 2026-07-28:
 * «не обязательно BIG WIN — всё зависит от промпта»).
 *
 * Правило намеренно простое и предсказуемое, без модели: берём то, что
 * написано в промпте КАПСОМ. Маркетологи так офферы и пишут — `BIG WIN`,
 * `FREE SPINS`, `CASHBACK`, `100% BONUS`. Автор промпта получает прямой
 * контроль над надписью, а не гадает, что решит эвристика.
 *
 * Пусто → вызывающий берёт токены из спеки (или пропускает слот, если тот
 * помечен `tokensSource: "campaign"`).
 *
 * Умный подбор токена под оффер — задача прослойки «казино-дизайнера»
 * (DECISIONS DV-E1), она идёт отдельным треком после Фазы 4.
 */
export function deriveTokens(campaignPrompt: string, max = 3): string[] {
  // Разбор пословный, а не одной регуляркой: `\b` в JS работает по ASCII и
  // молча не видит кириллицу — «НОВОГОДНИЙ ДЖЕКПОТ» не находился вовсе.
  const chunks = campaignPrompt.split(/\s+/u).filter(Boolean);
  const isShouty = (w: string): boolean => {
    if (/\p{Ll}/u.test(w)) return false; // есть строчная — не капс
    return /[\p{Lu}\p{N}]/u.test(w);
  };

  // Соседние «кричащие» слова склеиваются в одну надпись: `FREE SPINS`,
  // `CASHBACK 20%` — это один токен, а не два. Но знак препинания группу
  // ЗАКРЫВАЕТ: «CASHBACK, FREE SPINS» — это два разных оффера, а не один.
  const groups: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) groups.push(current.join(" "));
    current = [];
  };
  for (const chunk of chunks) {
    const word = chunk.replace(/^[(["'«]+/u, "").replace(/[,.;:!?)\]"'»—–]+$/u, "");
    const closes = word.length !== chunk.length && /[,.;:!?)\]"'»—–]$/u.test(chunk);
    if (word && isShouty(word)) {
      current.push(word);
      if (closes) flush();
    } else {
      flush();
    }
  }
  flush();

  const out: string[] = [];
  for (const group of groups) {
    // Нужна хотя бы одна ЗАГЛАВНАЯ буква: иначе в токены попадают голые
    // числа вроде года из «promo 2026».
    if (!/\p{Lu}/u.test(group)) continue;

    // Длинную фразу не выбрасываем, а укорачиваем по целым словам: кампания
    // надпись просила, и разумнее показать её начало, чем ничего. Эталоны
    // держатся в пределах `BIG WIN` / `SCATTER` — после ужатия под ширину
    // полосы более длинное всё равно станет нечитаемым.
    let token = group;
    if (token.length > MAX_TOKEN_CHARS) {
      const parts = group.split(" ");
      token = "";
      for (const part of parts) {
        const next = token ? `${token} ${part}` : part;
        if (next.length > MAX_TOKEN_CHARS) break;
        token = next;
      }
    }

    const alnum = token.replace(/[^\p{Lu}\p{N}]/gu, "");
    if (alnum.length < 2) continue; // обрывок, а не надпись
    if (out.some((t) => t.toUpperCase() === token.toUpperCase())) continue;
    out.push(token);
    if (out.length >= max) break;
  }
  return out;
}

/** Потолок длины надписи: длиннее не читается после фита в свою полосу. */
export const MAX_TOKEN_CHARS = 14;

/** Материал по ключу из спеки; неизвестный ключ → золото, а не падение. */
export function resolveMaterial(key: string | undefined): TypoMaterial {
  if (key) {
    const direct = TYPO_MATERIALS[key];
    if (direct) return direct;
    // Спека хранит ссылку вида "brand.typo_material" — берём хвост после точки.
    const tail = key.split(".").pop();
    if (tail && TYPO_MATERIALS[tail]) return TYPO_MATERIALS[tail]!;
  }
  return TYPO_MATERIALS[DEFAULT_MATERIAL_KEY]!;
}

const PROBE_BASE = {
  fontSizePx: 96,
  material: TYPO_MATERIALS[DEFAULT_MATERIAL_KEY]!,
  skewDeg: 0,
  rotateDeg: 0,
  bevel: false,
  specular: false,
  ownShadow: false,
} as const;

/**
 * Заведомо несуществующее семейство — контроль для детекта подстановки.
 * Без цифр намеренно: имя с цифрой — невалидный CSS-идентификатор, librsvg
 * выбрасывает всю декларацию и рисует ДРУГИМ шрифтом, из-за чего контроль
 * «отличается» всегда и проверка молча вырождается в бессмыслицу.
 */
const NONSENSE_FAMILY = "Nonexistent Control Face";

/**
 * Жёсткая проверка: текст вообще рисуется. Ловит катастрофу «librsvg отдал
 * пустой растр», когда шрифтов в контейнере нет ни одного.
 *
 * ⚠️ Она НЕ отвечает на вопрос «нашёлся ли именно запрошенный шрифт»:
 * fontconfig на любое неизвестное имя молча подставляет замену, и рендер
 * получается непустым. Для этого есть `detectFontSubstitution`.
 *
 * Зовётся на старте воркера и из `scripts/check-fonts.ts`.
 */
export async function assertFontAvailable(
  fontStack = DEFAULT_FONT_STACK,
): Promise<{ ok: boolean; reason: string }> {
  try {
    const narrow = await renderToken({ ...PROBE_BASE, token: "I", fontStack });
    const wide = await renderToken({ ...PROBE_BASE, token: "MMMMMM", fontStack });
    if (narrow.width < 4 || narrow.height < 4) {
      return { ok: false, reason: `"${fontStack}" rendered nothing (empty raster)` };
    }
    if (wide.width <= narrow.width * 2) {
      return {
        ok: false,
        reason:
          `"${fontStack}" looks unresolved: "MMMMMM" is ${wide.width}px vs "I" ${narrow.width}px ` +
          `— glyphs are not being laid out`,
      };
    }
    return { ok: true, reason: `renders (I=${narrow.width}px, MMMMMM=${wide.width}px)` };
  } catch (err) {
    return { ok: false, reason: `render failed: ${err instanceof Error ? err.message : err}` };
  }
}

/**
 * Нашёлся ли ИМЕННО запрошенный шрифт, или fontconfig подставил замену.
 *
 * Метод: рисуем один токен запрошенным семейством и заведомо несуществующим.
 * Совпали байт в байт → запрошенное семейство отсутствует, обе строки ушли в
 * один и тот же fallback.
 *
 * Оговорка: если `config/fonts.conf` алиасит `sans-serif` на вендоренный
 * шрифт, контроль тоже отрисуется им — результат будет «substituted», хотя
 * рендер правильный. Поэтому это диагностика для отчёта, а не гейт деплоя;
 * гейтом остаётся `assertFontAvailable`.
 */
export async function detectFontSubstitution(
  family: string,
): Promise<{ substituted: boolean; reason: string }> {
  try {
    const asked = await renderToken({ ...PROBE_BASE, token: "Rgh8", fontStack: family });
    const control = await renderToken({ ...PROBE_BASE, token: "Rgh8", fontStack: NONSENSE_FAMILY });
    const same = asked.png.equals(control.png);
    return {
      substituted: same,
      reason: same
        ? `совпало с рендером несуществующего семейства — fontconfig подставил замену`
        : `отличается от fallback (${asked.width}×${asked.height} px) — семейство реально найдено`,
    };
  } catch (err) {
    return {
      substituted: true,
      reason: `проверка не удалась: ${err instanceof Error ? err.message : err}`,
    };
  }
}
