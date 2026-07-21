<script setup lang="ts">
// Image Bundles — right-panel wizard, step 1 "Project setup"
// (figma/crm-bundle/start.PNG). Canonical asset sizes come from the bundle
// type config, not the static mock (D2). One brand toggle = both tone
// variants (D3/D7). Presets drop-down on prompt focus (D8).
import { ref, computed } from "vue";

const MAX_PROMPT = 1500;

const store = useBundlesStore();
const emit = defineEmits<{ (e: "launched", id: string): void }>();

const name = ref("");
const plannedSendAt = ref(""); // datetime-local value
const prompt = ref("");
const selectedBrands = ref<Set<string>>(new Set());
const brandSearch = ref("");
const includesOpen = ref(true);
const presetsOpen = ref(false);
const triedSubmit = ref(false);

const bundleType = computed(() => store.bundleTypes[0] ?? null);

const filteredBrands = computed(() => {
  const q = brandSearch.value.trim().toLowerCase();
  if (!q) return store.brands;
  return store.brands.filter((b) => b.displayName.toLowerCase().includes(q));
});

const nameError = computed(() => triedSubmit.value && !name.value.trim());
const brandsError = computed(() => triedSubmit.value && selectedBrands.value.size === 0);
const canSubmit = computed(() => !store.launching && store.metaReady);

