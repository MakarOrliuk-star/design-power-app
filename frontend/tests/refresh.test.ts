import { describe, it, expect, vi } from "vitest";
import { nextTick } from "vue";
import { mergeNewImages, useResult, type ResultApi } from "~/composables/useResult";
import { makeImage, makeGen, withSetup } from "./helpers";

/**
 * FE Test 5 — Real-time merge (TASK §6 / Phase 5). Polling must prepend only
 * genuinely new images and count them for the "Готово +N" banner — never
 * double-insert an image already on screen.
 */
describe("real-time refresh", () => {
  it("mergeNewImages prepends only unseen ids and reports how many were added", () => {
    const a = makeImage();
    const b = makeImage();
    const c = makeImage();

    const fresh = mergeNewImages([a, b], [c, a, b]); // only c is new
    expect(fresh.added).toBe(1);
    expect(fresh.images.map((i) => i.id)).toEqual([c.id, a.id, b.id]);

    const existing = [a, b];
    const none = mergeNewImages(existing, [a, b]); // nothing new
    expect(none.added).toBe(0);
    expect(none.images).toBe(existing); // returns the same array reference (no churn)
  });

  it("refresh() merges new images to the front and bumps newReadyCount", async () => {
    const a = makeImage();
    const b = makeImage();
    const c = makeImage();

    let payload = { images: [a, b], total: 2, hasMore: false };
    const api = vi.fn(async () => payload) as unknown as ResultApi;
    const { result, unmount } = withSetup(() => useResult({ api, gen: makeGen() }));

    await result.load();
    await nextTick();
    expect(result.images.value.map((i) => i.id)).toEqual([a.id, b.id]);
    expect(result.newReadyCount.value).toBe(0);

    // A new image finished server-side; the next poll returns it.
    payload = { images: [c, a, b], total: 3, hasMore: false };
    await result.refresh();
    expect(result.images.value.map((i) => i.id)).toEqual([c.id, a.id, b.id]);
    expect(result.newReadyCount.value).toBe(1);

    // Polling again with no new images must NOT re-insert or re-count.
    await result.refresh();
    expect(result.images.value).toHaveLength(3);
    expect(result.newReadyCount.value).toBe(1);

    unmount();
  });
});
