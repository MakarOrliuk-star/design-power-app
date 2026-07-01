import VueKonva from "vue-konva";

// Konva touches the DOM/canvas, so this is a client-only plugin. Registers the
// global <v-stage>/<v-layer>/<v-image>/<v-rect>/<v-transformer> components used by
// the Scale window (ScalePanel.vue).
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.use(VueKonva);
});
