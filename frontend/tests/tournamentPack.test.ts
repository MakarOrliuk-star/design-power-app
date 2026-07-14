import { describe, it, expect, vi } from "vitest";
import { reactive } from "vue";
import {
  buildPackExportQuery,
  packFolderOf,
  packDisplayName,
  groupPack,
  batchStatusLabel,
  packCounts,
  exportableIds,
  replacePackImage,
  useTournamentPack,
  type PackBatch,
  type PackGeneration,
} from "~/composables/useTournamentPack";
import { withSetup } from "./helpers";

let seq = 0;
function gen(over: Partial<PackGeneration> = {}): PackGeneration {
  seq += 1;
  return {
    id: `g${seq}`,
    status: "DONE",
    statusMessage: null,
    generatedImageUrl: `https://cdn/${seq}.png`,
    brandName: "Bonuskong",
    tourCategoryKey: "tournament",
    tourElementName: "Tournament_1",
    tourMode: "BASE",
    tourFileName: `Bonuskong_Tournament_1_${seq}`,
    ...over,
  };
}

describe("buildPackExportQuery", () => {
  it("an explicit selection wins over the batch (mirrors the Archive contract)", () => {
    const p = new URLSearchParams(buildPackExportQuery({ batchId: "b1", ids: ["g1", "g2"] }));
    expect(p.get("ids")).toBe("g1,g2");
    expect(p.get("batchId")).toBeNull();
  });
  it("whole-batch export sends batchId only", () => {
    const p = new URLSearchParams(buildPackExportQuery({ batchId: "b1", ids: [] }));
    expect(p.get("batchId")).toBe("b1");
    expect(p.get("ids")).toBeNull();
  });
});

describe("groupPack — the flat ZIP layout ({Brand}/{Element}_N.png)", () => {
  it("groups by brand folder, preserving first-appearance order", () => {
    const a1 = gen({ tourFileName: "Bonuskong_Tournament_1_1" });
    const b1 = gen({
      tourFileName: "Bonuskong_Lottery_2_1",
      tourElementName: "Lottery_2",
      tourCategoryKey: "lotterie",
    });
    const a2 = gen({ tourFileName: "Bonuskong_Tournament_1_2" });
    const other = gen({
      tourFileName: "SpinogambinoMen_Tournament_1_1",
      brandName: "Spinogambino(Men)",
    });
    const women = gen({
      tourFileName: "SpinogambinoWomen_Tournament_1_1",
      brandName: "Spinogambino (Women)",
    });
    const groups = groupPack([a1, b1, a2, other, women]);
    // One folder per brand; (Men)/(Women) merge, elements mix — like the ZIP.
    expect(groups.map((g) => g.title)).toEqual(["Bonuskong", "Spinogambino"]);
    expect(groups[0]!.images).toEqual([a1, b1, a2]);
    expect(groups[1]!.images).toEqual([other, women]);
  });

  it("packDisplayName = element + index + gender suffix (the ZIP file name)", () => {
    expect(packDisplayName(gen({ tourFileName: "Bonuskong_Tournament_1_2" }))).toBe(
      "Tournament_1_2",
    );
    expect(
      packDisplayName(
        gen({ tourFileName: "SpinogambinoMen_Tournament_1_2", brandName: "Spinogambino(Men)" }),
      ),
    ).toBe("Tournament_1_2_men");
    expect(
      packDisplayName(
        gen({ tourElementName: "Playson & Booongo", tourFileName: "Bonuskong_Playson_&_Booongo_3" }),
      ),
    ).toBe("Playson_&_Booongo_3");
  });

  it("packFolderOf strips only the trailing index (old-row fallback)", () => {
    expect(packFolderOf("Bonuskong_Playson_&_Booongo_3")).toBe("Bonuskong_Playson_&_Booongo");
    expect(packFolderOf("Bonuskong_Tournament_1_12")).toBe("Bonuskong_Tournament_1");
  });

  it("skips rows without a fixed file name (never crashes the tab)", () => {
    expect(groupPack([gen({ tourFileName: null })])).toEqual([]);
  });
});

