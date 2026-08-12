/**
 * Задача 5 — backfill Generation.isBrandTest for rows created BEFORE the flag
 * existed, so Library's «Тесты (N)» keeps listing the brand's historic test runs.
 *
 * Matching: brandId IS NOT NULL AND actionType = NANO_REF. Only createBrandTestBatch
 * ever writes Generation.brandId (regular Home generations store the denormalized
 * brandName only), so this hits exactly the test panel's rows.
 *
 * Historic never-saved tests keep isTest=true, so they stay hidden from Results
 * AND from Library's «Тесты» — they were never meant to be shown. The same flag
 * now marks draft previews from «Редактировать стиль».
 *
 * Dry-run by default; run with --apply to write. Uses DATABASE_URL from
 * backend/.env (Railway in prod), same as the app:
 *   npx tsx scripts/backfill-brand-tests.ts          # preview
 *   npx tsx scripts/backfill-brand-tests.ts --apply  # write
 */
import { prisma } from "../src/lib/prisma.js";

const apply = process.argv.includes("--apply");

const where = {
  brandId: { not: null },
  actionType: "NANO_REF",
  isBrandTest: false,
} as const;

const rows = await prisma.generation.findMany({
  where,
  select: { id: true, brandName: true, isTest: true, status: true, createdAt: true },
  orderBy: { createdAt: "desc" },
});

const visible = rows.filter((r) => !r.isTest);
const hidden = rows.filter((r) => r.isTest);

console.log(`Brand-test rows missing the flag: ${rows.length}`);
console.log(`  visible — were «saved», will show under «Тесты»: ${visible.length}`);
console.log(`  hidden — never saved, stay out of Results and Library: ${hidden.length}`);
for (const r of rows.slice(0, 20)) {
  console.log(`  ${r.createdAt.toISOString()}  ${r.brandName}  ${r.status}${r.isTest ? "  [hidden]" : ""}`);
}
if (rows.length > 20) console.log(`  … and ${rows.length - 20} more`);

if (!apply) {
  console.log("\nDry run — nothing written. Re-run with --apply.");
} else if (rows.length === 0) {
  console.log("\nNothing to update.");
} else {
  const res = await prisma.generation.updateMany({ where, data: { isBrandTest: true } });
  console.log(`\nUpdated ${res.count} generations.`);
}

await prisma.$disconnect();
