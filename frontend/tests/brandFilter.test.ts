import { describe, it, expect } from "vitest";
import { filterBrands, type BrandOption } from "~/components/super-designer/brandFilter";

/** Задача 6 — the brand search behind «Редактировать стиль». */
describe("filterBrands", () => {
  const brands: BrandOption[] = [
    { id: "1", name: "Betnella", isActive: true },
    { id: "2", name: "Wildbet", isActive: false },
    { id: "3", name: "Goldzino", isActive: true },
    { id: "4", name: "BETSSON", isActive: true },
  ];

  it("returns every brand for a blank query", () => {
    expect(filterBrands(brands, "").map((b) => b.id)).toEqual(["1", "2", "3", "4"]);
    expect(filterBrands(brands, "   ").map((b) => b.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("matches case-insensitively, prefix hits first", () => {
    expect(filterBrands(brands, "bet").map((b) => b.id)).toEqual(["1", "4", "2"]);
    expect(filterBrands(brands, "BET").map((b) => b.id)).toEqual(["1", "4", "2"]);
  });

  it("ignores surrounding whitespace and keeps disabled brands in the list", () => {
    const res = filterBrands(brands, "  wild ");
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ id: "2", isActive: false });
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterBrands(brands, "zzz")).toEqual([]);
  });

  it("does not mutate the source array", () => {
    const copy = [...brands];
    filterBrands(brands, "bet");
    expect(brands).toEqual(copy);
  });
});