function toggleBrand(key: string) {
  const next = new Set(selectedBrands.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  selectedBrands.value = next;
}

function applyPreset(text: string) {
  prompt.value = text.slice(0, MAX_PROMPT);
  presetsOpen.value = false;
}

function closePresetsSoon() {
  // Let the preset click land before the blur hides the list.
  setTimeout(() => (presetsOpen.value = false), 150);
}

function reset() {
  name.value = "";
  plannedSendAt.value = "";
  prompt.value = "";
  selectedBrands.value = new Set();
  brandSearch.value = "";
  triedSubmit.value = false;
}
defineExpose({ reset });

async function submit() {
  triedSubmit.value = true;
  if (!name.value.trim() || selectedBrands.value.size === 0 || !bundleType.value) return;
  const id = await store.createAndGenerate({
    name: name.value.trim(),
    plannedSendAt: plannedSendAt.value ? new Date(plannedSendAt.value).toISOString() : null,
    neuralPrompt: prompt.value,
    brandNames: [...selectedBrands.value],
    bundleTypeKey: bundleType.value.key,
  });
  if (id) {
    reset();
    emit("launched", id);
  }
}

const ASSET_ICONS: Record<string, string> = { email: "✉️", popup: "🪟", push: "🔔" };
</script>

<template>
  <section class="wizard">
    <!-- Stepper: 1 Project setup → 2 Customize → 3 Review & generate -->
    <header class="stepper">
      <div class="step step--active">
        <span class="step__num">1</span>
        <span class="step__text">
          <b>Project setup</b>
          <small>Define the basics</small>
        </span>
      </div>
      <span class="stepper__line" />
      <div class="step">
        <span class="step__num">2</span>
        <span class="step__text">
          <b>Customize</b>
          <small>Set style preferences</small>
        </span>
      </div>
      <span class="stepper__line" />
      <div class="step">
        <span class="step__num">3</span>
        <span class="step__text">
          <b>Review &amp; generate</b>
          <small>Confirm and generate</small>
        </span>
      </div>
    </header>

    <p v-if="store.metaError" class="wizard__error">
      Failed to load the wizard data.
      <button type="button" class="link" @click="store.fetchMeta()">Retry</button>
    </p>

    <div v-else class="wizard__body">
      <!-- Name + planned send date -->
      <div class="row row--two">
        <label class="field">
          <span class="field__label">Project name</span>
          <input
            v-model="name"
            type="text"
            class="field__input"
            :class="{ 'field__input--error': nameError }"
            placeholder="Enter project name"
            maxlength="200"
          />
          <small v-if="nameError" class="field__err">Project name is required</small>
        </label>
        <label class="field">
          <span class="field__label">Planned send date</span>
          <input v-model="plannedSendAt" type="datetime-local" class="field__input" />
        </label>
      </div>

      <!-- Bundle type (extensible — rendered from config, D2) -->
      <div class="field">
        <span class="field__label">Bundle type</span>
        <div v-if="bundleType" class="type-card">
          <span class="type-card__radio" aria-hidden="true" />
          <div class="type-card__main">
            <b class="type-card__title">{{ bundleType.title }}</b>
            <small class="type-card__desc">{{ bundleType.description }}</small>
          </div>
          <div v-if="includesOpen" class="type-card__includes">
            <span class="type-card__includes-label">Includes:</span>
            <span v-for="a in bundleType.assets" :key="a.key" class="include">
              <span class="include__icon">{{ ASSET_ICONS[a.key] ?? "🖼️" }}</span>
              <span class="include__text">
                <b>{{ a.label }}</b>
                <small>{{ a.width }}×{{ a.height }}</small>
              </span>
            </span>
          </div>
          <button
            type="button"
            class="type-card__chevron"
            :class="{ 'type-card__chevron--open': includesOpen }"
            :aria-label="includesOpen ? 'Hide includes' : 'Show includes'"
            @click="includesOpen = !includesOpen"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
              <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
        <p v-else class="field__hint">Loading bundle types…</p>
      </div>

      <!-- Neural network prompt + presets (D8) -->
      <div class="field field--prompt">
        <span class="field__label">Neural network prompt <span class="field__info" title="Used as the campaign brief for every brand variant">ⓘ</span></span>
        <textarea
          v-model="prompt"
          class="field__input field__textarea"
          rows="4"
          :maxlength="MAX_PROMPT"
          placeholder="Describe your campaign and what the mailing is about."
          @focus="presetsOpen = true"
          @blur="closePresetsSoon"
        />
        <div v-if="presetsOpen && store.presets.length" class="presets">
          <span class="presets__title">Suggested prompts</span>
          <button
            v-for="p in store.presets"
            :key="p.id"
            type="button"
            class="presets__item"
            @mousedown.prevent="applyPreset(p.text)"
          >
            <b>{{ p.title }}</b>
            <small>{{ p.text }}</small>
          </button>
        </div>
        <div class="field__foot">
          <small class="field__hint">Be specific about the offer, audience, tone and key message. The more detail you provide, the better the results.</small>
          <small class="field__counter">{{ prompt.length }} / {{ MAX_PROMPT }}</small>
        </div>
      </div>

      <!-- Select brands: one toggle covers (Men)+(Women), D3 -->
      <div class="field">
        <div class="brands-head">
          <span>
            <span class="field__label">Select brands</span>
            <small class="field__hint">Choose the brands and tone of voice variants to include in this bundle.</small>
          </span>
          <span class="brands-search">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.6" />
              <path d="M16 16l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
            <input v-model="brandSearch" type="text" placeholder="Search brands" />
          </span>
        </div>
        <small v-if="brandsError" class="field__err">Select at least one brand</small>
        <div class="brands-grid">
          <label v-for="b in filteredBrands" :key="b.key" class="brand">
            <span class="brand__avatar">{{ b.displayName.slice(0, 1).toUpperCase() }}</span>
            <span class="brand__name" :title="b.variants.map((v) => v.displayName).join(', ')">{{ b.displayName }}</span>
            <input
              type="checkbox"
              class="brand__input"
              :checked="selectedBrands.has(b.key)"
              @change="toggleBrand(b.key)"
            />
            <span class="brand__toggle" aria-hidden="true" />
          </label>
          <p v-if="store.metaReady && filteredBrands.length === 0" class="field__hint">No brands found.</p>
        </div>
      </div>

      <p v-if="store.launchError" class="wizard__error">
        {{ store.launchError === "queue_unavailable" ? "Generation queue is unavailable — try again later." : "Failed to launch the bundle." }}
      </p>

      <button class="btn-generate" type="button" :disabled="!canSubmit" @click="submit">
        <span v-if="store.launching" class="btn-generate__spinner" aria-hidden="true" />
        <template v-else>✨</template>
        Generate bundle
      </button>
    </div>
  </section>
</template>

<style scoped>
.wizard {
  display: flex;
  flex-direction: column;
  gap: 18px;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  padding: 22px;
  min-height: 0;
  overflow-y: auto;
}

/* Stepper */
.stepper {
  display: flex;
  align-items: center;
  gap: 14px;
}
.stepper__line {
  flex: 1;
  height: 1px;
  background: var(--color-border);
}
.step {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--color-grey);
}
.step__num {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid var(--color-border);
  font-size: 13px;
  font-weight: 600;
}
.step--active {
  color: var(--color-text);
}
.step--active .step__num {
  background: var(--gradient-active, var(--color-accent));
  border: none;
  color: #fff;
}
.step__text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}
.step__text b {
  font-size: 13px;
}
.step__text small {
  font-size: 11px;
  color: var(--color-grey);
}

