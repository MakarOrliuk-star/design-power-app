import { mulberry32, seedToInt } from "../lib/composeEngine.js";
import { METHOD, type Corridor, type PatternSpec } from "../lib/patternMiner.js";
import type { CreativeBrief } from "../lib/creativeBrief.js";
import { resolveDecorChain, type DecorEntry, type DecorSource } from "../lib/decorLibrary.js";

/**
 * Scene Planner — Задание 3, Фаза 2. `creative-brief + pattern-spec + seed`
 * превращается в план кадра.
 *
 * Планировщик ДЕТЕРМИНИРОВАН: одна и та же тройка входов и один seed дают
 * побайтово один и тот же план. Разнообразие между брендами берётся из
 * вариации seed и палитры, а не из случайности в рантайме (`D-N5`).
 *
 * Здесь нет ни одной магической константы. Каждое число либо приходит из
 * брифа, либо сэмплируется из коридора `pattern-spec`, добытого майнером из
 * корпуса эталонов (`D-C1`). Границы зон — из `METHOD.zones` (§3.4, `D-C5`).
 *
 * Модель на этом шаге не участвует: `D-E4'` требует, чтобы позицию определяла
 * спека, а не нейросеть.
 */

export type { DecorSource };

export interface SlotPlan {
  id: string;
  zone: "hero-left" | "hero-right" | "scene-top" | "text-core" | "scene-bottom";
  source: string;
  optional: boolean;
  /** Концепты для отбора декора; пусто → любой доступный. */
  concepts?: string[];
  count?: number;
  targetCoveragePct?: number;
  clusterHeightPct?: number;
  headTopPct?: number;
  areaPct?: number;
  cx?: number;
  cropEdge?: "top";
  blurPx?: number;
  opacity?: number;
  text?: string;
  placement?: "overlap-item" | "beside-person" | "in-hands";
}

export interface ScenePlan {
  patternSpecVersion: string;
  patternCorpusHash: string;
  seed: string;
  canvas: { w: number; h: number };
  /** Низ контента, % высоты (V10): к нему прибиты item и person, ниже него
   *  не опускается декор. Касание нижней кромки запрещено (`D-C4`). */
  baselineYPct: number;
  /** Минимальный размер куска декора, % холста — низ коридора медианы. */
  decorMinPieceAreaPct: number;
  background: {
    type: "generated-light";
    lightPrompt: string;
    /** Альфа слоя света выводится из яркости (`D-N6`). */
    alphaFrom: "luminance";
    peakYPct: number;
    targetCornerLum: [number, number];
    targetCenterLum: [number, number];
  };
  /** Цепочка источников декора; первый доступный выигрывает (`D-N7'`). */
  decorSourceChain: DecorSource[];
  /** Концепты, которых нет в библиотеке — их придётся сгенерировать. */
  conceptsToGenerate: string[];
  slots: SlotPlan[];
  colorKey: { maxHues: number; paletteHint: string | null };
  textOverlay: {
    safeZone: { x: number; y: number; w: number; h: number };
    lines: string[];
    cta: string | null;
  };
}

export interface ScenePlanInput {
  brief: CreativeBrief;
  patternSpec: PatternSpec;
  /** Детерминированный ключ: `hash(bundleId, brandVariant, assetType)`. */
  seed: string;
  canvas: { w: number; h: number };
  /** Библиотека декора БРЕНДА (`D-N7'` шаг 1); непустая перекрывает общую. */
  brandDecor?: DecorEntry[];
  /** Общая библиотека (`D-N7'` шаг 2). Обе пусты — план всё равно исполним. */
  commonDecor?: DecorEntry[];
}

// ---------------------------------------------------------------------------
// Сэмплирование из коридоров
// ---------------------------------------------------------------------------

