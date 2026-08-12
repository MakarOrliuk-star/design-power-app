import { describe, it, expect, beforeEach, vi } from "vitest";

const db = vi.hoisted(() => ({
  brandFindUnique: vi.fn(),
  batchCreate: vi.fn(),
  generationCreate: vi.fn(),
}));
const queue = vi.hoisted(() => ({ add: vi.fn() }));

vi.mock("../src/env.js", () => ({
  personPipelineReady: true,
  itemPipelineReady: true,
  editPipelineReady: true,
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    brand: { findUnique: db.brandFindUnique },
    batch: { create: db.batchCreate },
    generation: { create: db.generationCreate },
  },
}));
vi.mock("../src/queues/index.js", () => ({
  getPersonQueue: () => ({ add: queue.add, addBulk: vi.fn() }),
  getItemQueue: () => ({ add: vi.fn(), addBulk: vi.fn() }),
}));

import { createBrandTestBatch } from "../src/services/generation.service.js";

beforeEach(() => {
  for (const fn of [...Object.values(db), ...Object.values(queue)]) fn.mockReset();
  db.brandFindUnique.mockResolvedValue({
    id: "b1",
    name: "Betnella",
    forcedAspectRatio: null,
    nanoRef: { referenceImages: ["https://cdn/ref-1.png", "https://cdn/ref-2.png"] },
  });
  db.batchCreate.mockResolvedValue({ id: "batch1" });
  db.generationCreate.mockResolvedValue({ id: "gen1" });
});

/**
 * BE Test — brand test runs (задача 5). Every run is tagged by origin; a test of
 * the SAVED brand is visible (lands in Results with no «Сохранить» step), while a
 * DRAFT run stays hidden — it doesn't match the stored brand.
 */
describe("createBrandTestBatch", () => {
  it("creates a visible run tagged isBrandTest (no isTest flag)", async () => {
    const res = await createBrandTestBatch({
      userId: "user1",
      brandId: "b1",
      prompt: "bulldog on a cloud",
      aspectRatio: "9:16",
    });

    expect(res).toEqual({ batchId: "batch1", generationId: "gen1" });
    const data = db.generationCreate.mock.calls[0]![0].data;
    expect(data.isBrandTest).toBe(true);
    expect(data.isTest).toBeUndefined(); // defaults to false → visible in Results
    expect(data.brandId).toBe("b1");
    expect(data.brandName).toBe("Betnella");
    expect(data.actionType).toBe("NANO_REF");
    expect(data.referenceImages).toEqual(["https://cdn/ref-1.png"]); // count=1 → refs[0]
    expect(queue.add).toHaveBeenCalledWith("submit", {
      generationId: "gen1",
      batchId: "batch1",
      aspectRatio: "9:16",
    });
  });

  it("keeps a DRAFT run out of Results and uses the brand's forced aspect ratio", async () => {
    db.brandFindUnique.mockResolvedValue({
      id: "b1",
      name: "Betnella",
      forcedAspectRatio: "9:16",
      nanoRef: { referenceImages: ["https://cdn/saved.png"] },
    });

    await createBrandTestBatch({
      userId: "user1",
      brandId: "b1",
      prompt: "p",
      aspectRatio: "1:1", // overridden by the brand's forced ratio
      draft: true,
      overrides: { personPrompt: "draft person", referenceImages: ["https://cdn/draft.png"] },
    });

    const data = db.generationCreate.mock.calls[0]![0].data;
    expect(data.referenceImages).toEqual(["https://cdn/draft.png"]);
    expect(data.isBrandTest).toBe(true); // still a test run for Library's purposes
    expect(data.isTest).toBe(true); // …but hidden from Results
    expect(data.job.create.draftOverrides).toEqual({ personPrompt: "draft person" });
    expect(queue.add).toHaveBeenCalledWith("submit", expect.objectContaining({ aspectRatio: "9:16" }));
  });

  it("throws when the brand is gone", async () => {
    db.brandFindUnique.mockResolvedValue(null);
    await expect(
      createBrandTestBatch({ userId: "user1", brandId: "nope", prompt: "p", aspectRatio: "1:1" }),
    ).rejects.toThrow("brand_not_found");
    expect(db.generationCreate).not.toHaveBeenCalled();
  });
});
