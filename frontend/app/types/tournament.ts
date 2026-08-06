/**
 * The one definition of a tournament prompt mode, mirroring the backend's
 * Prisma `TournamentMode` enum.
 *
 * It lives in app/types/ ON PURPOSE: Nuxt auto-imports every export of
 * composables/ and utils/ (and Pinia every export of stores/), so declaring the
 * same type name in two of those directories makes the build pick one and
 * silently ignore the other — a real trap once the two definitions drift.
 * Nothing under types/ is auto-imported, so this file can be the shared source
 * of truth without competing for a global name. Import it explicitly.
 */
export type TournamentMode = "BASE" | "VIP";
