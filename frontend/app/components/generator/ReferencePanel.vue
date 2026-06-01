<script setup lang="ts">
import type { ContentTab } from "~/stores/generator";

const gen = useGeneratorStore();

const tabs: { id: ContentTab; label: string }[] = [
  { id: "PERSON", label: "Person" },
  { id: "ITEM", label: "Item" },
  { id: "BACKGROUND", label: "Background" },
];

const imageOptions = [1, 2, 3, 4];
const fileInput = ref<HTMLInputElement | null>(null);

function pickRefs() {
  fileInput.value?.click();
}

async function onRefFiles(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  for (const file of files.slice(0, 3 - gen.refImages.length)) {
    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
    gen.refImages.push(dataUrl);
  }
  input.value = "";
}

function removeRef(i: number) {
  gen.refImages.splice(i, 1);
}
</script>

<template>
  <section class="panel">
    <header class="panel__head">
      <h2>References &amp; Prompt</h2>
      <div class="mode">
        <button
          :class="['mode__btn', { 'mode__btn--active': gen.refMode === 'ALL' }]"
          @click="gen.refMode = 'ALL'"
        >
          All
        </button>
        <button
          :class="['mode__btn', { 'mode__btn--active': gen.refMode === 'EACH' }]"
          @click="gen.refMode = 'EACH'"
        >
          Each
        </button>
      </div>
    </header>

    <div class="tabs">
      <button
        v-for="t in tabs"
        :key="t.id"
        :class="['tab', { 'tab--active': gen.activeTab === t.id }]"
        @click="gen.activeTab = t.id"
      >
        {{ t.label }}
      </button>
    </div>

    <p v-if="gen.activeTab === 'BACKGROUND'" class="hint">
      Background-генерация будет добавлена позже.
    </p>

    <!-- Reference upload (Person only) -->
    <template v-if="gen.activeTab === 'PERSON'">
      <div class="refs">
        <div v-for="(img, i) in gen.refImages" :key="i" class="ref-slot ref-slot--filled">
          <img :src="img" alt="ref" />
          <button class="ref-slot__x" @click="removeRef(i)">×</button>
        </div>
        <button v-if="gen.refImages.length < 3" class="ref-slot" @click="pickRefs">+</button>
      </div>
      <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="onRefFiles" />
    </template>

    <!-- Prompt -->
    <template v-if="gen.refMode === 'ALL'">
      <textarea
        v-model="gen.prompt"
        class="prompt"
        rows="3"
        placeholder="Example: Neon casino banner, purple & gold"
      />
    </template>
    <template v-else>
      <p v-if="!gen.currentTargets.length" class="hint">
        Выберите {{ gen.isItem ? "стили" : "бренды" }} — для каждого появится отдельное поле промпта.
      </p>
      <div v-else class="each-list">
        <div v-for="t in gen.currentTargets" :key="t.key" class="each-row">
          <span class="each-row__name">{{ t.label }}</span>
          <input
            v-model="gen.targetPrompts[t.key]"
            class="each-row__input"
            :placeholder="gen.isItem ? 'Промпт для стиля…' : 'Промпт для бренда…'"
          />
        </div>
      </div>
    </template>

    <footer class="panel__foot">
      <select v-model="gen.themeId" class="select" title="Тема">
        <option v-if="!gen.themes.length" value="">Нет тем (нужен seed)</option>
        <option v-for="t in gen.themes" :key="t.id" :value="t.id">{{ t.name }}</option>
      </select>

      <select v-model.number="gen.imageCount" class="select">
        <option v-for="n in imageOptions" :key="n" :value="n">{{ n }} image</option>
      </select>

      <button v-if="gen.isRunning" class="stop" @click="gen.stop()">■ Stop</button>
      <button v-else class="run" :disabled="!gen.canRun" @click="gen.submit()">
        {{ gen.submitting ? "…" : "▶ Run" }}
      </button>
    </footer>

    <p v-if="gen.statusError" class="error">{{ gen.statusError }}</p>

    <!-- Progress -->
    <div v-if="gen.batchStatus" class="progress">
      <div class="progress__bar">
        <div class="progress__fill" :style="{ width: gen.batchStatus.progress + '%' }" />
      </div>
      <span class="progress__label">
        {{ gen.batchStatus.completed }}/{{ gen.batchStatus.total }} готово
        <template v-if="gen.batchStatus.failed">· {{ gen.batchStatus.failed }} ошибок</template>
        <template v-if="gen.batchStatus.isComplete"> · завершено</template>
      </span>
    </div>
  </section>
</template>

<style scoped>
.panel {
  background: var(--color-window);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 20px;
  min-height: 280px;
  display: flex;
  flex-direction: column;
}
.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
h2 {
  margin: 0;
  font-size: 16px;
}
.mode {
  display: inline-flex;
  background: var(--color-bubble);
  border-radius: 999px;
  padding: 2px;
}
.mode__btn {
  border: none;
  background: none;
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 13px;
  color: var(--color-grey);
}
.mode__btn--active {
  background: var(--color-white);
  color: var(--color-text);
}
.tabs {
  display: flex;
  gap: 4px;
  background: var(--color-bubble);
  border-radius: var(--radius-md);
  padding: 4px;
  margin-bottom: 16px;
}
.tab {
  flex: 1;
  border: none;
  background: none;
  padding: 8px;
  border-radius: var(--radius-sm);
  font-weight: 500;
  color: var(--color-grey);
}
.tab--active {
  background: var(--color-white);
  color: var(--color-text);
}
.refs {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}
.ref-slot {
  position: relative;
  width: 64px;
  height: 64px;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm);
  display: grid;
  place-items: center;
  color: var(--color-grey);
  background: var(--color-white);
  font-size: 20px;
}
.ref-slot--filled {
  border-style: solid;
  overflow: hidden;
}
.ref-slot--filled img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ref-slot__x {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: var(--color-stop);
  color: #fff;
  line-height: 1;
}
.prompt,
.each-row__input {
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  font-family: inherit;
  font-size: 14px;
  resize: vertical;
  background: var(--color-white);
}
.each-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 180px;
  overflow-y: auto;
}
.each-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.each-row__name {
  flex: 0 0 140px;
  font-size: 13px;
  font-weight: 500;
}
.hint {
  color: var(--color-grey);
  font-size: 13px;
}
.panel__foot {
  margin-top: auto;
  display: flex;
  gap: 10px;
  align-items: center;
  padding-top: 16px;
}
.select {
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-white);
  font-size: 14px;
}
.run,
.stop {
  margin-left: auto;
  border: none;
  border-radius: var(--radius-md);
  padding: 10px 28px;
  font-weight: 600;
  color: var(--color-white);
}
.run {
  background: var(--gradient-active);
}
.run:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.stop {
  background: var(--color-stop);
}
.stop:hover {
  background: var(--color-stop-hover);
}
.error {
  margin: 12px 0 0;
  color: var(--color-stop-hover);
  font-size: 13px;
}
.progress {
  margin-top: 14px;
}
.progress__bar {
  height: 8px;
  background: var(--color-bubble);
  border-radius: 999px;
  overflow: hidden;
}
.progress__fill {
  height: 100%;
  background: var(--gradient-active);
  transition: width 0.4s ease;
}
.progress__label {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-grey);
}
</style>
