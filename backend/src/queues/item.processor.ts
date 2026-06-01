import { prisma } from "../lib/prisma.js";
import { buildItemPrompt } from "../services/prompts.js";
import { generateItemImage } from "../lib/nanogpt.js";
import { uploadBase64, withRetry } from "../lib/cloudinary.js";
import { finalizeSuccess, finalizeFailure } from "../services/finalize.js";

/**
 * Item worker step: wrap the prompt, generate synchronously via nano-gpt, upload
 * the base64 result to Cloudinary, finalize the row. Mirrors the legacy
 * `processPendingItemJobs`.
 */
export async function processItemJob(generationId: string): Promise<void> {
  const gen = await prisma.generation.findUnique({
    where: { id: generationId },
    select: {
      brandName: true,
      description: true,
      job: { select: { id: true, cloudinaryFolder: true } },
    },
  });
  if (!gen || !gen.job) return;

  const jobId = gen.job.id;
  const folder = gen.job.cloudinaryFolder ?? `brands/${gen.brandName}`;
  const finalPrompt = await buildItemPrompt(gen.brandName, gen.description ?? "");

  const gen1 = await generateItemImage(finalPrompt);
  if (!gen1.success || !gen1.b64) {
    await prisma.job.update({ where: { id: jobId }, data: { status: "FAILED" } });
    await finalizeFailure(generationId, gen1.error ?? "nano-gpt failed");
    return;
  }

  const fileName = `${gen.brandName}_item_${Date.now()}`;
  const up = await withRetry(
    () => uploadBase64(gen1.b64!, fileName, folder),
    `${gen.brandName}#${generationId}`,
  );

  if (up.success && up.secure_url) {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "DONE", responseUrl: up.secure_url },
    });
    await finalizeSuccess(generationId, up.secure_url);
  } else {
    await prisma.job.update({ where: { id: jobId }, data: { status: "FAILED" } });
    await finalizeFailure(generationId, `Cloudinary: ${up.error ?? "unknown"}`);
  }
}
