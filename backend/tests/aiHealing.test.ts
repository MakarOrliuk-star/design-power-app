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

vi.mock("../src/lib/fal.js", () => fal);
vi.mock("../src/lib/assetFit.js", () => fit);
vi.mock("../src/services/layerCache.js", () => cache);
vi.mock("../src/lib/aiAssetValidator.js", () => validator);
vi.mock("../src/lib/vlmReviewer.js", () => reviewer);

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
    expect(p).toContain("do not add any text");
  });

  it("пустой список замечаний → generic cleanup, промпт не ломается", () => {
    const p = buildHealingPrompt([]);
    expect(p).toContain("general quality cleanup");
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
