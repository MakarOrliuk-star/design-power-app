// Seed catalog data. Brands + themes are from the legacy GAS CONFIG; the picker
// category tabs are from the Figma. Brand→category links are intentionally NOT
// seeded yet (the mapping wasn't in the reference) — brands show under "All"
// until assigned. Item styles live separately in seed-data/item-styles.json.

export const THEMES: string[] = [
  "iGaming",
  "Casino",
  "Sports Betting",
  "Poker",
  "Slots",
  "Live Casino",
  "Roulette",
  "Blackjack",
  "Table Games",
];

// Picker tabs from Figma (Favorites + All are virtual, handled client-side).
export const CATEGORIES: string[] = [
  "All Aramuz",
  "DJslot and Vinci",
  "Oscar, Corgi, Spinjoys",
  "Korea",
  "Sport",
];

// ~120 casino brands (legacy CONFIG.BRANDS, de-duplicated).
export const BRANDS: string[] = [
  "corgi", "Oscar(man)", "Oscar(woman)", "Spinjoys", "Spingranny",
  "Spinogambino(Men)", "Spinogambino(Women)", "Roulettino(Men)", "Roulettino(Women)", "Spinmama",
  "Gambloria(Men)", "Gambloria(Women)", "Playjonny(Men)", "Playjonny(Women)", "Baxterbet",
  "Rodeoslot(Men)", "Rodeoslot(Women)", "Winairlines(Men)", "Winairlines(Women)", "Casinacho",
  "Honeybetz", "Needforslots(Men)", "Needforslots(Women)", "Boomzino(Men)", "Boomzino(Women)",
  "Browinner(Men)", "Browinner(Women)", "Goldzino(Men)", "Goldzino(Women)", "Magneticslots",
  "Ivybet(Men)", "Ivybet(Women)", "Makispin", "Spinmacho(Men)", "Spinmacho(Women)",
  "Morospin(Men)", "Morospin(Women)", "Morospin(Monkey)", "Piperspin", "Royalstiger",
  "Spinania", "Spinsahara(Men)", "Spinsahara(Women)", "Spinwinera", "Rockyspin",
  "Rolldorado(Men)", "Rolldorado(Women)", "Afkspin", "Spinmaya(Men)", "Spinmaya(Women)",
  "Billionairespin(Men)", "Billionairespin(Women)", "Fridayroll(Men)", "Fridayroll(Women)", "Duckysino",
  "Highflybet(Men)", "Highflybet(Women)", "Nyxbets(Men)", "Nyxbets(Women)", "Winbeatz",
  "Korea_game_art", "Korea_realism(Men)", "Korea_realism(Women)", "SLOTSDJ(Men)", "SLOTSDJ(Women)",
  "Vincispin(Men)", "Vincispin(Women)", "Frogyspin_women_red", "Frogyspin_women_black", "Frogyspin(Men)",
  "Lootzino(Women)", "Lootzino(Men)", "Manekispin", "Senseizino(Women)", "Senseizino(Men)",
  "Bonuskong", "Scizino", "Slotexity", "Slotrize(Men)", "Slotrize(Duck)",
  "Spinogrino", "TeddySlot", "Betnella(Men)", "Betnella(Women)", "Gamblerina",
  "Gangstasino(Men)", "Gangstasino(Women)", "Glitzbets(Men)", "Glitzbets(Women)", "Riverspin",
  "Liraluck(Men)", "Liraluck(Women)", "Tesorcasino(Men)", "Tesorcasino(Women)", "Thorfortune",
  "Rooksbet", "Royalzino", "Spinstein", "Beezyspin", "Betsamuro(Men)",
  "Betsamuro(Women)", "BONUSERIA", "Lamalucky", "Luckysheriff(Dog)", "Luckysheriff(Sheriff)",
  "Rollflame", "Noodlespin(Panda)", "Noodlespin(Bussel)", "Oopspin(Men)", "Oopspin(Women)",
  "Rollambia(Men)", "Rollambia(Women)",
];
