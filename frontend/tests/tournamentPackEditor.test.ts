import { describe, it, expect } from "vitest";
import {
  draftError,
  draftOf,
  hasProviderRefs,
  modesOf,
  movedIds,
  packErrorMessage,
  padTo2,
  patchOf,
  serializeDraft,
  type PackCategory,
  type PackElement,
} from "~/stores/tournamentPackEditor";

function cat(over: Partial<PackCategory> = {}): PackCategory {
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

function el(over: Partial<PackElement> = {}): PackElement {
  return {
    id: "e1",
    name: "Tournament_1",
    nameVip: "Tournament_1_VIP",
    order: 0,
    isActive: true,
    referenceImages: [],
    prompts: [
      { mode: "BASE", content: "base prompt", updatedAt: "2026-08-01" },
      { mode: "VIP", content: "vip prompt", updatedAt: "2026-08-01" },
    ],
    ...over,
  };
}

/**
 * «Edit Tournament pack» draft rules: what the modal edits, what it is allowed
 * to send, and when the unsaved-changes guard fires. The backend enforces the
 * same rules — these keep the user from ever seeing the 400/409.
 */
describe("modesOf / provider refs", () => {
  it("Base+VIP categories carry both prompts, fixed-mode ones exactly one", () => {
    expect(modesOf(cat())).toEqual(["BASE", "VIP"]);
    expect(modesOf(cat({ hasModes: false, fixedMode: "VIP" }))).toEqual(["VIP"]);
    expect(modesOf(cat({ hasModes: false, fixedMode: null }))).toEqual(["BASE"]);
  });

  it("only the provider category shows reference slots", () => {
    expect(hasProviderRefs(cat({ key: "provider" }))).toBe(true);
    expect(hasProviderRefs(cat({ key: "calendar_vip" }))).toBe(false);
  });

  it("pads the provider slots to exactly 2", () => {
    expect(padTo2([])).toEqual(["", ""]);
    expect(padTo2(["a"])).toEqual(["a", ""]);
    expect(padTo2(["a", "b", "c"])).toEqual(["a", "b"]);
  });
});

describe("draftOf", () => {
  it("fills a prompt box per category mode, empty when the element has none", () => {
    const d = draftOf(cat(), el({ prompts: [{ mode: "BASE", content: "only base", updatedAt: "" }] }));
    expect(d.prompts).toEqual({ BASE: "only base", VIP: "" });
  });

  it("keeps a fixed-mode category to its single prompt and blanks a null VIP name", () => {
    const d = draftOf(
      cat({ hasModes: false, fixedMode: "BASE", key: "provider" }),
      el({ nameVip: null, referenceImages: ["u1"] }),
    );
    expect(Object.keys(d.prompts)).toEqual(["BASE"]);
    expect(d.nameVip).toBe("");
    expect(d.referenceImages).toEqual(["u1", ""]);
  });
});

describe("patchOf", () => {
  it("sends the VIP name and both prompts for a Base+VIP category", () => {
    const c = cat();
    const patch = patchOf(c, draftOf(c, el()));
    expect(patch.nameVip).toBe("Tournament_1_VIP");
    expect(patch.prompts).toEqual([
      { mode: "BASE", content: "base prompt" },
      { mode: "VIP", content: "vip prompt" },
    ]);
    expect(patch).not.toHaveProperty("referenceImages");
  });

  it("omits nameVip on a fixed-mode category (the backend 400s on it)", () => {
    const c = cat({ hasModes: false, fixedMode: "VIP" });
    const d = draftOf(c, el());
    d.nameVip = "leftover from another category";
    expect(patchOf(c, d)).not.toHaveProperty("nameVip");
  });

  it("sends provider refs trimmed, empties dropped", () => {
    const c = cat({ key: "provider", hasModes: false, fixedMode: "BASE" });
    const d = draftOf(c, el({ referenceImages: [" https://cdn/1.png ", ""] }));
    expect(patchOf(c, d).referenceImages).toEqual(["https://cdn/1.png"]);
  });

  it("trims names and prompts so a whitespace-only edit is not 'changed'", () => {
    const c = cat();
    const d = draftOf(c, el());
    d.name = "  Tournament_1  ";
    d.prompts.BASE = "  base prompt  ";
    expect(serializeDraft(c, d)).toBe(serializeDraft(c, draftOf(c, el())));
  });
});

describe("dirty check (serializeDraft)", () => {
  it("is stable for an untouched draft and flips on any real edit", () => {
    const c = cat();
    const saved = serializeDraft(c, draftOf(c, el()));

    const same = draftOf(c, el());
    expect(serializeDraft(c, same)).toBe(saved);

    const edited = draftOf(c, el());
    edited.prompts.VIP = "rewritten";
    expect(serializeDraft(c, edited)).not.toBe(saved);

    const toggled = draftOf(c, el());
    toggled.isActive = false;
    expect(serializeDraft(c, toggled)).not.toBe(saved);
  });
});

describe("draftError", () => {
  it("blocks an empty name, an empty VIP name and empty prompts", () => {
    const c = cat();
    const empty = draftOf(c, el({ name: "" }));
    expect(draftError(c, empty)).toMatch(/название элемента/i);

    const noVip = draftOf(c, el({ nameVip: null }));
    expect(draftError(c, noVip)).toMatch(/VIP/);

    const noPrompt = draftOf(c, el({ prompts: [] }));
    expect(draftError(c, noPrompt)).toMatch(/BASE и VIP/);
  });

  it("does not demand a VIP name on a fixed-mode category", () => {
    const c = cat({ hasModes: false, fixedMode: "BASE" });
    expect(draftError(c, draftOf(c, el({ nameVip: null })))).toBe("");
  });

  it("passes a complete draft", () => {
    const c = cat();
    expect(draftError(c, draftOf(c, el()))).toBe("");
  });
});

describe("movedIds", () => {
  it("swaps with the neighbour in the requested direction", () => {
    expect(movedIds(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(movedIds(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });

  it("returns the SAME array at the edges, so the caller skips the request", () => {
    const ids = ["a", "b", "c"];
    expect(movedIds(ids, "a", -1)).toBe(ids);
    expect(movedIds(ids, "c", 1)).toBe(ids);
    expect(movedIds(ids, "nope", 1)).toBe(ids);
  });
});

describe("packErrorMessage", () => {
  it("maps backend codes to Russian text and falls back on unknown ones", () => {
    expect(packErrorMessage("already_exists", "x")).toMatch(/занято/);
    expect(packErrorMessage("nothing_to_rollback", "x")).toMatch(/предыдущей версии/);
    expect(packErrorMessage("file_too_large", "x")).toMatch(/10 МБ/);
    expect(packErrorMessage("boom", "запасной текст")).toBe("запасной текст");
    expect(packErrorMessage(undefined, "запасной текст")).toBe("запасной текст");
  });
});
