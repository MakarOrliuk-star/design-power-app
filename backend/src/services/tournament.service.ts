import { prisma } from "../lib/prisma.js";
import { getItemQueue } from "../queues/index.js";
import { getPrompt } from "./prompts.js";

/**
 * Tournaments page (feature/tournament-page, Phase 3).
 *
 * A run creates ONE Batch per category (so the header pills / per-category
 * cancel reuse the existing batch machinery). The final prompt is assembled
 * HERE, at creation time (override ?? default -> system {{prompt}} wrapper ->
 * + brand stylePrompt) and stored in Generation.description — the item worker
 * uses it raw for actionType=TOURNAMENT. The output file name is fixed here
 * too (Generation.tourFileName), so the ZIP / Result tab never re-derive it.
 */

export type TournamentMode = "BASE" | "VIP";

export const MAX_TOURNAMENT_BRANDS = 4;
export const MAX_TOURNAMENT_COUNT = 4;
/** How many brand reference images are mixed into one request (Phase 0). */
export const BRAND_REFS_PER_JOB = 2;

/**
 * File-name part sanitizer (Phase 0 decision): drop parentheses, spaces -> "_",
 * everything else ("&" included) stays. "Spinogambino(Men)" -> "SpinogambinoMen",
 * "Playson & Booongo" -> "Playson_&_Booongo".
 */
export function sanitizeName(s: string): string {
  return s.replace(/[()]/g, "").trim().replace(/\s+/g, "_");
}

/**
 * Wrap the (resolved) element prompt with the TOURNAMENT system template — the
 * existing {{prompt}} mechanism — then append the brand's style prompt.
 */
export function buildTournamentPrompt(
  systemWrapper: string,
  elementPrompt: string,
  brandStylePrompt: string,
): string {
  const p = elementPrompt.trim();
  const wrapped = !systemWrapper
    ? p
    : systemWrapper.includes("{{prompt}}")
      ? systemWrapper.split("{{prompt}}").join(p)
      : `${systemWrapper}\n${p}`;
  const style = brandStylePrompt.trim();
  return style ? `${wrapped}\n${style}` : wrapped;
}

/**
 * Atomically issue the next DES number (single-row counter, seeded value=100000;
 * the first issued number is 100001 per the spec's own example). UPDATE ...
 * RETURNING makes concurrent downloads collision-free.
 */
export async function nextDesNumber(): Promise<number> {
  const rows = await prisma.$queryRaw<{ value: number }[]>`
    UPDATE "DesCounter" SET value = value + 1 WHERE id = 1 RETURNING value`;
  const value = rows[0]?.value;
  if (value === undefined) throw new Error("des_counter_missing"); // not seeded
  return value;
}

export interface TournamentSelection {
  elementId: string;
  /** Required when the element's category hasModes; ignored otherwise. */
  mode?: TournamentMode | undefined;
}

export interface CreateTournamentParams {
  userId: string;
  brandIds: string[]; // 1..4 (route-validated; re-checked here)
  count: number; // images per brand x element, 1..4
  selections: TournamentSelection[];
}

