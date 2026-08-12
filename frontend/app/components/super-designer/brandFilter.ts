/**
 * Brand search for BrandCombobox (задача 6). Kept as a pure module so it is
 * unit-tested without mounting the component.
 */
export interface BrandOption {
  id: string;
  name: string;
  isActive: boolean;
}

/**
 * Case-insensitive substring match on the brand name. An empty/blank query
 * returns everything (the list opens showing all brands). Matches are ordered
 * name-first: brands STARTING with the query come before mid-name hits, so
 * typing "bet" surfaces "Betnella" above "Wildbet"; ties keep the caller's
 * order (the backend already sorts the list).
 */
export function filterBrands(brands: BrandOption[], query: string): BrandOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...brands];
  const starts: BrandOption[] = [];
  const contains: BrandOption[] = [];
  for (const b of brands) {
    const name = b.name.toLowerCase();
    if (name.startsWith(q)) starts.push(b);
    else if (name.includes(q)) contains.push(b);
  }
  return [...starts, ...contains];
}
