import { runGptImage2Edit } from "../lib/fal.js";
import { fitAndStoreAsset } from "../lib/assetFit.js";
import { fetchBuffer } from "./layerCache.js";
import { validateAiAsset } from "../lib/aiAssetValidator.js";
import type { AiTechReport } from "../lib/aiAssetValidator.js";
import { reviewComposition, QA_REFS_SHOWN } from "../lib/vlmReviewer.js";
import type { QaProfile } from "../lib/vlmReviewer.js";

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
export function buildHealingPrompt(
  reasons: string[],
  opts?: { keepCenterClear?: boolean },
): string {
  const keepCenterClear = opts?.keepCenterClear ?? true;
  const issues = reasons
    .map((r) => r.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((r) => `- ${r}`)
    .join("\n");
  const centerRule = keepCenterClear
    ? "the wide central copy space (the middle half of the banner, top to bottom) must remain " +
      "COMPLETELY EMPTY white — remove any prop, coin, sparkle or particle that entered it; "
    : "keep the existing composition and framing — this format has no reserved copy space, " +
      "do not clear or empty the middle of the canvas; ";
  return (
    "Retouch this existing casino promo hero composition. Apply ONLY the minimal " +
    "corrections needed to fix the QA issues listed below and change NOTHING else: " +
    "keep the same characters, props, palette, lighting, rendering style, proportions " +
    "and placement, identical outside the corrected spots.\n" +
    `QA issues to fix:\n${issues || "- general quality cleanup"}\n` +
    "MANDATORY constraints while fixing: the background stays pure solid white (#FFFFFF), " +
    "completely flat — remove any glow, gradients, bokeh, light rays or cast shadows on it; " +
    centerRule +
    "all key elements stay fully inside the frame; do not add any text, logos or watermarks."
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
}

export interface HealOutcome {
  /** Healing-попытки для metadata.qa.healing (в порядке выполнения). */
  attempts: AiRefAttempt[];
  winner: HealWinner;
}

/**
 * Лечение забракованного кандидата: до maxAttempts циклов
 * edit → fit → stage C → VLM. Ошибки транспорта/валидации не бросают —
 * попытка записывается проваленной, победителем остаётся лучший по score.
 */
export async function healComposition(opts: {
  /** Забракованный лучший кандидат генерации и его вердикт приёмки. */
  source: { imageUrl: string; score: number; reasons: string[] };
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
  /** Профиль чек-листа приёмки: тот же, что в генерации этого ассета. */
  profile?: QaProfile;
  /** Якорная композиция кампании — показывается приёмщику зависимых форматов. */
  anchorUrl?: string | null;
  formatLabel?: string;
  maxAttempts?: number;
}): Promise<HealOutcome> {
  const max = opts.maxAttempts ?? AI_HEAL_MAX_ATTEMPTS;
  const profile: QaProfile = opts.profile ?? "anchor";
  const keepCenterClear = Boolean(opts.centerClearZone);
  const attempts: AiRefAttempt[] = [];
  // Текущий лучший кандидат — его лечим и его же отдаём, если лучше не станет.
  let best: HealWinner & { reasons: string[] } = {
    imageUrl: opts.source.imageUrl,
    pass: false,
    score: opts.source.score,
    healingIndex: null,
    reasons: opts.source.reasons,
  };

  for (let attempt = 1; attempt <= max; attempt++) {
    const prompt = buildHealingPrompt(best.reasons.length ? best.reasons : opts.source.reasons, {
      keepCenterClear,
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
    });
    const row: AiRefAttempt = {
      imageUrl: fitted.url,
      score: Math.max(0, verdict.score),
      pass: verdict.pass,
      reasons: verdict.reasons,
      tech,
      ...(verdict.skipped ? { qaSkipped: true } : {}),
    };
    attempts.push(row);

    if (verdict.pass) {
      return {
        attempts,
        winner: { imageUrl: fitted.url, pass: true, score: row.score, healingIndex: attempts.length - 1 },
      };
    }
    if (row.score > best.score) {
      best = {
        imageUrl: fitted.url,
        pass: false,
        score: row.score,
        healingIndex: attempts.length - 1,
        reasons: verdict.reasons,
      };
    }
  }

  const { reasons: _ignored, ...winner } = best;
  return { attempts, winner };
}
