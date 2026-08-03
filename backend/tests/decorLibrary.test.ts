import { describe, it, expect } from "vitest";
import {
  parseDecorEntries,
  serializeDecorEntries,
  decorEntryUrls,
  mergeDecorEntries,
  selectDecorEntries,
  resolveDecorChain,
  type DecorEntry,
} from "../src/lib/decorLibrary.js";
import { mulberry32 } from "../src/lib/composeEngine.js";

/**
 * Библиотека декора с тегами (Фаза 3, D-N9/D-N9').
 *
 * Главная гарантия — обратная совместимость в обе стороны: старые списки
 * строк читаются, записи без тегов пишутся обратно строками. Формат
 * Json-колонки — это контракт с работающей админкой, его нельзя сломать.
 */

const e = (url: string, concepts: string[] = [], season: string | null = null): DecorEntry => ({
  url,
  concepts,
  season,
});

describe("parseDecorEntries — читает старое и новое", () => {
  it("плоский список строк (ручная заливка) → безымянные записи", () => {
    expect(parseDecorEntries(["https://cdn/a.png", "https://cdn/b.png"])).toEqual([
      e("https://cdn/a.png"),
      e("https://cdn/b.png"),
    ]);
  });

  it("тегированные записи автосохранения читаются с концептами и сезоном", () => {
    const parsed = parseDecorEntries([
      { url: "https://cdn/c.png", concepts: ["coin", "spark"], season: "sakura" },
    ]);
    expect(parsed).toEqual([e("https://cdn/c.png", ["coin", "spark"], "sakura")]);
  });

  it("смешанный список — норма переходного периода", () => {
    const parsed = parseDecorEntries(["https://cdn/a.png", { url: "https://cdn/b.png", concepts: ["chip"] }]);
    expect(decorEntryUrls(parsed)).toEqual(["https://cdn/a.png", "https://cdn/b.png"]);
  });

  it("мусор не роняет чтение: битые элементы выбрасываются молча", () => {
    const parsed = parseDecorEntries([42, null, { concepts: ["coin"] }, "", "https://cdn/ok.png"]);
    expect(parsed).toEqual([e("https://cdn/ok.png")]);
  });

  it("не-массив (null, объект, undefined) → пустая библиотека", () => {
    expect(parseDecorEntries(null)).toEqual([]);
    expect(parseDecorEntries(undefined)).toEqual([]);
    expect(parseDecorEntries({ url: "x" })).toEqual([]);
  });

  it("теги чистятся тем же правилом, что концепты брифа: ^[a-z_]{2,20}$", () => {
    const parsed = parseDecorEntries([
      { url: "https://cdn/a.png", concepts: ["Coin", "RED coin!", "chip", "x"] },
    ]);
    expect(parsed[0]!.concepts).toEqual(["coin", "chip"]);
  });
});

describe("serializeDecorEntries — записи без тегов остаются строками", () => {
  it("безымянная запись → строка (формат админки не меняется)", () => {
    expect(serializeDecorEntries([e("https://cdn/a.png")])).toEqual(["https://cdn/a.png"]);
  });

  it("тегированная запись → объект; сезон пишется только когда есть", () => {
    expect(serializeDecorEntries([e("https://cdn/a.png", ["coin"]), e("https://cdn/b.png", ["petal"], "sakura")])).toEqual([
      { url: "https://cdn/a.png", concepts: ["coin"] },
      { url: "https://cdn/b.png", concepts: ["petal"], season: "sakura" },
    ]);
  });

  it("parse(serialize(x)) — без потерь", () => {
    const entries = [e("https://cdn/a.png"), e("https://cdn/b.png", ["coin", "chip"], "winter")];
    expect(parseDecorEntries(serializeDecorEntries(entries))).toEqual(entries);
  });
});

describe("mergeDecorEntries — sha256-дедуп означает дедуп по URL", () => {
  it("повторный URL не плодит запись, а дополняет теги", () => {
    const { merged, skipped } = mergeDecorEntries(
      [e("https://cdn/a.png", ["coin"])],
      [e("https://cdn/a.png", ["spark"]), e("https://cdn/b.png", ["chip"])],
      20,
    );
    expect(merged).toEqual([e("https://cdn/a.png", ["coin", "spark"]), e("https://cdn/b.png", ["chip"])]);
    expect(skipped).toBe(0);
  });

  it("потолок библиотеки: лишнее пропускается и считается", () => {
    const { merged, skipped } = mergeDecorEntries(
      [e("https://cdn/a.png")],
      [e("https://cdn/b.png"), e("https://cdn/c.png")],
      2,
    );
    expect(merged.length).toBe(2);
    expect(skipped).toBe(1);
  });

  it("не мутирует вход: библиотека варианта живёт дольше вызова", () => {
    const current = [e("https://cdn/a.png", ["coin"])];
    mergeDecorEntries(current, [e("https://cdn/a.png", ["spark"])], 20);
    expect(current[0]!.concepts).toEqual(["coin"]);
  });
});

