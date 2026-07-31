import sharp from "sharp";
import type { OverlayOptions } from "sharp";
import { mulberry32, seedToInt, dominantColor, tintToKey } from "./composeEngine.js";
import { cropLayerTop } from "./layerNormalize.js";
import { lightCornerLuminance } from "./lightLayer.js";
import { METHOD } from "./patternMiner.js";
import type { ScenePlan, SlotPlan } from "../services/scenePlan.js";

/**
 * Scene Renderer — Задание 3, Фаза 4. `scene-plan + слои → кадр`.
 *
 * Исполняет план буквально: каждое число берётся из плана (а туда попало из
 * коридоров добытой спеки либо из брифа), границы зон — из `METHOD.zones`
 * майнера. Магических констант раскладки здесь нет; немногие инженерные
 * константы (зазор слипания, доля кропа focal) прокомментированы по месту —
 * они про механику сборки, не про паттерн.
 *
 * Детерминизм (`D-E4'`): один план и одни байты слоёв → побайтово один кадр.
 * Собственный rand-поток (`seed + ":render"`) не пересекается с потоком
 * планировщика — пересев раскладки не трогает план, и наоборот.
 *
 * Порядок слоёв (три слоя альфы, `D-N6`): свет (кейнутая альфа) → focal-blur
 * за верхней кромкой → декор дальнего/ближнего плана → добор hero-left →
 * item → person. Глубина честная: разброс резкости делается настоящим блюром
 * дальнего плана, а не постфактум-фильтром.
 */

export interface RenderLayer {
  png: Buffer;
  width: number;
  height: number;
}

export interface SceneRenderInputs {
  person: RenderLayer;
  item: RenderLayer;
  /** Кейнутый слой света (`lightLayer.ts`); null — сцена без света (тесты). */
  light?: Buffer | null;
  /** Нормализованные куски декора, крупные первыми (порядок листа/библиотеки). */
  decor: RenderLayer[];
  /**
   * Поясной кроп персонажа — доля высоты слоя сверху. Значение приходит из
   * СПЕКИ (`EMAIL_HERO_V3.subjects.person.cropTopFraction` = 0.55), рендерер
   * его не выбирает. undefined/1 — слой уже поясной, не резать.
   */
  personCropTopFraction?: number;
}

export interface PlacedBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  blurPx: number;
}

export interface SceneRenderResult {
  png: Buffer;
  width: number;
  height: number;
  placed: PlacedBox[];
}

/**
 * Структурные коридоры — предмет рендерера, один список для тестов и живого
 * прогона. Без метрик файла-с-альфой (`transparentPct` — V2 неприменим к
 * файлу, ответ β на вопрос 0). Цветовой ключ (`dominantHues`, V14) проверяется:
 * декор перекрашивается под палитру героев (П8). Свет (`cornerLum`/
 * `centerBgLum`) проверяется отдельно, когда слой света настоящий.
 */
export const STRUCTURAL_CHECK_KEYS = [
  "dominantHues",
  "bandCoverage",
  "bandTopThird",
  "bandMidThird",
  "bandBottomThird",
  "componentCount",
  "decorCount",
  "decorAreaPct",
  "decorMedianAreaPct",
  "sharpnessSpread",
  "croppedTop",
  "croppedTopLargestAreaPct",
  "croppedTopLargestCx",
  "croppedLeft",
  "croppedRight",
  "croppedBottom",
  "contentBottomPct",
  "itemClusterHeightPct",
  "personClusterHeightPct",
  "personTopPct",
];

/**
 * Зазор между декор-объектами, px @1x. Склеивает не только `MORPH_CLOSE` 5×5:
 * полупрозрачные ореолы рисованных кусков (блики, хвосты) поверх слоя света
 * пробивают порог маски и наводят мосты ЗА пределами bbox. Зазор кроет и
 * морфологию, и типичный ореол.
 */
const MERGE_GAP = 24;
/** Попыток посадить объект без пересечений, прежде чем принять как есть. */
const PLACE_TRIES = 24;
/**
 * Доля focal-объекта, уводимая ЗА верхнюю кромку (V9 «подрезан верхом»).
 * Треть — как у эталонов: объект читается, но явно срезан.
 */
const FOCAL_CROP = 0.35;
/**
 * Цикл блюра декора, px: большинство объектов резкие (ближний план), каждый
 * третий-четвёртый размыт (дальний план). Это источник разброса резкости
 * ≥ 10× (V8) — настоящая глубина, а не одинаково-острые вырезки result-2.
 * Потолок цикла ниже блюра focal-объекта: тот остаётся самым размытым (V9).
 */
