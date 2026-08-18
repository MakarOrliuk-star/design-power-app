import { prisma } from "../lib/prisma.js";

/**
 * «Edit Welcome packs» (TASK welcome-packs): the mutation layer behind
 * /api/welcome-pack (the super-designer's window) and /api/welcome-admin (the
 * admin panel). Both surfaces share these rules — one copy of the domain logic
 * — and every write lands in WelcomeChangeLog with before/after snapshots, so
 * the journal answers "кто и что менял" whichever surface was used. Elements
 * can be rolled back to their previous snapshot.
 *
 * Mirrors services/tournamentPack.service.ts, minus Base/VIP: a Welcome element
 * carries exactly ONE prompt. "Own references" is a category flag here
 * (usesOwnReferences) rather than a hardcoded key, because Welcome categories
 * are created by hand and their keys can't be known in advance.
 */

export interface PackActor {
  userId: string;
  userEmail: string;
}

export interface WelcomeElementSnapshot {
  name: string;
  order: number;
  isActive: boolean;
  referenceImages: string[];
  /** null while the element has no default prompt row yet. */
  prompt: string | null;
}

export interface WelcomeCategorySnapshot {
  key: string;
  name: string;
  usesOwnReferences: boolean;
  order: number;
  elements: WelcomeElementSnapshot[];
}

/**
 * "Welcome Series (VIP)" -> "welcome_series_vip". The key doubles as the ZIP
 * folder name and is frozen at creation (renames keep it, so old archives stay
 * coherent).
 */
export function slugifyKey(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "category";
}

// ---- Snapshots (the audit payloads; also what rollback restores) ----

const ELEMENT_SNAPSHOT_SELECT = {
  name: true,
  order: true,
  isActive: true,
  referenceImages: true,
  prompt: { select: { content: true } },
} as const;

interface ElementRow {
  name: string;
  order: number;
  isActive: boolean;
  referenceImages: string[];
  prompt: { content: string } | null;
}

function toSnapshot(row: ElementRow): WelcomeElementSnapshot {
  return {
    name: row.name,
    order: row.order,
    isActive: row.isActive,
    referenceImages: [...row.referenceImages],
    prompt: row.prompt?.content ?? null,
  };
}

export async function getElementSnapshot(id: string): Promise<WelcomeElementSnapshot | null> {
  const row = (await prisma.welcomeElement.findUnique({
    where: { id },
    select: ELEMENT_SNAPSHOT_SELECT,
  })) as ElementRow | null;
  return row ? toSnapshot(row) : null;
}

/** Includes every element — a hard-deleted category must stay recoverable. */
export async function getCategorySnapshot(id: string): Promise<WelcomeCategorySnapshot | null> {
  const row = await prisma.welcomeCategory.findUnique({
    where: { id },
    select: {
      key: true,
      name: true,
      usesOwnReferences: true,
      order: true,
      elements: { orderBy: { order: "asc" }, select: ELEMENT_SNAPSHOT_SELECT },
    },
  });
  if (!row) return null;
  return {
    key: row.key,
    name: row.name,
    usesOwnReferences: row.usesOwnReferences,
    order: row.order,
    elements: (row.elements as ElementRow[]).map(toSnapshot),
  };
}

async function logChange(entry: {
  entityType: "ELEMENT" | "CATEGORY" | "SYSTEM";
  entityId: string | null;
  entityName: string;
  action: "CREATE" | "UPDATE" | "DELETE" | "ROLLBACK";
  before: unknown;
  after: unknown;
  actor: PackActor;
}): Promise<void> {
  await prisma.welcomeChangeLog.create({
    data: {
      entityType: entry.entityType,
      entityId: entry.entityId,
      entityName: entry.entityName,
      userId: entry.actor.userId,
      userEmail: entry.actor.userEmail,
      action: entry.action,
      before: (entry.before ?? {}) as object,
      after: (entry.after ?? {}) as object,
    },
  });
}

// ---- Read: the whole pack (same shape for both editing surfaces) ----

