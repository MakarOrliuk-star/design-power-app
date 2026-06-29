/**
 * Task 1 — set Brand.imageModel = "xai/grok-imagine-image" for Morospin(Men).
 *
 * All generation/edit requests for that brand then route to the Grok Imagine
 * Image endpoint instead of the default nano-banana-2. Other brands are left at
 * null (default model).
 *
 * Dry-run by default — prints the would-be change. Run with --apply to write.
 * Uses DATABASE_URL from backend/.env (Railway in prod), same as the app:
 *   npx tsx scripts/seed-image-model.ts          # preview
 *   npx tsx scripts/seed-image-model.ts --apply  # write
 */
import { prisma } from "../src/lib/prisma.js";

const TARGET_BRAND = "Morospin(Men)";
const MODEL_KEY = "xai/grok-imagine-image";

const apply = process.argv.includes("--apply");

const brand = await prisma.brand.findUnique({
  where: { name: TARGET_BRAND },
  select: { id: true, name: true, imageModel: true },
});

if (!brand) {
  console.error(`Brand "${TARGET_BRAND}" not found — nothing to do.`);
  await prisma.$disconnect();
  process.exit(1);
}

console.log(`Brand: ${brand.name}`);
console.log(`Current imageModel: ${brand.imageModel ?? "(null → nano-banana-2)"}`);
console.log(`Target  imageModel: ${MODEL_KEY}`);

if (brand.imageModel === MODEL_KEY) {
  console.log("\nAlready set — nothing to update.");
} else if (!apply) {
  console.log("\nDry run — nothing written. Re-run with --apply to set it.");
} else {
  await prisma.brand.update({ where: { id: brand.id }, data: { imageModel: MODEL_KEY } });
  console.log("\nUpdated.");
}

await prisma.$disconnect();
