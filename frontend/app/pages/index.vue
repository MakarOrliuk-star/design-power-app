<script setup lang="ts">
// Home — the Person/Item generator. Phase 3 builds the full selection UI and
// loads the catalog; the Run action (fal/nano-gpt) is wired in Phase 4.
useHead({ title: "Design Power — Home" });

const gen = useGeneratorStore();
onMounted(() => {
  if (!gen.loaded) gen.load();
});
</script>

<template>
  <div class="home">
    <div class="home__top">
      <GeneratorCurrentStyles />
      <GeneratorReferencePanel />
    </div>
    <GeneratorBrandPicker />
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.home__top {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
}
@media (max-width: 900px) {
  .home__top {
    grid-template-columns: 1fr;
  }
}
</style>
