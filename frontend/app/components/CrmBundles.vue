<script setup lang="ts">
// Image Bundles — screen container (TASK crm-bundle Phases 3+5).
// Wizard view (start.PNG): Projects list | 3-step wizard.
// Result view (result.PNG): Projects list | bundle result | Generation summary.
// Assets render dynamically while generating (store polling every 4s).
import { ref, computed, onMounted, onUnmounted } from "vue";
import type { BundleListItem } from "~/stores/bundles";

const store = useBundlesStore();

type RightPane = "wizard" | "result";
const pane = ref<RightPane>("wizard");

const selectedId = computed(() => (pane.value === "result" ? store.selected?.id ?? null : null));

function openWizard() {
  store.clearSelected();
  pane.value = "wizard";
}

async function selectBundle(b: BundleListItem) {
  pane.value = "result";
  await store.fetchDetails(b.id);
}

async function onLaunched(id: string) {
  pane.value = "result";
  await store.fetchDetails(id);
}

onMounted(() => {
  void store.fetchList();
  void store.fetchMeta();
  store.ensurePolling();
});
onUnmounted(() => store.stopPolling());
</script>

<template>
  <div class="bundles" :class="{ 'bundles--result': pane === 'result' && store.selected }">
    <BundlesProjectList :selected-id="selectedId" @new="openWizard" @select="selectBundle" />

    <BundlesBundleWizard v-if="pane === 'wizard'" @launched="onLaunched" />

    <template v-else-if="store.selected">
      <BundlesBundleResult />
      <BundlesGenerationSummary />
    </template>

    <section v-else class="fallback">
      <p v-if="store.selectedLoading">Loading…</p>
      <p v-else>
        Проект не найден.
        <button class="link" type="button" @click="openWizard">← New bundle</button>
      </p>
    </section>
  </div>
</template>

<style scoped>
.bundles {
  display: grid;
  grid-template-columns: minmax(320px, 380px) 1fr;
  gap: 20px;
  align-items: start;
  min-height: 0;
}
.bundles--result {
  grid-template-columns: minmax(300px, 350px) 1fr minmax(250px, 290px);
}
@media (max-width: 1280px) {
  .bundles--result {
    grid-template-columns: minmax(280px, 320px) 1fr;
  }
  .bundles--result > :last-child {
    grid-column: 2;
  }
}
@media (max-width: 980px) {
  .bundles,
  .bundles--result {
    grid-template-columns: 1fr;
  }
  .bundles--result > :last-child {
    grid-column: auto;
  }
}

.fallback {
  display: grid;
  place-items: center;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 48px;
  color: var(--color-grey);
  font-size: 13px;
}
.link {
  border: none;
  background: none;
  color: var(--color-accent);
  cursor: pointer;
  font-size: inherit;
}
</style>
