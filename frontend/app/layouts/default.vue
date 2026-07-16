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
    <AppToasts />
    <!-- Super-designer: Create a New Style / edit-brand modal (global, opens
         from the toolbar user menu and from the Library page). -->
    <SuperDesignerStyleModal />
  </div>
</template>

<style scoped>
/* SPA shell — locked to exactly one screen. No document-level scroll; pages
   put their own local scroll on the inner container that needs it. */
.shell {
  height: 100dvh;
  overflow: hidden;
  background: var(--color-bg);
}

.main {
  height: 100%;
  display: flex;
  justify-content: center;
}

.container {
  width: 100%;
  max-width: var(--container-width);
  height: 100%;
  padding: var(--container-pad);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

@media (max-width: 700px) {
  .container {
    padding: 16px;
  }
}
</style>
