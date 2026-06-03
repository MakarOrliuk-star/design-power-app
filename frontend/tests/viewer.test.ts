import { describe, it, expect } from "vitest";
import { nextTick } from "vue";
import { stepIndex, useResult } from "~/composables/useResult";
import { makeImage, makeApi, makeGen, withSetup } from "./helpers";

/**
 * FE Test 3 — Fullscreen viewer navigation (TASK §3 / Phase 3). Verifies the pure
 * wrap-around math and the id-tracked behavior that keeps the open image stable.
 */
describe("viewer", () => {
  it("stepIndex wraps around both ends and guards empty/invalid input", () => {
    expect(stepIndex(0, 1, 3)).toBe(1);
    expect(stepIndex(2, 1, 3)).toBe(0); // forward wrap
    expect(stepIndex(0, -1, 3)).toBe(2); // backward wrap
    expect(stepIndex(0, 1, 0)).toBe(-1); // empty list
    expect(stepIndex(-1, 1, 3)).toBe(-1); // nothing open
  });

  it("opens, steps with wrap-around, and closes when the image leaves the list", async () => {
    const images = [makeImage(), makeImage(), makeImage()];
    const api = makeApi({ images, total: 3, hasMore: false });
    const { result, unmount } = withSetup(() => useResult({ api, gen: makeGen() }));

    await result.load();
    await nextTick();

    result.openViewer(images[0]!);
    expect(result.viewerOpen.value).toBe(true);
    expect(result.viewerImage.value!.id).toBe(images[0]!.id);

    result.viewerStep(1);
    expect(result.viewerImage.value!.id).toBe(images[1]!.id);

    result.viewerStep(-1); // back to first
    result.viewerStep(-1); // wrap to last
    expect(result.viewerIndex.value).toBe(2);

    // If the currently-viewed image disappears (e.g. a tab change replaces the
    // list), the viewer reports itself closed instead of pointing at nothing.
    result.openViewer(images[1]!);
    result.images.value = [images[0]!]; // image-1 no longer present
    await nextTick();
    expect(result.viewerOpen.value).toBe(false);

    unmount();
  });
});
