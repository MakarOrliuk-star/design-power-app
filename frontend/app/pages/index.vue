<script setup lang="ts">
// Home — the generator, re-laid per figma/home 2.0 new.PNG: a single white
// board with a control row on top (search / clear / content tabs / All-Each),
// the selected-styles box + the Style panel in the middle, and the brand
// picker filling the rest of the screen. The board itself never scrolls —
// only the chips box, the Each stack and the picker list scroll locally.
useHead({ title: "Design Power — Home" });

const gen = useGeneratorStore();
onMounted(() => {
  if (!gen.loaded) void gen.load();
});

const TABS = [
  { label: "Person", value: "PERSON" },
  { label: "Item", value: "ITEM" },
  { label: "Background", value: "BACKGROUND" },
] as const;

const MODES = [
  { label: "All", value: "ALL" },
  { label: "Each", value: "EACH" },
] as const;

// Cloudinary media library (asset browser) — opens in a new tab.
const CLOUDINARY_ASSETS_URL =
  "https://console.cloudinary.com/app/c-f1e35ef68f5213bd50f69a1362c323/assets/media_library/search?q=&view_mode=mosaic";
function openAssets() {
  window.open(CLOUDINARY_ASSETS_URL, "_blank", "noopener");
}
</script>

<template>
  <div class="home">
    <TheToolbar />

    <div class="board">
      <!-- control row: search | clear all | Person/Item/Background | All/Each -->
      <div class="top">
        <div class="search">
          <input v-model="gen.search" class="search__input" type="text" placeholder="Search" />
          <span class="search__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.8" />
              <path d="M16 16l4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
          </span>
        </div>

        <button class="clear" type="button" @click="gen.clearAll()">Clear all</button>

        <div class="seg seg--tabs">
          <button
            v-for="t in TABS"
            :key="t.value"
            :class="['seg__btn', { 'seg__btn--on': gen.activeTab === t.value }]"
            type="button"
            @click="gen.activeTab = t.value"
          >
            <span v-if="t.value === 'PERSON'" class="seg__ic" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
                <circle cx="12" cy="8" r="3.4" stroke="currentColor" stroke-width="1.6" />
                <path d="M5 19c0-3.3 3.1-5 7-5s7 1.7 7 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
              </svg>
            </span>
            {{ t.label }}
          </button>
        </div>

        <div class="seg seg--mode">
          <button
            v-for="m in MODES"
            :key="m.value"
            :class="['seg__btn', { 'seg__btn--on': gen.refMode === m.value }]"
            type="button"
            @click="gen.refMode = m.value"
          >
            {{ m.label }}
          </button>
        </div>
      </div>

      <div class="board__cols">
        <GeneratorCurrentStyles />
        <GeneratorReferencePanel />
      </div>

      <GeneratorBrandPicker class="board__picker" />

      <button class="assets" type="button" title="Cloudinary media library" @click="openAssets">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
          <path d="M4 12a8 8 0 0113.7-5.7L20 8M20 4v4h-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M20 12a8 8 0 01-13.7 5.7L4 16M4 20v-4h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        Assets
      </button>
    </div>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: var(--space-20);
  height: 100%;
  min-height: 0;
}

/* unified white content board — locked to the screen, no scroll of its own
   (TASK Phase 1): the chips box, the Each stack and the picker list scroll
   locally instead. */
.board {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-32);
  display: flex;
  flex-direction: column;
  gap: var(--space-20);
}

/* control row */
.top {
  display: flex;
  align-items: center;
  gap: var(--space-16);
  flex-wrap: wrap;
}
/* mock: 660×38, 1px #E5E5E5 border, dark magnifier 18px from the right */
.search {
  position: relative;
  flex: 1 1 320px;
  max-width: 660px;
}
.search__input {
  width: 100%;
  height: 38px;
  padding: 0 44px 0 18px;
  border: 1px solid var(--color-bubble);
  border-radius: var(--radius-pill);
  background: var(--color-white);
  font-family: inherit;
  font-size: var(--fs-tab);
  color: var(--color-text);
  outline: none;
}
.search__input::placeholder {
  color: var(--color-grey);
}
.search__input:focus {
  border-color: var(--color-accent);
}
.search__icon {
  position: absolute;
  right: 18px;
  top: 50%;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  color: var(--color-text);
  pointer-events: none;
}
.search__icon svg {
  width: 16px;
  height: 16px;
}
.clear {
  border: none;
  background: none;
  padding: 0;
  margin-left: auto; /* mock: wide gap between the search box and Clear all */
  margin-right: 32px; /* nudge left of the tabs (mock: ~34px gap) */
  font-family: inherit;
  font-size: var(--fs-btn);
  color: var(--color-text);
}
.clear:hover {
  color: var(--color-accent);
}

/* segmented controls (Person/Item/Background + All/Each) — 38px tall (mock) */
.seg {
  display: inline-flex;
  background: var(--color-segment);
  border-radius: var(--radius-pill);
  padding: 3px;
}
.seg--tabs {
  flex: 0 1 530px;
}
.seg--mode {
  margin-left: auto;
}
.seg__btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: none;
  background: none;
  padding: 8px 22px;
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: var(--fs-tab);
  font-weight: 500;
  color: var(--color-grey);
  white-space: nowrap;
}
.seg__btn--on {
  background: var(--color-white);
  color: var(--color-text);
  box-shadow: var(--shadow-card);
}
.seg__ic {
  display: inline-grid;
  place-items: center;
}

/* middle: chips box + style panel, fixed share of the screen so the picker
   below always gets the remainder. */
.board__cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 32px;
  height: clamp(330px, 40vh, 460px);
  min-height: 0;
}

.board__picker {
  flex: 1;
  min-height: 0;
}

/* Assets (Cloudinary) — pinned to the board corner; the picker list keeps a
   bottom padding so the last row can scroll out from under it. */
.assets {
  position: absolute;
  right: var(--space-32);
  bottom: var(--space-20);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-white);
  box-shadow: 0 4px 14px rgba(31, 31, 31, 0.08);
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
}
.assets svg {
  color: var(--color-grey);
}
.assets:hover {
  border-color: var(--color-accent);
}

/* Narrow screens: the two columns stack and can never fit one screen, so the
   board falls back to scrolling as a whole. */
@media (max-width: 900px) {
  .board {
    overflow-y: auto;
  }
  .board__cols {
    grid-template-columns: 1fr;
    gap: var(--space-20);
    height: auto;
  }
  .board__picker {
    flex: 0 0 auto;
  }
}
</style>
