import { describe, it, expect } from "vitest";
import { clampCreativeBrief, type CreativeBrief } from "../src/lib/creativeBrief.js";
import { TEST_PROMPTS } from "../src/lib/creativeBriefCorpus.js";

/**
 * Набор тест-промптов Фазы 2 (TASK §8: «15–20 тест-промптов, включая неполные
 * и противоречащие конфигу бренда»).
 *
 * ЧТО именно проверяется. Не «правильно ли модель разобрала промпт» — это
 * зависит от модели, недоступно офлайн и меняется от версии к версии. Здесь
 * проверяется ГАРАНТИЯ: что бы модель ни навыдумывала, кламп обязан вырезать
 * то, чего в промпте не было. Поэтому на вход каждому промпту подаётся
 * заведомо галлюцинирующий ответ — один и тот же для всех.
 *
 * Такой тест ловит регресс клампа, а не настроение LLM.
 */

/** Ответ модели, выдумавшей всё, что можно выдумать. */
const HALLUCINATED: CreativeBrief = {
  offer: {
    kind: "deposit_bonus",
    headline: "UP TO",
    amount: "500 000$",
    extras: ["+50 FREE SPINS"],
    cta: "Start Playing",
  },
  mood: "celebration",
  season: null,
  decorConcepts: ["coin", "chip", "spark"],
  paletteHint: "gold",
  lightMood: "warm golden glow",
  captions: ["BIG WIN", "SCATTER"],
  confidence: { offer: 1, scene: 1 },
};

describe("корпус тест-промптов: кламп держит гарантию на всех", () => {
  it("корпус содержит 15–20 промптов, как требует TASK §8", () => {
    expect(TEST_PROMPTS.length).toBeGreaterThanOrEqual(15);
    expect(TEST_PROMPTS.length).toBeLessThanOrEqual(20);
  });

  it("корпус покрывает все заявленные классы", () => {
    const kinds = new Set(TEST_PROMPTS.map((p) => p.kind));
    for (const required of ["complete", "mood-only", "incomplete", "contradictory", "edge"]) {
      expect(kinds, `не покрыт класс ${required}`).toContain(required);
    }
  });

  for (const p of TEST_PROMPTS) {
    describe(`[${p.kind}] ${p.id}`, () => {
      const out = clampCreativeBrief(HALLUCINATED, { campaignPrompt: p.prompt });

      it("сумма остаётся только если её цифры есть в промпте", () => {
        if (p.expectAmount) {
          expect(out.offer.amount).toBe("500 000$");
        } else {
          expect(out.offer.amount, `выдуманная сумма просочилась: ${p.prompt}`).toBeNull();
          // Ведущая строка без числа под ней — обрывок, а не оффер.
          expect(out.offer.headline).toBeNull();
        }
      });

      it("надписи остаются только те, что прозвучали в промпте", () => {
        expect(out.captions).toEqual(p.expectCaptions);
      });

      it("headline, CTA и extras переживают кламп только из промпта (D-N16)", () => {
        if (p.expectHeadline) expect(out.offer.headline).toBe("UP TO");
        else expect(out.offer.headline, `выдуманный headline просочился: ${p.prompt}`).toBeNull();
        if (p.expectCta) expect(out.offer.cta).toBe("Start Playing");
        else expect(out.offer.cta, `выдуманный CTA просочился: ${p.prompt}`).toBeNull();
        expect(out.offer.extras).toEqual(p.expectExtras ?? []);
      });

      it("никогда не выдаёт больше двух надписей и шести концептов", () => {
        expect(out.captions.length).toBeLessThanOrEqual(2);
        expect(out.decorConcepts.length).toBeLessThanOrEqual(6);
      });
    });
  }
});

describe("противоречащие промпты не ломают разбор", () => {
  it("промпт, требующий другой раскладки, каркас не меняет — его тут просто нет", () => {
    // Каркас в брифе не представлен ВООБЩЕ: описать его модель не может, даже
    // если промпт прямо просит. Это сильнее любой проверки постфактум.
    const out = clampCreativeBrief(HALLUCINATED, {
      campaignPrompt: "put the character on the LEFT and the item on the RIGHT, full-width text",
    });
    expect(Object.keys(out)).not.toContain("layout");
    expect(Object.keys(out)).not.toContain("slots");
  });

  it("промпт с чужим брендовым персонажем не порождает описания персонажа", () => {
    const out = clampCreativeBrief(HALLUCINATED, {
      campaignPrompt: "use a blonde woman croupier instead of the dog mascot",
    });
    expect(Object.keys(out)).not.toContain("personConcept");
  });
});
