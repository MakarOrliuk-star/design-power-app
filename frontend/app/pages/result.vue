<script setup lang="ts">
// Result gallery — the current user's completed generations (per-user isolated
// on the backend), newest first, paginated. Mirrors the legacy Result page.
useHead({ title: "Design Power — Result" });

interface GalleryImage {
  id: string;
  brandName: string;
  theme: string | null;
  description: string | null;
  generatedImageUrl: string;
  actionType: string;
  createdAt: string;
}

const api = useApi();
const images = ref<GalleryImage[]>([]);
const total = ref(0);
const hasMore = ref(false);
const loading = ref(false);
const brand = ref("");
const LIMIT = 50;

async function load(reset = true) {
  loading.value = true;
  try {
    const offset = reset ? 0 : images.value.length;
    const res = await api<{ images: GalleryImage[]; total: number; hasMore: boolean }>(
      "/api/generations",
      { query: { limit: LIMIT, offset, ...(brand.value ? { brand: brand.value } : {}) } },
    );
    images.value = reset ? res.images : [...images.value, ...res.images];
    total.value = res.total;
    hasMore.value = res.hasMore;
  } finally {
    loading.value = false;
  }
}

onMounted(() => load());
</script>

<template>
  <div class="result">
    <header class="result__head">
      <h1>Result</h1>
      <div class="filters">
        <input
          v-model="brand"
          class="filter-input"
          placeholder="Фильтр по бренду…"
          @keyup.enter="load()"
        />
        <button class="btn" @click="load()">Обновить</button>
      </div>
    </header>

    <p class="count">{{ total }} изображений</p>

    <div v-if="images.length" class="grid">
      <a
        v-for="img in images"
        :key="img.id"
        :href="img.generatedImageUrl"
        target="_blank"
        rel="noopener"
        class="card"
      >
        <img :src="img.generatedImageUrl" :alt="img.brandName" loading="lazy" />
        <div class="card__meta">
          <span class="card__brand">{{ img.brandName }}</span>
          <span class="card__theme">{{ img.theme }}</span>
        </div>
      </a>
    </div>
    <p v-else-if="!loading" class="empty">
      Пока нет готовых изображений. Запустите генерацию на странице Home.
    </p>

    <div v-if="hasMore" class="more">
      <button class="btn" :disabled="loading" @click="load(false)">Показать ещё</button>
    </div>
  </div>
</template>

<style scoped>
.result {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.result__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
h1 {
  margin: 0;
}
.filters {
  display: flex;
  gap: 8px;
}
.filter-input {
  padding: 8px 14px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-white);
}
.btn {
  border: 1px solid var(--color-border);
  background: var(--color-white);
  border-radius: var(--radius-sm);
  padding: 8px 16px;
  font-weight: 500;
}
.btn:hover {
  background: var(--color-bubble);
}
.count {
  color: var(--color-grey);
  margin: 0;
  font-size: 14px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
}
.card {
  background: var(--color-window);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.card img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  background: var(--color-bubble);
}
.card__meta {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.card__brand {
  font-weight: 600;
  font-size: 14px;
}
.card__theme {
  color: var(--color-grey);
  font-size: 12px;
}
.empty {
  color: var(--color-grey);
}
.more {
  display: flex;
  justify-content: center;
  padding: 16px 0;
}
</style>