const BLUR_CYCLE = [0, 12, 0, 0, 6, 13];

const PNG_OPTS = { compressionLevel: 9, adaptiveFiltering: false, palette: false } as const;

/** Непрозрачных пикселей по порогу майнера — для попадания в целевые покрытия. */
async function opaqueArea(png: Buffer): Promise<number> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! > METHOD.alphaThreshold) n++;
  }
  return Math.max(1, n);
}

/**
 * Пиксели, которые увидит МАСКА СОДЕРЖИМОГО майнера на композите: яркость
 * премультиплицированного цвета выше порога. Размытый или полупрозрачный кусок
 * «тает» для маски — его видимая площадь заметно меньше непрозрачной, и без
 * поправки покрытия и медиана недобираются. Оценка по чёрной подложке
 * консервативна: свет под куском только добавит яркости.
 */
async function maskVisibleArea(png: Buffer, opacity = 1): Promise<number> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = (data[i + 3]! / 255) * opacity;
    const lum = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
    if (lum * a > METHOD.brightThreshold) n++;
  }
  return n;
}

interface PreparedPiece {
  png: Buffer;
  w: number;
  h: number;
}

/** Масштаб под целевую площадь + блюр дальнего плана. */
async function prepPiece(
  piece: RenderLayer,
  pieceOpaque: number,
  targetOpaquePx: number,
  blurPx: number,
): Promise<PreparedPiece> {
  const factor = Math.sqrt(targetOpaquePx / pieceOpaque);
  const w = Math.max(8, Math.round(piece.width * factor));
  const h = Math.max(8, Math.round(piece.height * factor));
  if (blurPx <= 0) {
    const png = await sharp(piece.png).resize(w, h, { fit: "fill" }).png(PNG_OPTS).toBuffer();
    return { png, w, h };
  }
  // Кусок обрезан по bbox ВПЛОТНУЮ — блюру некуда растечься, и альфа-край
  // остаётся ступенькой 0→255. Такой «размытый» объект несёт на границе ту же
  // резкость, что резкий, и глубина V8 не набирается. Прозрачный отступ даёт
  // краю честно расплыться.
  const pad = Math.ceil(blurPx);
  const padded = await sharp(piece.png)
    .resize(w, h, { fit: "fill" })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const png = await sharp(padded).blur(blurPx / 2).png(PNG_OPTS).toBuffer(); // sigma ≈ радиус/2
  return { png, w: w + 2 * pad, h: h + 2 * pad };
}

/**
 * Композит с подрезкой кромкой холста: sharp не принимает отрицательные
 * смещения, поэтому выходящая за кадр часть объекта отрезается заранее —
 * ровно так «подрезка верхом» (V9) и «подрезка слева» становятся пикселями.
 */
async function clippedOverlay(
  png: Buffer,
  box: { x: number; y: number; w: number; h: number },
  W: number,
  H: number,
): Promise<OverlayOptions | null> {
  const sx = Math.max(0, -box.x);
  const sy = Math.max(0, -box.y);
  const w = Math.min(box.w - sx, W - Math.max(0, box.x));
  const h = Math.min(box.h - sy, H - Math.max(0, box.y));
  if (w <= 0 || h <= 0) return null;
  const input =
    sx === 0 && sy === 0 && w === box.w && h === box.h
      ? png
      : await sharp(png).extract({ left: sx, top: sy, width: w, height: h }).png(PNG_OPTS).toBuffer();
  return { input, left: Math.max(0, box.x), top: Math.max(0, box.y) };
}

function overlaps(a: PlacedBox, boxes: PlacedBox[], gap: number): boolean {
  for (const b of boxes) {
    if (
      a.x < b.x + b.w + gap &&
      a.x + a.w + gap > b.x &&
      a.y < b.y + b.h + gap &&
      a.y + a.h + gap > b.y
    ) {
      return true;
    }
  }
  return false;
}

