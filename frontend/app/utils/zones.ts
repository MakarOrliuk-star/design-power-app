/**
 * Zone model — the single source of truth for "who may go where" on the client.
 *
 * Three zones since the Game module (TASK game-manager, Phase 1): Design, CRM
 * and Game. Both the route guard (middleware/auth.global.ts) and the session
 * store (stores/auth.ts) read from here, so the rules can't drift apart — and
 * being free of Nuxt runtime imports, the whole role × route matrix is unit
 * testable (tests/gameZone.test.ts).
 *
 * Mirrors the backend guards: requireZone("DESIGNER"), requireZone("CRM") and
 * requireGameZone in middleware/auth.ts. The backend is the real wall; this
 * layer exists so users see /forbidden instead of a broken page.
 */

export type AppRole =
  | "ADMIN"
  | "DESIGNER"
  | "CRM"
  | "MANAGER"
  | "SUPER_DESIGNER"
  | "CRM_SUPER"
  | "GAME_MANAGER";

export type Zone = "design" | "crm" | "game";

/**
 * Which roles reach which zone.
 *
 * ADMIN and MANAGER pass everywhere. SUPER_DESIGNER is a Design-zone role and
 * CRM_SUPER a CRM-zone one. GAME_MANAGER appears in `game` ONLY — that single
 * omission is the Q2 wall keeping it out of both Design and CRM.
 */
const ZONE_ROLES: Record<Zone, ReadonlySet<AppRole>> = {
  design: new Set<AppRole>(["ADMIN", "MANAGER", "DESIGNER", "SUPER_DESIGNER"]),
  crm: new Set<AppRole>(["ADMIN", "MANAGER", "CRM", "CRM_SUPER"]),
  // Q1, variant «б» — everyone with a Design-side role plus the dedicated one.
  game: new Set<AppRole>(["ADMIN", "MANAGER", "DESIGNER", "SUPER_DESIGNER", "GAME_MANAGER"]),
};

/**
 * The zone a route belongs to. Unrecognised paths fall back to Design — that
 * was the behaviour before the Game module and keeps new Design pages guarded
 * by default rather than open.
 */
export function zoneOf(path: string): Zone {
  if (path.startsWith("/crm")) return "crm";
  if (path.startsWith("/game")) return "game";
  return "design";
}

export function canEnterZone(role: AppRole | null | undefined, zone: Zone): boolean {
  return role != null && ZONE_ROLES[zone].has(role);
}

/** /admin — ADMIN sees everything, MANAGER only the Tournaments section. */
export function canAdminPanel(role: AppRole | null | undefined): boolean {
  return role === "ADMIN" || role === "MANAGER";
}

/** /library + the Create-a-New-Style surface (TASK super-designer). */
export function canCreateStyles(role: AppRole | null | undefined): boolean {
  return role === "SUPER_DESIGNER" || role === "ADMIN" || role === "MANAGER";
}

/** Routes reachable without a session. */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/login"]);

/**
 * The whole route decision as a pure function: where to redirect, or null to
 * let the navigation through. middleware/auth.global.ts is a thin wrapper over
 * this so the matrix below is what actually ships.
 *
 * `role` is null for an anonymous visitor.
 */
export function guardRoute(path: string, role: AppRole | null | undefined): string | null {
  if (PUBLIC_PATHS.has(path)) return null; // /login doubles as the portal
  if (role == null) return "/login";
  if (path === "/forbidden") return null; // exempt, or it would bounce itself

  if (path.startsWith("/admin") && !canAdminPanel(role)) return "/forbidden";
  if (path.startsWith("/library") && !canCreateStyles(role)) return "/forbidden";
  if (!canEnterZone(role, zoneOf(path))) return "/forbidden";
  return null;
}