/**
 * Значение из коридора по seed.
 *
 * Берётся отрезок [min, max] — ГОЛЫЕ границы корпуса, без допуска §4.1.
 * Это осознанно: допуск существует для ПРИЁМКИ, чтобы эталон, задающий
 * границу, не падал на округлении. Генерировать по расширенным границам
 * значило бы целиться ровно в ту зону, где кадр уже хуже любого эталона.
 * Итог — генерация метит в узкую полосу, а валидатор принимает чуть шире.
 */
export function sampleCorridor(c: Corridor, rand: () => number): number {
  if (c.max <= c.min) return c.min;
  return c.min + rand() * (c.max - c.min);
}

export function sampleCorridorInt(c: Corridor, rand: () => number): number {
  return Math.round(sampleCorridor(c, rand));
}

function corridorOf(spec: PatternSpec, key: string): Corridor {
  const c = spec.corridors[key];
  if (!c) throw new Error(`scene-plan: в pattern-spec нет коридора "${key}"`);
  return c;
}

// ---------------------------------------------------------------------------
// Промпт слоя света (шаг [3] PROMPT-CONTRACT §4)
// ---------------------------------------------------------------------------

/**
 * Собирается КОДОМ из полей брифа. Заменяет прежний `backgroundPrompt()`,
 * который рисовал «почти пустую светлую студийную стену» — прямо
 * противоположное эталонам с их тёмным фоном и радиальным свечением.
 *
 * Негативная часть намеренно избыточна: «no objects» модели соблюдают
 * ненадёжно, а каждый нарисованный здесь объект — дефект, потому что кейинг
 * `alpha = f(яркость)` сделает из него полупрозрачный призрак.
 */
