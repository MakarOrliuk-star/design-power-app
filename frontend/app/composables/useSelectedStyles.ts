import { ref } from "vue";

// Shared selection state for the Home generator: the styles/brands the user has
// picked. Both "Current styles" (left) and the Each cards in "References & Promt"
// (right) read from this single source, so the number of Each sections always
// equals the number of selected styles.
//
// Module-level ref => one shared instance across all importers. This is a mock
// stand-in; Phase 7 replaces it with the generator store (gen.currentTargets).
const selected = ref<string[]>([
  "Bonuskong",
  "Casinacho",
  "Frogyspin (Women Black)",
]);

export function useSelectedStyles() {
  function add(name: string) {
    if (!selected.value.includes(name)) selected.value.push(name);
  }
  function addMany(names: string[]) {
    for (const n of names) add(n);
  }
  function toggle(name: string) {
    selected.value.includes(name) ? remove(name) : add(name);
  }
  function remove(name: string) {
    selected.value = selected.value.filter((s) => s !== name);
  }
  function isSelected(name: string) {
    return selected.value.includes(name);
  }
  function clear() {
    selected.value = [];
  }
  return { selected, add, addMany, toggle, remove, isSelected, clear };
}
