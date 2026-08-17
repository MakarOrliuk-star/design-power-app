import { describe, it, expect, beforeEach, vi } from "vitest";
import sharp from "sharp";

// Auto-healing композиции ai_reference (TASK safe-zone/auto-heal, B1–B4):
// re-edit забракованного кандидата по замечаниям приёмки, до 2 попыток,
// каждая — через stage C + VLM; победитель — лучший по score среди всех.

const fal = vi.hoisted(() => ({ runGptImage2Edit: vi.fn() }));
const fit = vi.hoisted(() => ({ fitAndStoreAsset: vi.fn() }));
const cache = vi.hoisted(() => ({ fetchBuffer: vi.fn() }));
const validator = vi.hoisted(() => ({ validateAiAsset: vi.fn() }));
const reviewer = vi.hoisted(() => ({ reviewComposition: vi.fn(), QA_REFS_SHOWN: 3 }));
// Текстовый детектор (TASK no-baked-text) — свои тесты в textScan.test.ts.
const textScan = vi.hoisted(() => ({ scanImageUrl: vi.fn(), newScanBudget: vi.fn() }));

vi.mock("../src/lib/fal.js", () => fal);
vi.mock("../src/lib/assetFit.js", () => fit);
vi.mock("../src/services/layerCache.js", () => cache);
vi.mock("../src/lib/aiAssetValidator.js", () => validator);
vi.mock("../src/lib/vlmReviewer.js", () => reviewer);
vi.mock("../src/lib/textScan.js", () => textScan);

import {
  buildHealingPrompt,
  healComposition,
  AI_HEAL_MAX_ATTEMPTS,
} from "../src/services/aiHealing.js";

const pngBuffer = await sharp({
  create: { width: 60, height: 30, channels: 3, background: { r: 255, g: 255, b: 255 } },
})
  .png()
  .toBuffer();

const OPTS = {
  source: {
    imageUrl: "https://cdn/bad.png",
    score: 55,
    reasons: ["свечение на заднем плане", "монеты в центральной полосе"],
  },
  targetW: 1200,
  targetH: 600,
  publicIdBase: "v1_email",
  folder: "bundles/bun1",
  logTag: "ai-ref#a1",
  refUrls: ["https://cdn/ref0.png", "https://cdn/ref1.png"],
  variationText: "VIP Exclusive campaign",
  brandName: "Betnella",
  centerClearZone: { x: 0.28, y: 0.08, w: 0.44, h: 0.62 },
};

beforeEach(() => {
  fal.runGptImage2Edit.mockReset();
  fit.fitAndStoreAsset.mockReset();
  cache.fetchBuffer.mockReset();
  validator.validateAiAsset.mockReset();
  reviewer.reviewComposition.mockReset();
  textScan.scanImageUrl.mockReset();

  fal.runGptImage2Edit.mockResolvedValue({ success: true, imageUrl: "https://fal/healed.png" });
  fit.fitAndStoreAsset.mockResolvedValue({ ok: true, url: "https://cdn/heal1.png", publicId: "h1" });
  cache.fetchBuffer.mockResolvedValue(pngBuffer);
  validator.validateAiAsset.mockResolvedValue({ passed: true, checks: [] });
  reviewer.reviewComposition.mockResolvedValue({ pass: true, score: 90, reasons: [] });
});

