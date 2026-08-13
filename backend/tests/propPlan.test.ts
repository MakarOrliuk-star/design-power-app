import { describe, it, expect, beforeEach, vi } from "vitest";

// Планировщик набора предметов кампании (правка 2026-08-15, заказчик:
// «предметы сами сгенерировать на основании рефов которые есть и подстроить
// под промпт»). Набор считается ДО первой генерации по референсам бренда и
// брифу вариации и потом переиспользуется всеми форматами.
const visionMock = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/fal.js", () => ({ runVisionQa: visionMock }));

import {
  parsePropPlan,
  formatPropPlan,
  planCampaignProps,
  buildPropPlanPrompt,
  PROP_PLAN_REFS_SHOWN,
} from "../src/lib/propPlan.js";

beforeEach(() => visionMock.mockReset());

const PLAN = {
  props: ["golden coin with a ruby", "red poker chip", "volumetric golden FS letter"],
  keyProps: ["volumetric golden FS letter"],
};

describe("parsePropPlan", () => {
  it("разбирает JSON, чистит пробелы и режет длинные названия", () => {
    const parsed = parsePropPlan(
      JSON.stringify({ props: ["  golden   coin\nwith a ruby ", "x".repeat(200)], keyProps: [] }),
    );
    expect(parsed!.props[0]).toBe("golden coin with a ruby");
    expect(parsed!.props[1]!.length).toBe(80);
  });

  it("вытаскивает JSON из ```fences```", () => {
    expect(parsePropPlan(`\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``)).toEqual(PLAN);
  });

  // Главный предмет — основа иерархии композиции у зависимых форматов, и
  // «главный, которого нет в наборе» утёк бы в промпт мимо инвентаря.
  it("выкидывает главные предметы, которых нет в наборе", () => {
    const parsed = parsePropPlan(
      JSON.stringify({ props: PLAN.props, keyProps: ["slot machine", "RED POKER CHIP"] }),
    );
    // Сверка регистронезависимая: модель меняет регистр между полями.
    expect(parsed!.keyProps).toEqual(["RED POKER CHIP"]);
  });

  it("главный не распознан → берётся первый по списку, а не пусто", () => {
    const parsed = parsePropPlan(JSON.stringify({ props: PLAN.props }));
    expect(parsed!.keyProps).toEqual(["golden coin with a ruby"]);
  });

  it("null на не-JSON и на наборе короче двух объектов", () => {
    expect(parsePropPlan("нет тут json")).toBeNull();
    expect(parsePropPlan(JSON.stringify({ props: ["golden coin"] }))).toBeNull();
    expect(parsePropPlan(JSON.stringify({ props: [] }))).toBeNull();
  });
});

describe("formatPropPlan", () => {
  it("перечисляет набор и отдельно называет главные объекты", () => {
    const text = formatPropPlan(PLAN);
    expect(text).toContain("golden coin with a ruby, red poker chip");
    expect(text).toContain("KEY objects of the campaign: volumetric golden FS letter");
  });

  it("пустой план → пустая строка (в промпт ничего не добавится)", () => {
    expect(formatPropPlan(null)).toBe("");
  });
});

describe("planCampaignProps", () => {
  const opts = {
    refUrls: ["r1", "r2", "r3", "r4", "r5", "r6", "r7"].map((r) => `https://cdn/${r}.png`),
    variationText: "Lucky Friday reload",
    brandName: "Betnella",
  };

  it("показывает референсы бренда и бриф, отдаёт готовую строку набора", async () => {
    visionMock.mockResolvedValue({ success: true, output: JSON.stringify(PLAN) });
    const res = await planCampaignProps(opts);
    expect(res.plan).toEqual(PLAN);
    expect(res.text).toContain("golden coin with a ruby");
    const call = visionMock.mock.calls[0]![0] as { imageUrls: string[]; prompt: string };
    expect(call.imageUrls).toHaveLength(PROP_PLAN_REFS_SHOWN);
    expect(call.prompt).toContain("Campaign brief: Lucky Friday reload");
    expect(call.prompt).toContain("Brand: Betnella.");
  });

  // Fail-open, как у styleAnchor: набор — улучшение, а не условие генерации.
  it("транспортная ошибка и битый ответ не бросают, а отдают пустой набор", async () => {
    visionMock.mockResolvedValue({ success: false, error: "HTTP 500" });
    expect(await planCampaignProps(opts)).toEqual({ text: "", plan: null, error: "HTTP 500" });

    visionMock.mockResolvedValue({ success: true, output: "просто текст" });
    expect((await planCampaignProps(opts)).error).toBe("prop-plan-unparseable");
  });

  it("без референсов запрос не делается вовсе", async () => {
    const res = await planCampaignProps({ ...opts, refUrls: [] });
    expect(res.error).toBe("нет референсов");
    expect(visionMock).not.toHaveBeenCalled();
  });

  it("бриф пуст → плейсхолдер вместо пустой строки в промпте", () => {
    expect(buildPropPlanPrompt("Betnella", "   ")).toContain("(not specified)");
  });
});
