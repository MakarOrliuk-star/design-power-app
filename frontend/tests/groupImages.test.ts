import { describe, it, expect } from "vitest";
import { groupImages, stripGender } from "~/composables/useResult";
import { makeImage } from "./helpers";

/**
 * FE Test 1 — Result grouping logic (TASK §3 "style indication").
 * The lane shows one labelled row per (content type + brand + prompt); each row's
 * state pill must reflect whether its images are edited. This is the core of how
 * the page presents results, so it's the highest-value unit to lock.
 */
describe("groupImages", () => {
  it("groups images by content type + brand + prompt and preserves order", () => {
    const a1 = makeImage({ brandName: "Nike", description: "studio" });
    const a2 = makeImage({ brandName: "Nike", description: "studio" });
    const b1 = makeImage({ brandName: "Adidas", description: "studio" });
    const c1 = makeImage({ brandName: "Nike", description: "outdoor" }); // diff prompt → new group

    const groups = groupImages([a1, a2, b1, c1]);

    expect(groups).toHaveLength(3);
    // Same brand+type+prompt collapse into one row, keeping both images.
    expect(groups[0]!.brand).toBe("Nike");
    expect(groups[0]!.images.map((i) => i.id)).toEqual([a1.id, a2.id]);
    // A different prompt forms a separate row even for the same brand.
    expect(groups[2]!.prompt).toBe("outdoor");
  });

  it("derives the state pill from isEdit and groups edited separately", () => {
    const gen = makeImage({ brandName: "Nike", description: "studio", isEdit: false });
    const edited = makeImage({ brandName: "Nike", description: "studio", isEdit: true });

    const groups = groupImages([gen, edited]);

    // Even with identical brand/prompt, the key includes nothing about isEdit, so
    // they share a group — but the FIRST image decides the state badge.
    expect(groups).toHaveLength(1);
    expect(groups[0]!.state).toBe("Generated");

    // When the edited image leads, the row is badged "Edited".
    expect(groupImages([edited])[0]!.state).toBe("Edited");
  });

  it("treats a null description as an empty prompt (no crash)", () => {
    const groups = groupImages([makeImage({ description: null })]);
    expect(groups[0]!.prompt).toBe("");
  });

  it("returns an empty array for no images", () => {
    expect(groupImages([])).toEqual([]);
  });

  // TASK §2 — gender merge (display-only).
  it("merges (Men)/(Women) of the same brand into one 'Goldzino' row", () => {
    const men = makeImage({ brandName: "Goldzino(Men)", description: "studio" });
    const women = makeImage({ brandName: "Goldzino(Women)", description: "studio" });

    const groups = groupImages([men, women]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.brand).toBe("Goldzino"); // suffix stripped for display
    expect(groups[0]!.images.map((i) => i.id)).toEqual([men.id, women.id]);
  });

  it("keeps different prompts in separate rows even after the gender merge", () => {
    const men = makeImage({ brandName: "Goldzino(Men)", description: "studio" });
    const women = makeImage({ brandName: "Goldzino(Women)", description: "outdoor" });

    const groups = groupImages([men, women]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.brand === "Goldzino")).toBe(true);
  });
});

describe("stripGender", () => {
  it("strips (Men)/(Women) case-insensitively", () => {
    expect(stripGender("Goldzino(Men)")).toBe("Goldzino");
    expect(stripGender("Goldzino(Women)")).toBe("Goldzino");
    expect(stripGender("SLOTSDJ(MEN)")).toBe("SLOTSDJ");
  });

  it("leaves other names untouched", () => {
    expect(stripGender("Spinmama")).toBe("Spinmama");
    expect(stripGender("Morospin(Monkey)")).toBe("Morospin(Monkey)");
    expect(stripGender("Slotrize(Duck)")).toBe("Slotrize(Duck)");
    expect(stripGender("Frogyspin_women_red")).toBe("Frogyspin_women_red");
  });
});
