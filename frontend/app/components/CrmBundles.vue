<script setup lang="ts">
// Image Bundles — screen container (TASK crm-bundle Phases 3+5).
// Wizard view (start.PNG): Projects list | 3-step wizard.
// Result view (result.PNG): Projects list | bundle result | Generation summary.
// Assets render dynamically while generating (store polling every 4s).
import { ref, computed, onMounted, onUnmounted } from "vue";
import type { BundleListItem } from "~/stores/bundles";

const store = useBundlesStore();

// "refs" — управление вариациями и референсами (TASK ai-reference, DI-R12):
// доступно всем, кто прошёл requireCrmSuper (CRM_SUPER / ADMIN / MANAGER).
type RightPane = "wizard" | "result" | "refs";
const pane = ref<RightPane>("wizard");

const selectedId = computed(() => (pane.value === "result" ? store.selected?.id ?? null : null));

function openWizard() {
  store.clearSelected();
  pane.value = "wizard";
}

function openRefs() {
  store.clearSelected();
  pane.value = "refs";
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
    <div class="bundles__left">
      <button
        class="refsbtn"
        type="button"
        :class="{ 'refsbtn--on': pane === 'refs' }"
        title="Вариации и референсы для AI-композиции"
        @click="pane === 'refs' ? openWizard() : openRefs()"
      >
        ⚙ Референсы и вариации
      </button>
      <BundlesProjectList :selected-id="selectedId" @new="openWizard" @select="selectBundle" />
    </div>

    <BundlesBundleWizard v-if="pane === 'wizard'" @launched="onLaunched" />

    <BundlesRefsManager v-else-if="pane === 'refs'" />

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

.bundles__left {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.refsbtn {
  border: 1px solid var(--color-border);
  background: var(--color-white);
  color: var(--color-text);
  border-radius: var(--radius-md);
  padding: 9px 12px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
}
.refsbtn:hover {
  border-color: var(--color-accent);
}
.refsbtn--on {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 1px var(--color-accent);
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