export async function loadPackConfig(): Promise<{ categories: unknown[]; systemPrompt: string }> {
  const [categories, wrapper] = await Promise.all([
    prisma.welcomeCategory.findMany({
      orderBy: { order: "asc" },
      select: {
        id: true,
        key: true,
        name: true,
        usesOwnReferences: true,
        order: true,
        elements: {
          orderBy: [{ order: "asc" }, { name: "asc" }],
          select: {
            id: true,
            name: true,
            order: true,
            isActive: true,
            referenceImages: true,
            prompt: { select: { content: true, updatedAt: true } },
          },
        },
      },
    }),
    prisma.promptTemplate.findUnique({
      where: { type_key: { type: "WELCOME", key: "system" } },
      select: { content: true },
    }),
  ]);
  return { categories, systemPrompt: wrapper?.content ?? "" };
}

// ---- Elements ----

async function nameClash(categoryId: string, name: string, excludeId?: string): Promise<boolean> {
  const clash = await prisma.welcomeElement.findUnique({
    where: { categoryId_name: { categoryId, name } },
    select: { id: true },
  });
  return Boolean(clash) && clash?.id !== excludeId;
}

export type CreateElementError = "category_not_found" | "already_exists";

export type CreateElementResult =
  | { ok: true; element: { id: string }; snapshot: WelcomeElementSnapshot | null }
  | { ok: false; error: CreateElementError };

export async function createElement(
  input: { categoryId: string; name: string },
  actor: PackActor,
): Promise<CreateElementResult> {
  const category = await prisma.welcomeCategory.findUnique({
    where: { id: input.categoryId },
    select: { id: true },
  });
  if (!category) return { ok: false, error: "category_not_found" };
  if (await nameClash(input.categoryId, input.name)) {
    return { ok: false, error: "already_exists" };
  }

  const last = await prisma.welcomeElement.findFirst({
    where: { categoryId: input.categoryId },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  // New elements get a placeholder prompt so the designers' page always has
  // something to show and override (nothing is seeded in this feature).
  const element = await prisma.welcomeElement.create({
    data: {
      categoryId: input.categoryId,
      name: input.name,
      order: (last?.order ?? -1) + 1,
      prompt: {
        create: {
          content: `[placeholder] Default prompt for "${input.name}" — edit me in «Edit Welcome packs» or Admin → Welcome packs.`,
        },
      },
    },
    select: { id: true },
  });

  const snapshot = await getElementSnapshot(element.id);
  await logChange({
    entityType: "ELEMENT",
    entityId: element.id,
    entityName: input.name,
    action: "CREATE",
    before: {},
    after: snapshot,
    actor,
  });
  return { ok: true, element, snapshot };
}

export interface ElementPatch {
  name?: string;
  order?: number;
  isActive?: boolean;
  referenceImages?: string[];
  prompt?: string;
}

export type ElementUpdateError = "element_not_found" | "already_exists";

export type ElementUpdateResult =
  | { ok: true; snapshot: WelcomeElementSnapshot; changed: boolean }
  | { ok: false; error: ElementUpdateError };

/**
 * The single save behind «Сохранить (для всех)»: name, prompt, references and
 * the active flag land in ONE transaction and ONE audit entry, so a rollback
 * restores the element as a whole. A no-op save writes no log entry (it must
 * not become a rollback target).
 */
export async function updateElementAudited(
  id: string,
  patch: ElementPatch,
  actor: PackActor,
  action: "UPDATE" | "ROLLBACK" = "UPDATE",
): Promise<ElementUpdateResult> {
  const existing = await prisma.welcomeElement.findUnique({
    where: { id },
    select: { categoryId: true },
  });
  if (!existing) return { ok: false, error: "element_not_found" };

  const before = await getElementSnapshot(id);
  if (!before) return { ok: false, error: "element_not_found" };

  if (patch.name !== undefined && (await nameClash(existing.categoryId, patch.name, id))) {
    return { ok: false, error: "already_exists" };
  }

  // Only write the keys the caller actually sent (exactOptionalPropertyTypes).
  const data: {
    name?: string;
    order?: number;
    isActive?: boolean;
    referenceImages?: string[];
  } = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.order !== undefined) data.order = patch.order;
  if (patch.isActive !== undefined) data.isActive = patch.isActive;
  if (patch.referenceImages !== undefined) {
    data.referenceImages = patch.referenceImages.map((s) => s.trim()).filter(Boolean);
  }

  const ops = [];
  if (Object.keys(data).length > 0) {
    ops.push(prisma.welcomeElement.update({ where: { id }, data }));
  }
  if (patch.prompt !== undefined) {
    // updatedAt bumps on every write — designers with a local override then see
    // the "default changed" banner (their baseUpdatedAt snapshot is now older).
    // The prompt lives in its own table precisely so a rename/reorder does NOT
    // move this timestamp.
    ops.push(
      prisma.welcomePrompt.upsert({
        where: { elementId: id },
        create: { elementId: id, content: patch.prompt },
        update: { content: patch.prompt },
      }),
    );
  }
  if (ops.length > 0) await prisma.$transaction(ops);

  const after = await getElementSnapshot(id);
  if (!after) return { ok: false, error: "element_not_found" };
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) {
    await logChange({
      entityType: "ELEMENT",
      entityId: id,
      entityName: after.name,
      action,
      before,
      after,
      actor,
    });
  }
  return { ok: true, snapshot: after, changed };
}

