/**
 * Post-login redirect target ("?next=..." on /auth/google).
 *
 * An allowlist, never free-form: the value comes back from the browser through
 * a cookie, so anything unlisted must collapse to the Design home rather than
 * become an open redirect. One entry per portal zone in pages/login.vue —
 * "/game" was added with the Game module (TASK game-manager, Phase 1).
 *
 * Lives in lib/ (not routes/auth.ts) so it is unit-testable without pulling in
 * the OAuth config and its env validation.
 */
export const ALLOWED_NEXT: ReadonlySet<string> = new Set(["/", "/crm", "/game"]);

export function sanitizeNext(value: unknown): string {
  return typeof value === "string" && ALLOWED_NEXT.has(value) ? value : "/";
}
