import { describe, it, expect } from "vitest";
import {
  draftOf,
  draftError,
  hasOwnRefs,
  movedIds,
  packErrorMessage,
  padTo2,
  patchOf,
  serializeDraft,
} from "~/stores/welcomePackEditor";
import type { ElementDraft, PackCategory, PackElement } from "~/stores/welcomePackEditor";

/**
 * «Edit Welcome packs» draft helpers. The rules they encode: one prompt per
 * element, and reference slots that exist because the CATEGORY says so.
 */

function cat(over: Partial<PackCategory> = {}): PackCategory {
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

function el(over: Partial<PackElement> = {}): PackElement {
  return {
    id: "e1",
    name: "Welcome_1",
    order: 0,
    isActive: true,
    referenceImages: [],
    prompt: { content: "default", updatedAt: "2026-08-01" },
    ...over,
  };
}

function draft(over: Partial<ElementDraft> = {}): ElementDraft {
  return {
    name: "Welcome_1",
    isActive: true,
    referenceImages: ["", ""],
    prompt: "default",
    ...over,
  };
}

describe("padTo2", () => {
  it("always yields exactly two slots, filled or not", () => {
    expect(padTo2([])).toEqual(["", ""]);
    expect(padTo2(["a"])).toEqual(["a", ""]);
    expect(padTo2(["a", "b", "c"])).toEqual(["a", "b"]);
  });
});

describe("hasOwnRefs", () => {
  it("follows the category flag, not a hardcoded key", () => {
    expect(hasOwnRefs(cat())).toBe(false);
    expect(hasOwnRefs(cat({ usesOwnReferences: true }))).toBe(true);
    // Even a category literally keyed "provider" obeys the flag here.
    expect(hasOwnRefs(cat({ key: "provider", usesOwnReferences: false }))).toBe(false);
  });
});

describe("draftOf", () => {
  it("copies the element into an editable draft with padded ref slots", () => {
    const d = draftOf(cat({ usesOwnReferences: true }), el({ referenceImages: ["u1"] }));
    expect(d).toEqual({
      name: "Welcome_1",
      isActive: true,
      referenceImages: ["u1", ""],
      prompt: "default",
    });
  });

  it("a missing prompt starts as an empty string, never undefined", () => {
    expect(draftOf(cat(), el({ prompt: null })).prompt).toBe("");
  });
});

describe("patchOf", () => {
  it("omits referenceImages entirely when the category doesn't use its own", () => {
    const patch = patchOf(cat(), draft({ referenceImages: ["u1", "u2"] }));
    expect(patch).toEqual({ name: "Welcome_1", isActive: true, prompt: "default" });
    expect("referenceImages" in patch).toBe(false);
  });

  it("sends the trimmed, blank-free refs for an own-reference category", () => {
    const patch = patchOf(
      cat({ usesOwnReferences: true }),
      draft({ referenceImages: [" u1 ", ""] }),
    );
    expect(patch.referenceImages).toEqual(["u1"]);
  });

  it("omits an empty prompt instead of sending a blank one (the API rejects it)", () => {
    const patch = patchOf(cat(), draft({ prompt: "   " }));
    expect("prompt" in patch).toBe(false);
  });

  it("trims the name", () => {
    expect(patchOf(cat(), draft({ name: "  Welcome_2  " })).name).toBe("Welcome_2");
  });
});

describe("serializeDraft (the dirty check)", () => {
  it("is stable for an unchanged draft and moves on a real edit", () => {
    const c = cat();
    const base = serializeDraft(c, draft());
    expect(serializeDraft(c, draft())).toBe(base);
    expect(serializeDraft(c, draft({ prompt: "changed" }))).not.toBe(base);
  });

  it("ignores refs the category cannot carry — no phantom unsaved-changes guard", () => {
    const c = cat(); // no own references
    expect(serializeDraft(c, draft({ referenceImages: ["u1", "u2"] }))).toBe(
      serializeDraft(c, draft()),
    );
  });
});

describe("draftError", () => {
  it("blocks an empty name and an empty prompt, mirroring the backend", () => {
    expect(draftError(cat(), draft({ name: "  " }))).toContain("название");
    expect(draftError(cat(), draft({ prompt: "  " }))).toContain("Промпт");
  });

  it("passes a complete draft", () => {
    expect(draftError(cat(), draft())).toBe("");
  });
});

describe("movedIds", () => {
  it("moves one slot up or down", () => {
    expect(movedIds(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(movedIds(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });

  it("returns the SAME array at the edges, so the caller skips the request", () => {
    const ids = ["a", "b"];
    expect(movedIds(ids, "a", -1)).toBe(ids);
    expect(movedIds(ids, "b", 1)).toBe(ids);
    expect(movedIds(ids, "ghost", 1)).toBe(ids);
  });
});

describe("packErrorMessage", () => {
  it("maps backend codes to Russian, falling back for unknown ones", () => {
    expect(packErrorMessage("already_exists", "fallback")).toContain("занято");
    expect(packErrorMessage("nothing_to_rollback", "fallback")).toContain("предыдущей");
    expect(packErrorMessage(undefined, "fallback")).toBe("fallback");
    expect(packErrorMessage("weird_code", "fallback")).toBe("fallback");
  });
});
