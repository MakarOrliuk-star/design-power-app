import { describe, it, expect, vi } from "vitest";
import { reactive } from "vue";
import {
  buildPackExportQuery,
  packFolderOf,
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

describe("groupPack — the ZIP pack folders", () => {
  it("groups by Brand_Element (index stripped), preserving first-appearance order", () => {
    const a1 = gen({ tourFileName: "Bonuskong_Tournament_1_1" });
    const b1 = gen({ tourFileName: "Bonuskong_Lottery_2_1", tourCategoryKey: "lotterie" });
    const a2 = gen({ tourFileName: "Bonuskong_Tournament_1_2" });
    const groups = groupPack([a1, b1, a2]);
    expect(groups.map((g) => g.title)).toEqual(["Bonuskong_Tournament_1", "Bonuskong_Lottery_2"]);
    expect(groups[0]!.images).toEqual([a1, a2]);
    expect(groups[1]!.categoryKey).toBe("lotterie");
  });

  it("packFolderOf strips only the trailing index", () => {
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
    const genStore = reactive({ runningCount: 0 });
    return { api: api as never, apiBase: "https://api", download, gen: genStore };
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
