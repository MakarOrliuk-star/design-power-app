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
