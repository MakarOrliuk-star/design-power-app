import { runGptImage2Edit } from "../lib/fal.js";
import { fitAndStoreAsset } from "../lib/assetFit.js";
import { fetchBuffer } from "./layerCache.js";
import { validateAiAsset } from "../lib/aiAssetValidator.js";
import type { AiTechReport } from "../lib/aiAssetValidator.js";
import { reviewComposition, QA_REFS_SHOWN } from "../lib/vlmReviewer.js";
import type { QaProfile } from "../lib/vlmReviewer.js";
import { scanImageUrl } from "../lib/textScan.js";
import type { ScanBudget } from "../lib/textScan.js";

/**
 * Auto-healing композиции ai_reference (TASK safe-zone/auto-heal, B1/B2/B3).
 *
 * Запускается ТОЛЬКО когда все AI_REF_MAX_ATTEMPTS попыток генерации провалили
 * приёмку (B1: лечим лучшего кандидата, а не каждую попытку). Замечания
 * приёмщика — текст без координат, поэтому коррекция — re-edit той же
 * gpt-image-2/edit по одной картинке (без референсов, чтобы модель не
 * пересочиняла композицию) с промптом «исправь только перечисленное».
 *
 * Цикл (B3: до AI_HEAL_MAX_ATTEMPTS попыток): каждая вылеченная версия
 * проходит тот же контур контроля, что и генерация, — сначала дешёвая
 * техвалидация (stage C), затем VLM-приёмка. Прошла приёмку → она и есть
 * победитель. Обе не прошли → победитель — лучший по score среди исходника
 * и вылеченных (Спор 2 R-Plan): специалист получает лучшее из возможного
 * с warning-бейджем, ассет НЕ падает (B4).
 *
 * Попытка №2 лечит лучшего кандидата на данный момент по ЕГО замечаниям:
 * если первая коррекция улучшила score, но внесла новые дефекты — правим их;
 * если ухудшила — возвращаемся к исходнику и его замечаниям.
 */

export const AI_HEAL_MAX_ATTEMPTS = 2;

/** Одна попытка (генерации или лечения) в metadata.qa — что видел админ/CRM. */
export interface AiRefAttempt {
  imageUrl: string | null;
  score: number;
  pass: boolean;
  reasons: string[];
  tech: AiTechReport | null;
  /** Приёмка пропущена по транспортной причине (vision недоступен). */
  qaSkipped?: boolean;
  /**
   * Вердикт текстового детектора по этой попытке (TASK no-baked-text).
   * Отсутствует — строгий режим выключен или скан не проводился.
   */
  textGate?: { clean: boolean; found: string };
}

/**
 * Промпт коррекции (B2): точечные исправления по замечаниям приёмки + жёсткое
 * «всё остальное не трогай» + повтор инвариантов safe-зоны из
 * AI_REF_COMPOSITION_CONTRACT (белый фон, пустой центр) — чтобы починка одного
 * дефекта не сломала контракт в другом месте. Замечания приёмщик пишет
 * по-русски (QA_SYSTEM_PROMPT) — gpt-image-2 мультиязычна, не переводим.
 *
 * `keepCenterClear` (TASK multiformat-promo, DI2-4) — только для якорного
 * формата: у push/pop-up copy space не нужен, и требование пустой середины
 * выгрызло бы центр баннера при лечении постороннего дефекта.
 */
/**
 * Инвариант анатомии для ретуши (правка 2026-08-15). Формулировка отличается
 * от генерации: там задача «нарисуй правильно», здесь — «почини руку, если о
 * ней замечание, и не сломай, если замечание про другое». Число пальцев берём
 * с самой картинки: референсов при лечении нет по построению (лечим по одной
 * картинке, чтобы модель не пересочинила композицию), поэтому эталон — тот
 * тип рук, который уже нарисован у героя.
 */
