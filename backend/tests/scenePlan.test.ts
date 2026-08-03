import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { buildScenePlan, sampleCorridor, type ScenePlan } from "../src/services/scenePlan.js";
import { checkAgainstSpec, type PatternSpec } from "../src/lib/patternMiner.js";
import { clampCreativeBrief, type CreativeBrief } from "../src/lib/creativeBrief.js";
import { mineCorpus } from "../scripts/mine-pattern.js";

/**
 * Scene Planner (Фаза 2). DoD: по произвольному промпту получается валидный
 * план; изменение промпта заметно меняет СОДЕРЖИМОЕ слотов при НЕИЗМЕННОМ
 * каркасе; повтор идентичен.
 *
 * Коридоры берутся из настоящей добытой спеки, а не из выдуманных чисел —
 * иначе тест проверял бы фикстуру, а не связку майнер → планировщик.
 */

const EXAMPLES = path.resolve(__dirname, "../../figma/crm-bundle/examples");
const CANVAS = { w: 1200, h: 600 };

let spec: PatternSpec;

beforeAll(async () => {
  spec = (await mineCorpus(EXAMPLES)).spec;
}, 120_000);

/** Бриф в том виде, в каком его отдаёт кламп — то есть уже проверенный. */
function brief(over: Partial<CreativeBrief> = {}, campaignPrompt = ""): CreativeBrief {
  return clampCreativeBrief(
    {
      offer: { kind: "reload", headline: null, amount: null, extras: [], cta: null },
      mood: "celebration",
      season: null,
      decorConcepts: ["coin", "spark", "star"],
      paletteHint: "gold",
      lightMood: "bright warm golden burst",
      captions: [],
      confidence: { offer: 0.9, scene: 0.8 },
      ...over,
    },
    { campaignPrompt },
  );
}

const plan = (over?: Partial<CreativeBrief>, seed = "seed-a", campaignPrompt = "", rest = {}) =>
  buildScenePlan({
    brief: brief(over, campaignPrompt),
    patternSpec: spec,
    seed,
    canvas: CANVAS,
    ...rest,
  });

/** Каркас — то, что обязано совпадать у любых двух планов (§4.2.1). */
function frameOf(p: ScenePlan) {
  return p.slots.map((s) => `${s.zone}`).sort().join("|");
}

describe("детерминизм — D-E4' и DoD Фазы 2", () => {
  it("те же входы и seed → побайтово тот же план", () => {
    expect(JSON.stringify(plan(undefined, "bundle-1"))).toBe(
      JSON.stringify(plan(undefined, "bundle-1")),
    );
  });

  it("другой seed → другие числа, но тот же каркас", () => {
    const a = plan(undefined, "bundle-1");
    const b = plan(undefined, "bundle-2");
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(frameOf(a)).toBe(frameOf(b));
  });

  it("план несёт версию спеки и хэш корпуса — иначе не ответить, почему съехало", () => {
    const p = plan();
    expect(p.patternSpecVersion).toBe(spec.specVersion);
    expect(p.patternCorpusHash).toBe(spec.corpusHash);
  });
});

describe("каркас — инвариант, содержимое — переменная (D-C8)", () => {
  it("item слева, person справа, центр под текст — всегда", () => {
    const p = plan();
    const byId = new Map(p.slots.map((s) => [s.id, s]));
    expect(byId.get("hero-item")!.zone).toBe("hero-left");
    expect(byId.get("hero-person")!.zone).toBe("hero-right");
    expect(p.textOverlay.safeZone).toEqual({ x: 0.25, y: 1 / 3, w: 0.47, h: 1 / 3 });
  });

  it("scene-top и scene-bottom заполняются всегда (D-C5)", () => {
    const zones = plan().slots.map((s) => s.zone);
    expect(zones).toContain("scene-top");
    expect(zones).toContain("scene-bottom");
  });

  it("другой промпт меняет содержимое слотов, каркас не трогает", () => {
    const a = plan({ decorConcepts: ["coin", "chip"], lightMood: "warm gold" });
    const b = plan({ decorConcepts: ["petal_sakura"], lightMood: "cool pink haze", season: "sakura" });
    expect(frameOf(a)).toBe(frameOf(b));
    expect(a.slots.find((s) => s.id === "decor-top")!.concepts).not.toEqual(
      b.slots.find((s) => s.id === "decor-top")!.concepts,
    );
    expect(a.background.lightPrompt).not.toBe(b.background.lightPrompt);
  });
});