interface Zone {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function slotById(plan: ScenePlan, id: string): SlotPlan | undefined {
  return plan.slots.find((s) => s.id === id);
}

export async function renderScene(
  plan: ScenePlan,
  inputs: SceneRenderInputs,
): Promise<SceneRenderResult> {
  const W = plan.canvas.w;
  const H = plan.canvas.h;
  const rand = mulberry32(seedToInt(`${plan.seed}:render`));
  const z = METHOD.zones;
  const baselineY = Math.round((plan.baselineYPct / 100) * H);

  const composites: OverlayOptions[] = [];
  const placed: PlacedBox[] = [];
  /** Объекты, слипание с которыми запрещено (декор ↔ декор, декор ↔ герои). */
  const solid: PlacedBox[] = [];

  // ── Слой 1: свет (D-N6) ───────────────────────────────────────────────
  if (inputs.light) {
    const light = await sharp(inputs.light).resize(W, H, { fit: "fill" }).png(PNG_OPTS).toBuffer();
    composites.push({ input: light, left: 0, top: 0 });
  }

  // ── Герои: геометрия считается ДО декора (декор обходит их зоны) ──────
  // Item: высота кластера из плана, низ на baseline, правый край не заходит
  // за границу зоны — центр обязан остаться под шаблон. Выход за ЛЕВУЮ
  // кромку разрешён: у эталонов 0–3 объектов подрезано слева.
  const itemSlot = slotById(plan, "hero-item");
  const itemTargetH = Math.round(((itemSlot?.clusterHeightPct ?? 88) / 100) * H);
  const itemScale = itemTargetH / inputs.item.height;
  const itemW = Math.round(inputs.item.width * itemScale);
  const itemZoneRight = Math.round(z.heroLeft.x1 * W);
  const itemBox: PlacedBox = {
    id: "hero-item",
    x: Math.min(Math.round((itemZoneRight - itemW) / 2), itemZoneRight - itemW),
    y: baselineY - itemTargetH,
    w: itemW,
    h: itemTargetH,
    blurPx: 0,
  };

  // Person: поясной кроп из спеки, макушка и высота из плана, низ на baseline.
  let person = inputs.person;
  const cropTop = inputs.personCropTopFraction;
  if (cropTop !== undefined && cropTop < 1) {
    const cropped = await cropLayerTop(person.png, cropTop);
    if (!cropped.ok) throw new Error(`person crop: ${cropped.reason}`);
    person = { png: cropped.png, width: cropped.width, height: cropped.height };
  }
  const personSlot = slotById(plan, "hero-person");
  let personTargetH = Math.round(((personSlot?.clusterHeightPct ?? 88) / 100) * H);
  let personScale = personTargetH / person.height;
  let personW = Math.round(person.width * personScale);
  // Ширина ограничена так, чтобы персонаж не лез в защищённую среднюю треть
  // центральной полосы: левый край не левее её правой границы (x = 0.72).
  // Потеря высоты при этом логируется — её увидит валидатор кластера.
  const personMaxW = W - Math.round(z.central.x1 * W);
  if (personW > personMaxW) {
    personScale = personMaxW / person.width;
    personW = personMaxW;
    personTargetH = Math.round(person.height * personScale);
  }
  // П8 — цветовой ключ кадра (V14 «2–3 доминирующих оттенка»): персонаж, item
  // и куски листа приходят из разных генераций, каждая со своей палитрой, и
  // без сведения это читается как коллаж. Ключ берётся из САМИХ героев (они
  // подлинные и не перекрашиваются — D-E4'), декор подтягивается к ключу тем
  // же tintToKey и с той же силой, что в действующем движке.
  const colorKey = await dominantColor([
    { data: inputs.item.png, width: inputs.item.width, height: inputs.item.height },
    { data: person.png, width: person.width, height: person.height },
  ]);
  const TINT_STRENGTH = 0.35; // значение сцены v3 (composeEngine, П8)
  const decorTinted: RenderLayer[] = [];
  for (const piece of inputs.decor) {
    const tinted = await tintToKey(
      { data: piece.png, width: piece.width, height: piece.height },
      colorKey,
      TINT_STRENGTH,
    );
    decorTinted.push({ png: tinted.data, width: tinted.width, height: tinted.height });
  }

  const personBox: PlacedBox = {
    id: "hero-person",
    x: W - personW, // правый край вплотную к кромке — эталонные 1–2 объекта, подрезанных справа
    // Якорь — МАКУШКА по плану, не низ: если ширинный кап урезал высоту, низ
    // персонажа всплывает над baseline — ровно как ex5 корпуса (высота 77.7 %,
    // макушка 11.1 %, низ на 88.8 % при contentBottom 91.8 %). Прибивать низ
    // означало бы утопить макушку ниже коридора personTopPct.
    y: Math.round(((personSlot?.headTopPct ?? 4) / 100) * H),
    w: personW,
    h: personTargetH,
    blurPx: 0,
  };
  solid.push(itemBox, personBox);

  // ── Слой 2: focal-blur — крупный размытый объект за верхней кромкой ───
  const focalSlot = slotById(plan, "focal-blur");
  let focalIndex = 0;
  if (focalSlot && decorTinted.length > 0) {
    // Focal — самый КОМПАКТНЫЙ из трёх крупнейших кусков: у куска с
    // рисованными хвостами-бликами bbox сильно больше тела, его площадь в
    // кадре не совпадёт с планом, а коридор V9 задан именно по площади.
    const candidates = decorTinted.slice(0, 3);
    let best = 0;
    let bestCompact = -1;
    for (const [i, c] of candidates.entries()) {
      const compact = (await opaqueArea(c.png)) / (c.width * c.height);
      if (compact > bestCompact) {
        bestCompact = compact;
        best = i;
      }
    }
    focalIndex = best;
    const piece = decorTinted[focalIndex]!;
    const pieceOpaque = await opaqueArea(piece.png);
    const targetVisiblePx = ((focalSlot.areaPct ?? 1.5) / 100) * W * H;
    // Кроп верхом съедает долю ПЛОЩАДИ, зависящую от формы объекта (у круга
    // верхняя треть легче средней). Первый проход — грубая компенсация на
    // равномерную форму, второй — поправка по фактически видимым пикселям:
    // коридор V9 задан по площади компонента в кадре, а не по масштабу слоя.
    let targetPx = targetVisiblePx / (1 - FOCAL_CROP);
    let prep = await prepPiece(piece, pieceOpaque, targetPx, focalSlot.blurPx ?? 14);
    {
      const cropRows = Math.round(prep.h * FOCAL_CROP);
      const { data, info } = await sharp(prep.png)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      // Видимость — той же маской, что у майнера (яркость композита), а не по
      // альфе: у размытого объекта альфа шире видимого маске тела.
      let visible = 0;
      for (let y = cropRows; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          const i = (y * info.width + x) * 4;
          const a = data[i + 3]! / 255;
          const lum = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
          if (lum * a > METHOD.brightThreshold) visible++;
        }
      }
      if (visible > 0) {
        targetPx *= Math.min(4, Math.max(0.25, targetVisiblePx / visible));
        prep = await prepPiece(piece, pieceOpaque, targetPx, focalSlot.blurPx ?? 14);
      }
    }
    const cx = Math.round((focalSlot.cx ?? 0.5) * W);
    const box: PlacedBox = {
      id: "focal-blur",
      x: cx - Math.round(prep.w / 2),
      y: -Math.round(prep.h * FOCAL_CROP),
      w: prep.w,
      h: prep.h,
      blurPx: focalSlot.blurPx ?? 14,
    };
    const overlay = await clippedOverlay(prep.png, box, W, H);
    if (overlay) {
      composites.push(overlay);
      placed.push(box);
      solid.push(box);
    }
  }