const ANATOMY_RULE =
  "the hero's hands must end up anatomically correct: keep the same KIND of hand the character already has " +
  "(human hand, gloved cartoon hand, animal paw, hoof) and give every hand the correct number of digits — " +
  "exactly five (four fingers and a thumb) on a human or humanoid hand, and the same count on both hands. " +
  "If any issue above is about hands, fingers, limbs or anatomy, redraw that hand completely until it is " +
  "correct — this is the one place where you MAY change the drawing beyond a minimal retouch; if a correct " +
  "hand is impossible in this pose, hide it behind a prop or behind the body instead. Never leave fused, " +
  "extra, missing or backwards-bent fingers, and never break a hand that was already correct; ";

export function buildHealingPrompt(
  reasons: string[],
  opts?: {
    keepCenterClear?: boolean;
    gender?: "male" | "female" | null;
    /** Набор предметов кампании (правка 2026-08-15) — из него берутся добавки. */
    propInventory?: string;
    /** Режим текста вариации (TASK no-baked-text); дефолт — строгий запрет. */
    allowText?: boolean;
  },
): string {
  const keepCenterClear = opts?.keepCenterClear ?? true;
  const allowText = opts?.allowText ?? false;
  // Лечение умеет ДОБАВЛЯТЬ пропсы (пустые бока по чеку `sides`). Без списка
  // оно дорисовывало что придётся — ровно тот рандом, который убирает
  // единый набор кампании. Пусто — прежнее «того же семейства».
  const inventory = (opts?.propInventory ?? "").trim();
  const addSource = inventory
    ? `taken ONLY from the campaign prop set (${inventory}) — repeats of objects already in the frame are fine`
    : "of the same family";
  // Пол героя повторяется и здесь: коррекция перерисовывает персонажа, и без
  // напоминания она способна «починить» замечание, заодно сменив пол.
  const genderRule = opts?.gender
    ? `the main character must remain ${opts.gender === "male" ? "a MAN" : "a WOMAN"}; `
    : "";
  const issues = reasons
    .map((r) => r.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((r) => `- ${r}`)
    .join("\n");
  const centerRule = keepCenterClear
    ? "the wide central copy space (the middle half of the banner, top to bottom) must remain " +
      "COMPLETELY EMPTY white — remove any prop, coin, sparkle or particle that entered it; "
    : // Зависимый формат: центр чистить не надо, но перегруз (DI3-9) лечится
      // именно удалением предметов — без этой оговорки «не меняй ничего»
      // выше по промпту запрещает единственно верную правку.
      "keep the existing composition and framing — this format has no reserved copy space, " +
      "do not clear or empty the middle of the canvas; if an issue above asks to reduce the number " +
      "of props or to declutter the scene, DELETING the extra props is exactly what is required — " +
      "erase them and leave plain white background in their place, never replace them with other objects; " +
      // Обратный случай (правка 2026-08-13): чек `sides` бракует кадр с
      // пустыми краями, и починка здесь — ДОБАВИТЬ предметы, не тронув героя.
      "conversely, if an issue says the sides or the frame are empty, ADD more floating props " +
      addSource +
      " into the left and right thirds of the canvas — keep the hero exactly as it is; " +
      // Правка 2026-08-15: лечение раньше досыпало предметы «в пустое место»,
      // то есть само производило ту самую равномерную россыпь, из-за которой
      // кадр и выглядит непродуманным.
      "when you add props, attach them to the groups that already exist — overlapping the objects that are " +
      "there, in varied sizes and tilt angles — never place them at equal distances or in a neat row; " +
      "if an issue says the props look scattered, evenly spaced or all the same size, REARRANGE them into two " +
      "or three overlapping groups with one clearly dominant prop near the hero and empty space between the " +
      "groups, keeping the same objects; " +
      (inventory
        ? "if an issue says a prop does not belong to the campaign, REPLACE that object with one from the " +
          "campaign prop set above, keeping its size and position; "
        : "");
  return (
    "Retouch this existing casino promo hero composition. Apply ONLY the minimal " +
    "corrections needed to fix the QA issues listed below and change NOTHING else: " +
    "keep the same characters, props, palette, lighting, rendering style, proportions " +
    "and placement, identical outside the corrected spots.\n" +
    `QA issues to fix:\n${issues || "- general quality cleanup"}\n` +
    "MANDATORY constraints while fixing: " +
    genderRule +
    "the background stays pure solid white (#FFFFFF), " +
    "completely flat — remove any glow, gradients, bokeh, light rays or cast shadows on it; " +
    centerRule +
    // Анатомия (правка 2026-08-15). Два повода держать пункт именно здесь:
    // (1) замечание приёмщика про руку исполнимо только с явным разрешением
    // перерисовать её — «не меняй ничего» выше по промпту это запрещает;
    // (2) ретушь чужого дефекта сама ломает кисти, и без напоминания лечение
    // одного замечания приносит другое.
    ANATOMY_RULE +
    // Правка TASK no-baked-text: прежний хвост запрещал ДОБАВЛЯТЬ текст, но не
    // велел стирать уже нарисованный, а «не меняй ничего» выше по промпту прямо
    // мешал это сделать. Оговорка про сохранение предмета обязательна: без неё
    // gpt-image-2 выпиливает вместе с надписью весь носитель — барабан, фишку,
    // ящик — и композиция разваливается сильнее, чем от самой надписи.
    (allowText
      ? "all key elements stay fully inside the frame; do not add any text, logos or watermarks."
      : "all key elements stay fully inside the frame; never add any text, logos or watermarks. " +
        "If any issue above mentions text, lettering, words or numbers in the image, ERASE that lettering " +
        "completely: keep the object that carried it — the reel, chip, crate, medallion, ribbon or banner — " +
        "in the exact same place, size and shape, and rebuild its surface clean, as bare material, ornament " +
        "or a pictorial symbol. Never replace the erased words with other words, and never delete the object " +
        "itself. A standard playing card keeps its natural rank marks and suit pips — those are not lettering.")
  );
}

/** Победитель healing-этапа: финальная база композиции. */
export interface HealWinner {
  imageUrl: string;
  /** Прошёл ли победитель приёмку (после лечения). */
  pass: boolean;
  score: number;
  /** Индекс в attempts, если победитель — вылеченная версия; null — исходник. */
  healingIndex: number | null;
  /**
   * Свободен ли победитель от запечённого текста (TASK no-baked-text).
   * undefined — строгий режим выключен либо детектор был недоступен.
   */
  textClean?: boolean;
  /** Прочитанный на победителе текст; пусто, когда чисто. */
  textFound?: string;
}

export interface HealOutcome {
  /** Healing-попытки для metadata.qa.healing (в порядке выполнения). */
  attempts: AiRefAttempt[];
  winner: HealWinner;
  /** Сколько текстовых сканов потрачено на этапе лечения (контроль расходов). */
  textScanned?: number;
}

/**
 * Лечение забракованного кандидата: до maxAttempts циклов
 * edit → fit → stage C → VLM. Ошибки транспорта/валидации не бросают —
 * попытка записывается проваленной, победителем остаётся лучший по score.
 */
export async function healComposition(opts: {
  /**
   * Забракованный лучший кандидат генерации и его вердикт приёмки.
   * `textClean: false` — источник лечится в том числе из-за запечённого текста
   * (TASK no-baked-text): тогда любая чистая от букв версия побеждает его
   * независимо от score.
   */
  source: { imageUrl: string; score: number; reasons: string[]; textClean?: boolean };
  targetW: number;
  targetH: number;
  /** Детерминированная база public id (`${variantId}_${assetKey}`). */
  publicIdBase: string;
  folder: string;
  logTag: string;
  refUrls: string[];
  variationText: string;
  brandName: string;
  /** Только у якорного формата (DI2-4); без неё чек центра не выполняется. */
  centerClearZone?: { x: number; y: number; w: number; h: number };
  /** Только у зависимых форматов: минимальная заполненность боковых третей. */
  minSideFill?: number;
  /** Профиль чек-листа приёмки: тот же, что в генерации этого ассета. */
  profile?: QaProfile;
  /** Якорная композиция кампании — показывается приёмщику зависимых форматов. */
  anchorUrl?: string | null;
  formatLabel?: string;
  maxAttempts?: number;
  /** Верх коридора предметов (DI3-9) — тот же, что в генерации. */
  maxProps?: number;
  /** Низ коридора предметов — тот же, что в генерации. */
  minProps?: number;
  /** Пол героя тон-варианта — тот же, что в генерации (правка 2026-08-13). */
  gender?: "male" | "female" | null;
  /** Сходство персонажа с референсами — то же, что в генерации. */
  fidelity?: "exact" | "variant";
  /** Набор предметов кампании — тот же, что в генерации (правка 2026-08-15). */
  propInventory?: string;
  /** Режим текста вариации — тот же, что в генерации (TASK no-baked-text). */
  allowText?: boolean;
  /**
   * Бюджет текстовых сканов, общий с этапом генерации. Задан — каждая
   * вылеченная версия пересканируется: без этого мы приняли бы «вылеченную»
   * картинку, на которой надпись осталась.
   */
  textBudget?: ScanBudget;
}): Promise<HealOutcome> {
  const max = opts.maxAttempts ?? AI_HEAL_MAX_ATTEMPTS;
  const profile: QaProfile = opts.profile ?? "anchor";
  const keepCenterClear = Boolean(opts.centerClearZone);
  const allowText = opts.allowText ?? false;
  // Строгий режим И включённый гейт: без бюджета сканов лечение работает
  // по-старому (только приёмка), и это корректный режим для legacy-вызовов.
  const textGateOn = !allowText && Boolean(opts.textBudget);
  let textScanned = 0;
  const attempts: AiRefAttempt[] = [];
  // Текущий лучший кандидат — его лечим и его же отдаём, если лучше не станет.
  let best: HealWinner & { reasons: string[]; textClean: boolean } = {
    imageUrl: opts.source.imageUrl,
    pass: false,
    score: opts.source.score,
    healingIndex: null,
    reasons: opts.source.reasons,
    textClean: opts.source.textClean ?? true,
  };

  for (let attempt = 1; attempt <= max; attempt++) {
    const prompt = buildHealingPrompt(best.reasons.length ? best.reasons : opts.source.reasons, {
      keepCenterClear,
      ...(opts.gender ? { gender: opts.gender } : {}),
      ...(opts.propInventory ? { propInventory: opts.propInventory } : {}),
      allowText,
    });
    const gen = await runGptImage2Edit({
      prompt,
      imageUrls: [best.imageUrl],
      width: opts.targetW,
      height: opts.targetH,
    });
    if (!gen.success || !gen.imageUrl) {
      attempts.push({
        imageUrl: null,
        score: 0,
        pass: false,
        reasons: [`heal: ${gen.error ?? "unknown"}`],
        tech: null,
      });
      continue;
    }

    const fitted = await fitAndStoreAsset(
      gen.imageUrl,
      opts.targetW,
      opts.targetH,
      `${opts.publicIdBase}_heal${attempt}`,
      opts.folder,
      `${opts.logTag}@heal${attempt}`,
    );
    if (!fitted.ok) {
      attempts.push({ imageUrl: null, score: 0, pass: false, reasons: [fitted.reason], tech: null });
      continue;
    }

    const buffer = await fetchBuffer(fitted.url);
    if (!buffer) {
      attempts.push({
        imageUrl: fitted.url,
        score: 0,
        pass: false,
        reasons: ["download: не удалось прочитать сохранённый ассет"],
        tech: null,
      });
      continue;
    }

    // Тот же порядок, что в генерации: stage C до VLM — на явный брак
    // (сломанный размер/резкость/центр) приёмщик не тратится, и такая
    // попытка не участвует в выборе лучшего.
    const tech = await validateAiAsset(buffer, opts.targetW, opts.targetH, {
      ...(opts.centerClearZone ? { centerClearZone: opts.centerClearZone } : {}),
      ...(opts.minSideFill !== undefined ? { minSideFill: opts.minSideFill } : {}),
    });
    if (!tech.passed) {
      attempts.push({
        imageUrl: fitted.url,
        score: 0,
        pass: false,
        reasons: tech.checks.filter((c) => !c.passed).map((c) => `${c.key}: ${c.detail}`),
        tech,
      });
      continue;
    }

    const verdict = await reviewComposition({
      imageUrl: fitted.url,
      refUrls: opts.refUrls.slice(0, QA_REFS_SHOWN),
      variationText: opts.variationText,
      brandName: opts.brandName,
      profile,
      anchorUrl: opts.anchorUrl ?? null,
      ...(opts.formatLabel ? { formatLabel: opts.formatLabel } : {}),
      ...(opts.maxProps !== undefined ? { maxProps: opts.maxProps } : {}),
      ...(opts.minProps !== undefined ? { minProps: opts.minProps } : {}),
      ...(opts.gender ? { gender: opts.gender } : {}),
      ...(opts.fidelity ? { fidelity: opts.fidelity } : {}),
      ...(opts.propInventory ? { propInventory: opts.propInventory } : {}),
      allowText,
    });

    // Перескан вылеченной версии (TASK no-baked-text): ретушь могла стереть
    // одну надпись и оставить другую — или дорисовать новую. Недоступный
    // детектор трактуется как «чисто» (best-effort, как везде в этом контуре).
    let textClean = true;
    let textFound = "";
    if (textGateOn) {
      const scan = await scanImageUrl(fitted.url, opts.textBudget, "strict");
      if (scan) {
        textScanned += 1;
        textClean = !scan.hasText || scan.approvedOk;
        textFound = textClean ? "" : scan.text;
      }
    }

    const row: AiRefAttempt = {
      imageUrl: fitted.url,
      score: Math.max(0, verdict.score),
      pass: verdict.pass,
      reasons: verdict.reasons,
      tech,
      ...(verdict.skipped ? { qaSkipped: true } : {}),
      ...(textGateOn ? { textGate: { clean: textClean, found: textFound } } : {}),
    };
    attempts.push(row);

    // Победа — только когда сошлись ОБА контура: приёмка и чистота от текста.
    // Иначе высокий score вернул бы в CRM ровно ту надпись, ради которой
    // лечение и запускалось.
    if (verdict.pass && textClean) {
      return {
        attempts,
        winner: {
          imageUrl: fitted.url,
          pass: true,
          score: row.score,
          healingIndex: attempts.length - 1,
          ...(textGateOn ? { textClean: true, textFound: "" } : {}),
        },
        ...(textGateOn ? { textScanned } : {}),
      };
    }
    // Чистая от текста версия обходит грязную НЕЗАВИСИМО от score: иначе
    // лечение с хорошей композицией и оставшимся «FS» победило бы вылеченную
    // чистую. При равной чистоте решает score, как и раньше.
    const cleaner = textClean && !best.textClean;
    const better = cleaner || (textClean === best.textClean && row.score > best.score);
    if (better) {
      best = {
        imageUrl: fitted.url,
        pass: false,
        score: row.score,
        healingIndex: attempts.length - 1,
        reasons: verdict.reasons,
        textClean,
        textFound,
      };
    }
  }

  const { reasons: _ignored, textClean, textFound, ...rest } = best;
  const winner: HealWinner = {
    ...rest,
    ...(textGateOn ? { textClean, textFound: textFound ?? "" } : {}),
  };
  return { attempts, winner, ...(textGateOn ? { textScanned } : {}) };
}
