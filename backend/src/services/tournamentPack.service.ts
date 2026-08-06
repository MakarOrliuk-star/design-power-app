import { prisma } from "../lib/prisma.js";

/**
 * «Edit Tournament pack» (TASK tournament-pack): the mutation layer behind
 * /api/tournament-pack, the super-designer's window on Home.
 *
 * It edits the SAME global data the admin panel owns, so — unlike the plain
 * /api/tournament-admin routes — every write here lands in TournamentChangeLog
 * with before/after snapshots, and elements can be rolled back. The domain
 * rules (frozen category keys, VIP-name uniqueness, which modes an element
 * carries) mirror routes/tournamentAdmin.ts; keep the two in sync.
 */

export const TOURNAMENT_MODES = ["BASE", "VIP"] as const;
export type TournamentModeValue = (typeof TOURNAMENT_MODES)[number];

export interface PackActor {
  userId: string;
  userEmail: string;
}

export interface PromptSnapshot {
  mode: TournamentModeValue;
  content: string;
}

export interface ElementSnapshot {
  name: string;
  nameVip: string | null;
  order: number;
  isActive: boolean;
  referenceImages: string[];
  prompts: PromptSnapshot[];
}

export interface CategorySnapshot {
  key: string;
  name: string;
  hasModes: boolean;
  fixedMode: TournamentModeValue | null;
  order: number;
  elements: ElementSnapshot[];
}

interface CategoryModes {
  hasModes: boolean;
  fixedMode: TournamentModeValue | null;
}

/** Which prompt modes an element of this category carries. */
export function modesOf(category: CategoryModes): TournamentModeValue[] {
  return category.hasModes ? ["BASE", "VIP"] : [category.fixedMode ?? "BASE"];
}

/**
 * "Calendar (VIP)" -> "calendar_vip". The key doubles as the ZIP folder name
 * and is frozen at creation (renames keep it, so old archives stay coherent).
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
  nameVip: true,
  order: true,
  isActive: true,
  referenceImages: true,
  prompts: { select: { mode: true, content: true } },
} as const;

interface ElementRow {
  name: string;
  nameVip: string | null;
  order: number;
  isActive: boolean;
  referenceImages: string[];
  prompts: { mode: TournamentModeValue; content: string }[];
}

/** BASE before VIP — a stable order keeps the JSON diff meaningful. */
function toSnapshot(row: ElementRow): ElementSnapshot {
  return {
    name: row.name,
    nameVip: row.nameVip,
    order: row.order,
    isActive: row.isActive,
    referenceImages: [...row.referenceImages],
    prompts: [...row.prompts]
      .sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "BASE" ? -1 : 1))
      .map((p) => ({ mode: p.mode, content: p.content })),
  };
}

export async function getElementSnapshot(id: string): Promise<ElementSnapshot | null> {
  const row = (await prisma.tournamentElement.findUnique({
    where: { id },
    select: ELEMENT_SNAPSHOT_SELECT,
  })) as ElementRow | null;
  return row ? toSnapshot(row) : null;
}