  // ── Слои 3–5: декор по зонам ──────────────────────────────────────────
  const centralX0 = Math.round(z.central.x0 * W);
  const centralX1 = Math.round(z.central.x1 * W);
  const third = Math.round(H / 3);

  const scatter = async (
    slot: SlotPlan | undefined,
    zone: Zone,
    startIndex: number,
    /** true — кусок без чистого места пропускается: слипание с героем
     *  склеивает компоненты, и кластер героя «дотягивается» до кромки. */
    requireClean = false,
  ): Promise<number> => {
    if (!slot || decorTinted.length === 0) return startIndex;
    const count = slot.count ?? 0;
    const zoneArea = (zone.x1 - zone.x0) * (zone.y1 - zone.y0);
    const targetTotal = ((slot.targetCoveragePct ?? 0) / 100) * zoneArea;
    // Слот без целевого покрытия (добор hero-left): кусок ~2 % зоны — размер
    // «второго объекта зоны», а не пылинки, которая утопила бы медиану V-серии.
    const perPiece = count > 0 ? (targetTotal > 0 ? targetTotal / count : zoneArea * 0.02) : 0;
    let index = startIndex;
    for (let i = 0; i < count; i++) {
      const piece = decorTinted[index % decorTinted.length]!;
      index++;
      const pieceOpaque = await opaqueArea(piece.png);
      // Разброс размеров вокруг среднего — сцена из одинаковых штампов не
      // бывает у дизайнеров; множитель сидирован. Нижняя граница размера —
      // из плана (низ коридора медианы корпуса): кусок-пылинка топит V-серию.
      const minPiecePx = ((plan.decorMinPieceAreaPct ?? 0) / 100) * W * H;
      const target = Math.max(
        METHOD.minComponentArea * 2,
        minPiecePx,
        perPiece * (0.6 + rand() * 0.9),
      );
      const blurPx = slot.blurPx ?? BLUR_CYCLE[i % BLUR_CYCLE.length]!;
      let prep = await prepPiece(piece, pieceOpaque, target, blurPx);
      // Поправка на «таяние»: блюр и прозрачность уводят периферию куска ниже
      // порога маски. Один корректирующий проход по фактически видимым
      // пикселям; множитель ограничен — тёмный кусок бесконечно не раздуть.
      // В text-core поправки НЕТ: у защищённой зоны дефект только сверху
      // (ceiling) — недобор ambience безопасен, раздутый кусок пробьёт потолок.
      const opacity = slot.opacity ?? 1;
      if (slot.zone !== "text-core" && (blurPx > 0 || opacity < 1)) {
        const visible = await maskVisibleArea(prep.png, opacity);
        if (visible < target * 0.75) {
          const boost = Math.min(4, target / Math.max(1, visible));
          prep = await prepPiece(piece, pieceOpaque, target * boost, blurPx);
        }
      }
      // Объект больше зоны (короткая нижняя полоса, крупный блюр-отступ) —
      // ужимается под зону, а не пропускается: молчаливый пропуск оставлял
      // недобор покрытия ровно там, где коридор и так самый тесный.
      const zoneW = zone.x1 - zone.x0;
      const zoneH = zone.y1 - zone.y0;
      if (prep.w > zoneW || prep.h > zoneH) {
        const shrink = Math.min((zoneW * 0.9) / prep.w, (zoneH * 0.9) / prep.h);
        prep = await prepPiece(piece, pieceOpaque, target * shrink * shrink, blurPx);
        if (prep.w > zoneW || prep.h > zoneH) continue;
      }

      let box: PlacedBox | null = null;
      let clean = false;
      for (let attempt = 0; attempt < PLACE_TRIES; attempt++) {
        const x = zone.x0 + Math.round(rand() * (zone.x1 - zone.x0 - prep.w));
        const y = zone.y0 + Math.round(rand() * (zone.y1 - zone.y0 - prep.h));
        const candidate: PlacedBox = { id: slot.id, x, y, w: prep.w, h: prep.h, blurPx };
        box = candidate; // последняя попытка принимается: пустая зона хуже касания
        if (!overlaps(candidate, solid, MERGE_GAP)) {
          clean = true;
          break;
        }
      }
      if (!box || (requireClean && !clean)) continue;
      const overlay: OverlayOptions = { input: prep.png, left: box.x, top: box.y };
      if (slot.opacity !== undefined && slot.opacity < 1) {
        // Прозрачность ambience: альфа умножается заранее, композит обычный.
        const faded = await sharp(prep.png)
          .ensureAlpha()
          .linear([1, 1, 1, slot.opacity], [0, 0, 0, 0])
          .png(PNG_OPTS)
          .toBuffer();
        overlay.input = faded;
      }
      composites.push(overlay);
      placed.push(box);
      solid.push(box);
    }
    return index;
  };

