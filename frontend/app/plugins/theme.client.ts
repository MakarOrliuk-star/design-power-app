// Apply the saved (or OS-preferred) theme as early as possible on the client.
export default defineNuxtPlugin(() => {
  useTheme().init();
});
