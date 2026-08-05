import { runVisionQa } from "./fal.js";

/**
 * Системный промпт-«Приемщик» (TASK ai-reference, стадия B; DI-R9/R10, A-1).
 *
 * Отдельный VLM-агент смотрит на сгенерированную композицию рядом с
 * референсами бренда и выносит машинно-читаемый вердикт. Правило текста —
 * A-1 (утверждено 2026-08-04): в композиции допустимы только короткие
 * «казиношные» слова на пропсах (FS, SCATTER, BONUS, VIP…); любые фразы,
 * предложения, CTA-кнопки, логотипы и водяные знаки — брак.
 *
 * Транспортная ошибка VLM ≠ брак картинки: приёмка помечается пропущенной
 * (`skipped`), генерация не блокируется — тот же fail-open, что у
 * requestCreativeBrief (нейтральный фолбэк) в Задании 3. Неразобранный ответ
 * после ре-запроса — наоборот брак попытки (`qa-unparseable`): модель ответила,
 * но контракт JSON нарушен, доверять такому «да» нельзя.
 */

export interface QaVerdict {
  pass: boolean;
  /** 0–100; используется для best-of при исчерпании ретраев (DI-R10). */
  score: number;
  reasons: string[];
  /** true — приёмка не состоялась по транспортной причине (не мнение модели). */
  skipped?: boolean;
}

/** Сколько референсов показываем приёмщику рядом с результатом (первые по порядку). */
export const QA_REFS_SHOWN = 3;

export const QA_SYSTEM_PROMPT = [
  // A-2 (2026-08-05): композиция намеренно на белом фоне под вырезание;
  // белый фон и пустой центр — требование, а не расхождение с референсами.
  "You are a strict QA reviewer («Приемщик») for casino email hero compositions (1200×600).",
  "The FIRST image is the generated composition under review. The remaining images are reference banners of the same brand — the ground truth for style.",
  "IMPORTANT: the composition is INTENTIONALLY rendered on a plain solid white background for later cut-out, even if the reference banners have scenic backgrounds. A white background is correct and must NEVER be reported as a style mismatch.",
  "Evaluate the generated composition against this checklist:",
  "1. STYLE: palette, prop family, character style, lighting and rendering quality must match the reference banners. Ignore background differences (see above).",
  "2. BRIEF: the composition must express the campaign brief provided in the user prompt.",
  "3. BACKGROUND & CENTER: the background must be plain solid white with no scenery, gradients, glow or bokeh. The central band (the middle ~46% of the width, top to bottom) must be COMPLETELY EMPTY: any plate, oval, panel, frame, character part — and even a single small floating coin, gem, sparkle or particle — inside that band is a FAIL. The only exception is one or two tiny decorative props near the very bottom edge of the band. A headline and CTA will be overlaid there later.",
  "4. TEXT: the ONLY lettering allowed is single short casino words organically placed on props (slot reels, chips, crates, medallions). The allowed list includes, non-exhaustively: FS, FREE SPINS, SCATTER, BONUS, VIP, WILD, 777, JACKPOT, MEGA WIN, RELOAD, SPIN. Never flag a word from this list or a similar single casino term. FAIL only for: phrases or sentences, headlines, CTA buttons, logos, brand names, watermarks.",
  "5. ANATOMY/ARTIFACTS: no deformed faces or hands, no extra limbs, no duplicated or melted objects, no visible generation artifacts. Intentional depth-of-field blur on small distant props is good design, NOT an artifact.",
  "6. EMAIL HERO FITNESS: a clear designer-grade focal hierarchy (a large anchor group of props in a lower corner, the main character on the opposite side, smaller props around); the character and key props fully inside the frame, not cut by the canvas edges.",
  'Respond with ONLY a JSON object, no prose, no markdown fences: {"pass": boolean, "score": number, "reasons": string[]}.',
  '"score" is 0-100 overall quality. "reasons" lists concrete failures (empty if pass). Write reasons in Russian.',
].join("\n");

/** Пользовательский промпт: бриф вариации + напоминание формата. */
export function buildQaPrompt(variationText: string, brandName: string): string {
  return [
    `Brand: ${brandName}.`,
    `Campaign brief: ${variationText.trim() || "(not specified)"}`,
    "Review the first image against the checklist and answer with the JSON object only.",
  ].join("\n");
}

/**
 * Разбор вердикта: модель иногда заворачивает JSON в ```fences``` или добавляет
 * слова вокруг — берём первый {...} блок. null → вызывающий делает один
 * ре-запрос «верни только JSON» (контракт R-2 из R-PLAN).
 */
export function parseVerdict(text: string): QaVerdict | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof raw.pass !== "boolean") return null;
    const score =
      typeof raw.score === "number" && Number.isFinite(raw.score)
        ? Math.max(0, Math.min(100, Math.round(raw.score)))
        : raw.pass
          ? 70
          : 0;
    const reasons = Array.isArray(raw.reasons)
      ? raw.reasons.filter((r): r is string => typeof r === "string").slice(0, 10)
      : [];
    return { pass: raw.pass, score, reasons };
  } catch {
    return null;
  }
}

/**
 * Стадия B: вердикт приёмщика по сгенерированной композиции.
 * `refUrls` — референсы пары (передаются первые QA_REFS_SHOWN).
 */
export async function reviewComposition(opts: {
  imageUrl: string;
  refUrls: string[];
  variationText: string;
  brandName: string;
}): Promise<QaVerdict> {
  const imageUrls = [opts.imageUrl, ...opts.refUrls.slice(0, QA_REFS_SHOWN)];
  const prompt = buildQaPrompt(opts.variationText, opts.brandName);

  const first = await runVisionQa({ prompt, imageUrls, systemPrompt: QA_SYSTEM_PROMPT });
  if (!first.success || !first.output) {
    return {
      pass: true,
      score: -1,
      reasons: [`qa-skipped: ${first.error ?? "vision недоступен"}`],
      skipped: true,
    };
  }
  const verdict = parseVerdict(first.output);
  if (verdict) return verdict;

  // Один ре-запрос со строгим напоминанием формата (R-2).
  const retry = await runVisionQa({
    prompt: `${prompt}\nYour previous answer was not valid JSON. Respond with ONLY the JSON object.`,
    imageUrls,
    systemPrompt: QA_SYSTEM_PROMPT,
  });
  if (retry.success && retry.output) {
    const second = parseVerdict(retry.output);
    if (second) return second;
  }
  return { pass: false, score: 0, reasons: ["qa-unparseable: приёмщик не вернул валидный JSON"] };
}
