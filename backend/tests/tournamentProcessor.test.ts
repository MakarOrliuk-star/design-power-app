import { describe, it, expect, beforeEach, vi } from "vitest";

// ---- Mocks (hoisted so the processor's module graph picks them up) ----
const db = vi.hoisted(() => ({
  generationFindUnique: vi.fn(),
  generationUpdate: vi.fn(),
  jobUpdate: vi.fn(),
  brandFindUnique: vi.fn(),
  promptTemplateFindFirst: vi.fn(),
}));
const fal = vi.hoisted(() => ({
  runPersonFal: vi.fn(),
  runSeedvrUpscale: vi.fn(),
}));
const fin = vi.hoisted(() => ({
  finalizeSuccess: vi.fn(),
  finalizeFailure: vi.fn(),
}));
const pp = vi.hoisted(() => ({
  buildPersonPromptMemoized: vi.fn(),
}));

vi.mock("../src/env.js", () => ({
  personPipelineReady: true,
  itemPipelineReady: true,
  editPipelineReady: true,
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    generation: { findUnique: db.generationFindUnique, update: db.generationUpdate },
    job: { update: db.jobUpdate },
    brand: { findUnique: db.brandFindUnique },
    promptTemplate: { findFirst: db.promptTemplateFindFirst },
  },
}));
vi.mock("../src/lib/fal.js", () => ({
  runPersonFal: fal.runPersonFal,
  runSeedvrUpscale: fal.runSeedvrUpscale,
}));
vi.mock("../src/lib/cloudinary.js", () => ({
  uploadFromUrl: vi.fn(),
  withRetry: vi.fn(async (f: () => Promise<unknown>) => ({
    success: true,
    secure_url: "https://cdn/stored.png",
  })),
}));
vi.mock("../src/services/finalize.js", () => ({
  finalizeSuccess: fin.finalizeSuccess,
  finalizeFailure: fin.finalizeFailure,
}));
// The TOURNAMENT branch delegates to the Person prompt-writer — mock it out so
// no nano-gpt/redis is touched here.
vi.mock("../src/queues/person.processor.js", () => ({
  buildPersonPromptMemoized: pp.buildPersonPromptMemoized,
}));

import { processItemJob } from "../src/queues/item.processor.js";

function genRow(over: Record<string, unknown> = {}) {
  return {
    brandName: "Bonuskong",
    description: "base prompt", // element prompt (override ?? default)
    referenceImages: ["https://cdn/ref1.png", "https://cdn/ref2.png"],
    isEdit: false,
    actionType: "TOURNAMENT",
    batchId: "batch1",
    job: { id: "job1", cloudinaryFolder: "tournaments/tournament/2026-07-08" },
    ...over,
  };
}

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset();
  for (const fn of Object.values(fal)) fn.mockReset();
  for (const fn of Object.values(fin)) fn.mockReset();
  pp.buildPersonPromptMemoized.mockReset();
  db.generationUpdate.mockResolvedValue({});
  db.jobUpdate.mockResolvedValue({});
  db.brandFindUnique.mockResolvedValue({
    imageModel: null,
    nanoRef: { stylePrompt: "kong style" },
  });
  pp.buildPersonPromptMemoized.mockResolvedValue("LLM[base prompt]");
  fal.runPersonFal.mockResolvedValue({ success: true, imageUrl: "https://fal/out.png" });
  fal.runSeedvrUpscale.mockResolvedValue({ success: true, imageUrl: "https://fal/up.png" });
});

/**
 * QA — the item worker's TOURNAMENT branch: the element prompt goes through the
 * brand's PERSON prompt-writer (same as the Person flow), the brand stylePrompt
 * is appended verbatim, there is no ITEM-template wrap, and the edit-only
 * SeedVR upscale must NOT run.
 */
describe("processItemJob — TOURNAMENT branch", () => {
  it("rewrites via the Person prompt-writer, appends the brand style, skips the upscale", async () => {
    db.generationFindUnique.mockResolvedValue(genRow());

    await processItemJob("gen1", "9:16");

    // Prompt-writer got batch+brand+element prompt; buildItemPrompt was NOT
    // consulted (its PromptTemplate lookup never fires).
    expect(pp.buildPersonPromptMemoized).toHaveBeenCalledWith("batch1", "Bonuskong", "base prompt");
    expect(db.promptTemplateFindFirst).not.toHaveBeenCalled();
    expect(fal.runPersonFal).toHaveBeenCalledWith(
      "LLM[base prompt]\nkong style",
      ["https://cdn/ref1.png", "https://cdn/ref2.png"],
      "9:16",
      null,
    );
    expect(fal.runSeedvrUpscale).not.toHaveBeenCalled(); // edits only
    expect(fin.finalizeSuccess).toHaveBeenCalledWith("gen1", "https://cdn/stored.png");
  });

  it("without a brand stylePrompt the prompt-writer output goes to fal as-is", async () => {
    db.generationFindUnique.mockResolvedValue(genRow());
    db.brandFindUnique.mockResolvedValue({ imageModel: null, nanoRef: { stylePrompt: "" } });

    await processItemJob("gen1", "9:16");

    expect(fal.runPersonFal).toHaveBeenCalledWith(
      "LLM[base prompt]",
      expect.any(Array),
      "9:16",
      null,
    );
  });

  it("ITEM rows still go through the style template (regression guard)", async () => {
    db.generationFindUnique.mockResolvedValue(
      genRow({ actionType: "CREATE_ITEM", brandName: "Neon", description: "a sword" }),
    );
    db.promptTemplateFindFirst.mockResolvedValue({ content: "wrap({{prompt}})" });

    await processItemJob("gen2");

    expect(fal.runPersonFal).toHaveBeenCalledWith(
      "wrap(a sword)",
      expect.any(Array),
      "1:1",
      null,
    );
  });

  it("edit rows keep their upscale (regression guard)", async () => {
    db.generationFindUnique.mockResolvedValue(
      genRow({ actionType: "CREATE_ITEM", isEdit: true, description: "make it darker" }),
    );

    await processItemJob("gen3");

    expect(fal.runPersonFal).toHaveBeenCalledWith(
      "make it darker",
      expect.any(Array),
      "1:1",
      null,
    );
    expect(fal.runSeedvrUpscale).toHaveBeenCalledTimes(1);
  });
});