describe("опциональные слоты — ответ на вопрос 8", () => {
  it("без надписей зона hero-left добирается декором, а не остаётся с одиноким предметом", () => {
    const ids = plan({ captions: [] }).slots.map((s) => s.id);
    expect(ids).toContain("left-fill-decor");
    expect(ids).not.toContain("left-fill");
  });

  it("надпись из брифа занимает слот вместо декора", () => {
    const p = plan({ captions: ["FREE SPINS"] }, "s", "get 50 free spins");
    const slot = p.slots.find((s) => s.id === "left-fill");
    expect(slot?.text).toBe("FREE SPINS");
    expect(p.slots.map((s) => s.id)).not.toContain("left-fill-decor");
  });

  it("слот held появляется только при второй надписи и ставится РЯДОМ с персонажем", () => {
    expect(plan({ captions: [] }).slots.map((s) => s.id)).not.toContain("held");
    const p = plan({ captions: ["BIG WIN", "X2"] }, "s", "BIG WIN X2 today");
    expect(p.slots.find((s) => s.id === "held")?.placement).toBe("beside-person");
  });
});

describe("числа приходят из коридоров, а не из кода", () => {
  it("высоты кластеров лежат в коридорах спеки", () => {
    const p = plan();
    const item = p.slots.find((s) => s.id === "hero-item")!.clusterHeightPct!;
    const person = p.slots.find((s) => s.id === "hero-person")!.clusterHeightPct!;
    const ci = spec.corridors.itemClusterHeightPct!;
    const cp = spec.corridors.personClusterHeightPct!;
    expect(item).toBeGreaterThanOrEqual(ci.min);
    expect(item).toBeLessThanOrEqual(ci.max);
    expect(person).toBeGreaterThanOrEqual(cp.min);
    expect(person).toBeLessThanOrEqual(cp.max);
  });

  it("сэмпл берёт ГОЛЫЕ границы корпуса, а не расширенные допуском", () => {
    // Допуск существует для приёмки. Генерировать по нему — целиться туда,
    // где кадр уже хуже любого эталона.
    const c = spec.corridors.decorCount!;
    for (let i = 0; i < 200; i++) {
      const v = sampleCorridor(c, () => i / 200);
      expect(v).toBeGreaterThanOrEqual(c.min);
      expect(v).toBeLessThanOrEqual(c.max);
    }
  });

  it("объект, подрезанный верхом, планируется всегда — приём 5/5", () => {
    const focal = plan().slots.find((s) => s.id === "focal-blur")!;
    expect(focal.cropEdge).toBe("top");
    expect(focal.areaPct).toBeGreaterThanOrEqual(spec.corridors.croppedTopLargestAreaPct!.min);
  });

  it("суммарное число объектов декора попадает в коридор корпуса", () => {
    for (const seed of ["a", "b", "c", "d", "e"]) {
      const p = plan(undefined, seed);
      const total = p.slots
        .filter((s) => s.source === "decor" && s.id !== "left-fill-decor")
        .reduce((n, s) => n + (s.count ?? 0), 0);
      const c = spec.corridors.decorCount!;
      expect(total, `seed ${seed}: ${total}`).toBeGreaterThanOrEqual(c.min);
      expect(total).toBeLessThanOrEqual(c.max);
    }
  });

  it("план целится в коридоры, по которым его же и будут принимать", () => {
    // Подставляем плановые величины как измеренные и убеждаемся, что
    // валидатор их принял бы: генерация и приёмка не должны конфликтовать.
    const p = plan();
    const asMetrics = {
      itemClusterHeightPct: p.slots.find((s) => s.id === "hero-item")!.clusterHeightPct!,
      personClusterHeightPct: p.slots.find((s) => s.id === "hero-person")!.clusterHeightPct!,
      personTopPct: p.slots.find((s) => s.id === "hero-person")!.headTopPct!,
      bandTopThird: p.slots.find((s) => s.id === "decor-top")!.targetCoveragePct!,
      bandBottomThird: p.slots.find((s) => s.id === "decor-bottom")!.targetCoveragePct!,
      bandMidThird: p.slots.find((s) => s.id === "ambience")!.targetCoveragePct!,
    } as never;
    const report = checkAgainstSpec(asMetrics, spec, [
      "itemClusterHeightPct",
      "personClusterHeightPct",
      "personTopPct",
      "bandTopThird",
      "bandBottomThird",
      "bandMidThird",
    ]);
    expect(report.failedKeys).toEqual([]);
  });
});

