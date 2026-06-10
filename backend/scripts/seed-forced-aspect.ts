/**
 * TASK §7 — set Brand.forcedAspectRatio = "9:16" for the strict-format brands.
 *
 * Matching (agreed 2026-06-10): a brand gets the flag when its name contains
 * one of the eight brand names, OR contains a men/women variant marker
 * ("мен"/"вумен"/"(Men)"/"(Women)") — case-insensitive.
 *
 * Dry-run by default — prints the would-be changes. Run with --apply to write.
 * Uses DATABASE_URL from backend/.env (Railway in prod), same as the app:
 *   npx tsx scripts/seed-forced-aspect.ts          # preview
 *   npx tsx scripts/seed-forced-aspect.ts --apply  # write
 */
import { prisma } from "../src/lib/prisma.js";

const BRAND_NAMES = [
  "spinogrino",
  "noodlespin",
  "betsamuro",
  "bonuseria",
  "lamalucky",
  "slotexity",
  "royalzino",
  "needforslots",
];
// "мен"/"вумен" from the TASK list = the (Men)/(Women) brand variants.
// NOTE: "women"/"вумен" contain "men"/"мен", so the shorter markers cover both.
const VARIANT_MARKERS = ["мен", "(men)", "(women)"];

function isForced(name: string): boolean {
  const n = name.toLowerCase();
  return (
    BRAND_NAMES.some((b) => n.includes(b)) || VARIANT_MARKERS.some((m) => n.includes(m))
  );
}

const apply = process.argv.includes("--apply");

const brands = await prisma.brand.findMany({
  select: { id: true, name: true, forcedAspectRatio: true },
  orderBy: { name: "asc" },
});

const toSet = brands.filter((b) => isForced(b.name) && b.forcedAspectRatio !== "9:16");
const already = brands.filter((b) => isForced(b.name) && b.forcedAspectRatio === "9:16");
const untouched = brands.filter((b) => !isForced(b.name));

console.log(`Brands total: ${brands.length}`);
console.log(`\nWill set "9:16" (${toSet.length}):`);
for (const b of toSet) console.log(`  + ${b.name}`);
console.log(`\nAlready forced (${already.length}):`);
for (const b of already) console.log(`  = ${b.name}`);
console.log(`\nLeft as user-pick (${untouched.length}):`);
for (const b of untouched) console.log(`  - ${b.name}`);

if (!apply) {
  console.log("\nDry run — nothing written. Re-run with --apply to set the flags.");
} else if (toSet.length === 0) {
  console.log("\nNothing to update.");
} else {
  const res = await prisma.brand.updateMany({
    where: { id: { in: toSet.map((b) => b.id) } },
    data: { forcedAspectRatio: "9:16" },
  });
  console.log(`\nUpdated ${res.count} brands.`);
}

await prisma.$disconnect();
