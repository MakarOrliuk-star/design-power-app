/**
 * Welcome packs (TASK welcome-packs) — seed.
 *
 * Deliberately minimal: the заказчик asked for NO seeded content — every
 * category, element and prompt is created by hand from «Edit Welcome packs».
 * The only thing this script writes is the WELCOME system wrapper
 * (PromptTemplate type=WELCOME, key="system"), seeded as the identity
 * "{{prompt}}" so generation works before anyone writes a real wrapper.
 *
 * Idempotent: an existing wrapper is NEVER overwritten (upsert with an empty
 * `update`), so re-running after edits is safe.
 *
 * Dry-run by default — prints the would-be changes. Run with --apply to write.
 * Uses DATABASE_URL from backend/.env (Railway in prod), same as the app:
 *   npx tsx scripts/seed-welcome.ts          # preview
 *   npx tsx scripts/seed-welcome.ts --apply  # write
 */
import { prisma } from "../src/lib/prisma.js";

const APPLY = process.argv.includes("--apply");

/** Identity wrapper: the element prompt reaches the pipeline unchanged. */
const DEFAULT_SYSTEM_WRAPPER = "{{prompt}}";

async function main(): Promise<void> {
  console.log(APPLY ? "🚀 Seeding Welcome packs (apply)" : "🔍 Welcome packs seed — dry run");

  const existing = await prisma.promptTemplate.findUnique({
    where: { type_key: { type: "WELCOME", key: "system" } },
    select: { content: true },
  });

  if (existing) {
    console.log("• WELCOME system wrapper: already present — left untouched");
  } else if (!APPLY) {
    console.log(`• WELCOME system wrapper: would create with ${JSON.stringify(DEFAULT_SYSTEM_WRAPPER)}`);
  } else {
    await prisma.promptTemplate.create({
      data: { type: "WELCOME", key: "system", content: DEFAULT_SYSTEM_WRAPPER },
    });
    console.log("• WELCOME system wrapper: created");
  }

  const categories = await prisma.welcomeCategory.count();
  console.log(
    `• Categories in the DB: ${categories} (nothing is seeded by design — create them in «Edit Welcome packs»)`,
  );

  console.log(APPLY ? "✅ Done" : "ℹ️  Dry run finished — re-run with --apply to write");
}

main()
  .catch((err) => {
    console.error("Welcome seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
