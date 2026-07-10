/**
 * Tournaments page (feature/tournament-page) — Phase 2 seed.
 *
 * Seeds, idempotently (safe to re-run; existing admin edits are NEVER
 * overwritten — upserts use empty `update`):
 *  - the 4 fixed categories (tournament / lotterie / provider / calendar_vip)
 *  - the elements from the Figma mock (Tournament_1..3 + seasonal, etc.)
 *  - placeholder default prompts per element/mode (admin fills real ones)
 *  - the DES counter row (id=1, value=100000; value is never reset)
 *  - the TOURNAMENT system wrapper PromptTemplate (key="system", identity
 *    "{{prompt}}" until the admin writes the real wrapper)
 *
 * Dry-run by default — prints the would-be changes. Run with --apply to write.
 * Uses DATABASE_URL from backend/.env (Railway in prod), same as the app:
 *   npx tsx scripts/seed-tournaments.ts          # preview
 *   npx tsx scripts/seed-tournaments.ts --apply  # write
 */
import { prisma } from "../src/lib/prisma.js";

type Mode = "BASE" | "VIP";

interface CategorySeed {
  key: string;
  name: string;
  hasModes: boolean;
  fixedMode: Mode | null;
  order: number;
  elements: string[];
}

const seasonal = (prefix: string) =>
  ["Halloween", "Christmas", "Easter", "Summer"].map((s) => `${prefix} ${s}`);

const CATEGORIES: CategorySeed[] = [
  {
    key: "tournament",
    name: "Tournament (Bs)",
    hasModes: true,
    fixedMode: null,
    order: 0,
    elements: ["Tournament_1", "Tournament_2", "Tournament_3", ...seasonal("Tournament")],
  },
  {
    key: "lotterie",
    name: "Lotterie (Bs)",
    hasModes: true,
    fixedMode: null,
    order: 1,
    elements: ["Lottery_1", "Lottery_2", "Lottery_3", ...seasonal("Lottery")],
  },
  {
    key: "provider",
    name: "Provider",
    hasModes: false,
    fixedMode: "BASE",
    order: 2,
    elements: ["Endorphina", "Playson & Booongo", "Spinoleague", "Bgaming", "Drops & Wins", "Evolution"],
  },
  {
    key: "calendar_vip",
    name: "Calendar (VIP)",
    hasModes: false,
    fixedMode: "VIP",
    order: 3,
    elements: ["Calendar_1", "Calendar_2", "Calendar_3", ...seasonal("Calendar")],
  },
];

/** Which prompt modes an element of this category carries. */
function modesFor(c: CategorySeed): Mode[] {
  return c.hasModes ? ["BASE", "VIP"] : [c.fixedMode!];
}

function placeholder(element: string, mode: Mode): string {
  return `[placeholder ${mode}] Default prompt for "${element}" — edit me in Admin → Tournaments.`;
}

const apply = process.argv.includes("--apply");
let created = 0;
let skipped = 0;

for (const c of CATEGORIES) {
  const existingCat = await prisma.tournamentCategory.findUnique({
    where: { key: c.key },
    select: { id: true },
  });
  console.log(`${existingCat ? "=" : "+"} category ${c.key} (${c.name})`);

  let categoryId = existingCat?.id ?? "";
  if (apply) {
    const row = await prisma.tournamentCategory.upsert({
      where: { key: c.key },
      create: {
        key: c.key,
        name: c.name,
        hasModes: c.hasModes,
        fixedMode: c.fixedMode,
        order: c.order,
      },
      update: {}, // never clobber
      select: { id: true },
    });
    categoryId = row.id;
  }

  for (const [i, name] of c.elements.entries()) {
    const existingEl = categoryId
      ? await prisma.tournamentElement.findUnique({
          where: { categoryId_name: { categoryId, name } },
          select: { id: true },
        })
      : null;
    if (existingEl) skipped++;
    else created++;
    console.log(`  ${existingEl ? "=" : "+"} element ${name}`);
    if (!apply) continue;

    const el = await prisma.tournamentElement.upsert({
      where: { categoryId_name: { categoryId, name } },
      create: { categoryId, name, order: i },
      update: {},
      select: { id: true },
    });

    for (const mode of modesFor(c)) {
      await prisma.tournamentPrompt.upsert({
        where: { elementId_mode: { elementId: el.id, mode } },
        create: { elementId: el.id, mode, content: placeholder(name, mode) },
        update: {},
      });
    }
  }
}

// DES counter: create at 100000; NEVER reset an existing value.
const counter = await prisma.desCounter.findUnique({ where: { id: 1 } });
console.log(counter ? `= DES counter exists (value=${counter.value})` : "+ DES counter -> 100000");
if (apply && !counter) {
  await prisma.desCounter.create({ data: { id: 1, value: 100000 } });
}

// System wrapper (identity until the admin writes the real one).
const wrapper = await prisma.promptTemplate.findUnique({
  where: { type_key: { type: "TOURNAMENT", key: "system" } },
  select: { id: true },
});
console.log(wrapper ? "= TOURNAMENT system wrapper exists" : "+ TOURNAMENT system wrapper -> {{prompt}}");
if (apply && !wrapper) {
  await prisma.promptTemplate.create({
    data: { type: "TOURNAMENT", key: "system", content: "{{prompt}}" },
  });
}

console.log(`\nElements: ${created} new, ${skipped} already present.`);
if (!apply) console.log("Dry run — nothing written. Re-run with --apply to seed.");

await prisma.$disconnect();