describe("библиотека декора необязательна (D-N7')", () => {
  const entry = (url: string, concepts: string[] = []) => ({ url, concepts, season: null });

  it("пустая библиотека → концепты уходят в генерацию, план исполним", () => {
    const p = plan(undefined, "s", "", { brandDecor: [], commonDecor: [] });
    expect(p.decorSourceChain).toContain("generated:sheet");
    expect(p.conceptsToGenerate).toEqual(["coin", "spark", "star"]);
  });

  it("наполненная библиотека бренда идёт первой, генерация не нужна", () => {
    const p = plan(undefined, "s", "", {
      brandDecor: [entry("https://cdn/a.png", ["coin", "spark"]), entry("https://cdn/b.png", ["star"])],
    });
    expect(p.decorSourceChain[0]).toBe("library:brand");
    expect(p.conceptsToGenerate).toEqual([]);
  });

  it("частичное совпадение: недостающее генерируется, остальное из библиотеки", () => {
    const p = plan(undefined, "s", "", { commonDecor: [entry("https://cdn/coin.png", ["coin"])] });
    expect(p.decorSourceChain).toEqual(["library:common", "generated:sheet", "split:item"]);
    expect(p.conceptsToGenerate).toEqual(["spark", "star"]);
  });

  it("безымянная библиотека используется, но концепты не покрывает (D-N9')", () => {
    // Ручная заливка без тегов: ассеты годятся под любой слот, но «монета в
    // библиотеке есть» они не доказывают — лист генерируется всё равно.
    const p = plan(undefined, "s", "", { brandDecor: [entry("https://cdn/x.png")] });
    expect(p.decorSourceChain).toEqual(["library:brand", "generated:sheet", "split:item"]);
    expect(p.conceptsToGenerate).toEqual(["coin", "spark", "star"]);
  });

  it("нарезка слоя ITEM остаётся последним рубежом", () => {
    expect(plan().decorSourceChain.at(-1)).toBe("split:item");
  });
});

describe("промпт слоя света (D-N6)", () => {
  it("требует чёрных углов — под кейинг альфы по яркости", () => {
    expect(plan().background.lightPrompt).toMatch(/PURE BLACK at all four corners/);
    expect(plan().background.alphaFrom).toBe("luminance");
  });

  it("запрещает объекты: иначе монета станет полупрозрачным призраком", () => {
    expect(plan().background.lightPrompt).toMatch(/NO objects, no characters/);
  });

  it("сезон входит как свет и дымка, а не как предмет", () => {
    const p = plan({ season: "sakura" });
    expect(p.background.lightPrompt).toMatch(/Seasonal atmosphere: sakura, as light and haze only/);
  });

  it("обнулённый клампом lightMood не попадает в промпт и не оставляет пустот", () => {
    const p = plan({ lightMood: "golden coins everywhere" });
    // «coins» в промпте есть и должно быть — но только в негативной части
    // («no coins»). Фразы модели там быть не должно.
    expect(p.background.lightPrompt).not.toContain("golden coins everywhere");
    expect(p.background.lightPrompt).not.toMatch(/\s{2,}/);
    expect(p.background.lightPrompt).toMatch(/no coins/);
  });
});

describe("текст письма", () => {
  it("строки собираются из оффера, пустые поля не превращаются в пустые строки", () => {
    // Сумму надо назвать в промпте: иначе кламп её обнулит — и правильно
    // сделает, см. amountAppearsInBrief.
    const p = plan(
      {
        offer: {
          kind: "reload",
          headline: "UP TO",
          amount: "500 000$",
          extras: ["+50 FREE SPINS"],
          cta: "Play now",
        },
      },
      "seed-a",
      "Reload bonus up to 500 000$ and 50 free spins. CTA: Play now.",
    );
    expect(p.textOverlay.lines).toEqual(["UP TO", "500 000$", "+50 FREE SPINS"]);
    expect(p.textOverlay.cta).toBe("Play now");
  });

  it("сумма, которой не было в промпте, не доходит до текста письма", () => {
    const p = plan(
      {
        offer: {
          kind: "reload",
          headline: "UP TO",
          amount: "500 000$",
          extras: [],
          cta: null,
        },
      },
      "seed-a",
      "Weekend reload promotion, bright celebratory mood.",
    );
    expect(p.textOverlay.lines).toEqual([]);
  });

  it("бриф без конкретики оффера даёт пустой текст, а не выдуманный", () => {
    const p = plan();
    expect(p.textOverlay.lines).toEqual([]);
    expect(p.textOverlay.cta).toBeNull();
  });
});
