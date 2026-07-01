import { describe, it, expect, vi } from "vitest";
import { nextTick } from "vue";
import { capPad, bustCache, mapScaleError, useResult, type ResultApi } from "~/composables/useResult";
import { makeImage, makeGen, withSetup } from "./helpers";

/**
 * FE Test — Scale editor (TASK §1). Covers the pure helpers plus the runScale /
 * runInpaint actions: selection guard, request body (pad / placement / mask), and
 * in-place URL replacement.
 */
describe("scale helpers", () => {
  it("capPad clamps each side to [0, dimension]", () => {
    const natural = { width: 500, height: 300 };
    expect(capPad({ top: -10, right: 9999, bottom: 100, left: 700 }, natural)).toEqual({
      top: 0, // negative → 0
      right: 500, // capped to width
      bottom: 100, // within range
      left: 500, // capped to width
    });
  });

  it("bustCache appends a version param (? or &)", () => {
    expect(bustCache("https://cdn/x.png")).toMatch(/^https:\/\/cdn\/x\.png\?v=\d+$/);
    expect(bustCache("https://cdn/x.png?a=1")).toMatch(/^https:\/\/cdn\/x\.png\?a=1&v=\d+$/);
  });

  it("mapScaleError maps known codes and falls back", () => {
    expect(mapScaleError("scale_pipeline_not_configured")).toContain("не настроен");
    expect(mapScaleError("empty_prompt")).toContain("промпт");
    expect(mapScaleError(undefined)).toContain("Не удалось");
  });
});

/** A gallery-plus-mutation api mock: reads return `payload`, writes return `write`. */
function makeMutApi(payload: unknown, endpoint: string, write: unknown) {
  return vi.fn(async (req: string) => (req === endpoint ? write : payload)) as unknown as ResultApi &
    ReturnType<typeof vi.fn>;
}
function scaleCalls(api: unknown, endpoint: string) {
  return (api as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === endpoint);
}

describe("runScale", () => {
  it("is a no-op unless exactly one image is selected", async () => {
    const a = makeImage();
    const b = makeImage();
    const api = vi.fn(async () => ({ images: [a, b], total: 2, hasMore: false })) as unknown as ResultApi;
    const { result, unmount } = withSetup(() => useResult({ api, gen: makeGen() }));

    await result.load();
    await nextTick();
    result.toggleSelect(a.id);
    result.toggleSelect(b.id); // two selected → scaleTarget is null
    await nextTick();
    expect(result.scaleTarget.value).toBeNull();

    await result.runScale({ pad: { top: 100, right: 0, bottom: 0, left: 0 } });
    expect(scaleCalls(api, "/api/generate/scale")).toHaveLength(0); // guard blocked the POST
    unmount();
  });

  it("posts the pad and replaces the source image URL in place (cache-busted)", async () => {
    const a = makeImage({ generatedImageUrl: "https://cdn/old.png" });
    const api = makeMutApi(
      { images: [a], total: 1, hasMore: false },
      "/api/generate/scale",
      { generationId: a.id, generatedImageUrl: "https://cdn/new.png" },
    );
    const { result, unmount } = withSetup(() => useResult({ api, gen: makeGen() }));

    await result.load();
    await nextTick();
    result.toggleSelect(a.id);
    await nextTick();

    await result.runScale({ pad: { top: 100, right: 0, bottom: 50, left: 0 }, prompt: "add sky" });

    const call = scaleCalls(api, "/api/generate/scale")[0];
    expect(call?.[1]).toMatchObject({
      method: "POST",
      body: { generationId: a.id, pad: { top: 100, right: 0, bottom: 50, left: 0 }, prompt: "add sky" },
    });
    expect(result.images.value[0]!.generatedImageUrl).toMatch(/^https:\/\/cdn\/new\.png\?v=\d+$/);
    expect(result.scaleMsg.value).toContain("Готово");
    unmount();
  });

  it("posts a free-transform placement", async () => {
    const a = makeImage();
    const api = makeMutApi(
      { images: [a], total: 1, hasMore: false },
      "/api/generate/scale",
      { generationId: a.id, generatedImageUrl: "https://cdn/new.png" },
    );
    const { result, unmount } = withSetup(() => useResult({ api, gen: makeGen() }));

    await result.load();
    await nextTick();
    result.toggleSelect(a.id);
    await nextTick();

    const placement = { canvasW: 1000, canvasH: 800, imgW: 400, imgH: 400, imgX: 100, imgY: 50 };
    await result.runScale({ placement });

    const call = scaleCalls(api, "/api/generate/scale")[0];
    expect(call?.[1]).toMatchObject({ body: { generationId: a.id, placement } });
    expect((call?.[1] as { body: Record<string, unknown> }).body.pad).toBeUndefined();
    unmount();
  });

  it("maps a backend error code to a friendly message", async () => {
    const a = makeImage();
    const api = vi.fn(async (req: string) => {
      if (req === "/api/generate/scale") throw { data: { error: "scale_pipeline_not_configured" } };
      return { images: [a], total: 1, hasMore: false };
    }) as unknown as ResultApi;
    const { result, unmount } = withSetup(() => useResult({ api, gen: makeGen() }));

    await result.load();
    await nextTick();
    result.toggleSelect(a.id);
    await nextTick();

    await result.runScale({ pad: { top: 100, right: 0, bottom: 0, left: 0 } });
    expect(result.scaleError.value).toContain("не настроен");
    unmount();
  });
});

describe("runInpaint", () => {
  it("posts the mask + mode and replaces the source in place", async () => {
    const a = makeImage({ generatedImageUrl: "https://cdn/old.png" });
    const api = makeMutApi(
      { images: [a], total: 1, hasMore: false },
      "/api/generate/inpaint",
      { generationId: a.id, generatedImageUrl: "https://cdn/inp.png" },
    );
    const { result, unmount } = withSetup(() => useResult({ api, gen: makeGen() }));

    await result.load();
    await nextTick();
    result.toggleSelect(a.id);
    await nextTick();

    await result.runInpaint({ maskDataUrl: "data:image/png;base64,AAAA", mode: "fill", prompt: "a cat" });

    const call = scaleCalls(api, "/api/generate/inpaint")[0];
    expect(call?.[1]).toMatchObject({
      method: "POST",
      body: { generationId: a.id, maskDataUrl: "data:image/png;base64,AAAA", mode: "fill", prompt: "a cat" },
    });
    expect(result.images.value[0]!.generatedImageUrl).toMatch(/^https:\/\/cdn\/inp\.png\?v=\d+$/);
    unmount();
  });

  it("omits the prompt for erase mode", async () => {
    const a = makeImage();
    const api = makeMutApi(
      { images: [a], total: 1, hasMore: false },
      "/api/generate/inpaint",
      { generationId: a.id, generatedImageUrl: "https://cdn/inp.png" },
    );
    const { result, unmount } = withSetup(() => useResult({ api, gen: makeGen() }));

    await result.load();
    await nextTick();
    result.toggleSelect(a.id);
    await nextTick();

    await result.runInpaint({ maskDataUrl: "data:image/png;base64,AAAA", mode: "erase" });

    const body = (scaleCalls(api, "/api/generate/inpaint")[0]?.[1] as { body: Record<string, unknown> }).body;
    expect(body.mode).toBe("erase");
    expect(body.prompt).toBeUndefined();
    unmount();
  });
});
