import { prisma } from "../lib/prisma.js";

/**
 * Brand create/update/delete shared by the admin panel and the super-designer
 * surface (/api/my-brands). Ownership checks stay in the routes — this module
 * only mutates.
 */

export interface CreateBrandInput {
  name: string;
  categoryIds: string[];
  personPrompt: string; // → PromptTemplate(PERSON, key=name)
  stylePrompt: string; // → BrandNanoRef.stylePrompt
  referenceImages: string[]; // → BrandNanoRef.referenceImages (Cloudinary URLs)
  forcedAspectRatio: string | null;
  createdById: string | null; // owner (TASK super-designer); null = legacy/admin
}

export type CreateBrandResult =
  | { ok: true; brand: { id: string; name: string } }
  | { ok: false; error: "already_exists" | "create_failed" };

export async function createBrand(input: CreateBrandInput): Promise<CreateBrandResult> {
  const name = input.name.trim();
  const existing = await prisma.brand.findUnique({ where: { name }, select: { id: true } });
  if (existing) return { ok: false, error: "already_exists" };

  const validCategoryIds = await filterCategoryIds(input.categoryIds);
  const refs = input.referenceImages.map((s) => s.trim()).filter(Boolean);
  const stylePrompt = input.stylePrompt.trim();

  try {
    const brand = await prisma.brand.create({
      data: {
        name,
        forcedAspectRatio: input.forcedAspectRatio,
        createdById: input.createdById,
        categories: {
          create: validCategoryIds.map((id) => ({ category: { connect: { id } } })),
        },
        ...(stylePrompt || refs.length
          ? { nanoRef: { create: { referenceImages: refs, stylePrompt } } }
          : {}),
      },
      select: { id: true, name: true },
    });

    // Base PERSON prompt (looked up by brand name in the generation flow).
    if (input.personPrompt.trim()) {
      await prisma.promptTemplate.upsert({
        where: { type_key: { type: "PERSON", key: name } },
        create: { type: "PERSON", key: name, content: input.personPrompt, brandId: brand.id },
        update: { content: input.personPrompt, brandId: brand.id },
      });
    }

    return { ok: true, brand };
  } catch {
    return { ok: false, error: "create_failed" };
  }
}

export interface UpdateBrandInput {
  name?: string;
  categoryIds?: string[];
  personPrompt?: string;
  stylePrompt?: string;
  referenceImages?: string[];
  forcedAspectRatio?: string | null;
}

export type UpdateBrandResult =
  | { ok: true; brand: { id: string; name: string } }
  | { ok: false; error: "brand_not_found" | "already_exists" | "update_failed" };

/**
 * Full-field brand update (super-designer edit modal / Library). A rename also
 * moves the PERSON PromptTemplate to the new key; Generation history keeps the
 * old denormalized brandName (saved tests survive via Generation.brandId).
 */
export async function updateBrand(
  brandId: string,
  input: UpdateBrandInput,
): Promise<UpdateBrandResult> {
  const current = await prisma.brand.findUnique({
    where: { id: brandId },
    select: { id: true, name: true },
  });
  if (!current) return { ok: false, error: "brand_not_found" };

  const newName = input.name?.trim();
  if (newName && newName !== current.name) {
    const clash = await prisma.brand.findUnique({ where: { name: newName }, select: { id: true } });
    if (clash) return { ok: false, error: "already_exists" };
  }

  try {
    const data: {
      name?: string;
      forcedAspectRatio?: string | null;
      categories?: { deleteMany: Record<string, never>; create: { category: { connect: { id: string } } }[] };
    } = {};
    if (newName) data.name = newName;
    if (input.forcedAspectRatio !== undefined) data.forcedAspectRatio = input.forcedAspectRatio;
    if (input.categoryIds !== undefined) {
      const validCategoryIds = await filterCategoryIds(input.categoryIds);
      data.categories = {
        deleteMany: {},
        create: validCategoryIds.map((id) => ({ category: { connect: { id } } })),
      };
    }

    const brand = await prisma.brand.update({
      where: { id: brandId },
      data,
      select: { id: true, name: true },
    });

    // NanoRef: style prompt and/or reference images.
    if (input.stylePrompt !== undefined || input.referenceImages !== undefined) {
      const refs = input.referenceImages?.map((s) => s.trim()).filter(Boolean);
      await prisma.brandNanoRef.upsert({
        where: { brandId },
        create: {
          brandId,
          referenceImages: refs ?? [],
          stylePrompt: input.stylePrompt?.trim() ?? "",
        },
        update: {
          ...(refs !== undefined ? { referenceImages: refs } : {}),
          ...(input.stylePrompt !== undefined ? { stylePrompt: input.stylePrompt.trim() } : {}),
        },
      });
    }

    // PERSON prompt: rename moves the key; content update writes the new text.
    const key = brand.name;
    if (newName && newName !== current.name) {
      // Move any existing template off the old key first (unique on type+key).
      await prisma.promptTemplate.deleteMany({ where: { type: "PERSON", key: newName } });
      await prisma.promptTemplate.updateMany({
        where: { type: "PERSON", key: current.name },
        data: { key: newName },
      });
    }
    if (input.personPrompt !== undefined) {
      if (input.personPrompt.trim()) {
        await prisma.promptTemplate.upsert({
          where: { type_key: { type: "PERSON", key } },
          create: { type: "PERSON", key, content: input.personPrompt, brandId: brand.id },
          update: { content: input.personPrompt, brandId: brand.id },
        });
      } else {
        await prisma.promptTemplate.deleteMany({ where: { type: "PERSON", key } });
      }
    }

    return { ok: true, brand };
  } catch {
    return { ok: false, error: "update_failed" };
  }
}

/**
 * Hard delete (Phase 0 decision). Cascades take categories/nanoRef/favorites;
 * the PERSON PromptTemplate rows are removed explicitly. Generation history
 * stays (brandName is denormalized; Generation.brandId SetNulls).
 */
export async function deleteBrand(brandId: string): Promise<boolean> {
  const brand = await prisma.brand.findUnique({
    where: { id: brandId },
    select: { id: true, name: true },
  });
  if (!brand) return false;
  await prisma.promptTemplate.deleteMany({ where: { type: "PERSON", key: brand.name } });
  await prisma.brand.delete({ where: { id: brandId } });
  return true;
}

/** Keep only category IDs that actually exist. */
async function filterCategoryIds(categoryIds: string[]): Promise<string[]> {
  if (!categoryIds.length) return [];
  const rows = await prisma.brandCategory.findMany({
    where: { id: { in: categoryIds } },
    select: { id: true },
  });
  return rows.map((c) => c.id);
}
