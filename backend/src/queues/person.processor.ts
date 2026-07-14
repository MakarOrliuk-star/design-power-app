import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { ensureRedis, redis } from "../lib/redis.js";
import { getPersonSystemPrompt } from "../services/prompts.js";
import { buildPersonPrompt } from "../lib/nanogpt.js";
import { runPersonFal } from "../lib/fal.js";
import { uploadFromUrl, withRetry } from "../lib/cloudinary.js";
import { finalizeSuccess, finalizeFailure } from "../services/finalize.js";

/**
 * Person worker step (synchronous, matches the Make blueprint):
 *   build prompt (nano-gpt chat, memoized per brand+text) → run fal SYNC
 *   (fal.run/nano-banana-2[/edit]) → upload the result URL to Cloudinary →
 *   finalize the row. fal.run blocks until the image is ready, so the BullMQ
 *   person worker is configured with a long lock duration.
 */
export async function processPersonJob(generationId: string, aspectRatio = "1:1"): Promise<void> {
  const gen = await prisma.generation.findUnique({
    where: { id: generationId },
    select: {
      brandName: true,
      description: true,
      referenceImages: true,
      batchId: true,
      job: { select: { id: true, cloudinaryFolder: true } },
    },
  });
  if (!gen || !gen.job) return; // row/job gone (cancelled) → no-op

  const jobId = gen.job.id;
  const folder = gen.job.cloudinaryFolder ?? `brands/${gen.brandName}`;
  await prisma.job.update({ where: { id: jobId }, data: { status: "PROCESSING" } });
  await prisma.generation.update({
    where: { id: generationId },
    data: { status: "PROCESSING", statusMessage: "⏳ Generating" },
  });

  const userText = gen.description ?? "";
  const builtPrompt = await buildPersonPromptMemoized(gen.batchId ?? "", gen.brandName, userText);
  // ADDENDUM §7: two refs are blended via the PROMPT (nano-banana-2/edit has no
  // strength/controlnet weights). First image = brand style ref; the rest = the
  // user-uploaded image.
  const prompt = withBlendingHint(builtPrompt, gen.referenceImages.length);

  // Per-brand fal model override (admin-managed); null → default nano-banana-2.
  const brand = await prisma.brand.findUnique({
    where: { name: gen.brandName },
    select: { imageModel: true },
  });

  const fal = await runPersonFal(prompt, gen.referenceImages, aspectRatio, brand?.imageModel ?? null);
  if (!fal.success || !fal.imageUrl) {
    await prisma.job.update({ where: { id: jobId }, data: { status: "FAILED" } });
    await finalizeFailure(generationId, `fal: ${fal.error ?? "unknown"}`);
    return;
  }

  const up = await withRetry(
    () => uploadFromUrl(fal.imageUrl!, `${gen.brandName}_person_${Date.now()}`, folder),
    `${gen.brandName}#${generationId}`,
  );
  if (up.success && up.secure_url) {
    await prisma.job.update({ where: { id: jobId }, data: { status: "DONE", responseUrl: up.secure_url } });
    await finalizeSuccess(generationId, up.secure_url);
  } else {
    await prisma.job.update({ where: { id: jobId }, data: { status: "FAILED" } });
    await finalizeFailure(generationId, `Cloudinary: ${up.error ?? "unknown"}`);
  }
}

/** Append a blending directive when 2+ reference images are sent to fal. */
function withBlendingHint(prompt: string, imageCount: number): string {
  if (imageCount < 2) return prompt;
  return `${prompt} Use the first reference image for the brand style, wardrobe and overall look; take the subject identity and pose from the additional reference image. Blend them into one coherent result.`;
}

/**
 * system = brand's PERSON prompt (or the global default), user = the text —
 * nano-gpt writes the final image prompt, memoized per batch+brand+text.
 * Shared with the item worker's TOURNAMENT branch, which reuses the Person
 * prompt-writer for tournament element prompts.
 */
export async function buildPersonPromptMemoized(
  batchId: string,
  brandName: string,
  userText: string,
): Promise<string> {
  const key = `pp:${batchId}:${createHash("sha1").update(`${brandName}|${userText}`).digest("hex")}`;
  try {
    await ensureRedis();
    const cached = await redis.get(key);
    if (cached !== null) return cached;
  } catch {
    /* fall through to compute */
  }

  const system = await getPersonSystemPrompt(brandName);
  const prompt = await buildPersonPrompt(system, userText);

  try {
    await redis.set(key, prompt, "EX", 900);
  } catch {
    /* memo is best-effort */
  }
  return prompt;
}