/** Includes every element — a hard-deleted category must stay recoverable. */
export async function getCategorySnapshot(id: string): Promise<CategorySnapshot | null> {
  const row = await prisma.tournamentCategory.findUnique({
    where: { id },
    select: {
      key: true,
      name: true,
      hasModes: true,
      fixedMode: true,
      order: true,
      elements: { orderBy: { order: "asc" }, select: ELEMENT_SNAPSHOT_SELECT },
    },
  });
  if (!row) return null;
  return {
    key: row.key,
    name: row.name,
    hasModes: row.hasModes,
    fixedMode: row.fixedMode,
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
  await prisma.tournamentChangeLog.create({
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

// ---- Read: the whole pack (same shape as the admin panel's /config) ----

export async function loadPackConfig(): Promise<{ categories: unknown[]; systemPrompt: string }> {
  const [categories, wrapper] = await Promise.all([
    prisma.tournamentCategory.findMany({
      orderBy: { order: "asc" },
      select: {
        id: true,
        key: true,
        name: true,
        hasModes: true,
        fixedMode: true,
        order: true,
        elements: {
          orderBy: [{ order: "asc" }, { name: "asc" }],
          select: {
            id: true,
            name: true,
            nameVip: true,
            order: true,
            isActive: true,
            referenceImages: true,
            prompts: { select: { mode: true, content: true, updatedAt: true } },
          },
        },
      },
    }),
    prisma.promptTemplate.findUnique({
      where: { type_key: { type: "TOURNAMENT", key: "system" } },
      select: { content: true },
    }),
  ]);
  return { categories, systemPrompt: wrapper?.content ?? "" };
}

// ---- Elements ----

/** Another element of the category already uses this VIP name. */
async function vipNameClash(
  categoryId: string,
  nameVip: string,
  excludeId?: string,
): Promise<boolean> {
  const clash = await prisma.tournamentElement.findFirst({
    where: { categoryId, nameVip, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  return Boolean(clash);
}

async function baseNameClash(
  categoryId: string,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const clash = await prisma.tournamentElement.findUnique({
    where: { categoryId_name: { categoryId, name } },
    select: { id: true },
  });
  return Boolean(clash) && clash?.id !== excludeId;
}

export type CreateElementError = "category_not_found" | "vip_name_required" | "already_exists";

export type CreateElementResult =
  | { ok: true; element: { id: string }; snapshot: ElementSnapshot | null }
  | { ok: false; error: CreateElementError };

export async function createElement(
  input: { categoryId: string; name: string; nameVip?: string | undefined },
  actor: PackActor,
): Promise<CreateElementResult> {
  const category = await prisma.tournamentCategory.findUnique({
    where: { id: input.categoryId },
    select: { id: true, hasModes: true, fixedMode: true },
  });
  if (!category) return { ok: false, error: "category_not_found" };

  // hasModes categories carry a separate VIP name (required); fixed-mode never do.
  if (category.hasModes && !input.nameVip?.trim()) {
    return { ok: false, error: "vip_name_required" };
  }
  const nameVip = category.hasModes ? (input.nameVip as string).trim() : null;
  if (
    (await baseNameClash(input.categoryId, input.name)) ||
    (nameVip && (await vipNameClash(input.categoryId, nameVip)))
  ) {
    return { ok: false, error: "already_exists" };
  }

  const last = await prisma.tournamentElement.findFirst({
    where: { categoryId: input.categoryId },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  // New elements get a placeholder prompt per mode so the designers' page
  // always has something to show and override.
  const element = await prisma.tournamentElement.create({
    data: {
      categoryId: input.categoryId,
      name: input.name,
      nameVip,
      order: (last?.order ?? -1) + 1,
      prompts: {
        create: modesOf(category).map((mode) => ({
          mode,
          content: `[placeholder ${mode}] Default prompt for "${input.name}" — edit me in Admin → Tournaments or «Edit Tournament pack».`,
        })),
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
  nameVip?: string | null;
  order?: number;
  isActive?: boolean;
  referenceImages?: string[];
  prompts?: PromptSnapshot[];
}

export type ElementUpdateError =
  | "element_not_found"
  | "already_exists"
  | "vip_not_applicable"
  | "vip_name_required"
  | "invalid_mode";

export type ElementUpdateResult =
  | { ok: true; snapshot: ElementSnapshot; changed: boolean }
  | { ok: false; error: ElementUpdateError };

/**
 * The single save behind «Сохранить (для всех)»: names, prompts, provider refs
 * and the active flag land in ONE transaction and ONE audit entry, so a
 * rollback restores the element as a whole. A no-op save writes no log entry
 * (it must not become a rollback target).
 */
export async function updateElementAudited(
  id: string,
  patch: ElementPatch,
  actor: PackActor,
  action: "UPDATE" | "ROLLBACK" = "UPDATE",
): Promise<ElementUpdateResult> {
  const existing = await prisma.tournamentElement.findUnique({
    where: { id },
    select: {
      categoryId: true,
      category: { select: { hasModes: true, fixedMode: true } },
    },
  });
  if (!existing) return { ok: false, error: "element_not_found" };

  const before = await getElementSnapshot(id);
  if (!before) return { ok: false, error: "element_not_found" };

  if (patch.name !== undefined && (await baseNameClash(existing.categoryId, patch.name, id))) {
    return { ok: false, error: "already_exists" };
  }
  if (patch.nameVip !== undefined) {
    // VIP names exist only on hasModes categories; same clash rule as `name`.
    if (!existing.category.hasModes) {
      if (patch.nameVip !== null) return { ok: false, error: "vip_not_applicable" };
    } else if (!patch.nameVip?.trim()) {
      return { ok: false, error: "vip_name_required" };
    } else if (await vipNameClash(existing.categoryId, patch.nameVip.trim(), id)) {
      return { ok: false, error: "already_exists" };
    }
  }
  const allowedModes = modesOf(existing.category);
  if (patch.prompts?.some((p) => !allowedModes.includes(p.mode))) {
    return { ok: false, error: "invalid_mode" };
  }

  // Only write the keys the caller actually sent (exactOptionalPropertyTypes).
  const data: {
    name?: string;
    nameVip?: string | null;
    order?: number;
    isActive?: boolean;
    referenceImages?: string[];
  } = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.nameVip !== undefined) {
    data.nameVip = existing.category.hasModes ? (patch.nameVip as string).trim() : null;
  }
  if (patch.order !== undefined) data.order = patch.order;
  if (patch.isActive !== undefined) data.isActive = patch.isActive;
  if (patch.referenceImages !== undefined) {
    data.referenceImages = patch.referenceImages.map((s) => s.trim()).filter(Boolean);
  }

  const ops = [];
  if (Object.keys(data).length > 0) {
    ops.push(prisma.tournamentElement.update({ where: { id }, data }));
  }
  for (const p of patch.prompts ?? []) {
    // updatedAt bumps on every write — designers with a local override then see
    // the "default changed" banner (their baseUpdatedAt snapshot is now older).
    ops.push(
      prisma.tournamentPrompt.upsert({
        where: { elementId_mode: { elementId: id, mode: p.mode } },
        create: { elementId: id, mode: p.mode, content: p.content },
        update: { content: p.content },
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
  | { ok: true; snapshot: ElementSnapshot }
  | { ok: false; error: "element_not_found" };

/**
 * Removal is soft (isActive=false): Generation rows keep the denormalized
 * element name, so old batches and their ZIPs stay coherent.
 */
export async function softDeleteElement(id: string, actor: PackActor): Promise<SoftDeleteResult> {
  const before = await getElementSnapshot(id);
  if (!before) return { ok: false, error: "element_not_found" };

  await prisma.tournamentElement.update({ where: { id }, data: { isActive: false } });
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
  | { ok: true; snapshot: ElementSnapshot }
  | { ok: false; error: ElementUpdateError | "nothing_to_rollback" };

/**
 * Restore the `before` snapshot of the element's latest log entry, logged as a
 * ROLLBACK so the trail stays complete and the action is repeatable. `order` is
 * deliberately NOT restored — position is owned by reorderElements, and
 * resurrecting an old index would scramble the list around it.
 */
export async function rollbackElement(id: string, actor: PackActor): Promise<RollbackResult> {
  const last = await prisma.tournamentChangeLog.findFirst({
    where: { entityType: "ELEMENT", entityId: id },
    orderBy: { createdAt: "desc" },
    select: { before: true },
  });
  const snap = last?.before as unknown as ElementSnapshot | undefined;
  if (!snap || !snap.name) return { ok: false, error: "nothing_to_rollback" };

  return await updateElementAudited(
    id,
    {
      name: snap.name,
      nameVip: snap.nameVip,
      isActive: snap.isActive,
      referenceImages: snap.referenceImages,
      prompts: snap.prompts,
    },
    actor,
    "ROLLBACK",
  );
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
  const rows = await prisma.tournamentElement.findMany({
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
    orderedIds.map((id, i) => prisma.tournamentElement.update({ where: { id }, data: { order: i } })),
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

export type CreateCategoryResult = { ok: true; category: { id: string; key: string } };

export async function createCategory(
  input: { name: string; hasModes: boolean; fixedMode: TournamentModeValue | null },
  actor: PackActor,
): Promise<CreateCategoryResult> {
  let key = slugifyKey(input.name);
  for (
    let n = 2;
    await prisma.tournamentCategory.findUnique({ where: { key }, select: { id: true } });
    n++
  ) {
    key = `${slugifyKey(input.name)}_${n}`;
  }
  const last = await prisma.tournamentCategory.findFirst({
    orderBy: { order: "desc" },
    select: { order: true },
  });
  const category = await prisma.tournamentCategory.create({
    data: {
      key,
      name: input.name,
      hasModes: input.hasModes,
      fixedMode: input.fixedMode,
      order: (last?.order ?? -1) + 1,
    },
    select: { id: true, key: true, name: true, hasModes: true, fixedMode: true, order: true },
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

export interface CategoryRow {
  id: string;
  key: string;
  name: string;
  hasModes: boolean;
  fixedMode: TournamentModeValue | null;
  order: number;
}

export type CategoryUpdateResult =
  | { ok: true; category: CategoryRow }
  | { ok: false; error: "category_not_found" };

/** Rename/reorder only — the key and the Base/VIP config are frozen at creation. */
export async function updateCategoryAudited(
  id: string,
  patch: { name?: string; order?: number },
  actor: PackActor,
): Promise<CategoryUpdateResult> {
  const before = await prisma.tournamentCategory.findUnique({
    where: { id },
    select: { name: true, order: true },
  });
  if (!before) return { ok: false, error: "category_not_found" };

  // Only write the keys the caller sent (exactOptionalPropertyTypes).
  const data: { name?: string; order?: number } = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.order !== undefined) data.order = patch.order;

  const category = await prisma.tournamentCategory.update({
    where: { id },
    data,
    select: { id: true, key: true, name: true, hasModes: true, fixedMode: true, order: true },
  });
  if (before.name !== category.name || before.order !== category.order) {
    await logChange({
      entityType: "CATEGORY",
      entityId: id,
      entityName: category.name,
      action: "UPDATE",
      before,
      after: { name: category.name, order: category.order },
      actor,
    });
  }
  return { ok: true, category };
}

export async function reorderCategories(
  orderedIds: string[],
  actor: PackActor,
): Promise<ReorderResult> {
  const rows = await prisma.tournamentCategory.findMany({
    orderBy: { order: "asc" },
    select: { id: true, name: true },
  });
  if (rows.length !== orderedIds.length || !rows.every((r) => orderedIds.includes(r.id))) {
    return { ok: false, error: "invalid_ids" };
  }
  const nameById = new Map(rows.map((r) => [r.id, r.name]));

  await prisma.$transaction(
    orderedIds.map((id, i) => prisma.tournamentCategory.update({ where: { id }, data: { order: i } })),
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

export type DeleteCategoryResult =
  | { ok: true }
  | { ok: false; error: "category_not_found" };

/**
 * HARD delete (unlike elements): cascades to elements, default prompts and
 * every designer's local overrides. The audit entry therefore carries the FULL
 * category snapshot (all elements + their prompts) — the only trace left, and
 * enough to rebuild it by hand. Generation history is untouched: it keeps the
 * denormalized tourCategoryKey/tourElementName, so old ZIPs still work.
 */
export async function deleteCategoryAudited(
  id: string,
  actor: PackActor,
): Promise<DeleteCategoryResult> {
  const before = await getCategorySnapshot(id);
  if (!before) return { ok: false, error: "category_not_found" };

  await prisma.tournamentCategory.delete({ where: { id } });
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
  if (typeof o.nameVip === "string") out["Название VIP"] = o.nameVip;
  if (typeof o.order === "number") out["Порядок"] = String(o.order);
  if (typeof o.isActive === "boolean") out["Активен"] = o.isActive ? "да" : "нет";
  if (typeof o.content === "string") out["Текст"] = short(o.content);
  if (typeof o.key === "string") out["Ключ (папка ZIP)"] = o.key;

  if (Array.isArray(o.referenceImages)) {
    out["Референсы"] = (o.referenceImages as string[]).join(", ") || "—";
  }
  if (Array.isArray(o.prompts)) {
    for (const p of o.prompts as { mode?: string; content?: string }[]) {
      if (p?.mode) out[`Промпт ${p.mode}`] = short(p.content ?? "");
    }
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
 * Newest first. Every tournament mutation goes through this service — from the
 * admin panel AND from «Edit Tournament pack» — so the journal is the single
 * answer to "кто и что менял", whichever surface was used.
 */
export async function listChangeLog(limit = 50): Promise<ChangeLogEntry[]> {
  const rows = await prisma.tournamentChangeLog.findMany({
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

// ---- System wrapper (global: affects every tournament generation) ----

export async function saveSystemPrompt(content: string, actor: PackActor): Promise<string> {
  const before = await prisma.promptTemplate.findUnique({
    where: { type_key: { type: "TOURNAMENT", key: "system" } },
    select: { content: true },
  });
  const row = await prisma.promptTemplate.upsert({
    where: { type_key: { type: "TOURNAMENT", key: "system" } },
    create: { type: "TOURNAMENT", key: "system", content },
    update: { content },
    select: { content: true },
  });
  if ((before?.content ?? "") !== row.content) {
    await logChange({
      entityType: "SYSTEM",
      entityId: null,
      entityName: "tournament system wrapper",
      action: "UPDATE",
      before: { content: before?.content ?? "" },
      after: { content: row.content },
      actor,
    });
  }
  return row.content;
}