describe("selectDecorEntries — детерминированный отбор под слот", () => {
  const library = [
    e("https://cdn/coin1.png", ["coin"]),
    e("https://cdn/coin2.png", ["coin"]),
    e("https://cdn/petal.png", ["petal"]),
    e("https://cdn/noname.png"),
    e("https://cdn/snow.png", ["snowflake"], "winter"),
  ];

  it("один и тот же rand-поток → один и тот же выбор (D-N5)", () => {
    const a = selectDecorEntries(library, { concepts: ["coin"], season: null, count: 3, rand: mulberry32(7) });
    const b = selectDecorEntries(library, { concepts: ["coin"], season: null, count: 3, rand: mulberry32(7) });
    expect(a).toEqual(b);
  });

  it("совпавшие по тегам идут раньше безымянных, безымянные — раньше чужих", () => {
    const picked = selectDecorEntries(library, {
      concepts: ["coin"],
      season: null,
      count: 4,
      rand: mulberry32(1),
    });
    const urls = picked.map((p) => p.url);
    // Первые два — обе монеты (в сидированном порядке), третий — безымянный.
    expect(urls.slice(0, 2).sort()).toEqual(["https://cdn/coin1.png", "https://cdn/coin2.png"]);
    expect(urls[2]).toBe("https://cdn/noname.png");
    // Чужой тег (petal) — только когда больше нечем заполнить зону (D-C6).
    expect(urls[3]).toBe("https://cdn/petal.png");
  });

  it("сезонный ассет чужого сезона не попадает в кадр никогда", () => {
    const noSeason = selectDecorEntries(library, { concepts: [], season: null, count: 99, rand: mulberry32(2) });
    expect(noSeason.map((p) => p.url)).not.toContain("https://cdn/snow.png");
    const winter = selectDecorEntries(library, { concepts: [], season: "winter", count: 99, rand: mulberry32(2) });
    expect(winter.map((p) => p.url)).toContain("https://cdn/snow.png");
  });

  it("без концептов слота вся несезонная библиотека — равноправный пул", () => {
    const picked = selectDecorEntries(library, { concepts: [], season: null, count: 99, rand: mulberry32(3) });
    expect(picked.length).toBe(4);
  });
});

describe("resolveDecorChain — цепочка D-N7'", () => {
  it("непустая брендовая библиотека перекрывает общую", () => {
    const chain = resolveDecorChain({
      brandEntries: [e("https://cdn/brand.png", ["coin"])],
      commonEntries: [e("https://cdn/common.png", ["coin", "spark"])],
      concepts: ["coin"],
    });
    expect(chain.library).toBe("brand");
    expect(chain.steps).toEqual(["library:brand", "split:item"]);
    expect(chain.conceptsToGenerate).toEqual([]);
  });

  it("обе библиотеки пусты → лист декора, последний рубеж — куски ITEM", () => {
    const chain = resolveDecorChain({ brandEntries: [], commonEntries: [], concepts: ["coin", "petal"] });
    expect(chain.library).toBeNull();
    expect(chain.steps).toEqual(["generated:sheet", "split:item"]);
    expect(chain.conceptsToGenerate).toEqual(["coin", "petal"]);
  });

  it("безымянные ассеты концепт не покрывают: библиотека в деле, лист тоже", () => {
    const chain = resolveDecorChain({
      brandEntries: [e("https://cdn/x.png")],
      commonEntries: [],
      concepts: ["coin"],
    });
    expect(chain.steps).toEqual(["library:brand", "generated:sheet", "split:item"]);
    expect(chain.conceptsToGenerate).toEqual(["coin"]);
  });

  it("без концептов брифа лист не генерируется — прайм «нарисуй что-нибудь» запрещён", () => {
    const chain = resolveDecorChain({ brandEntries: [], commonEntries: [], concepts: [] });
    expect(chain.steps).toEqual(["split:item"]);
  });
});
