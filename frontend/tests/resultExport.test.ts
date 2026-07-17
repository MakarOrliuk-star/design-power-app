import { describe, it, expect, vi } from "vitest";
import { nextTick } from "vue";
import { useResult, buildResultExportQuery } from "~/composables/useResult";
import { makeImage, makeApi, makeGen, withSetup } from "./helpers";

// Result-page ZIP export: selection-only (no filter fallback, unlike the
// Archive) and a `result-*.zip` filename via the backend `prefix` param.
describe("buildResultExportQuery", () => {
  it("sends the ids csv plus the result filename prefix", () => {
    const p = new URLSearchParams(buildResultExportQuery(["g1", "g2"]));
    expect(p.get("ids")).toBe("g1,g2");
    expect(p.get("prefix")).toBe("result");
    expect(p.get("tab")).toBeNull();
    expect(p.get("period")).toBeNull();
  });
});

describe("useResult.exportZip", () => {
  function setup() {
    const a = makeImage();
    const b = makeImage();
    const api = makeApi({ images: [a, b], total: 2, hasMore: false });
    const download = vi.fn();
    const mounted = withSetup(() =>
      useResult({ api, gen: makeGen(), apiBase: "https://api.test", download }),
    );
    return { a, b, download, ...mounted };
  }

  it("does nothing with an empty selection (the button is disabled anyway)", async () => {
    const { result, download, unmount } = setup();
    await nextTick();
    result.exportZip();
    expect(download).not.toHaveBeenCalled();
    expect(result.exporting.value).toBe(false);
    unmount();
  });

  it("downloads the selected ids as a result-prefixed zip and flags exporting", async () => {
    const { a, b, result, download, unmount } = setup();
    await nextTick();
    await nextTick(); // let onMounted load() land the images

    result.toggleSelect(a.id);
    result.toggleSelect(b.id);
    result.exportZip();

    expect(download).toHaveBeenCalledTimes(1);
    const url = new URL(download.mock.calls[0]![0] as string);
    expect(url.origin).toBe("https://api.test");
    expect(url.pathname).toBe("/api/generations/export.zip");
    expect(url.searchParams.get("ids")).toBe(`${a.id},${b.id}`);
    expect(url.searchParams.get("prefix")).toBe("result");
    expect(result.exporting.value).toBe(true);

    // Re-entry guard: a second click while exporting must not double-download.
    result.exportZip();
    expect(download).toHaveBeenCalledTimes(1);
    unmount();
  });
});
