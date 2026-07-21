<script setup lang="ts">
// Image Bundles — left "Projects" panel (figma/crm-bundle/start.PNG, D1: no
// Scheduled tab). Search + status tabs + cards + pagination live in the store.
import { ref, computed, watch } from "vue";
import type { BundleListItem, StatusFilter } from "~/stores/bundles";

const emit = defineEmits<{ (e: "new"): void; (e: "select", bundle: BundleListItem): void }>();
const props = defineProps<{ selectedId?: string | null }>();

const store = useBundlesStore();

const TABS: Array<{ key: StatusFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "draft", label: "Draft" },
  { key: "generating", label: "Generating" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  generating: "Generating",
  completed: "Completed",
  failed: "Failed",
};

// Debounced search → store (mock: "Search projects").
const searchInput = ref(store.search);
let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(searchInput, (value) => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => store.setSearch(value), 300);
});

const rangeLabel = computed(() => {
  if (store.total === 0) return "0 of 0";
  const from = (store.page - 1) * store.pageSize + 1;
  const to = Math.min(store.page * store.pageSize, store.total);
  return `${from}–${to} of ${store.total}`;
});

// Windowed page numbers (mock shows 1 / 2 / 3).
const pageNumbers = computed(() => {
  const totalPages = store.totalPages;
  const current = store.page;
  const start = Math.max(1, Math.min(current - 1, totalPages - 2));
  return Array.from({ length: Math.min(3, totalPages) }, (_, i) => start + i);
});

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
</script>

<template>
  <aside class="projects">
    <header class="projects__head">
      <h2 class="projects__title">
        Projects <span class="projects__count">{{ store.counts.all }}</span>
      </h2>
      <button class="btn-new" type="button" @click="emit('new')">+ New bundle</button>
    </header>

    <div class="projects__search">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.6" />
        <path d="M16 16l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
      <input v-model="searchInput" type="text" placeholder="Search projects" />
    </div>

    <div class="projects__tabs">
      <button
        v-for="tab in TABS"
        :key="tab.key"
        type="button"
        class="tab"
        :class="{ 'tab--active': store.statusFilter === tab.key }"
        @click="store.setFilter(tab.key)"
      >
        {{ tab.label }}
      </button>
    </div>

    <div class="projects__list">
      <p v-if="store.listError" class="projects__empty projects__empty--error">
        Failed to load projects.
        <button type="button" class="link" @click="store.fetchList()">Retry</button>
      </p>
      <p v-else-if="!store.listLoading && store.bundles.length === 0" class="projects__empty">
        {{ store.search || store.statusFilter !== "all" ? "Nothing found." : "No projects yet — create the first bundle." }}
      </p>

      <article
        v-for="b in store.bundles"
        :key="b.id"
        class="card"
        :class="{ 'card--selected': b.id === props.selectedId }"
        @click="emit('select', b)"
      >
        <div class="card__main">
          <h3 class="card__name">{{ b.name }}</h3>
          <p class="card__brands">{{ b.brandLabels.join(", ") || "—" }}</p>
        </div>
        <div class="card__meta">
          <span class="card__date">{{ formatDate(b.createdAt) }}</span>
          <span class="card__time">{{ formatTime(b.createdAt) }}</span>
        </div>
        <span class="badge" :class="`badge--${b.status}`">{{ STATUS_LABEL[b.status] }}</span>
        <span v-if="b.status === 'generating'" class="spinner" aria-label="Generating" />
        <svg v-else class="card__chevron" viewBox="0 0 24 24" width="16" height="16" fill="none">
          <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </article>
    </div>

    <footer v-if="store.total > 0" class="projects__foot">
      <span class="projects__range">{{ rangeLabel }}</span>
      <div class="pager">
        <button type="button" class="pager__btn" :disabled="store.page <= 1" @click="store.setPage(store.page - 1)">‹</button>
        <button
          v-for="n in pageNumbers"
          :key="n"
          type="button"
          class="pager__btn"
          :class="{ 'pager__btn--active': n === store.page }"
          @click="store.setPage(n)"
        >
          {{ n }}
        </button>
        <button type="button" class="pager__btn" :disabled="store.page >= store.totalPages" @click="store.setPage(store.page + 1)">›</button>
      </div>
    </footer>
  </aside>
</template>

<style scoped>
.projects {
  display: flex;
  flex-direction: column;
  gap: 14px;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  padding: 20px;
  min-height: 0;
}
.projects__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.projects__title {
  margin: 0;
  font-size: 19px;
  font-weight: 700;
  color: var(--color-text);
  display: flex;
  align-items: center;
  gap: 8px;
}
.projects__count {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-grey);
  background: var(--color-segment);
  border-radius: var(--radius-pill);
  padding: 2px 8px;
}
.btn-new {
  border: none;
  cursor: pointer;
  border-radius: var(--radius-sm);
  padding: 9px 14px;
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  background: var(--gradient-active, var(--color-accent));
}
.btn-new:hover {
  filter: brightness(1.06);
}

.projects__search {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  padding: 8px 14px;
  color: var(--color-grey);
}
.projects__search input {
  flex: 1;
  border: none;
  outline: none;
  background: none;
  font-size: 13px;
  color: var(--color-text);
}

.projects__tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.tab {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--color-grey);
  padding: 6px 10px;
  border-radius: var(--radius-pill);
}
.tab--active {
  background: var(--color-text);
  color: var(--color-white);
  font-weight: 600;
}

.projects__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.projects__empty {
  color: var(--color-grey);
  font-size: 13px;
  text-align: center;
  padding: 24px 0;
}
.projects__empty--error .link {
  border: none;
  background: none;
  color: var(--color-accent);
  cursor: pointer;
  font-size: 13px;
}

.card {
  display: grid;
  grid-template-columns: 1fr auto auto auto;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.card:hover {
  border-color: var(--color-accent);
}
.card--selected {
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 6%, transparent);
}
.card__main {
  min-width: 0;
}
.card__name {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.card__brands {
  margin: 3px 0 0;
  font-size: 11.5px;
  color: var(--color-grey);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.card__meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  font-size: 11px;
  color: var(--color-grey);
  white-space: nowrap;
}
.card__chevron {
  color: var(--color-grey);
}

.badge {
  font-size: 10.5px;
  font-weight: 600;
  border-radius: var(--radius-pill);
  padding: 3px 9px;
  white-space: nowrap;
}
.badge--draft {
  background: var(--color-segment);
  color: var(--color-grey);
}
.badge--generating {
  background: #e0edff;
  color: #2563eb;
}
.badge--completed {
  background: #dcfce7;
  color: #16a34a;
}
.badge--failed {
  background: #fee2e2;
  color: #dc2626;
}
:global(.dark) .badge--generating { background: rgba(37, 99, 235, 0.18); }
:global(.dark) .badge--completed { background: rgba(22, 163, 74, 0.18); }
:global(.dark) .badge--failed { background: rgba(220, 38, 38, 0.18); }

.spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-accent);
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

.projects__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.projects__range {
  font-size: 11.5px;
  color: var(--color-grey);
}
.pager {
  display: flex;
  gap: 4px;
}
.pager__btn {
  min-width: 26px;
  height: 26px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text);
  font-size: 12px;
  cursor: pointer;
}
.pager__btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.pager__btn--active {
  background: var(--color-text);
  color: var(--color-white);
  border-color: var(--color-text);
}
</style>