describe("buildHealingPrompt (B2)", () => {
  it("замечания приёмки + «ничего больше не менять» + инварианты safe-зоны", () => {
    const p = buildHealingPrompt(["свечение на фоне", "монета в центре"]);
    expect(p).toContain("- свечение на фоне");
    expect(p).toContain("- монета в центре");
    expect(p).toContain("change NOTHING else");
    expect(p).toContain("pure solid white");
    expect(p).toContain("COMPLETELY EMPTY");
    // TASK no-baked-text: прежнее «do not add any text» запрещало ДОБАВЛЯТЬ
    // надпись, но не велело стирать уже нарисованную — а «не меняй ничего»
    // выше по промпту прямо этому мешало.
    expect(p).toContain("never add any text");
    expect(p).toContain("ERASE that lettering");
  });

  it("строгий режим: стереть надпись, но сохранить сам предмет-носитель", () => {
    const p = buildHealingPrompt(["на изображении есть запечённый текст «FS»"]);
    // Без этой оговорки gpt-image-2 выпиливает вместе с надписью весь
    // носитель — барабан, фишку, ящик.
    expect(p).toContain("keep the object that carried it");
    expect(p).toContain("never delete the object");
    expect(p).toContain("Never replace the erased words with other words");
  });

  it("allowText=true: прежний хвост, требования стирать надписи нет", () => {
    const p = buildHealingPrompt(["свечение на фоне"], { allowText: true });
    expect(p).toContain("do not add any text");
    expect(p).not.toContain("ERASE that lettering");
  });

  it("пустой список замечаний → generic cleanup, промпт не ломается", () => {
    const p = buildHealingPrompt([]);
    expect(p).toContain("general quality cleanup");
  });

  // Правка 2026-08-15: лечение умеет ДОБАВЛЯТЬ пропсы в пустые бока — без
  // списка кампании оно дорисовывало что придётся, то есть возвращало рандом,
  // который убирает единый набор.
  it("добавляет предметы только из набора кампании, если он задан", () => {
    const set = "golden coin with a ruby, red poker chip";
    const p = buildHealingPrompt(["левая треть пустая"], {
      keepCenterClear: false,
      propInventory: set,
    });
    expect(p).toContain(`campaign prop set (${set})`);
    expect(p).toContain("REPLACE that object with one from the campaign prop set");
    // Без набора — прежняя формулировка «того же семейства».
    const noSet = buildHealingPrompt(["левая треть пустая"], { keepCenterClear: false });
    expect(noSet).toContain("ADD more floating props of the same family");
    expect(noSet).not.toContain("campaign prop set");
  });

  // Правка 2026-08-15: лечение досыпало предметы «в пустое место» и само
  // производило равномерную россыпь, из-за которой кадр и выглядит непродуманным.
  it("добавляет предметы в существующие группы и умеет пересобрать россыпь", () => {
    const p = buildHealingPrompt(["предметы расставлены равномерно"], { keepCenterClear: false });
    expect(p).toContain("attach them to the groups that already exist");
    expect(p).toContain("never place them at equal distances or in a neat row");
    expect(p).toContain("REARRANGE them into two or three overlapping groups");
    expect(p).toContain("keeping the same objects");
  });

  // Правка 2026-08-15: замечание про руку исполнимо только с явным
  // разрешением перерисовать кисть — «change NOTHING else» его запрещает.
  it("анатомия рук: разрешена перерисовка кисти в обоих профилях", () => {
    for (const opts of [{ keepCenterClear: true }, { keepCenterClear: false }]) {
      const p = buildHealingPrompt(["у героя четыре пальца на правой руке"], opts);
      expect(p).toContain("exactly five (four fingers and a thumb)");
      expect(p).toContain("redraw that hand completely");
      expect(p).toContain("hide it behind a prop");
      expect(p).toContain("never break a hand that was already correct");
    }
  });
});

