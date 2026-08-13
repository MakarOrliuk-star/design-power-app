import { describe, it, expect, beforeEach, vi } from "vitest";

// Стиль-якорь кампании (TASK multiformat-promo, DI2-3): текстовое описание
// утверждённой email-композиции, которое уходит в промпт push/pop-up рядом с
// самой картинкой. Fail-open: без описания генерация не блокируется.
const visionMock = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/fal.js", () => ({ runVisionQa: visionMock }));

import {
  parseStyleAnchor,
  formatStyleAnchor,
  describeCampaignStyle,
} from "../src/lib/styleAnchor.js";

beforeEach(() => visionMock.mockReset());

const FULL = {
  palette: "deep purple with gold accents",
  character: "smiling blonde croupier in a red dress",
  hands: "human hands, five digits each",
  props: "gold coins, slot reels, poker chips",
  propInventory: "golden coin with a ruby, red poker chip, volumetric golden FS letter, purple gift box",
  lighting: "warm key light from the left",
  rendering: "glossy 3D advertising render",
};

describe("parseStyleAnchor", () => {
  it("разбирает JSON и обрезает лишние поля", () => {
    expect(parseStyleAnchor(JSON.stringify({ ...FULL, extra: "ignored" }))).toEqual(FULL);
  });

  it("вытаскивает JSON из ```fences``` и терпит частично заполненный ответ", () => {
    const parsed = parseStyleAnchor('```json\n{"palette": "neon purple"}\n```');
    expect(parsed).toEqual({
      palette: "neon purple",
      character: "",
      hands: "",
      props: "",
      propInventory: "",
      lighting: "",
      rendering: "",
    });
  });

  it("null на не-JSON и на пустом объекте (такой якорь бесполезен)", () => {
    expect(parseStyleAnchor("nice creative")).toBeNull();
    expect(parseStyleAnchor('{"palette": "", "props": ""}')).toBeNull();
  });
});

describe("formatStyleAnchor", () => {
  it("собирает абзац только из заполненных полей", () => {
    const text = formatStyleAnchor({ ...FULL, lighting: "", rendering: "" });
    expect(text).toContain("Palette: deep purple with gold accents");
    expect(text).toContain("Character: smiling blonde croupier");
    expect(text).not.toContain("Lighting:");
  });

  it("пустой якорь → пустая строка (в промпт ничего не добавится)", () => {
    expect(formatStyleAnchor(null)).toBe("");
  });

  // Правка 2026-08-15: анатомия рук кампании фиксируется утверждённым email —
  // push и pop-up получают её текстом, а не пересочиняют по референсам.
  it("руки героя уходят в промпт зависимых форматов отдельной строкой", () => {
    expect(formatStyleAnchor(FULL)).toContain("Hands (reproduce exactly): human hands, five digits each");
    // Рук в кадре не видно — строки нет, работает общее правило контракта.
    expect(formatStyleAnchor({ ...FULL, hands: "" })).not.toContain("Hands");
  });
});

describe("describeCampaignStyle", () => {
  it("отдаёт готовый абзац по вердикту VLM", async () => {
    visionMock.mockResolvedValue({ success: true, output: JSON.stringify(FULL) });
    const res = await describeCampaignStyle("https://cdn/email-base.png");
    expect(res.anchor).toEqual(FULL);
    expect(res.text).toContain("Campaign style to reproduce");
    const call = visionMock.mock.calls[0]![0] as { imageUrls: string[] };
    expect(call.imageUrls).toEqual(["https://cdn/email-base.png"]);
  });

  // Правка 2026-08-15: набор предметов кампании снимается ТЕМ ЖЕ запросом —
  // дополнительных обращений к VLM (и денег) правка не стоит.
  it("набор предметов отдаётся отдельным полем, бриф уходит в тот же запрос", async () => {
    visionMock.mockResolvedValue({ success: true, output: JSON.stringify(FULL) });
    const res = await describeCampaignStyle("https://cdn/email-base.png", "Lucky Friday reload");
    expect(res.propInventory).toBe(FULL.propInventory);
    // В абзац стиля перечисление НЕ дублируется — у него свой блок контракта.
    expect(res.text).not.toContain("volumetric golden FS letter");
    expect(visionMock).toHaveBeenCalledTimes(1);
    const call = visionMock.mock.calls[0]![0] as { prompt: string };
    expect(call.prompt).toContain("Campaign brief: Lucky Friday reload.");
  });

  it("транспортная ошибка → fail-open: пустой текст + причина", async () => {
    visionMock.mockResolvedValue({ success: false, error: "HTTP 500" });
    const res = await describeCampaignStyle("https://cdn/email-base.png");
    expect(res).toEqual({ text: "", propInventory: "", anchor: null, error: "HTTP 500" });
  });

  it("неразобранный ответ → fail-open с пометкой", async () => {
    visionMock.mockResolvedValue({ success: true, output: "просто текст" });
    const res = await describeCampaignStyle("https://cdn/email-base.png");
    expect(res.text).toBe("");
    expect(res.error).toBe("style-anchor-unparseable");
  });
});