.wizard__body {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.wizard__error {
  margin: 0;
  color: var(--color-stop-hover);
  font-size: 13px;
}
.wizard__error .link,
.link {
  border: none;
  background: none;
  color: var(--color-accent);
  cursor: pointer;
  font-size: inherit;
}

.row--two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: relative;
}
.field__label {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}
.field__info {
  color: var(--color-grey);
  cursor: help;
  font-weight: 400;
}
.field__input {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text);
  font-size: 13px;
  padding: 10px 12px;
  outline: none;
  font-family: inherit;
}
.field__input:focus {
  border-color: var(--color-accent);
}
.field__input--error {
  border-color: var(--color-stop);
}
.field__textarea {
  resize: vertical;
  min-height: 88px;
}
.field__foot {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.field__hint {
  font-size: 11px;
  color: var(--color-grey);
}
.field__counter {
  font-size: 11px;
  color: var(--color-grey);
  white-space: nowrap;
}
.field__err {
  font-size: 11px;
  color: var(--color-stop-hover);
}

/* Bundle type card */
.type-card {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-md);
  padding: 14px;
}
.type-card__radio {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 5px solid var(--color-accent);
  flex: 0 0 auto;
}
.type-card__main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.type-card__title {
  font-size: 13.5px;
  color: var(--color-text);
}
.type-card__desc {
  font-size: 11.5px;
  color: var(--color-grey);
}
.type-card__includes {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.type-card__includes-label {
  font-size: 11px;
  color: var(--color-grey);
}
.include {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
}
.include__icon {
  font-size: 15px;
}
.include__text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}
.include__text b {
  font-size: 11.5px;
  color: var(--color-text);
}
.include__text small {
  font-size: 10px;
  color: var(--color-grey);
}
.type-card__chevron {
  border: none;
  background: none;
  color: var(--color-grey);
  cursor: pointer;
  transition: transform 0.15s ease;
}
.type-card__chevron--open {
  transform: rotate(180deg);
}

/* Presets dropdown */
.presets {
  position: absolute;
  z-index: 5;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: 4px;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 240px;
  overflow-y: auto;
}
.presets__title {
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-grey);
  padding: 4px 8px;
}
.presets__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
  border: none;
  background: none;
  border-radius: var(--radius-sm);
  padding: 8px;
  cursor: pointer;
}
.presets__item:hover {
  background: var(--color-segment);
}
.presets__item b {
  font-size: 12.5px;
  color: var(--color-text);
}
.presets__item small {
  font-size: 11px;
  color: var(--color-grey);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Brands grid */
.brands-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.brands-head > span:first-child {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.brands-search {
  display: flex;
  align-items: center;
  gap: 7px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  padding: 7px 12px;
  color: var(--color-grey);
  flex: 0 0 auto;
}
.brands-search input {
  border: none;
  outline: none;
  background: none;
  font-size: 12.5px;
  color: var(--color-text);
  width: 150px;
}
.brands-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 10px;
  max-height: 300px;
  overflow-y: auto;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  cursor: pointer;
}
.brand__avatar {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--color-segment);
  color: var(--color-text);
  font-size: 12px;
  font-weight: 700;
  flex: 0 0 auto;
}
.brand__name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.brand__input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.brand__toggle {
  width: 34px;
  height: 20px;
  border-radius: var(--radius-pill);
  background: var(--color-segment);
  position: relative;
  flex: 0 0 auto;
  transition: background 0.15s ease;
}
.brand__toggle::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transition: transform 0.15s ease;
}
.brand__input:checked + .brand__toggle {
  background: var(--gradient-active, var(--color-accent));
}
.brand__input:checked + .brand__toggle::after {
  transform: translateX(14px);
}

/* Generate button */
.btn-generate {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: none;
  cursor: pointer;
  border-radius: var(--radius-md);
  padding: 13px;
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  background: var(--gradient-active, var(--color-accent));
}
.btn-generate:hover {
  filter: brightness(1.06);
}
.btn-generate:disabled {
  opacity: 0.6;
  cursor: default;
}
.btn-generate__spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 1100px) {
  .row--two {
    grid-template-columns: 1fr;
  }
  .type-card {
    flex-wrap: wrap;
  }
  .type-card__includes {
    margin-left: 28px;
  }
}
</style>
