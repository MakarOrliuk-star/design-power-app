import { describe, it, expect, vi } from "vitest";
import { nextTick } from "vue";
import { useArchive } from "~/composables/useArchive";
import type { GalleryImage } from "~/composables/useResult";
import { makeImage, withSetup } from "./helpers";

/** useArchive-shaped api mock (returns the given gallery payload for GET reads). */
function makeApi(payload: { images: GalleryImage[]; total: number; hasMore: boolean }) {
  return vi.fn(async () => payload) as never;
}

/**
 * Archive live auto-refresh: while a batch runs, refresh() must prepend only the
 * newly-finished images and bump newReadyCount — so the grid fills in without a
 * page reload (user request, parity with the Result page).
 */
describe("archive real-time refresh", () => {
  it("refresh() merges new images to the front and counts them", async () => {
    const a = makeImage();
    const b = makeImage();
    const c = makeImage();

    let payload = { images: [a, b], total: 2, hasMore: false };
    const api = makeApi(payload);
    const { result, unmount } = withSetup(() =>
      useArchive({
        api,
        apiBase: "",
        download: vi.fn(),
        gen: { runningCount: 0 },
        copy: vi.fn(),
      }),
    );

    await result.load();
    await nextTick();
    expect(result.images.value.map((i) => i.id)).toEqual([a.id, b.id]);
    expect(result.newReadyCount.value).toBe(0);

    // A new image finished server-side; the next poll returns it.
    payload = { images: [c, a, b], total: 3, hasMore: false };
    (api as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(payload);
    await result.refresh();
    expect(result.images.value.map((i) => i.id)).toEqual([c.id, a.id, b.id]);
    expect(result.newReadyCount.value).toBe(1);

    // Polling again with nothing new must not re-insert or re-count.
    await result.refresh();
    expect(result.images.value).toHaveLength(3);
    expect(result.newReadyCount.value).toBe(1);

    unmount();
  });
});