  // Подрезка кромками — привилегия focal (верх) и героев (лево/право):
  // рядовой декор держит зазор от кромок больше порога касания майнера,
  // иначе счётчик croppedTop уезжает за коридор 1–2.
  const clearPx = Math.ceil(METHOD.edgeTouchFraction * H * 2);

  // Дальний/ближний план: верх сцены, низ сцены (не ниже baseline — V10),
  // расфокус в text-core. Индекс кусков сквозной, чтобы один и тот же кусок
  // не штамповался в соседних зонах при богатой библиотеке.
  let decorIndex = focalIndex + 1; // focal уже занят
  decorIndex = await scatter(
    slotById(plan, "decor-top"),
    // Отступ сверху — на ширину ореола (MERGE_GAP): полупрозрачный хвост
    // куска над светом пробивает маску ВЫШЕ bbox и без отступа дотягивает
    // компонент до кромки — тогда подрезанным верхом считается он, а не focal.
    { x0: centralX0, x1: centralX1, y0: clearPx + MERGE_GAP, y1: third },
    decorIndex,
  );
  decorIndex = await scatter(
    slotById(plan, "decor-bottom"),
    { x0: centralX0, x1: centralX1, y0: third * 2, y1: Math.min(baselineY, H) },
    decorIndex,
  );
  decorIndex = await scatter(
    slotById(plan, "ambience"),
    { x0: centralX0, x1: centralX1, y0: third, y1: third * 2 },
    decorIndex,
  );