export function buildLightPrompt(brief: CreativeBrief, peakYPct: number): string {
  return [
    "Abstract cinematic lighting backdrop for a promo banner.",
    brief.lightMood ? `${brief.lightMood}.` : "",
    brief.paletteHint ? `Colour: ${brief.paletteHint}.` : "",
    brief.season ? `Seasonal atmosphere: ${brief.season}, as light and haze only.` : "",
    `Soft radial glow centred at ${Math.round(peakYPct)}% from the top,`,
    "falling off to PURE BLACK at all four corners.",
    "Volumetric haze, subtle bokeh, lens bloom, fine film grain.",
    "ABSOLUTELY NO objects, no characters, no animals, no coins, no text,",
    "no letters, no numbers, no logos, no borders, no frame.",
    "Pure atmosphere and light only.",
  ]
    .filter(Boolean)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Планировщик
// ---------------------------------------------------------------------------

export function buildScenePlan(input: ScenePlanInput): ScenePlan {
  const { brief, patternSpec: spec, seed, canvas } = input;
  const rand = mulberry32(seedToInt(seed));

  // Порядок обращений к `rand` — часть контракта детерминизма: любая
  // перестановка сэмплов меняет ВСЕ последующие числа при том же seed.
  const peakYPct = 50 + rand() * 10;
  const baseline = sampleCorridor(corridorOf(spec, "contentBottomPct"), rand);
  // «Подрезан верхом» (V9) — привилегия focal-объекта. Герои держат зазор от
  // верхней кромки больше порога касания майнера (2× запас), иначе item или
  // макушка персонажа засчитываются крупнейшим top-cropped компонентом и
  // валидатор меряет ИХ вместо focal.
  const topClearPct = METHOD.edgeTouchFraction * 100 * 2;
  const itemHeight = Math.min(
    baseline - topClearPct,
    sampleCorridor(corridorOf(spec, "itemClusterHeightPct"), rand),
  );
  const personTop = Math.max(
    topClearPct,
    sampleCorridor(corridorOf(spec, "personTopPct"), rand),
  );
  // Высота персонажа — ПРОИЗВОДНАЯ, а не сэмпл: низ прибит к baseline (V10),
  // макушка — к personTop, и третий независимый сэмпл на две степени свободы
  // давал бы планы, которые геометрически невозможно исполнить. Производная
  // зажимается в свой коридор, макушка при этом отступает от сэмпла.
  const personCorr = corridorOf(spec, "personClusterHeightPct");
  const personHeight = Math.min(personCorr.max, Math.max(personCorr.min, baseline - personTop));
  const personTopFinal = baseline - personHeight;
  // Band-метрика focal-объекта: замер шумит на ореолах и кропе, и сэмпл
  // вплотную к границе коридора вылетает за неё на измерении (живой прогон:
  // 2.51 при потолке 2.46). Целимся в СРЕДНЮЮ половину коридора — та же
  // логика D-N21, применённая к двустороннему коридору.
  const focalCorr = corridorOf(spec, "croppedTopLargestAreaPct");
  const focalQuarter = (focalCorr.max - focalCorr.min) / 4;
  const focalArea = sampleCorridor(
    { ...focalCorr, min: focalCorr.min + focalQuarter, max: focalCorr.max - focalQuarter },
    rand,
  );
  const focalCx = sampleCorridor(corridorOf(spec, "croppedTopLargestCx"), rand);
  // Floor-метрики — зеркало правила ceiling: дефект у заполненности только
  // СНИЗУ, и целиться в нижнюю границу значит целиться в дефект. Сэмпл из
  // верхней половины коридора; приёмка — по полному коридору §4.1.
  const topCorr = corridorOf(spec, "bandTopThird");
  const topCoverage = sampleCorridor({ ...topCorr, min: (topCorr.min + topCorr.max) / 2 }, rand);
  const bottomCorr = corridorOf(spec, "bandBottomThird");
  const bottomCoverage = sampleCorridor(
    { ...bottomCorr, min: (bottomCorr.min + bottomCorr.max) / 2 },
    rand,
  );
  // Уточнение D-N14 для ceiling-метрик: у text-core дефект только СВЕРХУ,
  // и целиться в верхнюю границу коридора значит целиться в дефект — сэмпл
  // берётся из нижней половины, приёмка остаётся по полному коридору §4.1.
  const coreCorr = corridorOf(spec, "bandMidThird");
  const coreCoverage = sampleCorridor(
    { ...coreCorr, max: (coreCorr.min + coreCorr.max) / 2 },
    rand,
  );
  const totalDecor = sampleCorridorInt(corridorOf(spec, "decorCount"), rand);

  const cornerLum = corridorOf(spec, "cornerLum");
  const centerLum = corridorOf(spec, "centerBgLum");
  const hues = corridorOf(spec, "dominantHues");
  // Нижняя граница размера куска декора — СЕРЕДИНА коридора медианы корпуса,
  // а не его нижняя граница: медиана меряется по всем компонентам маски, и у
  // живого арта часть кусков рассыпается на фрагменты — они и тянут медиану
  // вниз. Куски, целящиеся в центр коридора, оставляют фрагментам запас
  // (живой прогон: медиана 0.06–0.08 при поле 0.14 и цели на min).
  const medianCorr = corridorOf(spec, "decorMedianAreaPct");
  const decorMinPieceAreaPct = (medianCorr.min + medianCorr.max) / 2;

  // Из общего числа объектов один уходит на размытый объект, подрезанный
  // верхом (приём 5/5), один — на расфокусированную ambience в text-core.
  // Остальное делится между верхом и низом пропорционально их покрытию:
  // сцена сверху плотнее, и это свойство корпуса, а не наша выдумка.
  const rest = Math.max(2, totalDecor - 2);
  const topShare = topCoverage / Math.max(0.001, topCoverage + bottomCoverage);
  const decorTop = Math.max(1, Math.round(rest * topShare));
  const decorBottom = Math.max(1, rest - decorTop);

  const wanted = brief.decorConcepts;
  // Цепочка источников (`D-N7'`) — тем же кодом, каким её разрешает рендер
  // (`resolveDecorChain`): план декларирует ровно то, что будет исполнено,
  // и они не могут разъехаться — то же правило, что `D-C2` у валидатора.
  const decorChain = resolveDecorChain({
    brandEntries: input.brandDecor ?? [],
    commonEntries: input.commonDecor ?? [],
    concepts: wanted,
  });

  const [leftCaption, heldCaption] = brief.captions;

  const slots: SlotPlan[] = [
    {
      id: "hero-item",
      zone: "hero-left",
      source: "pipeline:item",
      optional: false,
      clusterHeightPct: round2(itemHeight),
    },
  ];

  // Опциональный второй объект hero-left. Есть надпись из брифа — ставим её;
  // нет — зона добирается декором до той же целевой высоты. Пустой слот НЕ
  // является браком (`D-C8`, ответ на вопрос 8), но одинокий предмет не
  // добирает зону — ровно это и дало 62 % вместо 84–91 % у `result-2`.
  if (leftCaption) {
    slots.push({
      id: "left-fill",
      zone: "hero-left",
      source: "typo3d",
      optional: true,
      text: leftCaption,
      placement: "overlap-item",
      clusterHeightPct: round2(itemHeight),
    });
  } else {
    slots.push({
      id: "left-fill-decor",
      zone: "hero-left",
      source: "decor",
      optional: true,
      concepts: wanted,
      count: 3,
      clusterHeightPct: round2(itemHeight),
    });
  }

  slots.push({
    id: "hero-person",
    zone: "hero-right",
    source: "pipeline:person",
    optional: false,
    clusterHeightPct: round2(personHeight),
    headTopPct: round2(personTopFinal),
  });

  // П6 в редакции DV-C4′: табличку рисуем сами и ставим РЯДОМ с персонажем.
  // Просить объект «в руки» у генератора нельзя — слой персонажа общий на все
  // три ассета, а у части брендов персонаж животное без рук.
  if (heldCaption) {
    slots.push({
      id: "held",
      zone: "hero-right",
      source: "typo3d",
      optional: true,
      text: heldCaption,
      placement: "beside-person",
    });
  }

  slots.push(
    {
      id: "focal-blur",
      zone: "scene-top",
      source: "decor",
      optional: false,
      concepts: wanted.slice(0, 1),
      count: 1,
      areaPct: round2(focalArea),
      cx: round2(focalCx),
      cropEdge: "top",
      blurPx: 14,
    },
    {
      id: "decor-top",
      zone: "scene-top",
      source: "decor",
      optional: false,
      concepts: wanted,
      count: decorTop,
      targetCoveragePct: round2(topCoverage),
    },
    {
      id: "decor-bottom",
      zone: "scene-bottom",
      source: "decor",
      optional: false,
      concepts: wanted,
      count: decorBottom,
      targetCoveragePct: round2(bottomCoverage),
    },
    {
      id: "ambience",
      zone: "text-core",
      source: "decor",
      optional: false,
      concepts: wanted,
      count: 1,
      targetCoveragePct: round2(coreCoverage),
      blurPx: 10,
      opacity: 0.5,
    },
  );

  const z = METHOD.zones;
  const lines = [brief.offer.headline, brief.offer.amount, ...brief.offer.extras].filter(
    (l): l is string => Boolean(l),
  );

  return {
    patternSpecVersion: spec.specVersion,
    patternCorpusHash: spec.corpusHash,
    seed,
    canvas,
    baselineYPct: round2(baseline),
    decorMinPieceAreaPct: round2(decorMinPieceAreaPct),
    background: {
      type: "generated-light",
      lightPrompt: buildLightPrompt(brief, peakYPct),
      alphaFrom: "luminance",
      peakYPct: round2(peakYPct),
      targetCornerLum: [round2(cornerLum.min), round2(cornerLum.max)],
      targetCenterLum: [round2(centerLum.min), round2(centerLum.max)],
    },
    decorSourceChain: decorChain.steps,
    conceptsToGenerate: decorChain.conceptsToGenerate,
    slots,
    colorKey: { maxHues: Math.round(hues.max), paletteHint: brief.paletteHint },
    textOverlay: {
      safeZone: {
        x: z.central.x0,
        y: z.textCore.y0,
        w: z.central.x1 - z.central.x0,
        h: z.textCore.y1 - z.textCore.y0,
      },
      lines,
      cta: brief.offer.cta,
    },
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
