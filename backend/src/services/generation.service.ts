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
  userRefUrls: string[]; // global (ALL) user refs
  perBrandRefUrls?: Record<string, string[]>; // per-brand (EACH) user refs
  perBrandCounts?: Record<string, number>; // per-brand (EACH) image count
  aspectRatio: string; // global (ALL) fal aspect_ratio
  perBrandAspect?: Record<string, string>; // per-brand (EACH) aspect_ratio
}

interface ItemParams {
  userId: string;
  styles: string[]; // Item style names (PromptTemplate ITEM keys), NOT brands
  themeName: string;
  sharedDescription: string;
  perStylePrompts: Record<string, string>;
  imageCount: number;
  userRefUrls: string[]; // global (ALL) user refs
  perStyleRefUrls?: Record<string, string[]>; // per-style (EACH) user refs
  perStyleCounts?: Record<string, number>; // per-style (EACH) image count
  aspectRatio: string; // global (ALL) fal aspect_ratio
  perStyleAspect?: Record<string, string>; // per-style (EACH) aspect_ratio
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
    select: {
      id: true,
      name: true,
      forcedAspectRatio: true,
      nanoRef: { select: { referenceImages: true } },
    },
  });
  if (brands.length === 0) throw new Error("no_brands");

  interface Spec {
    brandName: string;
    userText: string;
    imageUrls: string[];
    aspect: string;
  }
  const specs: Spec[] = [];

  for (const brand of brands) {
    const isEach = p.refMode === "EACH";
    const userText = (
      isEach ? p.perBrandPrompts[brand.id] || p.sharedDescription : p.sharedDescription
    ).trim();
    // EACH: the brand's own uploaded refs / count / aspect; ALL: the shared globals.
    const userRefs = isEach ? p.perBrandRefUrls?.[brand.id] ?? [] : p.userRefUrls;
    const count = isEach ? p.perBrandCounts?.[brand.id] ?? p.imageCount : p.imageCount;
    // Brand-level force (TASK §7) wins over the user's pick in either mode.
    const aspect =
      brand.forcedAspectRatio ||
      (isEach ? p.perBrandAspect?.[brand.id] : undefined) ||
      p.aspectRatio;
    const refs = brand.nanoRef?.referenceImages ?? [];

    // ADDENDUM §6: ONE fal job per output image. Iteration i pairs the i-th brand
    // reference (cycled if count > refs) with the user's uploaded image(s); same
    // prompt for all, so each image is a different pose of the same brand.
    for (let i = 0; i < count; i++) {
      const brandRef = refs.length > 0 ? refs[i % refs.length] : undefined;
      const imageUrls = brandRef
        ? userRefs.length
          ? [brandRef, ...userRefs]
          : [brandRef]
        : [...userRefs]; // no brand ref → just the user image(s)
      specs.push({ brandName: brand.name, userText, imageUrls, aspect });
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

  const created: { generationId: string; aspect: string }[] = [];
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
    created.push({ generationId: gen.id, aspect: spec.aspect });
  }

  await getPersonQueue().addBulk(
    created.map(({ generationId, aspect }) => ({
      name: "submit" as const,
      data: { generationId, batchId: batch.id, aspectRatio: aspect },
    })),
  );

  return { batchId: batch.id, count: created.length };
}

/**
 * Item (fal — ADDENDUM §2). Each selected style is the prompt-template key;
 * generation runs through `fal-ai/nano-banana-2/edit` in the item worker. Item
 * has no pre-baked brand refs, so each image is img2img on the user's upload
 * (or text-to-image when none), repeated `imageCount` times per style.
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

  const created: { generationId: string; aspect: string }[] = [];
  for (const style of styles) {
    // brandName stores the style name here (it's the row label + the ITEM
    // prompt-template lookup key used by the item worker).
    const userText = (p.perStylePrompts[style] || p.sharedDescription).trim();
    // Per-style refs/count/aspect when provided (EACH), else the global ones (ALL).
    const userRefs = p.perStyleRefUrls?.[style]?.length ? p.perStyleRefUrls[style]! : p.userRefUrls;
    const count = p.perStyleCounts?.[style] ?? p.imageCount;
    const aspect = p.perStyleAspect?.[style] || p.aspectRatio;

    for (let i = 0; i < count; i++) {
      const gen = await prisma.generation.create({
        data: {
          batchId: batch.id,
          userId: p.userId,
          brandName: style,
          theme: p.themeName,
          description: userText,
          referenceImages: [...userRefs],
          actionType: "CREATE_ITEM",
          status: "QUEUED",
          statusMessage: "⏳ Queued",
          job: {
            create: {
              provider: "FAL",
              type: "ITEM",
              status: "QUEUED",
              batchId: batch.id,
              cloudinaryFolder: folderFor(style),
            },
          },
        },
        select: { id: true },
      });
      created.push({ generationId: gen.id, aspect });
    }
  }

  await getItemQueue().addBulk(
    created.map(({ generationId, aspect }) => ({
      name: "generate" as const,
      data: { generationId, batchId: batch.id, aspectRatio: aspect },
    })),
  );

  return { batchId: batch.id, count: created.length };
}

type ActionType = "FULL" | "CREATE_ITEM" | "NANO_REF";

interface EditSource {
  sourceImageUrl: string; // the existing generated image to edit (fal image_urls)
  brandName: string; // preserved so the result keeps its style/label
  theme: string | null;
  actionType: ActionType; // preserved so content type (Person/Item) is kept
  prompt: string; // user's edit instruction (raw — no template wrapping)
  aspect: string;
}

/**
 * Edit (Result page, TASK §5). Each selected image becomes a NEW `isEdit` row that
 * runs fal `nano-banana-2/edit` on the source image + the user's instruction. The
 * job goes through the item queue (synchronous fal, no nano-gpt builder); the item
 * worker skips the ITEM template for `isEdit` rows. Originals are left untouched.
 */
export async function createEditBatch(
  userId: string,
  sources: EditSource[],
): Promise<CreateBatchResult> {
  if (sources.length === 0) throw new Error("nothing_to_edit");

  const batch = await prisma.batch.create({
    data: {
      userId,
      actionType: sources[0]!.actionType,
      description: sources[0]!.prompt,
    },
  });

  const created: { generationId: string; aspect: string }[] = [];
  for (const src of sources) {
    const gen = await prisma.generation.create({
      data: {
        batchId: batch.id,
        userId,
        brandName: src.brandName,
        theme: src.theme,
        description: src.prompt,
        referenceImages: [src.sourceImageUrl],
        actionType: src.actionType,
        isEdit: true,
        status: "QUEUED",
        statusMessage: "⏳ Queued",
        job: {
          create: {
            provider: "FAL",
            type: "ITEM", // routed through the item queue/worker
            status: "QUEUED",
            batchId: batch.id,
            cloudinaryFolder: folderFor(src.brandName),
          },
        },
      },
      select: { id: true },
    });
    created.push({ generationId: gen.id, aspect: src.aspect });
  }

  await getItemQueue().addBulk(
    created.map(({ generationId, aspect }) => ({
      name: "generate" as const,
      data: { generationId, batchId: batch.id, aspectRatio: aspect },
    })),
  );

  return { batchId: batch.id, count: created.length };
}
