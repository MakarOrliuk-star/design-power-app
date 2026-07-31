import { describe, it, expect } from "vitest";
import {
  CREATIVE_BRIEF_SYSTEM_PROMPT,
  buildCreativeBriefUserMessage,
  captionAppearsInBrief,
  clampCreativeBrief,
  lightMoodNamesObject,
  parseCreativeBrief,
  type CreativeBrief,
} from "../src/lib/creativeBrief.js";

/**
 * Creative Brief (Фаза 2). Тесты бьют по КЛАМПУ, а не по модели: схема ловит
 * неверные типы, а кламп — правдоподобную выдумку внутри допустимых типов.
 * Именно она опасна: «500 000$», которых не было в брифе, дойдёт до клиента.
 */

const base: CreativeBrief = {
  offer: { kind: "reload", headline: null, amount: null, extras: [], cta: null },
  mood: "celebration",
  season: null,
  decorConcepts: ["coin", "spark"],
  paletteHint: "gold",
  lightMood: "bright warm golden burst",
  captions: [],
  confidence: { offer: 0.9, scene: 0.8 },
};

const json = (b: unknown) => JSON.stringify(b);

describe("схема и разбор ответа", () => {
  it("снимает ```-ограду, которую модели ставят вопреки инструкции", () => {
    const text = "```json\n" + json(base) + "\n```";
    expect(parseCreativeBrief(text, { campaignPrompt: "" })).not.toBeNull();
  });

  it("мусор вместо JSON → null, а не исключение", () => {
    expect(parseCreativeBrief("извините, не могу", { campaignPrompt: "" })).toBeNull();
  });

  it("несуществующий offer.kind → null (рендер уйдёт на дефолты)", () => {
    const bad = { ...base, offer: { ...base.offer, kind: "megabonus" } };
    expect(parseCreativeBrief(json(bad), { campaignPrompt: "" })).toBeNull();
  });

  it("лишние поля модели не ломают разбор", () => {
    const extra = { ...base, somethingElse: 42 };
    expect(parseCreativeBrief(json(extra), { campaignPrompt: "" })).not.toBeNull();
  });
});

describe("кламп надписей — правило 2", () => {
  it("надпись, которой не было в брифе, выбрасывается", () => {
    const out = clampCreativeBrief(
      { ...base, captions: ["BIG WIN"] },
      { campaignPrompt: "Weekend reload promotion with bonus energy." },
    );
    expect(out.captions).toEqual([]);
  });

  it("надпись из брифа остаётся", () => {
    const out = clampCreativeBrief(
      { ...base, captions: ["FREE SPINS"] },
      { campaignPrompt: "Get 50 free spins this weekend" },
    );
    expect(out.captions).toEqual(["FREE SPINS"]);
  });

  it("сравнение игнорирует пунктуацию и регистр", () => {
    expect(captionAppearsInBrief("50 FREE SPINS", "…and +50 free-spins on top!")).toBe(true);
  });

  it("пустой список надписей — валидный ответ, а не сбой", () => {
    const out = clampCreativeBrief({ ...base, captions: [] }, { campaignPrompt: "любой" });
    expect(out.captions).toEqual([]);
  });

  it("не больше двух надписей: слотов ровно два", () => {
    const out = clampCreativeBrief(
      { ...base, captions: ["ONE", "TWO"] },
      { campaignPrompt: "ONE TWO" },
    );
    expect(out.captions.length).toBeLessThanOrEqual(2);
  });
});

describe("кламп lightMood — правило 4", () => {
  it.each([
    ["golden coins glowing", "объект"],
    ["light behind the character", "персонаж"],
    ["glow on the left side", "раскладка"],
    ["sparkling stars everywhere", "объект во множественном числе"],
  ])("«%s» обнуляется (%s)", (mood) => {
    const out = clampCreativeBrief({ ...base, lightMood: mood }, { campaignPrompt: "" });
    expect(out.lightMood).toBe("");
  });

  it("чистое описание света остаётся", () => {
    const out = clampCreativeBrief(
      { ...base, lightMood: "warm amber glow, high energy" },
      { campaignPrompt: "" },
    );
    expect(out.lightMood).toBe("warm amber glow, high energy");
  });

  it("ловит и концепты, названные самой моделью", () => {
    expect(lightMoodNamesObject("soft glow around the katana", ["katana"])).toBe(true);
  });
});

describe("кламп концептов декора — правило 3", () => {
  it("отбрасывает всё, что не короткое латинское существительное", () => {
    const out = clampCreativeBrief(
      { ...base, decorConcepts: ["coin", "Золотая Монета", "gift box!", "spark", "gift_box"] },
      { campaignPrompt: "" },
    );
    expect(out.decorConcepts).toEqual(["coin", "spark", "gift_box"]);
  });

  it("схлопывает дубликаты и приводит к нижнему регистру", () => {
    const out = clampCreativeBrief(
      { ...base, decorConcepts: ["Coin", "coin", "COIN"] },
      { campaignPrompt: "" },
    );
    expect(out.decorConcepts).toEqual(["coin"]);
  });

  it("концепт, которого нет в библиотеке, НЕ выбрасывается — он будет сгенерирован", () => {
    // Кламп вообще не знает про содержимое библиотеки: у ClampContext нет
    // такого поля. Библиотека необязательна (D-N7'), белым списком быть не
    // может — иначе первая же сезонная акция упрётся в её пустоту.
    const out = clampCreativeBrief({ ...base, decorConcepts: ["katana"] }, { campaignPrompt: "" });
    expect(out.decorConcepts).toEqual(["katana"]);
  });
});

describe("уверенность", () => {
  it("зажимается в 0..1, мусор становится нулём", () => {
    const out = clampCreativeBrief(
      { ...base, confidence: { offer: 7, scene: Number.NaN } },
      { campaignPrompt: "" },
    );
    expect(out.confidence).toEqual({ offer: 1, scene: 0 });
  });
});

describe("промпт-контракт", () => {
  it("запрещает описывать персонажа и предмет (D-N10)", () => {
    expect(CREATIVE_BRIEF_SYSTEM_PROMPT).toMatch(/You do NOT describe them/);
  });

  it("запрещает выдумывать сумму — самая дорогая ошибка", () => {
    expect(CREATIVE_BRIEF_SYSTEM_PROMPT).toMatch(/Do NOT\s+invent an amount/);
  });

  it("запрещает координаты и слова раскладки (D-E4')", () => {
    expect(CREATIVE_BRIEF_SYSTEM_PROMPT).toMatch(/Never output coordinates/);
  });

  it("пустая библиотека подаётся подсказкой, а не ограничением", () => {
    const msg = buildCreativeBriefUserMessage({
      campaignPrompt: "x",
      brandName: "B",
      assetKey: "email",
      availableConcepts: [],
    });
    expect(msg).toMatch(/\(none — will be generated\)/);
  });

  it("непустая библиотека перечисляет теги, а не URL", () => {
    const msg = buildCreativeBriefUserMessage({
      campaignPrompt: "x",
      brandName: "B",
      assetKey: "email",
      availableConcepts: ["coin", "chip"],
    });
    expect(msg).toContain("coin, chip");
    expect(msg).not.toMatch(/https?:/);
  });
});
