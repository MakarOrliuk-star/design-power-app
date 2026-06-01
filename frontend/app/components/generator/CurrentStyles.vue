<script setup lang="ts">
const gen = useGeneratorStore();
</script>

<template>
  <section class="panel">
    <header class="panel__head">
      <h2>Current styles</h2>
      <button v-if="gen.currentTargets.length" class="clear" @click="gen.clearAll()">
        Clear all
      </button>
    </header>

    <div v-if="gen.currentTargets.length" class="chips">
      <span v-for="t in gen.currentTargets" :key="t.key" class="chip">
        {{ t.label }}
        <button class="chip__x" title="Убрать" @click="gen.removeTarget(t.key)">×</button>
      </span>
    </div>
    <p v-else class="empty">
      {{ gen.isItem ? "Выберите стили ниже — они появятся здесь." : "Выберите бренды ниже — они появятся здесь." }}
    </p>
  </section>
</template>

<style scoped>
.panel {
  background: var(--color-window);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 20px;
  min-height: 280px;
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
.clear {
  border: none;
  background: none;
  color: var(--color-grey);
  font-weight: 500;
}
.clear:hover {
  color: var(--color-text);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px 6px 14px;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  font-size: 14px;
}
.chip__x {
  border: none;
  background: var(--color-bubble);
  border-radius: 50%;
  width: 18px;
  height: 18px;
  line-height: 1;
  color: var(--color-grey);
}
.chip__x:hover {
  background: var(--color-stop);
  color: var(--color-white);
}
.empty {
  color: var(--color-grey);
  font-size: 14px;
}
</style>
