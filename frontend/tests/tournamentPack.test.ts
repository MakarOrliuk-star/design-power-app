import { describe, it, expect, vi } from "vitest";
import { reactive } from "vue";
import {
  buildPackExportQuery,
  packFolderOf,
  packDisplayName,
  groupPack,
  groupPackByElement,
  batchStatusLabel,
  packCounts,
  exportableIds,
  replacePackImage,
  visibleGenerations,
  batchCategoryLabel,
  prettifyCategoryKey,
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

  it("packDisplayName = brand + element + index + gender (Frame 110-1 caption)", () => {
    expect(packDisplayName(gen({ tourFileName: "Bonuskong_Tournament_1_2" }))).toBe(
      "Bonuskong_Tournament_1_2",
    );
    expect(
      packDisplayName(
        gen({ tourFileName: "SpinogambinoMen_Tournament_1_2", brandName: "Spinogambino(Men)" }),
      ),
    ).toBe("Spinogambino_Tournament_1_2_men");
    expect(
      packDisplayName(
        gen({ tourElementName: "Playson & Booongo", tourFileName: "Bonuskong_Playson_&_Booongo_3" }),
      ),
    ).toBe("Bonuskong_Playson_&_Booongo_3");
  });

  it("packFolderOf strips only the trailing index (old-row fallback)", () => {
    expect(packFolderOf("Bonuskong_Playson_&_Booongo_3")).toBe("Bonuskong_Playson_&_Booongo");
    expect(packFolderOf("Bonuskong_Tournament_1_12")).toBe("Bonuskong_Tournament_1");
  });

  it("skips rows without a fixed file name (never crashes the tab)", () => {
    expect(groupPack([gen({ tourFileName: null })])).toEqual([]);
  });
});

describe("groupPackByElement — the Frame 110-1 subcategory level", () => {
  it("groups by element+mode with 'Element_Mode' titles, first-appearance order", () => {
    const t1a = gen({ tourElementName: "Tournament_1" });
    const t2 = gen({ tourElementName: "Tournament_2", tourFileName: "Bonuskong_Tournament_2_1" });
    const t1b = gen({
      tourElementName: "Tournament_1",
      brandName: "Spinogambino(Men)",
      tourFileName: "SpinogambinoMen_Tournament_1_1",
    });
    const groups = groupPackByElement([t1a, t2, t1b]);
    // Brands merge inside a subcategory — the level is the element, not the brand.
    expect(groups.map((g) => g.title)).toEqual(["Tournament_1_Base", "Tournament_2_Base"]);
    expect(groups[0]!.images).toEqual([t1a, t1b]);
    expect(groups[1]!.images).toEqual([t2]);
  });

  it("the same element under Base and VIP makes two visually separate blocks", () => {
    const base = gen({ tourMode: "BASE" });
    const vip = gen({ tourMode: "VIP" });
    const groups = groupPackByElement([base, vip]);
    expect(groups.map((g) => g.title)).toEqual(["Tournament_1_Base", "Tournament_1_VIP"]);
  });

  it("skips rows without a fixed file name (never crashes the tab)", () => {
    expect(groupPackByElement([gen({ tourFileName: null })])).toEqual([]);
  });
});

