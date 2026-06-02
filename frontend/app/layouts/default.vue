<script setup lang="ts">
// App shell (Phase 1): plain macaronka background + a centered, widened page
// container. The Figma design has no nav header — the top row of cards
// (logo, progress, user/logout, …) is built as TheToolbar in Phase 2 and
// rendered by the page inside <slot/>.
</script>

<template>
  <div class="shell">
    <main class="main">
      <div class="container">
        <slot />
      </div>
    </main>
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
  background: var(--color-bg);
}

.main {
  width: 100%;
}

.container {
  max-width: var(--container-width);
  margin: 0 auto;
  padding: var(--container-pad);
}

@media (max-width: 700px) {
  .container {
    padding: 16px;
  }
}
</style>