  // Добор hero-left (`D-C8`, ответ на вопрос 8): слот надписи пуст — зона
  // добирается декором, чтобы не вышло одинокого предмета result-2. Только на
  // чистое место: кусок, слипшийся с item, дотянул бы кластер героя до кромки.
  // Угловые патчи замера яркости (квадрат 5 % ширины, `D-N2`) — запретная
  // зона: яркий кусок в патче выбивает cornerLum за коридор «чёрных углов».
  const cornerPatch = Math.round(METHOD.cornerPatchFraction * W);
  await scatter(
    slotById(plan, "left-fill-decor"),
    {
      x0: 0,
      x1: Math.round(z.heroLeft.x1 * W),
      y0: Math.max(clearPx, cornerPatch, itemBox.y - Math.round(0.06 * H)),
      y1: Math.min(baselineY, H - cornerPatch),
    },
    decorIndex,
    true,
  );

  // ── Слой 6: герои поверх декора ───────────────────────────────────────
  const itemPng = await sharp(inputs.item.png)
    .resize(itemBox.w, itemBox.h, { fit: "fill" })
    .png(PNG_OPTS)
    .toBuffer();
  const itemOverlay = await clippedOverlay(itemPng, itemBox, W, H);
  if (itemOverlay) {
    composites.push(itemOverlay);
    placed.push(itemBox);
  }

  const personPng = await sharp(person.png)
    .resize(personBox.w, personBox.h, { fit: "fill" })
    .png(PNG_OPTS)
    .toBuffer();
  const personOverlay = await clippedOverlay(personPng, personBox, W, H);
  if (personOverlay) {
    composites.push(personOverlay);
    placed.push(personBox);
  }

  let png: Buffer = await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .png(PNG_OPTS)
    .toBuffer();

  // ── Harmonize (вариант C, шаг [4]): виньетка углов по КОМПОЗИТУ ─────────
  // «Чёрные углы» эталонов давят и контент: подножие item-стека в угловом
  // патче у дизайнеров затемнено общим светом. Слой света своё уже отработал —
  // здесь тонируется цвет готового кадра (альфа не трогается), вес строго в
  // углах (|dx·dy|): оси и центр — ноль, focal на верхней кромке не тускнеет.
  // Светимость композита линейна по цвету при неизменной альфе — сходится за
  // пару шагов без √-модели.
  const cornerHi = plan.background.targetCornerLum[1];
  const cornerMid =
    (plan.background.targetCornerLum[0] + plan.background.targetCornerLum[1]) / 2;
  for (let step = 0; step < 3; step++) {
    const corner = await lightCornerLuminance(png);
    if (corner <= cornerHi) break;
    png = await vignetteCornersRgb(png, cornerMid / corner);
  }

  return { png, width: W, height: H, placed };
}

/** Угловая виньетка по цвету: rgb умножается на радиальный фактор, альфа
 *  остаётся — доставка с альфой (`D-E5`) не меняет форму содержимого. */
async function vignetteCornersRgb(png: Buffer, ratio: number): Promise<Buffer> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const out = Buffer.alloc(data.length);
  data.copy(out);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = Math.abs((x - W / 2) / (W / 2));
      const dy = Math.abs((y - H / 2) / (H / 2));
      // |dx·dy|^1.5: единица только в углах, ноль на осях — затемняются углы,
      // а не верх/низ кадра, где стоят focal и герои.
      const t = Math.pow(dx * dy, 1.5);
      if (t <= 0) continue;
      const factor = 1 + (ratio - 1) * t;
      const i = (y * W + x) * 4;
      out[i] = Math.round(data[i]! * factor);
      out[i + 1] = Math.round(data[i + 1]! * factor);
      out[i + 2] = Math.round(data[i + 2]! * factor);
    }
  }
  return sharp(out, { raw: { width: W, height: H, channels: 4 } })
    .png(PNG_OPTS)
    .toBuffer();
}
