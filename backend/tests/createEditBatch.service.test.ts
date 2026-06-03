import { describe, it, expect, beforeEach, vi } from "vitest";

// env is mocked only to dodge its import-time process.exit() validation (the
// queues module, pulled in transitively, imports it).
const db = vi.hoisted(() => ({
  batchCreate: vi.fn(),
  generationCreate: vi.fn(),
}));
const queue = vi.hoisted(() => ({ addBulk: vi.fn() }));

vi.mock("../src/env.js", () => ({
  personPipelineReady: true,
  itemPipelineReady: true,
  editPipelineReady: true,
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    batch: { create: db.batchCreate },
    generation: { create: db.generationCreate },
  },
}));
vi.mock("../src/queues/index.js", () => ({
  getPersonQueue: () => ({ addBulk: queue.addBulk }),
  getItemQueue: () => ({ addBulk: queue.addBulk }),
}));

import { createEditBatch } from "../src/services/generation.service.js";

beforeEach(() => {
  db.batchCreate.mockReset();
  db.generationCreate.mockReset();
  queue.addBulk.mockReset();
  db.batchCreate.mockResolvedValue({ id: "batch1" });
  db.generationCreate.mockImplementation(async ({ data }: { data: { brandName: string } }) => ({
    id: `gen-${data.brandName}`,
  }));
});

const sources = [
  {
    sourceImageUrl: "https://cdn/orig-1.png",
    brandName: "Nike",
    theme: null,
    actionType: "FULL" as const,
    prompt: "make it darker",
    aspect: "1:1",
  },
  {
    sourceImageUrl: "https://cdn/orig-2.png",
    brandName: "Adidas",
    theme: "winter",
    actionType: "CREATE_ITEM" as const,
    prompt: "add neon glow",
    aspect: "16:9",
  },
];

/**
 * BE Test 5 — createEditBatch service (TASK §5 / Phase 4).
 * Each selected image becomes a NEW isEdit row that preserves the original's
 * brand + content type and edits the source URL — the original row is never
 * mutated — and exactly one queue job is enqueued per source.
 */
describe("createEditBatch", () => {
  it("creates one isEdit generation per source, preserving brand/type, and enqueues jobs", async () => {
    const res = await createEditBatch("user1", sources);

    expect(res).toEqual({ batchId: "batch1", count: 2 });
    expect(db.batchCreate).toHaveBeenCalledTimes(1);
    expect(db.generationCreate).toHaveBeenCalledTimes(2);

    const first = db.generationCreate.mock.calls[0]![0].data;
    expect(first.isEdit).toBe(true); // result is a NEW edited row, not a mutation
    expect(first.brandName).toBe("Nike"); // style/label preserved
    expect(first.actionType).toBe("FULL"); // content type preserved
    expect(first.referenceImages).toEqual(["https://cdn/orig-1.png"]); // edits the source image
    expect(first.description).toBe("make it darker");

    // One bulk enqueue, one job per source, routed through the item queue.
    expect(queue.addBulk).toHaveBeenCalledTimes(1);
    expect(queue.addBulk.mock.calls[0]![0]).toHaveLength(2);
    expect(queue.addBulk.mock.calls[0]![0][0].name).toBe("generate");
  });

  it("throws when there is nothing to edit", async () => {
    await expect(createEditBatch("user1", [])).rejects.toThrow("nothing_to_edit");
    expect(db.batchCreate).not.toHaveBeenCalled();
  });
});
