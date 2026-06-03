import { describe, it, expect } from "vitest";
import { nextTick } from "vue";
import { areAllSelected, useResult } from "~/composables/useResult";
import { makeImage, makeApi, makeGen, withSetup } from "./helpers";

/**
 * FE Test 2 — Multi-select (TASK §4). Covers both the pure predicate and the live
 * reactive flow the Edit panel + "Select all" depend on.
 */
describe("selection", () => {
  it("areAllSelected is true only when every id is selected", () => {
    expect(areAllSelected([], new Set())).toBe(false); // empty list is never "all"
    expect(areAllSelected(["a", "b"], new Set(["a"]))).toBe(false);
    expect(areAllSelected(["a", "b"], new Set(["a", "b"]))).toBe(true);
  });

  it("toggleSelect / toggleSelectAll drive selectedImages reactively", async () => {
    const images = [makeImage(), makeImage(), makeImage()];
    const api = makeApi({ images, total: 3, hasMore: false });
    const { result, unmount } = withSetup(() => useResult({ api, gen: makeGen() }));

    await result.load(); // populate the gallery
    await nextTick();

    // Toggle a single card on, then off.
    result.toggleSelect(images[0]!.id);
    expect(result.isSelected(images[0]!.id)).toBe(true);
    expect(result.selectedImages.value.map((i) => i.id)).toEqual([images[0]!.id]);
    result.toggleSelect(images[0]!.id);
    expect(result.isSelected(images[0]!.id)).toBe(false);

    // Select all → every image selected; toggling again clears.
    result.toggleSelectAll();
    expect(result.allSelected.value).toBe(true);
    expect(result.selectedImages.value).toHaveLength(3);
    result.toggleSelectAll();
    expect(result.allSelected.value).toBe(false);
    expect(result.selectedImages.value).toHaveLength(0);

    unmount();
  });
});