export type SoftDeleteResult =
  | { ok: true; snapshot: WelcomeElementSnapshot }
  | { ok: false; error: "element_not_found" };

/**
 * Removal is soft (isActive=false): Generation rows keep the denormalized
 * element name, so old batches and their ZIPs stay coherent.
 */
export async function softDeleteElement(id: string, actor: PackActor): Promise<SoftDeleteResult> {
  const before = await getElementSnapshot(id);
  if (!before) return { ok: false, error: "element_not_found" };

  await prisma.welcomeElement.update({ where: { id }, data: { isActive: false } });
  const after = await getElementSnapshot(id);
  if (!after) return { ok: false, error: "element_not_found" };

  await logChange({
    entityType: "ELEMENT",
    entityId: id,
    entityName: after.name,
    action: "DELETE",
    before,
    after,
    actor,
  });
  return { ok: true, snapshot: after };
}

export type RollbackResult =
  | { ok: true; snapshot: WelcomeElementSnapshot }
  | { ok: false; error: ElementUpdateError | "nothing_to_rollback" };

/**
 * Restore the `before` snapshot of the element's latest log entry, logged as a
 * ROLLBACK so the trail stays complete and the action is repeatable. `order` is
 * deliberately NOT restored — position is owned by reorderElements, and
 * resurrecting an old index would scramble the list around it.
 */
export async function rollbackElement(id: string, actor: PackActor): Promise<RollbackResult> {
  const last = await prisma.welcomeChangeLog.findFirst({
    where: { entityType: "ELEMENT", entityId: id },
    orderBy: { createdAt: "desc" },
    select: { before: true },
  });
  const snap = last?.before as unknown as WelcomeElementSnapshot | undefined;
  if (!snap || !snap.name) return { ok: false, error: "nothing_to_rollback" };

  const patch: ElementPatch = {
    name: snap.name,
    isActive: snap.isActive,
    referenceImages: snap.referenceImages,
  };
  // A CREATE entry has no prompt in its `before` — leave the current one alone
  // rather than wiping it with an empty string.
  if (snap.prompt !== null && snap.prompt !== undefined) patch.prompt = snap.prompt;

  return await updateElementAudited(id, patch, actor, "ROLLBACK");
}

export type ReorderResult = { ok: true } | { ok: false; error: "invalid_ids" };

/**
 * Applied immediately (not part of the draft): a swap touches two rows, so it
 * runs as one transaction rather than two racing PATCHes. Logged once, at the
 * category level, as the resulting name order.
 */
export async function reorderElements(
  categoryId: string,
  orderedIds: string[],
  actor: PackActor,
): Promise<ReorderResult> {
  const rows = await prisma.welcomeElement.findMany({
    where: { categoryId },
    orderBy: { order: "asc" },
    select: { id: true, name: true },
  });
  // The client must send exactly this category's elements — no more, no less.
  if (rows.length !== orderedIds.length || !rows.every((r) => orderedIds.includes(r.id))) {
    return { ok: false, error: "invalid_ids" };
  }
  const nameById = new Map(rows.map((r) => [r.id, r.name]));

  await prisma.$transaction(
    orderedIds.map((id, i) => prisma.welcomeElement.update({ where: { id }, data: { order: i } })),
  );
  await logChange({
    entityType: "CATEGORY",
    entityId: categoryId,
    entityName: "reorder elements",
    action: "UPDATE",
    before: { order: rows.map((r) => r.name) },
    after: { order: orderedIds.map((id) => nameById.get(id) ?? id) },
    actor,
  });
  return { ok: true };
}

// ---- Categories ----