describe("packCounts / exportableIds / batchStatusLabel", () => {
  it("counts only DONE images with a stored URL as exportable", () => {
    const batch: PackBatch = {
      id: "b1",
      status: "PARTIAL_FAILURE",
      createdAt: "2026-07-08T10:00:00Z",
      generations: [
        gen(),
        gen({ status: "FAILED", generatedImageUrl: null }),
        gen({ status: "DONE", generatedImageUrl: null }), // stored URL missing
      ],
    };
    expect(packCounts(batch)).toEqual({ done: 1, total: 3 });
    expect(exportableIds([batch])).toEqual([batch.generations[0]!.id]);
  });

  it("maps batch statuses to RU labels", () => {
    expect(batchStatusLabel("IN_PROGRESS")).toBe("Генерация…");
    expect(batchStatusLabel("PARTIAL_FAILURE")).toBe("Готово частично");
    expect(batchStatusLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW"); // graceful fallback
  });
});

describe("replacePackImage — in-place swap after Scale/Inpaint", () => {
  it("swaps ONLY the target generation's URL; untouched batches keep identity", () => {
    const g1 = gen();
    const g2 = gen();
    const b1: PackBatch = { id: "b1", status: "COMPLETED", createdAt: "2026-07-10", generations: [g1, g2] };
    const b2: PackBatch = { id: "b2", status: "COMPLETED", createdAt: "2026-07-09", generations: [gen()] };

    const next = replacePackImage([b1, b2], g2.id, "https://cdn/edited.png?v=1");
    expect(next[0]!.generations[1]!.generatedImageUrl).toBe("https://cdn/edited.png?v=1");
    expect(next[0]!.generations[0]).toBe(g1); // sibling row untouched
    expect(next[1]).toBe(b2); // other batch keeps reference identity
  });

  it("unknown id is a no-op on every batch", () => {
    const b: PackBatch = { id: "b1", status: "COMPLETED", createdAt: "2026-07-10", generations: [gen()] };
    expect(replacePackImage([b], "ghost", "https://cdn/x.png")[0]).toBe(b);
  });
});

describe("useTournamentPack — selection + export flow", () => {
  function makeDeps(batches: PackBatch[]) {
    const api = vi.fn(async () => ({ batches, total: batches.length, hasMore: false }));
    const download = vi.fn();
    const genStore = reactive({ runningCount: 0, addBatch: vi.fn() });
    const onEdited = vi.fn();
    return { api: api as never, apiBase: "https://api", download, gen: genStore, onEdited };
  }

  it("exports the ticked ids through the DES endpoint; no-op when nothing ticked", async () => {
    const g1 = gen();
    const deps = makeDeps([
      { id: "b1", status: "COMPLETED", createdAt: "2026-07-08T10:00:00Z", generations: [g1] },
    ]);
    const { result, unmount } = withSetup(() => useTournamentPack(deps));
    await vi.waitFor(() => expect(result.batches.value).toHaveLength(1));

    result.exportSelected();
    expect(deps.download).not.toHaveBeenCalled(); // nothing ticked

    result.toggleSelect(g1.id);
    result.exportSelected();
    expect(deps.download).toHaveBeenCalledWith(
      `https://api/api/tournament/export.zip?ids=${g1.id}`,
    );

    result.exportBatch("b1");
    expect(deps.download).toHaveBeenLastCalledWith(
      "https://api/api/tournament/export.zip?batchId=b1",
    );
    unmount();
  });

  it("batch checkbox ticks/unticks every exportable image of the session", async () => {
    const g1 = gen();
    const g2 = gen();
    const failed = gen({ status: "FAILED", generatedImageUrl: null });
    const batch: PackBatch = {
      id: "b1",
      status: "PARTIAL_FAILURE",
      createdAt: "2026-07-10T10:00:00Z",
      generations: [g1, g2, failed],
    };
    const deps = makeDeps([batch]);
    const { result, unmount } = withSetup(() => useTournamentPack(deps));
    await vi.waitFor(() => expect(result.batches.value).toHaveLength(1));

    expect(result.batchState(batch)).toBe("none");
    result.toggleBatch(batch);
    expect(result.batchState(batch)).toBe("all");
    expect([...result.selected.value].sort()).toEqual([g1.id, g2.id].sort()); // failed skipped

    result.toggleSelect(g2.id);
    expect(result.batchState(batch)).toBe("some");
    result.toggleBatch(batch); // some -> completes the batch
    expect(result.batchState(batch)).toBe("all");
    result.toggleBatch(batch); // all -> clears it
    expect(result.selected.value.size).toBe(0);
    unmount();
  });

  it("runEdit posts the ticked ids to /api/generate/edit and hands off to Edited", async () => {
    const g1 = gen();
    const batch: PackBatch = {
      id: "b1",
      status: "COMPLETED",
      createdAt: "2026-07-10T10:00:00Z",
      generations: [g1],
    };
    const deps = makeDeps([batch]);
    (deps.api as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) =>
      url === "/api/generate/edit"
        ? { batchId: "edit-b1", count: 1 }
        : { batches: [batch], total: 1, hasMore: false },
    );
    const { result, unmount } = withSetup(() => useTournamentPack(deps));
    await vi.waitFor(() => expect(result.batches.value).toHaveLength(1));

    result.editPrompt.value = "make it neon";
    await result.runEdit();
    expect(deps.api).not.toHaveBeenCalledWith("/api/generate/edit", expect.anything()); // nothing ticked

    result.toggleSelect(g1.id);
    await result.runEdit();
    expect(deps.api).toHaveBeenCalledWith("/api/generate/edit", {
      method: "POST",
      body: { generationIds: [g1.id], prompt: "make it neon" },
    });
    expect(deps.gen.addBatch).toHaveBeenCalledWith("edit-b1", "item");
    expect(deps.onEdited).toHaveBeenCalled();
    expect(result.selected.value.size).toBe(0); // selection cleared
    expect(result.editPrompt.value).toBe("");
    unmount();
  });

  it("runScale posts to /generate/scale for the targeted card and swaps its URL in place", async () => {
    const g1 = gen();
    const failed = gen({ status: "FAILED", generatedImageUrl: null });
    const batch: PackBatch = {
      id: "b1",
      status: "PARTIAL_FAILURE",
      createdAt: "2026-07-10T10:00:00Z",
      generations: [g1, failed],
    };
    const deps = makeDeps([batch]);
    (deps.api as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) =>
      url === "/api/generate/scale"
        ? { generationId: g1.id, generatedImageUrl: "https://cdn/scaled.png" }
        : { batches: [batch], total: 1, hasMore: false },
    );
    const { result, unmount } = withSetup(() => useTournamentPack(deps));
    await vi.waitFor(() => expect(result.batches.value).toHaveLength(1));

    // A non-editable row can never become the target.
    result.setScaleTarget(failed.id);
    expect(result.scaleImage.value).toBeNull();
    await result.runScale({ pad: { top: 0, right: 100, bottom: 0, left: 0 } });
    expect(deps.api).not.toHaveBeenCalledWith("/api/generate/scale", expect.anything());

    result.setScaleTarget(g1.id);
    expect(result.scaleImage.value).toMatchObject({ id: g1.id, brandName: g1.brandName });
    await result.runScale({ pad: { top: 0, right: 100, bottom: 0, left: 0 }, prompt: " sky " });
    expect(deps.api).toHaveBeenCalledWith("/api/generate/scale", {
      method: "POST",
      body: { generationId: g1.id, pad: { top: 0, right: 100, bottom: 0, left: 0 }, prompt: "sky" },
    });
    // URL swapped in place (cache-busted) — the target reflects it immediately.
    const updated = result.batches.value[0]!.generations[0]!;
    expect(updated.generatedImageUrl).toMatch(/^https:\/\/cdn\/scaled\.png\?v=\d+$/);
    expect(result.scaleImage.value!.generatedImageUrl).toBe(updated.generatedImageUrl);
    expect(result.scaleMsg.value).toContain("Готово");
    unmount();
  });

  it("runInpaint posts the mask and maps a backend error code to a RU message", async () => {
    const g1 = gen();
    const batch: PackBatch = {
      id: "b1",
      status: "COMPLETED",
      createdAt: "2026-07-10T10:00:00Z",
      generations: [g1],
    };
    const deps = makeDeps([batch]);
    (deps.api as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url === "/api/generate/inpaint")
        throw Object.assign(new Error("bad"), { data: { error: "inpaint_failed" } });
      return { batches: [batch], total: 1, hasMore: false };
    });
    const { result, unmount } = withSetup(() => useTournamentPack(deps));
    await vi.waitFor(() => expect(result.batches.value).toHaveLength(1));

    result.setScaleTarget(g1.id);
    await result.runInpaint({ maskDataUrl: "data:image/png;base64,AAA", mode: "erase" });
    expect(deps.api).toHaveBeenCalledWith("/api/generate/inpaint", {
      method: "POST",
      body: { generationId: g1.id, maskDataUrl: "data:image/png;base64,AAA", mode: "erase" },
    });
    expect(result.scaleError.value).toBe("Не удалось обработать область — попробуйте другую маску.");
    expect(result.batches.value[0]!.generations[0]!.generatedImageUrl).toBe(g1.generatedImageUrl); // untouched
    unmount();
  });

  it("prunes selected ids that are no longer exportable after a reload", async () => {
    const g1 = gen();
    const deps = makeDeps([
      { id: "b1", status: "COMPLETED", createdAt: "2026-07-08T10:00:00Z", generations: [g1] },
    ]);
    const { result, unmount } = withSetup(() => useTournamentPack(deps));
    await vi.waitFor(() => expect(result.batches.value).toHaveLength(1));

    result.toggleSelect(g1.id);
    result.toggleSelect("ghost-id");
    await result.load();
    expect([...result.selected.value]).toEqual([g1.id]); // ghost pruned
    unmount();
  });
});
