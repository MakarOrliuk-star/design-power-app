import { prisma } from "../lib/prisma.js";
import { buildItemPrompt } from "../services/prompts.js";
import { buildPersonPromptMemoized } from "./person.processor.js";
import { runPersonFal, runSeedvrUpscale } from "../lib/fal.js";
import { uploadFromUrl, withRetry } from "../lib/cloudinary.js";
import { finalizeSuccess, finalizeFailure } from "../services/finalize.js";

/**
 * Item worker step (ADDENDUM §2): wrap the prompt with the ITEM template, then
 * generate via `fal-ai/nano-banana-2/edit` (img2img on the user's uploaded ref
 * when present, else text-to-image), upload the result URL to Cloudinary, and
 * finalize the row. Same fal client as Person.
 */
export async function processItemJob(generationId: string, aspectRatio = "1:1"): Promise<void> {
  const gen = await prisma.generation.findUnique({
    where: { id: generationId },
    select: {
      brandName: true,
      description: true,
      referenceImages: true,
      isEdit: true,
      actionType: true,
      batchId: true,
      job: { select: { id: true, cloudinaryFolder: true } },
    },
  });
  if (!gen || !gen.job) return;

  const jobId = gen.job.id;
  const folder = gen.job.cloudinaryFolder ?? `brands/${gen.brandName}`;
  await prisma.job.update({ where: { id: jobId }, data: { status: "PROCESSING" } });
  await prisma.generation.update({
    where: { id: generationId },
    data: { status: "PROCESSING", statusMessage: "⏳ Generating" },
  });

  // Per-brand fal model override (admin-managed); null → default nano-banana-2.
  // Applies to Item generation and Result-page edits alike. stylePrompt is
  // appended to TOURNAMENT prompts after the prompt-writer pass.
  const brand = await prisma.brand.findUnique({
    where: { name: gen.brandName },
    select: { imageModel: true, nanoRef: { select: { stylePrompt: true } } },
  });

  // Edits (Result page) run nano-banana-2/edit on the source image with the user's
  // raw instruction — no ITEM style template, so the edit isn't re-styled.
  // Tournament rows carry the element prompt: the brand's PERSON prompt-writer
  // (nano-gpt, same as the Person flow) rewrites it into the final image prompt,
  // then the brand stylePrompt is appended verbatim.
  let finalPrompt: string;
  if (gen.isEdit) {
    finalPrompt = (gen.description ?? "").trim();
  } else if (gen.actionType === "TOURNAMENT") {
    const built = await buildPersonPromptMemoized(
      gen.batchId ?? "",
      gen.brandName,
      (gen.description ?? "").trim(),
    );
    const style = (brand?.nanoRef?.stylePrompt ?? "").trim();
    finalPrompt = style ? `${built}\n${style}` : built;
  } else {
    finalPrompt = await buildItemPrompt(gen.brandName, gen.description ?? "");
  }

  const fal = await runPersonFal(finalPrompt, gen.referenceImages, aspectRatio, brand?.imageModel ?? null);
  if (!fal.success || !fal.imageUrl) {
    await prisma.job.update({ where: { id: jobId }, data: { status: "FAILED" } });
    await finalizeFailure(generationId, `fal: ${fal.error ?? "unknown"}`);
    return;
  }

  // Edits go through a SeedVR upscale before being stored, so the edited result is
  // delivered at higher resolution. On a transient upscale failure we fall back to
  // the (already edited) image so the edit still completes.
  let imageUrl = fal.imageUrl;
  if (gen.isEdit) {
    await prisma.generation.update({
      where: { id: generationId },
      data: { statusMessage: "🔬 Upscaling" },
    });
    const upscaled = await runSeedvrUpscale(fal.imageUrl);
    if (upscaled.success && upscaled.imageUrl) {
      imageUrl = upscaled.imageUrl;
    } else {
      console.warn(`SeedVR upscale failed for ${generationId}: ${upscaled.error ?? "unknown"} — using non-upscaled edit`);
    }
  }

  const up = await withRetry(
    () => uploadFromUrl(imageUrl, `${gen.brandName}_item_${Date.now()}`, folder),
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
