import { describe, it, expect, beforeEach, vi } from "vitest";

// Приемщик (TASK ai-reference, стадия B): контракт JSON-вердикта + fail-open
// на транспортных ошибках и fail-closed на неразобранном ответе (R-2).
const visionMock = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/fal.js", () => ({ runVisionQa: visionMock }));

import {
  parseVerdict,
  reviewComposition,
  applyThreshold,
  qaThreshold,
  buildQaSystemPrompt,
  DEFAULT_QA_THRESHOLD,
  QA_REFS_SHOWN,
} from "../src/lib/vlmReviewer.js";

beforeEach(() => {
  visionMock.mockReset();
  vi.unstubAllEnvs();
});

describe("parseVerdict", () => {
  it("разбирает чистый JSON", () => {
    expect(parseVerdict('{"pass": true, "score": 88, "reasons": []}')).toEqual({
      pass: true,
      score: 88,
      reasons: [],
    });
  });

  it("вытаскивает JSON из ```fences``` и прозы вокруг", () => {
    const text = 'Вот мой вердикт:\n```json\n{"pass": false, "score": 30, "reasons": ["текст на баннере"]}\n```';
    expect(parseVerdict(text)).toEqual({ pass: false, score: 30, reasons: ["текст на баннере"] });
  });

  it("зажимает score в 0..100 и дефолтит его по pass", () => {
    expect(parseVerdict('{"pass": true, "score": 250}')!.score).toBe(100);
    expect(parseVerdict('{"pass": true}')!.score).toBe(70);
    expect(parseVerdict('{"pass": false}')!.score).toBe(0);
  });

  it("null на не-JSON и на JSON без boolean pass", () => {
    expect(parseVerdict("nice image!")).toBeNull();
    expect(parseVerdict('{"score": 50}')).toBeNull();
  });
});

describe("reviewComposition", () => {
  const opts = {
    imageUrl: "https://cdn/gen.png",
    refUrls: ["https://cdn/r1.png", "https://cdn/r2.png", "https://cdn/r3.png", "https://cdn/r4.png"],
    variationText: "VIP Exclusive weekend",
    brandName: "Betnella",
  };

  it("первым изображением идёт результат, референсы обрезаются до QA_REFS_SHOWN", async () => {
    visionMock.mockResolvedValue({ success: true, output: '{"pass": true, "score": 90, "reasons": []}' });
    const verdict = await reviewComposition(opts);
    expect(verdict.pass).toBe(true);
    const call = visionMock.mock.calls[0]![0] as { imageUrls: string[] };
    expect(call.imageUrls[0]).toBe("https://cdn/gen.png");
    expect(call.imageUrls).toHaveLength(1 + QA_REFS_SHOWN);
  });

  it("транспортная ошибка → приёмка пропущена (fail-open), не брак", async () => {
    visionMock.mockResolvedValue({ success: false, error: "HTTP 500" });
    const verdict = await reviewComposition(opts);
    expect(verdict.pass).toBe(true);
    expect(verdict.skipped).toBe(true);
    expect(verdict.reasons[0]).toContain("qa-skipped");
  });

  it("неразобранный ответ → один ре-запрос; повторный сбой = брак попытки", async () => {
    visionMock.mockResolvedValue({ success: true, output: "какой хороший баннер" });
    const verdict = await reviewComposition(opts);
    expect(visionMock).toHaveBeenCalledTimes(2);
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("qa-unparseable");
  });

  it("ре-запрос с валидным JSON спасает попытку", async () => {
    visionMock
      .mockResolvedValueOnce({ success: true, output: "не json" })
      .mockResolvedValueOnce({ success: true, output: '{"pass": false, "score": 40, "reasons": ["анатомия"]}' });
    const verdict = await reviewComposition(opts);
    expect(verdict).toEqual({ pass: false, score: 40, reasons: ["анатомия"] });
  });
});

