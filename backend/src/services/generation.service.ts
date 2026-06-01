import { prisma } from "../lib/prisma.js";
import { getPersonQueue, getItemQueue } from "../queues/index.js";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function folderFor(brandName: string): string {
  return `brands/${brandName}/${today()}`;
}

interface PersonParams {
  userId: string;
  brandIds: string[];
  themeName: string;
  refMode: "ALL" | "EACH";
  sharedDescription: string;
  perBrandPrompts: Record<string, string>;
  imageCount: number;
  userRefUrls: string[];
}

interface ItemParams {
  userId: string;
  styles: string[]; // Item style names (PromptTemplate ITEM keys), NOT brands
  themeName: string;
  sharedDescription: string;
  perStylePrompts: Record<string, string>;
  imageCount: number;
}

export interface CreateBatchResult {
  batchId: string;
  count: number;
}

/**
 * Person (fal). Per brand: one fal job PER NanoRef reference (user-uploaded ref
 * appended to each), or one text/image-to-image job when the brand has no refs.
 * `imageCount` repeats that base set. Faithful to the legacy `processPersonFal_`
 * — exact payloads may be revised once the Make blueprint arrives.
 */
export async function createPersonBatch(p: PersonParams): Promise<CreateBatchResult> {
  const brands = await prisma.brand.findMany({
    where: { id: { in: p.brandIds }, isActive: true },
    select: { id: true, name: true, nanoRef: { select: { referenceImages: true } } },
  });
  if (brands.length === 0) throw new Error("no_brands");

  interface Spec {
    brandName: string;
    userText: string;
    imageUrls: string[];
  }
  const specs: Spec[] = [];

  for (const brand of brands) {
    const userText = (
      p.refMode === "EACH" ? p.perBrandPrompts[brand.id] || p.sharedDescription : p.sharedDescription
    ).trim();
    const refs = brand.nanoRef?.referenceImages ?? [];

    const base: string[][] =
      refs.length > 0
        ? refs.map((r) => (p.userRefUrls.length ? [r, ...p.userRefUrls] : [r]))
        : [p.userRefUrls.length ? [...p.userRefUrls] : []];

    for (let n = 0; n < p.imageCount; n++) {
      for (const imageUrls of base) {
        specs.push({ brandName: brand.name, userText, imageUrls });
      }
    }
  }
  if (specs.length === 0) throw new Error("nothing_to_generate");

  const batch = await prisma.batch.create({
    data: {
      userId: p.userId,
      actionType: "FULL",
      theme: p.themeName,
      description: p.sharedDescription,
      refMode: p.refMode,
    },
  });

  const generationIds: string[] = [];
  for (const spec of specs) {
    const gen = await prisma.generation.create({
      data: {
        batchId: batch.id,
        userId: p.userId,
        brandName: spec.brandName,
        theme: p.themeName,
        description: spec.userText,
        referenceImages: spec.imageUrls,
        actionType: "FULL",
        status: "QUEUED",
        statusMessage: "⏳ Queued",
        job: {
          create: {
            provider: "FAL",
            type: "PERSON",
            status: "QUEUED",
            batchId: batch.id,
            cloudinaryFolder: folderFor(spec.brandName),
          },
        },
      },
      select: { id: true },
    });
    generationIds.push(gen.id);
  }

  await getPersonQueue().addBulk(
    generationIds.map((generationId) => ({
      name: "submit" as const,
      data: { generationId, batchId: batch.id },
    })),
  );

  return { batchId: batch.id, count: generationIds.length };
}

/**
 * Item (nano-gpt). Each selected brand is the style key; `imageCount` images per
 * brand, generated synchronously by the item worker (legacy `processCreateItems`
 * + `processPendingItemJobs`).
 */
export async function createItemBatch(p: ItemParams): Promise<CreateBatchResult> {
  const styles = [...new Set(p.styles.map((s) => s.trim()).filter(Boolean))];
  if (styles.length === 0) throw new Error("no_styles");

  const batch = await prisma.batch.create({
    data: {
      userId: p.userId,
      actionType: "CREATE_ITEM",
      theme: p.themeName,
      description: p.sharedDescription,
    },
  });

  const generationIds: string[] = [];
  for (const style of styles) {
    // brandName stores the style name here (it's the row label + the ITEM
    // prompt-template lookup key used by the item worker).
    const userText = (p.perStylePrompts[style] || p.sharedDescription).trim();
    for (let n = 0; n < p.imageCount; n++) {
      const gen = await prisma.generation.create({
        data: {
          batchId: batch.id,
          userId: p.userId,
          brandName: style,
          theme: p.themeName,
          description: userText,
          referenceImages: [],
          actionType: "CREATE_ITEM",
          status: "QUEUED",
          statusMessage: "⏳ Queued",
          job: {
            create: {
              provider: "NANO_GPT",
              type: "ITEM",
              status: "QUEUED",
              batchId: batch.id,
              cloudinaryFolder: folderFor(style),
            },
          },
        },
        select: { id: true },
      });
      generationIds.push(gen.id);
    }
  }

  await getItemQueue().addBulk(
    generationIds.map((generationId) => ({
      name: "generate" as const,
      data: { generationId, batchId: batch.id },
    })),
  );

  return { batchId: batch.id, count: generationIds.length };
}