export interface CategoryRow {
  id: string;
  key: string;
  name: string;
  usesOwnReferences: boolean;
  order: number;
}

export type CreateCategoryResult = { ok: true; category: CategoryRow };

export async function createCategory(
  input: { name: string; usesOwnReferences: boolean },
  actor: PackActor,
): Promise<CreateCategoryResult> {
  let key = slugifyKey(input.name);
  for (
    let n = 2;
    await prisma.welcomeCategory.findUnique({ where: { key }, select: { id: true } });
    n++
  ) {
    key = `${slugifyKey(input.name)}_${n}`;
  }
  const last = await prisma.welcomeCategory.findFirst({
    orderBy: { order: "desc" },
    select: { order: true },
  });
  const category = await prisma.welcomeCategory.create({
    data: {
      key,
      name: input.name,
      usesOwnReferences: input.usesOwnReferences,
      order: (last?.order ?? -1) + 1,
    },
    select: { id: true, key: true, name: true, usesOwnReferences: true, order: true },
  });
  await logChange({
    entityType: "CATEGORY",
    entityId: category.id,
    entityName: category.name,
    action: "CREATE",
    before: {},
    after: category,
    actor,
  });
  return { ok: true, category };
}

export type CategoryUpdateResult =
  | { ok: true; category: CategoryRow }
  | { ok: false; error: "category_not_found" };

/**
 * Rename / reorder / flip the own-references flag. The key stays frozen at
 * creation. Turning usesOwnReferences off does NOT clear the elements' images:
 * they stop reaching generation and come back when the flag is turned on again.
 */
export async function updateCategoryAudited(
  id: string,
  patch: { name?: string; order?: number; usesOwnReferences?: boolean },
  actor: PackActor,
): Promise<CategoryUpdateResult> {
  const before = await prisma.welcomeCategory.findUnique({
    where: { id },
    select: { name: true, order: true, usesOwnReferences: true },
  });
  if (!before) return { ok: false, error: "category_not_found" };

  // Only write the keys the caller sent (exactOptionalPropertyTypes).
  const data: { name?: string; order?: number; usesOwnReferences?: boolean } = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.order !== undefined) data.order = patch.order;
  if (patch.usesOwnReferences !== undefined) data.usesOwnReferences = patch.usesOwnReferences;

  const category = await prisma.welcomeCategory.update({
    where: { id },
    data,
    select: { id: true, key: true, name: true, usesOwnReferences: true, order: true },
  });
  if (
    before.name !== category.name ||
    before.order !== category.order ||
    before.usesOwnReferences !== category.usesOwnReferences
  ) {
    await logChange({
      entityType: "CATEGORY",
      entityId: id,
      entityName: category.name,
      action: "UPDATE",
      before,
      after: {
        name: category.name,
        order: category.order,
        usesOwnReferences: category.usesOwnReferences,
      },
      actor,
    });
  }
  return { ok: true, category };
}

export async function reorderCategories(
  orderedIds: string[],
  actor: PackActor,
): Promise<ReorderResult> {
  const rows = await prisma.welcomeCategory.findMany({
    orderBy: { order: "asc" },
    select: { id: true, name: true },
  });
  if (rows.length !== orderedIds.length || !rows.every((r) => orderedIds.includes(r.id))) {
    return { ok: false, error: "invalid_ids" };
  }
  const nameById = new Map(rows.map((r) => [r.id, r.name]));

  await prisma.$transaction(
    orderedIds.map((id, i) => prisma.welcomeCategory.update({ where: { id }, data: { order: i } })),
  );
  await logChange({
    entityType: "CATEGORY",
    entityId: null,
    entityName: "reorder categories",
    action: "UPDATE",
    before: { order: rows.map((r) => r.name) },
    after: { order: orderedIds.map((id) => nameById.get(id) ?? id) },
    actor,
  });
  return { ok: true };
}

export type DeleteCategoryResult = { ok: true } | { ok: false; error: "category_not_found" };

/**
 * HARD delete (unlike elements): cascades to elements, default prompts and
 * every designer's local overrides. The audit entry therefore carries the FULL
 * category snapshot (all elements + their prompts) — the only trace left, and
 * enough to rebuild it by hand. Generation history is untouched: it keeps the
 * denormalized welCategoryKey/welElementName, so old ZIPs still work.
 */
