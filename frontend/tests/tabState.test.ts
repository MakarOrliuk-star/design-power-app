import { describe, it, expect, vi } from "vitest";
import { nextTick } from "vue";
import { parseTab, parseMode, useResult } from "~/composables/useResult";
import { makeImage, makeApi, makeGen, withSetup } from "./helpers";

/**
 * Задача 2 + 4 — the Result page keeps its tab across a reload (`?tab=&mode=`)
 * and an Edit submission no longer redirects to the Edited tab.
 */
describe("tab state (?tab=&mode=)", () => {
  it("parseTab accepts known enabled tabs and falls back to generated", () => {
    expect(parseTab("edited")).toBe("edited");
    expect(parseTab("tournament")).toBe("tournament");
    expect(parseTab("background")).toBe("generated"); // disabled — no pipeline
    expect(parseTab("nope")).toBe("generated");
    expect(parseTab(undefined)).toBe("generated");
    expect(parseTab(["edited"])).toBe("generated"); // repeated query param
  });

  it("parseMode only accepts EACH", () => {
    expect(parseMode("EACH")).toBe("EACH");
    expect(parseMode("ALL")).toBe("ALL");
    expect(parseMode("each")).toBe("ALL");
    expect(parseMode(undefined)).toBe("ALL");
  });

  it("restores the tab from the URL with a single load", async () => {
    const api = makeApi({ images: [], total: 0, hasMore: false });
    const { result, unmount } = withSetup(() =>
      useResult({ api, gen: makeGen(), initial: { tab: "edited", mode: "EACH" } }),
    );
    await nextTick();

    expect(result.activeTab.value).toBe("edited");
    expect(result.selectMode.value).toBe("EACH");
    // onMounted must issue exactly one request — for the restored tab.
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith(
      "/api/generations",
      expect.objectContaining({ query: expect.objectContaining({ tab: "edited" }) }),
    );

    unmount();
  });

  it("reports tab and mode changes back to the page", async () => {
    const api = makeApi({ images: [], total: 0, hasMore: false });
    const onStateChange = vi.fn();
    const { result, unmount } = withSetup(() =>
      useResult({ api, gen: makeGen(), onStateChange }),
    );

    result.selectTab("item");
    await nextTick();
    expect(onStateChange).toHaveBeenLastCalledWith({ tab: "item", mode: "ALL" });

    result.selectMode.value = "EACH";
    await nextTick();
    expect(onStateChange).toHaveBeenLastCalledWith({ tab: "item", mode: "EACH" });

    unmount();
  });

  it("runEdit keeps the user on the current tab and preserves the prompt", async () => {
    const images = [makeImage()];
    const api = vi.fn(async (url: string) =>
      url === "/api/generate/edit"
        ? { batchId: "b1", count: 1 }
        : { images, total: 1, hasMore: false },
    );
    const { result, unmount } = withSetup(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useResult({ api: api as any, gen: makeGen(), initial: { tab: "person" } }),
    );

    await result.load();
    await nextTick();
    result.toggleSelect(images[0]!.id);
    result.editPrompt.value = "make it darker";
    await result.runEdit();

    expect(result.activeTab.value).toBe("person"); // задача 2: no redirect
    expect(result.editPrompt.value).toBe("make it darker"); // re-runnable
    expect(result.selectedImages.value).toHaveLength(0); // selection cleared
    expect(result.editMsg.value).toContain("General");

    unmount();
  });
});
