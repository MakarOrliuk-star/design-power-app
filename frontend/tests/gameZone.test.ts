import { describe, it, expect } from "vitest";
import {
  guardRoute,
  zoneOf,
  canEnterZone,
  type AppRole,
  type Zone,
} from "~/utils/zones";

/**
 * FE Test — the route guard as a role × route matrix (TASK game-manager,
 * Phase 1 DoD). middleware/auth.global.ts is a thin wrapper over guardRoute,
 * so this covers what actually ships.
 *
 * Key rows: GAME_MANAGER reaches /game and NOTHING else (Q2), while the Game
 * zone itself is open to the Design-side roles too (Q1, variant «б»).
 */

const ROLES: AppRole[] = [
  "ADMIN",
  "MANAGER",
  "DESIGNER",
  "SUPER_DESIGNER",
  "CRM",
  "CRM_SUPER",
  "GAME_MANAGER",
];

/** null = navigation allowed. */
type Outcome = string | null;

describe("zoneOf", () => {
  it("maps each route to its zone", () => {
    expect(zoneOf("/crm")).toBe("crm");
    expect(zoneOf("/crm/bundles")).toBe("crm");
    expect(zoneOf("/game")).toBe("game");
    expect(zoneOf("/")).toBe("design");
    expect(zoneOf("/tournaments")).toBe("design");
    expect(zoneOf("/welcome-packs")).toBe("design");
  });

  it("falls back to Design for unknown routes (guarded by default)", () => {
    expect(zoneOf("/some-future-page")).toBe("design");
  });

  it("does not mistake /games-something for the Game zone prefix boundary", () => {
    // startsWith("/game") deliberately covers /game/* — sub-routes of the
    // module must stay in the Game zone.
    expect(zoneOf("/game/composer")).toBe("game");
  });
});

describe("canEnterZone", () => {
  const expected: Record<Zone, AppRole[]> = {
    design: ["ADMIN", "MANAGER", "DESIGNER", "SUPER_DESIGNER"],
    crm: ["ADMIN", "MANAGER", "CRM", "CRM_SUPER"],
    game: ["ADMIN", "MANAGER", "DESIGNER", "SUPER_DESIGNER", "GAME_MANAGER"],
  };

  for (const zone of ["design", "crm", "game"] as Zone[]) {
    it(`admits exactly the listed roles into the ${zone} zone`, () => {
      for (const role of ROLES) {
        expect(canEnterZone(role, zone)).toBe(expected[zone].includes(role));
      }
    });
  }

  it("never admits an anonymous visitor", () => {
    expect(canEnterZone(null, "design")).toBe(false);
    expect(canEnterZone(null, "crm")).toBe(false);
    expect(canEnterZone(null, "game")).toBe(false);
  });
});

describe("guardRoute — anonymous visitors", () => {
  it("lets /login through and bounces everything else to it", () => {
    expect(guardRoute("/login", null)).toBeNull();
    expect(guardRoute("/", null)).toBe("/login");
    expect(guardRoute("/game", null)).toBe("/login");
    expect(guardRoute("/crm", null)).toBe("/login");
    expect(guardRoute("/forbidden", null)).toBe("/login");
  });
});

describe("guardRoute — role × route matrix", () => {
  const ALLOW: Outcome = null;
  const DENY: Outcome = "/forbidden";

  // rows: role → outcome per route
  const matrix: Record<AppRole, Record<string, Outcome>> = {
    ADMIN: { "/": ALLOW, "/crm": ALLOW, "/game": ALLOW, "/admin": ALLOW, "/library": ALLOW },
    MANAGER: { "/": ALLOW, "/crm": ALLOW, "/game": ALLOW, "/admin": ALLOW, "/library": ALLOW },
    DESIGNER: { "/": ALLOW, "/crm": DENY, "/game": ALLOW, "/admin": DENY, "/library": DENY },
    SUPER_DESIGNER: {
      "/": ALLOW,
      "/crm": DENY,
      "/game": ALLOW,
      "/admin": DENY,
      "/library": ALLOW,
    },
    CRM: { "/": DENY, "/crm": ALLOW, "/game": DENY, "/admin": DENY, "/library": DENY },
    CRM_SUPER: { "/": DENY, "/crm": ALLOW, "/game": DENY, "/admin": DENY, "/library": DENY },
    // The Q2 wall: the Game module and nothing else.
    GAME_MANAGER: { "/": DENY, "/crm": DENY, "/game": ALLOW, "/admin": DENY, "/library": DENY },
  };

  for (const role of ROLES) {
    for (const [path, outcome] of Object.entries(matrix[role])) {
      const verdict = outcome === null ? "reaches" : "is bounced from";
      it(`${role} ${verdict} ${path}`, () => {
        expect(guardRoute(path, role)).toBe(outcome);
      });
    }
  }

  it("every authenticated role may see /forbidden itself", () => {
    for (const role of ROLES) {
      expect(guardRoute("/forbidden", role)).toBeNull();
    }
  });

  it("every authenticated role may return to the portal", () => {
    for (const role of ROLES) {
      expect(guardRoute("/login", role)).toBeNull();
    }
  });

  it("Design sub-pages follow the Design zone, not just /", () => {
    for (const path of ["/result", "/archive", "/tournaments", "/welcome-packs"]) {
      expect(guardRoute(path, "DESIGNER")).toBeNull();
      expect(guardRoute(path, "GAME_MANAGER")).toBe("/forbidden");
      expect(guardRoute(path, "CRM")).toBe("/forbidden");
    }
  });
});
