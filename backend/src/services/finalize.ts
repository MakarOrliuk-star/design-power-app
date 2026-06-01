import { prisma } from "../lib/prisma.js";

/**
 * Shared terminal-state helpers used by the item worker, the fal webhook, and
 * the reconcile job. Keeping batch-status recomputation in one place mirrors the
 * legacy session-status aggregation.
 */

export async function finalizeSuccess(generationId: string, secureUrl: string): Promise<void> {
  const gen = await prisma.generation.update({
    where: { id: generationId },
    data: { status: "DONE", generatedImageUrl: secureUrl, statusMessage: "✅ Done" },
    select: { batchId: true },
  });
  if (gen.batchId) await recomputeBatchStatus(gen.batchId);
}

export async function finalizeFailure(generationId: string, message: string): Promise<void> {
  const gen = await prisma.generation.update({
    where: { id: generationId },
    data: { status: "FAILED", statusMessage: `❌ ${message}`.slice(0, 280) },
    select: { batchId: true },
  });
  if (gen.batchId) await recomputeBatchStatus(gen.batchId);
}

/** Recompute the batch's aggregate status from its generations. */
export async function recomputeBatchStatus(batchId: string): Promise<void> {
  const gens = await prisma.generation.findMany({
    where: { batchId },
    select: { status: true },
  });
  if (gens.length === 0) return;

  const done = gens.filter((g) => g.status === "DONE").length;
  const failed = gens.filter((g) => g.status === "FAILED").length;
  const cancelled = gens.filter((g) => g.status === "CANCELLED").length;
  const pending = gens.length - done - failed - cancelled;

  let status: "IN_PROGRESS" | "COMPLETED" | "PARTIAL_FAILURE" | "FAILED" | "CANCELLED";
  if (pending > 0) status = "IN_PROGRESS";
  else if (failed > 0 && done > 0) status = "PARTIAL_FAILURE";
  else if (failed > 0) status = "FAILED";
  else if (cancelled > 0 && done === 0) status = "CANCELLED";
  else status = "COMPLETED";

  await prisma.batch.update({ where: { id: batchId }, data: { status } });
}
