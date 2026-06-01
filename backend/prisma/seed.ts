import { readFile } from "node:fs/promises";
import { prisma } from "../src/lib/prisma.js";
import { BRANDS, CATEGORIES, THEMES } from "./seed-data/catalog.ts";

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

  // Item style prompts (extracted from CREATE_ITEMS.blueprint.json)
  const stylesUrl = new URL("./seed-data/item-styles.json", import.meta.url);
  const styles = JSON.parse(await readFile(stylesUrl, "utf8")) as { style: string; prompt: string }[];
  for (const { style, prompt } of styles) {
    await prisma.promptTemplate.upsert({
      where: { type_key: { type: "ITEM", key: style } },
      create: { type: "ITEM", key: style, content: prompt },
      update: { content: prompt },
    });
  }

  console.log(
    `✅ Seeded: ${THEMES.length} themes, ${CATEGORIES.length} categories, ` +
      `${uniqueBrands.length} brands, ${styles.length} item-style prompts`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error("❌ Seed failed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
