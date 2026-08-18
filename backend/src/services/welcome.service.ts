import { prisma } from "../lib/prisma.js";
import { getItemQueue } from "../queues/index.js";
import { getPrompt } from "./prompts.js";
import { BRAND_REFS_PER_JOB, buildPackPrompt, sanitizeName } from "../lib/packShared.js";

/**
 * Welcome packs page (TASK welcome-packs, Phase 4).
 *
 * Mirrors the tournament flow: a run creates ONE Batch per category (so the
 * header pills / per-category cancel reuse the existing batch machinery), and
 * Generation.description stores the resolved ELEMENT prompt wrapped by the
 * WELCOME system template. The item worker then runs it through the brand's
 * PERSON prompt-writer and appends the brand stylePrompt before calling fal.
 *
 * Two deliberate differences from tournaments:
 *  - no Base/VIP modes — one prompt per element;
 *  - "own references" is a CATEGORY FLAG (usesOwnReferences), not a hardcoded
 *    category key: Welcome categories are created by hand, so their keys can't
 *    be known in advance.
 */

export type WelcomeAspect = "1:1" | "9:16";

export const MAX_WELCOME_BRANDS = 4;
export const MAX_WELCOME_COUNT = 4;
export const DEFAULT_WELCOME_ASPECT: WelcomeAspect = "1:1";

export interface WelcomeSelection {
  elementId: string;
}

export interface CreateWelcomeParams {
  userId: string;
  brandIds: string[]; // 1..4 (route-validated; re-checked here)
  count: number; // images per brand x element, 1..4
  selections: WelcomeSelection[];
  /** Page-level 1:1 / 9:16 toggle; a brand's forcedAspectRatio still wins. */
  aspect?: WelcomeAspect;
}

export interface WelcomeBatchInfo {
  batchId: string;
  categoryKey: string;
  /** Category title — the toolbar builds its progress pills from real data. */
  categoryName: string;
  count: number; // generations queued in this batch
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Create one WELCOME batch per selected category; queue every job. */
export async function createWelcomeBatches(
  p: CreateWelcomeParams,
): Promise<WelcomeBatchInfo[]> {
  if (p.brandIds.length === 0) throw new Error("no_brands");
  if (p.brandIds.length > MAX_WELCOME_BRANDS) throw new Error("too_many_brands");
  const count = Math.min(Math.max(p.count, 1), MAX_WELCOME_COUNT);
  if (p.selections.length === 0) throw new Error("no_selection");

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

  const elementIds = [...new Set(p.selections.map((s) => s.elementId))];
  const elements = await prisma.welcomeElement.findMany({
    where: { id: { in: elementIds }, isActive: true },
    select: {
      id: true,
      name: true,
      referenceImages: true,
      category: { select: { key: true, name: true, usesOwnReferences: true } },
      prompt: { select: { content: true } },
    },
  });
  const elementById = new Map(elements.map((e) => [e.id, e]));

  // The user's local prompt edits (stored in the DB, per user).
  const overrides = await prisma.userWelcomePromptOverride.findMany({
    where: { userId: p.userId, elementId: { in: elementIds } },
    select: { elementId: true, content: true },
  });
  const overrideByElement = new Map(overrides.map((o) => [o.elementId, o.content]));

  const systemWrapper = await getPrompt("WELCOME", "system");

  // Resolve every selection up-front so a bad one fails the whole request
  // BEFORE any batch is created (no partial launches on invalid input).
  interface ResolvedSelection {
    element: NonNullable<ReturnType<typeof elementById.get>>;
    elementPrompt: string;
  }
  const resolved: ResolvedSelection[] = [];
  for (const sel of p.selections) {
    const element = elementById.get(sel.elementId);
    if (!element) throw new Error("inactive_element");
    const elementPrompt = overrideByElement.get(element.id) ?? element.prompt?.content;
    if (!elementPrompt || !elementPrompt.trim()) throw new Error("no_prompt");
    resolved.push({ element, elementPrompt });
  }

  // Group by category — one batch per category, in a stable key order.
  const byCategory = new Map<string, ResolvedSelection[]>();
  for (const r of resolved) {
    const key = r.element.category.key;
    const list = byCategory.get(key) ?? [];
    list.push(r);
    byCategory.set(key, list);
  }

  const result: WelcomeBatchInfo[] = [];
  const queued: { generationId: string; batchId: string; aspect: string }[] = [];

  for (const [categoryKey, sels] of byCategory) {
    const categoryName = sels[0]!.element.category.name;
    const batch = await prisma.batch.create({
      data: {
        userId: p.userId,
        actionType: "WELCOME",
        description: `Welcome pack: ${categoryKey}`,
      },
      select: { id: true },
    });

    let batchCount = 0;
    for (const brand of brands) {
      const brandRefs = (brand.nanoRef?.referenceImages ?? []).slice(0, BRAND_REFS_PER_JOB);
      const aspect = brand.forcedAspectRatio || p.aspect || DEFAULT_WELCOME_ASPECT;

      for (const sel of sels) {
        // Categories flagged usesOwnReferences bake in their elements' OWN
        // images (no brand references); the brand still contributes its text
        // style and multiplies the output.
        const refs = sel.element.category.usesOwnReferences
          ? sel.element.referenceImages.slice(0, BRAND_REFS_PER_JOB)
          : brandRefs;
        // Brand stylePrompt is NOT baked in here — the worker appends it after
        // the PERSON prompt-writer pass, so it reaches fal verbatim.
        const prompt = buildPackPrompt(systemWrapper, sel.elementPrompt, "");
        const baseName = `${sanitizeName(brand.name)}_${sanitizeName(sel.element.name)}`;

        for (let i = 1; i <= count; i++) {
          const gen = await prisma.generation.create({
            data: {
              batchId: batch.id,
              userId: p.userId,
              brandName: brand.name,
              description: prompt,
              referenceImages: refs,
              actionType: "WELCOME",
              status: "QUEUED",
              statusMessage: "⏳ Queued",
              welCategoryKey: categoryKey,
              welElementName: sel.element.name,
              welFileName: `${baseName}_${i}`,
              job: {
                create: {
                  provider: "FAL",
                  type: "ITEM", // routed through the item queue/worker
                  status: "QUEUED",
                  batchId: batch.id,
                  cloudinaryFolder: `welcome/${categoryKey}/${today()}`,
                },
              },
            },
            select: { id: true },
          });
          queued.push({ generationId: gen.id, batchId: batch.id, aspect });
          batchCount++;
        }
      }
    }
    result.push({ batchId: batch.id, categoryKey, categoryName, count: batchCount });
  }

  await getItemQueue().addBulk(
    queued.map(({ generationId, batchId, aspect }) => ({
      name: "generate" as const,
      data: { generationId, batchId, aspectRatio: aspect },
    })),
  );

  return result;
}