export interface TournamentBatchInfo {
  batchId: string;
  categoryKey: string;
  count: number; // generations queued in this batch
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Create one TOURNAMENT batch per selected category; queue every job. */
export async function createTournamentBatches(
  p: CreateTournamentParams,
): Promise<TournamentBatchInfo[]> {
  if (p.brandIds.length === 0) throw new Error("no_brands");
  if (p.brandIds.length > MAX_TOURNAMENT_BRANDS) throw new Error("too_many_brands");
  const count = Math.min(Math.max(p.count, 1), MAX_TOURNAMENT_COUNT);
  if (p.selections.length === 0) throw new Error("no_selection");

  const brands = await prisma.brand.findMany({
    where: { id: { in: p.brandIds }, isActive: true },
    select: {
      id: true,
      name: true,
      forcedAspectRatio: true,
      nanoRef: { select: { referenceImages: true, stylePrompt: true } },
    },
  });
  if (brands.length === 0) throw new Error("no_brands");

  const elementIds = [...new Set(p.selections.map((s) => s.elementId))];
  const elements = await prisma.tournamentElement.findMany({
    where: { id: { in: elementIds }, isActive: true },
    select: {
      id: true,
      name: true,
      referenceImages: true,
      category: { select: { key: true, hasModes: true, fixedMode: true } },
      prompts: { select: { mode: true, content: true } },
    },
  });
  const elementById = new Map(elements.map((e) => [e.id, e]));

  // The user's local prompt edits (Phase 0: stored in DB, per user).
  const overrides = await prisma.userTournamentPromptOverride.findMany({
    where: { userId: p.userId, elementId: { in: elementIds } },
    select: { elementId: true, mode: true, content: true },
  });
  const overrideByKey = new Map(overrides.map((o) => [`${o.elementId}:${o.mode}`, o.content]));

  const systemWrapper = await getPrompt("TOURNAMENT", "system");

  // Resolve every selection up-front so a bad one fails the whole request
  // BEFORE any batch is created (no partial launches on invalid input).
  interface ResolvedSelection {
    element: NonNullable<ReturnType<typeof elementById.get>>;
    mode: TournamentMode;
    elementPrompt: string;
  }
  const resolved: ResolvedSelection[] = [];
  for (const sel of p.selections) {
    const element = elementById.get(sel.elementId);
    if (!element) throw new Error("inactive_element");
    const mode: TournamentMode = element.category.hasModes
      ? sel.mode === "BASE" || sel.mode === "VIP"
        ? sel.mode
        : (() => {
            throw new Error("invalid_mode");
          })()
      : (element.category.fixedMode ?? "BASE");
    const elementPrompt =
      overrideByKey.get(`${element.id}:${mode}`) ??
      element.prompts.find((pr) => pr.mode === mode)?.content;
    if (!elementPrompt || !elementPrompt.trim()) throw new Error("no_prompt");
    resolved.push({ element, mode, elementPrompt });
  }

  // Group by category — one batch per category, in a stable key order.
  const byCategory = new Map<string, ResolvedSelection[]>();
  for (const r of resolved) {
    const key = r.element.category.key;
    const list = byCategory.get(key) ?? [];
    list.push(r);
    byCategory.set(key, list);
  }

  const result: TournamentBatchInfo[] = [];
  const queued: { generationId: string; batchId: string; aspect: string }[] = [];

  for (const [categoryKey, sels] of byCategory) {
    const batch = await prisma.batch.create({
      data: {
        userId: p.userId,
        actionType: "TOURNAMENT",
        description: `Tournament pack: ${categoryKey}`,
      },
      select: { id: true },
    });

    let batchCount = 0;
    for (const brand of brands) {
      const brandRefs = (brand.nanoRef?.referenceImages ?? []).slice(0, BRAND_REFS_PER_JOB);
      const stylePrompt = brand.nanoRef?.stylePrompt ?? "";
      const aspect = brand.forcedAspectRatio || "1:1";

      for (const sel of sels) {
        // Provider elements bake in their OWN 2 admin refs (no brand images);
        // the brand still contributes its text style + multiplies the output.
        const refs =
          categoryKey === "provider"
            ? sel.element.referenceImages.slice(0, BRAND_REFS_PER_JOB)
            : brandRefs;
        const prompt = buildTournamentPrompt(systemWrapper, sel.elementPrompt, stylePrompt);
        const baseName = `${sanitizeName(brand.name)}_${sanitizeName(sel.element.name)}`;

        for (let i = 1; i <= count; i++) {
          const gen = await prisma.generation.create({
            data: {
              batchId: batch.id,
              userId: p.userId,
              brandName: brand.name,
              description: prompt,
              referenceImages: refs,
              actionType: "TOURNAMENT",
              status: "QUEUED",
              statusMessage: "⏳ Queued",
              tourCategoryKey: categoryKey,
              tourElementName: sel.element.name,
              tourMode: sel.mode,
              tourFileName: `${baseName}_${i}`,
              job: {
                create: {
                  provider: "FAL",
                  type: "ITEM", // routed through the item queue/worker
                  status: "QUEUED",
                  batchId: batch.id,
                  cloudinaryFolder: `tournaments/${categoryKey}/${today()}`,
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
    result.push({ batchId: batch.id, categoryKey, count: batchCount });
  }

  await getItemQueue().addBulk(
    queued.map(({ generationId, batchId, aspect }) => ({
      name: "generate" as const,
      data: { generationId, batchId, aspectRatio: aspect },
    })),
  );

  return result;
}
