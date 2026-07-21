import { readFile } from "node:fs/promises";
import { prisma } from "../src/lib/prisma.js";
import { BRANDS, CATEGORIES, THEMES, BRAND_CATEGORIES } from "./seed-data/catalog.ts";
import { BRAND_NANO_REFS } from "./seed-data/nano-refs.ts";

/**
 * Idempotent seed (upserts) — safe to re-run.
 *  - Themes + picker categories (from Figma)
 *  - ~120 casino brands (legacy CONFIG.BRANDS) — for Person
 *  - Item style prompt wrappers extracted from the CREATE_ITEMS blueprint,
 *    stored as PromptTemplate(type=ITEM, key=style, content=wrapper with {{prompt}})
 *
 * The global Person system prompt lives in code (DEFAULT_PERSON_SYSTEM_PROMPT),
 * so it is not seeded here. Brand→category links are not seeded (mapping unknown).
 */
async function main() {
  // Themes
  for (let i = 0; i < THEMES.length; i++) {
    const name = THEMES[i]!;
    await prisma.theme.upsert({ where: { name }, create: { name, order: i }, update: { order: i } });
  }

  // Categories
  for (let i = 0; i < CATEGORIES.length; i++) {
    const name = CATEGORIES[i]!;
    await prisma.brandCategory.upsert({
      where: { name },
      create: { name, order: i },
      update: { order: i },
    });
  }

  // Brands (de-dupe defensively)
  const uniqueBrands = [...new Set(BRANDS)];
  for (const name of uniqueBrands) {
    await prisma.brand.upsert({ where: { name }, create: { name }, update: {} });
  }

  // Brand → category links (BrandCategoryLink) from BRAND_CATEGORIES.
  let linkCount = 0;
  for (const [categoryName, brandNames] of Object.entries(BRAND_CATEGORIES)) {
    const category = await prisma.brandCategory.findUnique({
      where: { name: categoryName },
      select: { id: true },
    });
    if (!category) continue;
    for (const brandName of brandNames) {
      const brand = await prisma.brand.findUnique({ where: { name: brandName }, select: { id: true } });
      if (!brand) {
        console.warn(`⚠️ link skipped — brand not found: ${brandName}`);
        continue;
      }
      await prisma.brandCategoryLink.upsert({
        where: { brandId_categoryId: { brandId: brand.id, categoryId: category.id } },
        create: { brandId: brand.id, categoryId: category.id },
        update: {},
      });
      linkCount++;
    }
  }

  // Brand reference images (BrandNanoRef) for Person generation.
  let nanoCount = 0;
  for (const [brandName, urls] of Object.entries(BRAND_NANO_REFS)) {
    const brand = await prisma.brand.findUnique({ where: { name: brandName }, select: { id: true } });
    if (!brand) {
      console.warn(`⚠️ nanoref skipped — brand not found: ${brandName}`);
      continue;
    }
    const referenceImages = urls.filter(Boolean);
    // Initial fill only: the admin panel is the source of truth for existing
    // refs, and this seed runs on every Railway deploy — never overwrite.
    await prisma.brandNanoRef.upsert({
      where: { brandId: brand.id },
      create: { brandId: brand.id, referenceImages, stylePrompt: "" },
      update: {},
    });
    nanoCount++;
  }

  // Item style prompts (extracted from CREATE_ITEMS.blueprint.json)
  const stylesUrl = new URL("./seed-data/item-styles.json", import.meta.url);
  const styles = JSON.parse(await readFile(stylesUrl, "utf8")) as { style: string; prompt: string }[];
  for (const { style, prompt } of styles) {
    // Initial fill only — ITEM prompts are edited via the admin panel.
    await prisma.promptTemplate.upsert({
      where: { type_key: { type: "ITEM", key: style } },
      create: { type: "ITEM", key: style, content: prompt },
      update: {},
    });
  }

  // Image Bundles (TASK crm-bundle): the one launch bundle type (D2 canonical
  // mask sizes) + starter Neural prompt presets (D8). Create-only — the admin
  // panel owns these after the initial fill (seed runs on every Railway deploy).
  await prisma.bundleType.upsert({
    where: { key: "simple_sendout" },
    create: {
      key: "simple_sendout",
      title: "Simple sendout",
      description: "Standard assets for email, pop-up and push.",
      assets: [
        { key: "email", label: "Email", width: 1200, height: 600 },
        { key: "popup", label: "Pop-up", width: 800, height: 600 },
        { key: "push", label: "Push", width: 1024, height: 512 },
      ],
    },
    update: {},
  });
  // Default ITEM anchor prompt for bundles (D12): used for brands without
  // their own ITEM template. Admin-editable via the existing prompt PUT.
  await prisma.promptTemplate.upsert({
    where: { type_key: { type: "ITEM", key: "bundle_default" } },
    create: {
      type: "ITEM",
      key: "bundle_default",
      content:
        "Casino slot item collection for an advertising creative: golden lucky seven symbols, casino chips, cherries, gold coins. Detailed glossy 3D render, isolated objects on a clean dark background, vivid advertising quality, no text. Theme: {{prompt}}",
    },
    update: {},
  });

  const presetCount = await prisma.neuralPromptPreset.count();
  if (presetCount === 0) {
    await prisma.neuralPromptPreset.createMany({
      data: [
        {
          title: "Weekend reload",
          text: "Weekend reload promotion with bonus energy and action. Bright celebratory mood, golden coins and glowing lights, high-energy casino excitement.",
          order: 0,
        },
        {
          title: "VIP exclusive",
          text: "Exclusive VIP offer for loyal players. Luxurious premium atmosphere, gold and black palette, elegant confident mood.",
          order: 1,
        },
        {
          title: "Cashback boost",
          text: "Cashback weekend promotion. Reassuring win-back mood, coins returning to the player, warm inviting colors.",
          order: 2,
        },
      ],
    });
  }

  console.log(
    `✅ Seeded: ${THEMES.length} themes, ${CATEGORIES.length} categories, ` +
      `${uniqueBrands.length} brands, ${linkCount} brand-category links, ` +
      `${nanoCount} brand nano-refs, ${styles.length} item-style prompts, ` +
      `1 bundle type, ${presetCount === 0 ? 3 : 0} prompt presets`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error("❌ Seed failed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
