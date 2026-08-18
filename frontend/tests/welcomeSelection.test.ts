import { describe, it, expect } from "vitest";
import {
  categoryStateOf,
  toggleCategoryIds,
  resolvePromptValue,
  addBrandCapped,
  allCategoryKeys,
} from "~/stores/welcome";
import type { WelCategory, WelElement } from "~/types/welcome";

/**
 * Welcome packs selection helpers. The unit of selection is the plain element
 * id (no Base/VIP), which is exactly what these tests pin down.
 */

function cat(over: Partial<WelCategory> = {}): WelCategory {
  return {
    id: "c1",
    key: "welcome_series",
    name: "Welcome Series",
    usesOwnReferences: false,
    order: 0,
    elements: [],
    ...over,
  };
}

function el(over: Partial<WelElement> = {}): WelElement {
  return {
    id: "e1",
    name: "Welcome_1",
    order: 0,
    referenceImages: [],
    prompt: { content: "default", updatedAt: "2026-08-01" },
    override: null,
    ...over,
  };
}

describe("allCategoryKeys", () => {
  it("is just the element ids — one selectable unit per element", () => {
    const c = cat({ elements: [el(), el({ id: "e2" }), el({ id: "e3" })] });
    expect(allCategoryKeys(c)).toEqual(["e1", "e2", "e3"]);
  });

  it("an empty category contributes nothing to the universe", () => {
    expect(allCategoryKeys(cat())).toEqual([]);
  });
});

describe("categoryStateOf", () => {
  it("reports all / some / none for the category checkbox", () => {
    expect(categoryStateOf(["e1", "e2"], ["e1", "e2"])).toBe("all");
    expect(categoryStateOf(["e1", "e2"], ["e2"])).toBe("some");
    expect(categoryStateOf(["e1", "e2"], [])).toBe("none");
  });

  it("an empty category is 'none', never 'all' (nothing to select)", () => {
    expect(categoryStateOf([], [])).toBe("none");
    expect(categoryStateOf([], ["ghost"])).toBe("none");
  });

  it("ignores checked ids that belong to other categories", () => {
    expect(categoryStateOf(["e1"], ["e1", "other"])).toBe("all");
  });
});

describe("toggleCategoryIds", () => {
  it("none/some -> selects the whole category; all -> clears it", () => {
    expect(toggleCategoryIds(["e1", "e2"], []).sort()).toEqual(["e1", "e2"]);
    expect(toggleCategoryIds(["e1", "e2"], ["e1"]).sort()).toEqual(["e1", "e2"]);
    expect(toggleCategoryIds(["e1", "e2"], ["e1", "e2"])).toEqual([]);
  });

  it("leaves other categories' ticks untouched", () => {
    expect(toggleCategoryIds(["e1"], ["e1", "x1"])).toEqual(["x1"]);
    expect(toggleCategoryIds(["e1"], ["x1"]).sort()).toEqual(["e1", "x1"]);
  });
});

describe("resolvePromptValue", () => {
  it("prefers the user's override over the global default", () => {
    expect(resolvePromptValue(el())).toBe("default");
    expect(resolvePromptValue(el({ override: { content: "mine", defaultChanged: false } }))).toBe(
      "mine",
    );
  });

  it("returns an empty string when the element has no prompt at all", () => {
    // A real state here: Welcome content is created by hand, nothing is seeded.
    expect(resolvePromptValue(el({ prompt: null }))).toBe("");
  });

  it("an override still wins when the default was never written", () => {
    expect(
      resolvePromptValue(el({ prompt: null, override: { content: "mine", defaultChanged: false } })),
    ).toBe("mine");
  });
});

describe("addBrandCapped", () => {
  it("adds up to the 4-brand cap, then refuses silently", () => {
    expect(addBrandCapped([], "b1")).toEqual(["b1"]);
    const full = ["b1", "b2", "b3", "b4"];
    expect(addBrandCapped(full, "b5")).toBe(full); // same array — nothing changed
  });

  it("never duplicates a brand already picked", () => {
    const one = ["b1"];
    expect(addBrandCapped(one, "b1")).toBe(one);
  });
});
