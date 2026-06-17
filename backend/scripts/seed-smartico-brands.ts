/**
 * Seed the SmarticoBrand table from the legacy hardcoded SMARTICO_BRANDS list
 * (ported verbatim from the GAS "Zip folder.txt" component). These are the
 * canonical brand_id values the Smartico function maps against; admins maintain
 * the list from /admin afterwards.
 *
 * Idempotent (upsert by name) — safe to re-run. Dry-run by default; pass --apply
 * to write. Uses DATABASE_URL from backend/.env, same as the app:
 *   npx tsx scripts/seed-smartico-brands.ts          # preview
 *   npx tsx scripts/seed-smartico-brands.ts --apply  # write
 */
import { prisma } from "../src/lib/prisma.js";

// Full legacy SMARTICO_BRANDS list (order preserved for readability only).
const SMARTICO_BRANDS = [
  "BrunoCasino", "NineCasino", "Memocasino", "Spinmacho", "Baxterbet",
  "Needforslots", "Rodeoslot", "Boomzino", "Honeybetz", "Playjonny",
  "Ivybet", "Blazingwildz", "Rolldorado", "Roulettino", "Morospin",
  "Gambloria", "Piperspin", "Rockyspin", "Spinmama", "Turbowinz",
  "Billionairespin", "Carlospin", "Senseizino", "Spinbuddha", "Sweetyspin",
  "Nyxbets", "Pupalupa", "Bettyspin", "Fridayroll", "Lolospin",
  "XtraSpin", "Jackpotraider", "Gigaspinz", "God of Coins", "Katanaspin",
  "Capospin", "Crystalroll", "Highflybet", "F7casino", "Vipzino",
  "Savaspin", "Liraspin", "Wbetz", "Loonaspin", "Lazybar",
  "Romancasino", "Coolzino", "R2pbet", "Winaura", "Betsixty",
  "Nomaspin", "Kinghills", "bdmbet", "zumospin", "B7",
  "Ninewin", "JokaBet", "cryptoleo.com", "BetOnRed", "Makispin",
  "Winairlines", "Buddyspin", "Spinogambino", "Royalstiger", "Browinner",
  "Duckysino", "Leprezone", "Magicspins", "Spinmaya", "Cowboyspin",
  "Royalzino", "Goldzino", "Magneticslots", "Spinsahara", "Casinacho",
  "Winzoria", "Spinania", "Spinwinera", "Winbeatz", "Retrozino",
  "Royalspinia", "Manekispin", "Happyjokers", "Ringospin", "Spinogrino",
  "Luckycapone", "Afkspin",
  "Scizino", "Slotexity", "Slotrize", "TeddySlot",
  "Betnella", "Gamblerina", "Gangstasino", "Glitzbets", "Riverspin",
  "Liraluck", "Tesorcasino", "Thorfortune", "Rooksbet", "Spinstein",
  "Beezyspin", "Betsamuro", "BONUSERIA", "Lamalucky", "Luckysheriff", "Rollflame",
  "Noodlespin", "Oopspin", "Rollambia",
  "Oscarspin", "Corgibet", "Spingranny", "Spinjoys",
];

const apply = process.argv.includes("--apply");

const names = [...new Set(SMARTICO_BRANDS.map((n) => n.trim()).filter(Boolean))];

const existing = await prisma.smarticoBrand.findMany({ select: { name: true } });
const existingNames = new Set(existing.map((b) => b.name));

const toCreate = names.filter((n) => !existingNames.has(n));
const already = names.filter((n) => existingNames.has(n));

console.log(`Smartico brands in list: ${names.length}`);
console.log(`Already in DB: ${already.length}`);
console.log(`\nWill create (${toCreate.length}):`);
for (const n of toCreate) console.log(`  + ${n}`);

if (!apply) {
  console.log("\nDry run — nothing written. Re-run with --apply to seed.");
} else {
  for (const name of names) {
    await prisma.smarticoBrand.upsert({ where: { name }, create: { name }, update: {} });
  }
  console.log(`\nUpserted ${names.length} Smartico brands.`);
}

await prisma.$disconnect();