describe("healComposition", () => {
  it("первая попытка прошла приёмку → победитель, второй edit не вызывается", async () => {
    const out = await healComposition(OPTS);

    expect(fal.runGptImage2Edit).toHaveBeenCalledTimes(1);
    const [args] = fal.runGptImage2Edit.mock.calls[0]!;
    // Лечится сам забракованный кадр, без референсов (не пересочинять).
    expect(args.imageUrls).toEqual(["https://cdn/bad.png"]);
    expect(args.prompt).toContain("- свечение на заднем плане");
    expect(args.width).toBe(1200);
    expect(args.height).toBe(600);
    // Хранится с детерминированным heal-суффиксом.
    expect(fit.fitAndStoreAsset).toHaveBeenCalledWith(
      "https://fal/healed.png",
      1200,
      600,
      "v1_email_heal1",
      "bundles/bun1",
      "ai-ref#a1@heal1",
    );
    // Контур контроля тот же: stage C, затем приёмщик с первыми референсами.
    expect(validator.validateAiAsset).toHaveBeenCalledTimes(1);
    expect(reviewer.reviewComposition).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrl: "https://cdn/heal1.png", brandName: "Betnella" }),
    );

    expect(out.winner).toEqual({
      imageUrl: "https://cdn/heal1.png",
      pass: true,
      score: 90,
      healingIndex: 0,
    });
    expect(out.attempts).toHaveLength(1);
  });

  it("первая не прошла, но улучшила score → вторая лечит ЕЁ по ЕЁ замечаниям", async () => {
    reviewer.reviewComposition
      .mockResolvedValueOnce({ pass: false, score: 70, reasons: ["новая монета"] })
      .mockResolvedValueOnce({ pass: true, score: 92, reasons: [] });
    fit.fitAndStoreAsset
      .mockResolvedValueOnce({ ok: true, url: "https://cdn/heal1.png", publicId: "h1" })
      .mockResolvedValueOnce({ ok: true, url: "https://cdn/heal2.png", publicId: "h2" });

    const out = await healComposition(OPTS);

    expect(fal.runGptImage2Edit).toHaveBeenCalledTimes(AI_HEAL_MAX_ATTEMPTS);
    const [second] = fal.runGptImage2Edit.mock.calls[1]!;
    expect(second.imageUrls).toEqual(["https://cdn/heal1.png"]); // score 70 > 55
    expect(second.prompt).toContain("- новая монета");
    expect(out.winner).toEqual({
      imageUrl: "https://cdn/heal2.png",
      pass: true,
      score: 92,
      healingIndex: 1,
    });
  });

  it("первая ухудшила score → вторая снова лечит исходник по исходным замечаниям", async () => {
    reviewer.reviewComposition
      .mockResolvedValueOnce({ pass: false, score: 20, reasons: ["всё расплылось"] })
      .mockResolvedValueOnce({ pass: false, score: 30, reasons: ["опять брак"] });

    const out = await healComposition(OPTS);

    const [second] = fal.runGptImage2Edit.mock.calls[1]!;
    expect(second.imageUrls).toEqual(["https://cdn/bad.png"]); // 20 < 55 — best остался исходник
    expect(second.prompt).toContain("- монеты в центральной полосе");
    // Обе не прошли и хуже исходника → победитель — исходник (B4: warning).
    expect(out.winner).toEqual({
      imageUrl: "https://cdn/bad.png",
      pass: false,
      score: 55,
      healingIndex: null,
    });
    expect(out.attempts).toHaveLength(2);
  });

  it("обе не прошли, но вторая лучше исходника → победитель — вылеченная с qaPassed=false", async () => {
    reviewer.reviewComposition
      .mockResolvedValueOnce({ pass: false, score: 40, reasons: ["брак"] })
      .mockResolvedValueOnce({ pass: false, score: 65, reasons: ["мелочь"] });
    fit.fitAndStoreAsset
      .mockResolvedValueOnce({ ok: true, url: "https://cdn/heal1.png", publicId: "h1" })
      .mockResolvedValueOnce({ ok: true, url: "https://cdn/heal2.png", publicId: "h2" });

    const out = await healComposition(OPTS);
    expect(out.winner).toEqual({
      imageUrl: "https://cdn/heal2.png",
      pass: false,
      score: 65,
      healingIndex: 1,
    });
  });

  it("транспортный сбой edit → попытка записана проваленной, цикл продолжается", async () => {
    fal.runGptImage2Edit
      .mockResolvedValueOnce({ success: false, error: "HTTP 503" })
      .mockResolvedValueOnce({ success: true, imageUrl: "https://fal/healed.png" });

    const out = await healComposition(OPTS);

    expect(out.attempts[0]).toEqual(
      expect.objectContaining({ imageUrl: null, pass: false, reasons: ["heal: HTTP 503"] }),
    );
    expect(out.winner.pass).toBe(true);
    expect(out.winner.healingIndex).toBe(1);
  });

  it("stage C забраковал вылеченную → она не кандидат, приёмщик не тратится", async () => {
    validator.validateAiAsset.mockResolvedValue({
      passed: false,
      checks: [{ key: "center", passed: false, detail: "мусор в центре" }],
    });

    const out = await healComposition(OPTS);

    expect(reviewer.reviewComposition).not.toHaveBeenCalled();
    expect(out.winner).toEqual({
      imageUrl: "https://cdn/bad.png",
      pass: false,
      score: 55,
      healingIndex: null,
    });
    expect(out.attempts.every((a) => !a.pass)).toBe(true);
    expect(out.attempts[0]!.reasons[0]).toContain("center");
  });
});

