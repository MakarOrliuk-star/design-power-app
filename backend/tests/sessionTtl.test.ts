import { describe, it, expect, vi } from "vitest";
import jwt from "jsonwebtoken";

vi.mock("../src/env.js", () => ({ JWT_SECRET: "test-secret-key" }));
const TEST_SECRET = "test-secret-key";

import { signSession, verifySession, SESSION_MAX_AGE_MS } from "../src/lib/jwt.js";

/**
 * BE Test — session lifetime (TASK security, §3.4).
 *
 * There is no revocation list, so the token's own expiry IS the exposure window
 * for a stolen cookie. It was 7 days; it is now 24 hours. The cookie max-age and
 * the token expiry must agree — a cookie outliving its token produces a
 * confusing 401 instead of a clean re-login, and a token outliving its cookie
 * leaves a valid credential behind after the browser has forgotten it.
 */
describe("session lifetime", () => {
  it("issues a token that expires in 24 hours", () => {
    const token = signSession({ sub: "u1", email: "e@x", role: "DESIGNER" });
    const decoded = jwt.verify(token, TEST_SECRET) as { iat: number; exp: number };

    expect(decoded.exp - decoded.iat).toBe(24 * 60 * 60);
  });

  it("keeps the cookie max-age in lockstep with the token expiry", () => {
    const token = signSession({ sub: "u1", email: "e@x", role: "DESIGNER" });
    const decoded = jwt.verify(token, TEST_SECRET) as { iat: number; exp: number };

    expect(SESSION_MAX_AGE_MS).toBe((decoded.exp - decoded.iat) * 1000);
  });

  it("rejects a token that has already expired", () => {
    // Proves expiry is actually enforced on the way in, not merely stamped.
    const expired = jwt.sign(
      { sub: "u1", email: "e@x", role: "ADMIN" },
      TEST_SECRET,
      { expiresIn: "-1s" },
    );
    expect(verifySession(expired)).toBeNull();
  });

  it("still round-trips a valid session", () => {
    const token = signSession({ sub: "u1", email: "e@x", role: "ADMIN" });
    expect(verifySession(token)).toEqual({ sub: "u1", email: "e@x", role: "ADMIN" });
  });
});