// TASK multiformat-promo (DI2-5): «% приемки» — числовой порог, а не только
// булев вердикт модели. Слабая, но формально принятая картинка теперь уходит
// в авто-ретрай сама, без ручного Regenerate.
describe("порог приёмки (DI2-5)", () => {
  it("дефолт 80, ENV переопределяет и зажимается в 0..100", () => {
    expect(qaThreshold()).toBe(DEFAULT_QA_THRESHOLD);
    vi.stubEnv("AI_REF_QA_THRESHOLD", "92");
    expect(qaThreshold()).toBe(92);
    vi.stubEnv("AI_REF_QA_THRESHOLD", "500");
    expect(qaThreshold()).toBe(100);
    vi.stubEnv("AI_REF_QA_THRESHOLD", "мусор");
    expect(qaThreshold()).toBe(DEFAULT_QA_THRESHOLD);
  });

  it("pass:true со score ниже порога отменяется, причина видна человеку", () => {
    const verdict = applyThreshold({ pass: true, score: 68, reasons: [] }, 80);
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toBe("оценка приёмки 68 ниже порога 80");
  });

  it("score на пороге проходит, чужие причины сохраняются", () => {
    expect(applyThreshold({ pass: true, score: 80, reasons: [] }, 80).pass).toBe(true);
    const failed = applyThreshold({ pass: false, score: 10, reasons: ["анатомия"] }, 80);
    expect(failed.reasons).toEqual(["анатомия"]);
  });

  it("порог применяется в reviewComposition поверх ответа модели", async () => {
    vi.stubEnv("AI_REF_QA_THRESHOLD", "85");
    visionMock.mockResolvedValue({
      success: true,
      output: '{"pass": true, "score": 80, "reasons": []}',
    });
    const verdict = await reviewComposition({
      imageUrl: "https://cdn/gen.png",
      refUrls: [],
      variationText: "VIP",
      brandName: "Betnella",
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.score).toBe(80);
  });
});

// TASK multiformat-promo (DI2-4): у push/pop-up нет copy space, зато есть
// сверка с якорной композицией кампании.
describe("профили чек-листа (DI2-4)", () => {
  it("якорный профиль требует пустой центр, зависимый — нет", () => {
    const anchor = buildQaSystemPrompt("anchor");
    const secondary = buildQaSystemPrompt("secondary");
    expect(anchor).toContain("central band");
    expect(anchor).toContain("COMPLETELY EMPTY");
    expect(secondary).not.toContain("COMPLETELY EMPTY");
    expect(secondary).toContain("NO required empty copy space");
  });

  // TASK glow-fade-density, задание 3 (DI3-12): перегруз ловит приёмщик и
  // отправляет попытку в авто-ретрай, а не показывает её человеку.
  it("зависимый профиль считает предметы по числу из конфига", () => {
    const secondary = buildQaSystemPrompt("secondary", { maxProps: 10 });
    expect(secondary).toContain("PROP DENSITY");
    expect(secondary).toContain("between 8 and 10 props");
    expect(secondary).toContain("more than 10");
    expect(secondary).toContain("slot machine");
    // Правка 2026-08-13: пункт двусторонний — пустой кадр тоже брак.
    expect(secondary).toContain("fewer than 8 floating props and the frame looks empty");
    // Число подставляется, а не зашито: дефолт остаётся дефолтом.
    expect(buildQaSystemPrompt("secondary")).toContain("between 8 and 14 props");
  });

  it("размытие пропсов — приём, а не артефакт; пустые бока — брак", () => {
    const secondary = buildQaSystemPrompt("secondary");
    expect(secondary).toContain("FOCUS VARIETY");
    expect(secondary).toContain("left and right thirds of the canvas are visibly empty");
    expect(secondary).toContain("only a blurry HERO is a defect");
  });

  it("пункт про плотность отсутствует в якорном профиле (DI3-10)", () => {
    expect(buildQaSystemPrompt("anchor", { maxProps: 5 })).not.toContain("PROP DENSITY");
  });

  // Правка 2026-08-13: пункт про «проще якоря» снят — заказчик просил больше
  // предметов на всех форматах, и требование «будь проще» тянуло в пустоту.
  it("другая раскладка по-прежнему не брак, но про «проще якоря» речи нет", () => {
    const secondary = buildQaSystemPrompt("secondary");
    expect(secondary).toContain("a different layout, crop or aspect ratio is CORRECT");
    expect(secondary).not.toContain("simpler and airier");
  });

  // Правка 2026-08-15 (заказчик: «чтобы на руке не было 4 пальца, хотя должно
  // быть 5»): пункт артефактов формулировал брак оценочно и приёмщик его
  // пропускал — теперь пальцы велено ПОСЧИТАТЬ, а эталон берётся с референсов.
  // Правка 2026-08-15 (заказчик: «предметы не должны быть рандомными — общая
  // композиция промо»): у зависимого формата инвентарь кампании фиксирован,
  // и приёмщик сверяет кадр с ним, а не с «семейством вообще».
  // Правка 2026-08-15: до неё приёмка считала предметы и мерила резкость, но
  // про раскладку не спрашивала ничего — ровный ковёр проходил её без замечаний.
  it("приёмщик судит композицию предметов, а не только их число", () => {
    const secondary = buildQaSystemPrompt("secondary");
    expect(secondary).toContain("PROP COMPOSITION");
    expect(secondary).toContain("composed by a designer, not scattered");
    expect(secondary).toContain("evenly spaced like stickers");
    // Группы — приём, а не перекос: пункт про формат переформулирован.
    expect(secondary).toContain("groups are correct, but everything piled on one side");
    expect(secondary).not.toContain("rather than clustered on one side");
    // Коридор из админки уходит в чек-лист целиком, обе границы.
    expect(buildQaSystemPrompt("secondary", { minProps: 10, maxProps: 16 })).toContain(
      "between 10 and 16 props",
    );
    // Композиция — требование зависимых форматов: email заказчик утвердил.
    expect(buildQaSystemPrompt("anchor")).not.toContain("PROP COMPOSITION");
  });

  it("набор предметов кампании становится критерием приёмки", () => {
    const set = "golden coin with a ruby, red poker chip, purple gift box";
    const withSet = buildQaSystemPrompt("secondary", { maxProps: 10, propInventory: set });
    expect(withSet).toContain("CAMPAIGN PROP SET");
    expect(withSet).toContain(set);
    expect(withSet).toContain("repeats at different sizes and angles are fine");
    // Раскладка по-прежнему своя — судим инвентарь, а не компоновку.
    expect(withSet).toContain("judge the inventory, never the layout");
    // Прежняя формулировка «другие объекты — это правильно» снимается: она
    // прямо противоречила бы требованию единого набора.
    expect(withSet).not.toContain("DIFFERENT OBJECTS are also CORRECT");
  });

  it("без набора (legacy-бандл) остаётся прежняя свобода выбора предметов", () => {
    const noSet = buildQaSystemPrompt("secondary", { maxProps: 10 });
    expect(noSet).toContain("DIFFERENT OBJECTS are also CORRECT");
    expect(noSet).not.toContain("CAMPAIGN PROP SET");
    // Набор — только у зависимых форматов: якорь его и задаёт.
    expect(buildQaSystemPrompt("anchor", { propInventory: "золото" })).not.toContain(
      "CAMPAIGN PROP SET",
    );
  });

  it("руки проверяются в обоих профилях: счёт пальцев и сверка с референсами", () => {
    for (const p of [buildQaSystemPrompt("anchor"), buildQaSystemPrompt("secondary", { maxProps: 10 })]) {
      expect(p).toContain("HANDS & DIGITS");
      expect(p).toContain("COUNT the digits");
      expect(p).toContain("exactly five digits: four fingers and one thumb");
      // Лапы/копыта — норма бренда, эталон задают референсы, а не пятерня.
      expect(p).toContain("animal paws with claws, hooves");
      expect(p).toContain("SAME number of digits as the references");
      // Спрятанная кисть — не брак: иначе нормальный кадр уходит в ретрай.
      expect(p).toContain("hidden behind a prop, behind the body or outside the crop is NOT a defect");
    }
  });

  it("пол героя проверяется в обоих профилях и только при тон-варианте", () => {
    expect(buildQaSystemPrompt("anchor", { gender: "male" })).toContain("must be a MAN");
    expect(buildQaSystemPrompt("secondary", { maxProps: 10, gender: "female" })).toContain("must be a WOMAN");
    expect(buildQaSystemPrompt("anchor")).not.toContain("HERO GENDER");
  });

  // Правка 2026-08-13: приёмщик судит персонажа по режиму бренда — иначе
  // вариативный герой браковался, а точная копия проходила там, где нужна
  // вариативность.
  it("режим сходства персонажа меняет пункт STYLE в обоих профилях", () => {
    const exact = buildQaSystemPrompt("anchor", { fidelity: "exact" });
    expect(exact).toContain("mascot is fixed");
    expect(exact).toContain("A redesigned or restyled character is a FAIL");

    const variant = buildQaSystemPrompt("anchor", { fidelity: "variant" });
    expect(variant).toContain("allows a variation of its character");
    expect(variant).toContain("must never be reported as a defect");

    // Дефолт — вариативный (решение заказчика 2026-08-13).
    expect(buildQaSystemPrompt("anchor")).toContain("allows a variation");
    expect(buildQaSystemPrompt("secondary", { maxProps: 10, fidelity: "exact" })).toContain("mascot is fixed");
  });

  it("якорный профиль требует богатых боковых групп, не трогая центр", () => {
    const anchor = buildQaSystemPrompt("anchor");
    expect(anchor).toContain("RICHNESS");
    expect(anchor).toContain("sparse composition");
    expect(anchor).toContain("does NOT apply to the central band");
  });

  it("зависимый профиль сверяет стиль с якорем и не считает другую раскладку браком", () => {
    const secondary = buildQaSystemPrompt("secondary");
    expect(secondary).toContain("CAMPAIGN STYLE MATCH");
    expect(secondary).toContain("a different layout, crop or aspect ratio is CORRECT");
  });

  it("якорь показывается приёмщику вторым изображением, перед референсами формата", async () => {
    visionMock.mockResolvedValue({
      success: true,
      output: '{"pass": true, "score": 95, "reasons": []}',
    });
    await reviewComposition({
      imageUrl: "https://cdn/push.png",
      refUrls: ["https://cdn/pr1.png", "https://cdn/pr2.png"],
      variationText: "VIP",
      brandName: "Betnella",
      profile: "secondary",
      anchorUrl: "https://cdn/email-base.png",
      formatLabel: "Push",
    });
    const call = visionMock.mock.calls[0]![0] as { imageUrls: string[]; prompt: string };
    expect(call.imageUrls).toEqual([
      "https://cdn/push.png",
      "https://cdn/email-base.png",
      "https://cdn/pr1.png",
      "https://cdn/pr2.png",
    ]);
    expect(call.prompt).toContain("Format: Push.");
  });
});
