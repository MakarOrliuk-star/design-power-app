import { describe, it, expect, beforeEach, vi } from "vitest";

// Приемщик (TASK ai-reference, стадия B): контракт JSON-вердикта + fail-open
// на транспортных ошибках и fail-closed на неразобранном ответе (R-2).
const visionMock = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/fal.js", () => ({ runVisionQa: visionMock }));

import { parseVerdict, reviewComposition, QA_REFS_SHOWN } from "../src/lib/vlmReviewer.js";

beforeEach(() => visionMock.mockReset());

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