describe("packCounts / exportableIds / batchStatusLabel", () => {
  it("failed rows are excluded from the total ('7 of 7', not '7 of 8')", () => {
    const batch: PackBatch = {
      id: "b1",
      status: "PARTIAL_FAILURE",
      createdAt: "2026-07-08T10:00:00Z",
      generations: [
        gen(),
        gen({ status: "FAILED", generatedImageUrl: null }), // hidden entirely
        gen({ status: "DONE", generatedImageUrl: null }), // stored URL missing
      ],
    };
    expect(packCounts(batch)).toEqual({ done: 1, total: 2 });
    expect(exportableIds([batch])).toEqual([batch.generations[0]!.id]);
  });

  it("visibleGenerations drops failed/cancelled rows, keeps pending ones", () => {
    const ok = gen();
    const pending = gen({ status: "PROCESSING", generatedImageUrl: null });
    const failed = gen({ status: "FAILED", generatedImageUrl: null });
    const cancelled = gen({ status: "CANCELLED", generatedImageUrl: null });
    expect(visibleGenerations([ok, failed, pending, cancelled])).toEqual([ok, pending]);
  });

  it("maps batch statuses to RU labels; PARTIAL_FAILURE reads as Готово (fails hidden)", () => {
    expect(batchStatusLabel("IN_PROGRESS")).toBe("Генерация…");
    expect(batchStatusLabel("PARTIAL_FAILURE")).toBe("Готово");
    expect(batchStatusLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW"); // graceful fallback
  });
});

describe("batchCategoryLabel — the main category line (Frame 110-1)", () => {
  it("prettifies the rows' category key and appends the generated mode(s)", () => {
    const batch: PackBatch = {
      id: "b1",
      status: "COMPLETED",
      createdAt: "2026-07-13T16:22:00Z",
      generations: [gen({ tourCategoryKey: "tournament" }), gen({ tourCategoryKey: "tournament" })],
    };
    expect(batchCategoryLabel(batch)).toBe("Tournament (Base)");
    const both: PackBatch = {
      ...batch,
      generations: [gen({ tourMode: "BASE" }), gen({ tourMode: "VIP" })],
    };
    expect(batchCategoryLabel(both)).toBe("Tournament (Base + VIP)");
  });

  it("handles multi-word keys, mixed batches and missing keys/modes", () => {
    expect(prettifyCategoryKey("calendar_vip")).toBe("Calendar VIP");
    expect(prettifyCategoryKey("lotterie")).toBe("Lotterie");
    const mixed: PackBatch = {
      id: "b1",
      status: "COMPLETED",
      createdAt: "2026-07-13T16:22:00Z",
      generations: [gen({ tourCategoryKey: "lotterie" }), gen({ tourCategoryKey: "provider" })],
    };
    expect(batchCategoryLabel(mixed)).toBe("Lotterie + Provider (Base)");
    const legacy: PackBatch = {
      ...mixed,
      generations: [gen({ tourCategoryKey: null, tourMode: null })],
    };
    expect(batchCategoryLabel(legacy)).toBe("Tournament"); // graceful fallback
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

  it("toggleSelectAll ticks every exportable image across batches, then clears", async () => {
    const g1 = gen();
    const g2 = gen();
    const failed = gen({ status: "FAILED", generatedImageUrl: null });
    const deps = makeDeps([
      { id: "b1", status: "COMPLETED", createdAt: "2026-07-10T10:00:00Z", generations: [g1, failed] },
      { id: "b2", status: "COMPLETED", createdAt: "2026-07-09T10:00:00Z", generations: [g2] },
    ]);
    const { result, unmount } = withSetup(() => useTournamentPack(deps));
    await vi.waitFor(() => expect(result.batches.value).toHaveLength(2));

    result.toggleSelectAll();
    expect([...result.selected.value].sort()).toEqual([g1.id, g2.id].sort());
    result.toggleSelectAll(); // all selected -> clears
    expect(result.selected.value.size).toBe(0);
    unmount();
  });

  it("runEdit in EACH mode sends the per-image prompt map", async () => {
    const g1 = gen();
    const g2 = gen();
    const batch: PackBatch = {
      id: "b1",
      status: "COMPLETED",
      createdAt: "2026-07-10T10:00:00Z",
      generations: [g1, g2],
    };
    const deps = makeDeps([batch]);
    (deps.api as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) =>
      url === "/api/generate/edit"
        ? { batchId: "edit-b1", count: 2 }
        : { batches: [batch], total: 1, hasMore: false },
    );
    const { result, unmount } = withSetup(() => useTournamentPack(deps));
    await vi.waitFor(() => expect(result.batches.value).toHaveLength(1));

    result.toggleSelect(g1.id);
    result.toggleSelect(g2.id);
    result.perEditPrompts.value = { [g1.id]: "neon", [g2.id]: "" };
    await result.runEdit("EACH");
    // A missing per-image prompt is a user-facing error, not a request.
    expect(deps.api).not.toHaveBeenCalledWith("/api/generate/edit", expect.anything());
    expect(result.editError.value).toContain("каждой");

    result.perEditPrompts.value = { [g1.id]: "neon", [g2.id]: "gold" };
    await result.runEdit("EACH");
    expect(deps.api).toHaveBeenCalledWith("/api/generate/edit", {
      method: "POST",
      body: { generationIds: [g1.id, g2.id], perPrompts: { [g1.id]: "neon", [g2.id]: "gold" } },
    });
    unmount();
  });

  it("panelScaleImage targets the pencil'd card, else the single ticked image", async () => {
    const g1 = gen();
    const g2 = gen();
    const batch: PackBatch = {
      id: "b1",
      status: "COMPLETED",
      createdAt: "2026-07-10T10:00:00Z",
      generations: [g1, g2],
    };
    const deps = makeDeps([batch]);
    const { result, unmount } = withSetup(() => useTournamentPack(deps));
    await vi.waitFor(() => expect(result.batches.value).toHaveLength(1));

    expect(result.panelScaleImage.value).toBeNull(); // nothing ticked, no pencil
    result.toggleSelect(g1.id);
    expect(result.panelScaleImage.value).toMatchObject({ id: g1.id });
    result.toggleSelect(g2.id); // two ticked -> ambiguous, no target
    expect(result.panelScaleImage.value).toBeNull();

    result.setScaleTarget(g2.id); // the pencil wins over the selection
    expect(result.panelScaleImage.value).toMatchObject({ id: g2.id });
    result.toggleSelect(g2.id); // any selection change drops the stale pencil
    expect(result.panelScaleImage.value).toMatchObject({ id: g1.id });
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