export async function deleteCategoryAudited(
  id: string,
  actor: PackActor,
): Promise<DeleteCategoryResult> {
  const before = await getCategorySnapshot(id);
  if (!before) return { ok: false, error: "category_not_found" };

  await prisma.welcomeCategory.delete({ where: { id } });
  await logChange({
    entityType: "CATEGORY",
    entityId: id,
    entityName: before.name,
    action: "DELETE",
    before,
    after: {},
    actor,
  });
  return { ok: true };
}

// ---- Change log (read side: the admin panel's «кто и что менял») ----

export interface ChangeField {
  field: string;
  before: string;
  after: string;
}

export interface ChangeLogEntry {
  id: string;
  entityType: string;
  entityName: string;
  userEmail: string;
  action: string;
  createdAt: Date;
  changes: ChangeField[];
}

/** Prompts are long — the journal shows a readable head, not the whole essay. */
const MAX_LOGGED_VALUE = 400;

function short(value: string): string {
  return value.length > MAX_LOGGED_VALUE ? `${value.slice(0, MAX_LOGGED_VALUE)}…` : value;
}

/**
 * Snapshot → flat "field label" → "value" map, so before/after can be compared
 * field by field regardless of which entity the entry describes.
 */
function flattenSnapshot(snap: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!snap || typeof snap !== "object") return out;
  const o = snap as Record<string, unknown>;

  if (typeof o.name === "string") out["Название"] = o.name;
  if (typeof o.order === "number") out["Порядок"] = String(o.order);
  if (typeof o.isActive === "boolean") out["Активен"] = o.isActive ? "да" : "нет";
  if (typeof o.prompt === "string") out["Промпт"] = short(o.prompt);
  if (typeof o.content === "string") out["Текст"] = short(o.content);
  if (typeof o.key === "string") out["Ключ (папка ZIP)"] = o.key;
  if (typeof o.usesOwnReferences === "boolean") {
    out["Свои референсы"] = o.usesOwnReferences ? "да" : "нет";
  }

  if (Array.isArray(o.referenceImages)) {
    out["Референсы"] = (o.referenceImages as string[]).join(", ") || "—";
  }
  // A reorder entry logs the resulting name order, not the entity itself.
  if (Array.isArray(o.order)) out["Порядок"] = (o.order as string[]).join(" → ");
  // A deleted category logs its whole content — report the size, not the dump.
  if (Array.isArray(o.elements)) out["Элементов"] = String(o.elements.length);

  return out;
}

/** Only what actually differs, so the journal reads as a list of edits. */
export function diffSnapshots(before: unknown, after: unknown): ChangeField[] {
  const a = flattenSnapshot(before);
  const b = flattenSnapshot(after);
  const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return fields
    .filter((f) => (a[f] ?? "") !== (b[f] ?? ""))
    .map((field) => ({ field, before: a[field] ?? "—", after: b[field] ?? "—" }));
}

/**
 * Newest first. Every Welcome mutation goes through this service — from the
 * admin panel AND from «Edit Welcome packs» — so the journal is the single
 * answer to "кто и что менял", whichever surface was used.
 */
export async function listChangeLog(limit = 50): Promise<ChangeLogEntry[]> {
  const rows = await prisma.welcomeChangeLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      entityType: true,
      entityName: true,
      userEmail: true,
      action: true,
      createdAt: true,
      before: true,
      after: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    entityType: r.entityType,
    entityName: r.entityName,
    userEmail: r.userEmail,
    action: r.action,
    createdAt: r.createdAt,
    changes: diffSnapshots(r.before, r.after),
  }));
}

// ---- System wrapper (global: affects every Welcome generation) ----

export async function saveSystemPrompt(content: string, actor: PackActor): Promise<string> {
  const before = await prisma.promptTemplate.findUnique({
    where: { type_key: { type: "WELCOME", key: "system" } },
    select: { content: true },
  });
  const row = await prisma.promptTemplate.upsert({
    where: { type_key: { type: "WELCOME", key: "system" } },
    create: { type: "WELCOME", key: "system", content },
    update: { content },
    select: { content: true },
  });
  if ((before?.content ?? "") !== row.content) {
    await logChange({
      entityType: "SYSTEM",
      entityId: null,
      entityName: "welcome system wrapper",
      action: "UPDATE",
      before: { content: before?.content ?? "" },
      after: { content: row.content },
      actor,
    });
  }
  return row.content;
}