// TASK multiformat-promo (DI2-4): у push/pop-up copy space нет — лечение не
// имеет права выгрызать середину кадра ради несуществующего требования.
describe("лечение зависимых форматов (DI2-4)", () => {
  it("keepCenterClear=false убирает требование пустого центра, инварианты фона остаются", () => {
    const p = buildHealingPrompt(["лишняя рука"], { keepCenterClear: false });
    expect(p).not.toContain("COMPLETELY EMPTY");
    expect(p).toContain("this format has no reserved copy space");
    expect(p).toContain("pure solid white");
    expect(p).toContain("never add any text");
  });

  it("без centerClearZone: чек центра не выполняется, приёмка идёт профилем secondary", async () => {
    const { centerClearZone: _drop, ...withoutZone } = OPTS;
    await healComposition({
      ...withoutZone,
      profile: "secondary",
      anchorUrl: "https://cdn/email-base.png",
      formatLabel: "Push",
      maxAttempts: 1,
    });
    const techOpts = validator.validateAiAsset.mock.calls[0]![3];
    expect(techOpts).toEqual({});
    const [qaArgs] = reviewer.reviewComposition.mock.calls[0]!;
    expect(qaArgs.profile).toBe("secondary");
    expect(qaArgs.anchorUrl).toBe("https://cdn/email-base.png");
    const [genArgs] = fal.runGptImage2Edit.mock.calls[0]!;
    expect(genArgs.prompt).not.toContain("COMPLETELY EMPTY");
  });
});

/**
 * Текстовый гейт внутри лечения (TASK no-baked-text): перескан каждой
 * вылеченной версии и правило «чистая побеждает грязную независимо от score».
 */
describe("лечение и запечённый текст", () => {
  const budget = { deadline: Date.now() + 120_000 };
  const scan = (hasText: boolean, text = "") => ({
    md5: "m", hasText, text, confidence: 0.9, approvedOk: false,
  });

  it("вылеченная версия пересканируется: текст остался → приёмка не спасает", async () => {
    // Ретушь прошла приёмку с высоким score, но надпись на месте.
    reviewer.reviewComposition.mockResolvedValue({ pass: true, score: 92, reasons: [] });
    textScan.scanImageUrl.mockResolvedValue(scan(true, "FS"));

    const out = await healComposition({
      ...OPTS,
      source: { ...OPTS.source, textClean: false },
      textBudget: budget,
    });

    // Победы нет — цикл отработал все попытки, а не принял грязную с ходу.
    expect(fal.runGptImage2Edit).toHaveBeenCalledTimes(AI_HEAL_MAX_ATTEMPTS);
    expect(out.winner.textClean).toBe(false);
    expect(out.winner.textFound).toBe("FS");
    expect(out.textScanned).toBe(AI_HEAL_MAX_ATTEMPTS);
  });

  it("чистая версия побеждает грязный исходник даже с меньшим score", async () => {
    // Исходник: score 55 и надпись. Ретушь: score 40, но чисто.
    reviewer.reviewComposition.mockResolvedValue({ pass: false, score: 40, reasons: ["композиция"] });
    textScan.scanImageUrl.mockResolvedValue(scan(false));

    const out = await healComposition({
      ...OPTS,
      source: { ...OPTS.source, textClean: false },
      textBudget: budget,
    });

    expect(out.winner.imageUrl).toBe("https://cdn/heal1.png");
    expect(out.winner.score).toBe(40); // score ниже исходных 55 — и это верно
    expect(out.winner.textClean).toBe(true);
  });

  it("победа только когда сошлись оба контура: приёмка И чистота", async () => {
    reviewer.reviewComposition.mockResolvedValue({ pass: true, score: 90, reasons: [] });
    textScan.scanImageUrl.mockResolvedValue(scan(false));

    const out = await healComposition({
      ...OPTS,
      source: { ...OPTS.source, textClean: false },
      textBudget: budget,
    });
    // Первая же попытка закрывает оба условия — второй вызов не нужен.
    expect(fal.runGptImage2Edit).toHaveBeenCalledTimes(1);
    expect(out.winner.pass).toBe(true);
    expect(out.winner.textClean).toBe(true);
  });

  it("без textBudget гейт выключен: сканов нет, поведение прежнее", async () => {
    reviewer.reviewComposition.mockResolvedValue({ pass: true, score: 90, reasons: [] });
    const out = await healComposition(OPTS);
    expect(textScan.scanImageUrl).not.toHaveBeenCalled();
    expect(out.winner.textClean).toBeUndefined();
    expect(out.textScanned).toBeUndefined();
  });
});
