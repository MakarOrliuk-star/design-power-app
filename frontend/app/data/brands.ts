// Master brand list — mirrors the `brand` table. Single source of truth so new
// brands/styles appear in the picker automatically as they're added.
//
// Phase 7: replace the static BRANDS import in BrandPicker with a backend load
// (e.g. useApi("/brands")) returning the same id list; groupBrands() stays.
// The DB can also carry a proper display name + category, which would replace
// the heuristic formatBrand() below.

export const BRANDS: string[] = [
  "corgi", "Oscar(man)", "Oscar(woman)", "Spinjoys",
  "Spingranny", "Spinogambino(Men)", "Spinogambino(Women)", "Roulettino(Men)", "Roulettino(Women)", "Spinmama",
  "Gambloria(Men)", "Gambloria(Women)", "Playjonny(Men)", "Playjonny(Women)", "Baxterbet",
  "Rodeoslot(Men)", "Rodeoslot(Women)", "Winairlines(Men)", "Winairlines(Women)", "Casinacho",
  "Honeybetz", "Needforslots(Men)", "Needforslots(Women)", "Boomzino(Men)", "Boomzino(Women)",
  "Browinner(Men)", "Browinner(Women)", "Goldzino(Men)", "Goldzino(Women)", "Magneticslots",
  "Ivybet(Men)", "Ivybet(Women)", "Makispin", "Spinmacho(Men)", "Spinmacho(Women)",
  "Morospin(Men)", "Morospin(Women)", "Morospin(Monkey)", "Piperspin", "Royalstiger",
  "Spinania", "Spinsahara(Men)", "Spinsahara(Women)", "Spinwinera", "Rockyspin",
  "Rolldorado(Men)", "Rolldorado(Women)", "Afkspin", "Spinmaya(Men)", "Spinmaya(Women)",
  "Billionairespin(Men)", "Billionairespin(Women)", "Fridayroll(Men)", "Fridayroll(Women)", "Duckysino",
  "Makispin", "Highflybet(Men)", "Highflybet(Women)", "Nyxbets(Men)", "Nyxbets(Women)",
  "Winbeatz", "Korea_game_art", "Korea_realism(Men)", "Korea_realism(Women)",
  "SLOTSDJ(Men)", "SLOTSDJ(Women)", "Vincispin(Men)", "Vincispin(Women)",
  "Frogyspin_women_red", "Frogyspin_women_black", "Frogyspin(Men)",
  "Lootzino(Women)", "Lootzino(Men)",
  "Manekispin",
  "Senseizino(Women)", "Senseizino(Men)",
  "Bonuskong",
  "Scizino", "Slotexity", "Slotrize(Men)", "Slotrize(Duck)", "Spinogrino", "TeddySlot",
  "Betnella(Men)", "Betnella(Women)", "Gamblerina", "Gangstasino(Men)", "Gangstasino(Women)",
  "Glitzbets(Men)", "Glitzbets(Women)", "Riverspin",
  "Liraluck(Men)", "Liraluck(Women)", "Tesorcasino(Men)", "Tesorcasino(Women)",
  "Thorfortune", "Rooksbet", "Royalzino", "Spinstein",
  "Beezyspin", "Betsamuro(Men)", "Betsamuro(Women)", "BONUSERIA", "Lamalucky",
  "Luckysheriff(Dog)", "Luckysheriff(Sheriff)", "Rollflame",
  "Noodlespin(Panda)", "Noodlespin(Bussel)", "Oopspin(Men)", "Oopspin(Women)",
  "Rollambia(Men)", "Rollambia(Women)",
];

const titleCase = (s: string) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;

/**
 * Raw brand id -> human display label.
 *   "Spinogambino(Men)"     -> "Spinogambino (Men)"
 *   "Frogyspin_women_black" -> "Frogyspin (Women Black)"
 *   "BONUSERIA"             -> "Bonuseria"
 * First underscore token is the brand; the rest + any trailing (...) become a
 * parenthesised qualifier.
 */
export function formatBrand(raw: string): string {
  const m = raw.match(/^(.*?)\(([^)]+)\)$/);
  const base = m ? m[1] : raw;
  const paren = m ? m[2] : "";

  const tokens = base.split("_").filter(Boolean);
  let label = titleCase(tokens[0] ?? base);

  const quals = tokens.slice(1).map(titleCase);
  if (paren) quals.push(titleCase(paren));
  if (quals.length) label += ` (${quals.join(" ")})`;
  return label;
}

export interface Brand {
  id: string;
  label: string;
}
export interface BrandGroup {
  letter: string;
  brands: Brand[];
}

/** Dedupe, format, sort A-Z and bucket by first letter for the picker. */
export function groupBrands(raw: string[]): BrandGroup[] {
  const seen = new Set<string>();
  const brands: Brand[] = [];
  for (const id of raw) {
    const label = formatBrand(id);
    if (seen.has(label)) continue;
    seen.add(label);
    brands.push({ id, label });
  }
  brands.sort((a, b) => a.label.localeCompare(b.label));

  const map = new Map<string, Brand[]>();
  for (const b of brands) {
    const letter = b.label[0]!.toUpperCase();
    (map.get(letter) ?? map.set(letter, []).get(letter)!).push(b);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([letter, list]) => ({ letter, brands: list }));
}
