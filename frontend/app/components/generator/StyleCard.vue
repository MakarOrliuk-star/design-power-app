<script setup lang="ts">
// One "Style Title" reference card — used once in All mode and repeated per
// style in Each mode (see ReferencePanel). Static mock; Phase 7 binds real
// title / reference images / prompt.
defineProps<{ title: string; example: string }>();

const placeholders = [0, 1, 2];
const formats = [
  { label: "Image", icon: "image" },
  { label: "1:1", icon: "square" },
  { label: "9:16", icon: "portrait" },
] as const;
</script>

<template>
  <div class="style">
    <span class="style__label">{{ title }}</span>

    <div class="style__slots">
      <div v-for="p in placeholders" :key="p" class="slot">
        <span class="slot__badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none">
            <rect x="4" y="4" width="16" height="16" rx="3" stroke="currentColor" stroke-width="2" />
            <path d="M7 15l3-3 3 3 2-2 2 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </div>
    </div>

    <p class="style__example">
      Example:<br />
      {{ example }}
    </p>

    <div class="style__formats">
      <span v-for="f in formats" :key="f.label" class="fmt">
        <span class="fmt__ic" aria-hidden="true">
          <svg v-if="f.icon === 'image'" viewBox="0 0 24 24" width="13" height="13" fill="none">
            <rect x="3.5" y="5" width="17" height="14" rx="2.5" stroke="currentColor" stroke-width="1.6" />
            <circle cx="9" cy="10" r="1.4" stroke="currentColor" stroke-width="1.3" />
            <path d="M5 17l4.5-4 3.5 3 3-2.5L19 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else-if="f.icon === 'square'" viewBox="0 0 24 24" width="13" height="13" fill="none">
            <rect x="5" y="5" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.6" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="13" height="13" fill="none">
            <rect x="7" y="4" width="10" height="16" rx="2" stroke="currentColor" stroke-width="1.6" />
          </svg>
        </span>
        {{ f.label }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.style {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 18px;
  background: var(--color-white);
}
.style__label {
  font-size: 13px;
  color: var(--color-grey);
  margin-bottom: 14px;
}
.style__slots {
  display: flex;
  gap: 14px;
}
.slot {
  position: relative;
  width: 110px;
  height: 110px;
  border-radius: var(--radius-sm);
  background: var(--color-bubble);
}
.slot__badge {
  position: absolute;
  top: 6px;
  right: 6px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-xs);
  background: var(--color-text);
  color: var(--color-white);
}
.style__example {
  margin: 16px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--color-grey);
}
.style__formats {
  /* margin-top:auto pushes chips to the bottom when the card grows (All mode);
     in the compact Each cards it just sits after the example. */
  margin-top: auto;
  display: flex;
  gap: 10px;
  padding-top: 16px;
}
.fmt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: var(--radius-pill);
  background: var(--color-window);
  border: 1px solid var(--color-border);
  font-size: 12px;
  color: var(--color-grey);
}
.fmt__ic {
  display: inline-grid;
  place-items: center;
}
</style>
