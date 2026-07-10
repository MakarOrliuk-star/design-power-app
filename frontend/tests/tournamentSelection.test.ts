import { describe, it, expect } from "vitest";
import {
  effectiveMode,
  categoryStateOf,
  toggleCategoryIds,
  resolvePromptValue,
  addBrandCapped,
  selectionKey,
  parseSelectionKey,
  type TourCategory,
  type TourElement,
} from "~/stores/tournament";

function cat(over: Partial<TourCategory> = {}): TourCategory {
  return {
    id: "c1",
    key: "tournament",
    name: "Tournament (Bs)",
    hasModes: true,
    fixedMode: null,
    order: 0,
    elements: [],
    ...over,
  };
}

function el(over: Partial<TourElement> = {}): TourElement {
  return {
    id: "e1",
    name: "Tournament_1",
    order: 0,
    referenceImages: [],
    prompts: { BASE: { content: "default base", updatedAt: "2026-07-01" } },
    overrides: {},
    ...over,
  };
}

/**
 * Phase 0 decisions under test: the Base/VIP toggle is per moded category
 * (fixed-mode categories ignore it), the category checkbox drives all its
 * elements with an indeterminate middle state, the brand cap is hard at 4,
 * and the prompt input resolves override ?? default.
 */
describe("effectiveMode", () => {
  it("moded category follows the toggle, defaulting to BASE", () => {
    const c = cat({ key: "lotterie", hasModes: true });
    expect(effectiveMode(c, {})).toBe("BASE");
    expect(effectiveMode(c, { lotterie: "VIP" })).toBe("VIP");
  });

  it("fixed-mode category ignores the toggle map", () => {
    const c = cat({ key: "calendar_vip", hasModes: false, fixedMode: "VIP" });
    expect(effectiveMode(c, { calendar_vip: "BASE" } as never)).toBe("VIP");
  });
});

describe("categoryStateOf / toggleCategoryIds — the checkbox tree", () => {
  const ids = ["a", "b", "c"];

  it("none / some / all states", () => {
    expect(categoryStateOf(ids, [])).toBe("none");
    expect(categoryStateOf(ids, ["b"])).toBe("some");
    expect(categoryStateOf(ids, ["a", "b", "c"])).toBe("all");
    expect(categoryStateOf([], ["a"])).toBe("none"); // empty category
  });

  it("click on none -> selects the whole block", () => {
    expect(toggleCategoryIds(ids, []).sort()).toEqual(["a", "b", "c"]);
  });

  it("click on partial (indeterminate) -> completes the block, keeping others", () => {
    const next = toggleCategoryIds(ids, ["b", "other"]);
    expect(next.sort()).toEqual(["a", "b", "c", "other"]);
  });

  it("click on all -> clears ONLY this block's elements", () => {
    const next = toggleCategoryIds(ids, ["a", "b", "c", "other"]);
    expect(next).toEqual(["other"]);
  });
});

describe("selectionKey / parseSelectionKey — per-mode checkboxes", () => {
  it("round-trips element:MODE (Base and VIP are distinct selections)", () => {
    expect(selectionKey("e1", "BASE")).toBe("e1:BASE");
    expect(selectionKey("e1", "BASE")).not.toBe(selectionKey("e1", "VIP"));
    expect(parseSelectionKey("e1:VIP")).toEqual({ elementId: "e1", mode: "VIP" });
  });

  it("keys plug into the generic checkbox-tree helpers per mode", () => {
    const baseKeys = ["e1", "e2"].map((id) => selectionKey(id, "BASE"));
    const checked = [selectionKey("e1", "BASE"), selectionKey("e1", "VIP")];
    // e1 is fully checked under VIP, but Base still reads "some" of 2.
    expect(categoryStateOf(baseKeys, checked)).toBe("some");
    // Completing the Base block must not touch the VIP key.
    expect(toggleCategoryIds(baseKeys, checked).sort()).toEqual([
      "e1:BASE",
      "e1:VIP",
      "e2:BASE",
    ]);
  });
});

describe("addBrandCapped — the hard 4-brand limit", () => {
  it("adds up to 4, then refuses", () => {
    let sel: string[] = [];
    for (const id of ["b1", "b2", "b3", "b4"]) sel = addBrandCapped(sel, id);
    expect(sel).toHaveLength(4);
    expect(addBrandCapped(sel, "b5")).toBe(sel); // unchanged reference
  });

  it("ignores duplicates", () => {
    expect(addBrandCapped(["b1"], "b1")).toEqual(["b1"]);
  });
});

describe("resolvePromptValue — override ?? default", () => {
  it("shows the default when there is no override", () => {
    expect(resolvePromptValue(el(), "BASE")).toBe("default base");
  });

  it("the user's override wins; other modes stay on default", () => {
    const e = el({
      prompts: {
        BASE: { content: "default base", updatedAt: "2026-07-01" },
        VIP: { content: "default vip", updatedAt: "2026-07-01" },
      },
      overrides: { BASE: { content: "mine", defaultChanged: false } },
    });
    expect(resolvePromptValue(e, "BASE")).toBe("mine");
    expect(resolvePromptValue(e, "VIP")).toBe("default vip");
  });

  it("empty string when the element has no prompt for the mode", () => {
    expect(resolvePromptValue(el(), "VIP")).toBe("");
  });
});
