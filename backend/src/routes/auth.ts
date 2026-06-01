import { Router } from "express";
import type { CookieOptions, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { env, googleOAuthConfigured, isProd } from "../env.js";
import { buildGoogleAuthUrl, exchangeCodeForProfile } from "../lib/google.js";
import { SESSION_COOKIE, signSession } from "../lib/jwt.js";
import { resolveLogin } from "../services/auth.service.js";
import { prisma } from "../lib/prisma.js";
import { loadUser, requireAuth } from "../middleware/auth.js";

export const authRouter: Router = Router();

const STATE_COOKIE = "oauth_state";

// In production the frontend and backend live on different Railway domains
// (cross-site), so the session cookie must be SameSite=None; Secure to be sent
// on credentialed XHR. Locally (same-site localhost) Lax is fine.
const baseCookie: CookieOptions = {
  httpOnly: true,
  sameSite: isProd ? "none" : "lax",
  secure: isProd,
  path: "/",
};

function loginRedirect(res: Response, error: string): void {
  res.redirect(`${env.FRONTEND_URL}/login?error=${encodeURIComponent(error)}`);
}

// Step 1 — kick off the Google consent flow.
authRouter.get("/google", (_req: Request, res: Response) => {
  if (!googleOAuthConfigured) {
    res.status(503).json({ error: "google_oauth_not_configured" });
    return;
  }
  const state = randomBytes(16).toString("hex");
  res.cookie(STATE_COOKIE, state, { ...baseCookie, maxAge: 10 * 60 * 1000 });
  res.redirect(buildGoogleAuthUrl(state));
});

// Step 2 — handle Google's redirect back.
authRouter.get("/google/callback", async (req: Request, res: Response) => {
  if (!googleOAuthConfigured) {
    res.status(503).json({ error: "google_oauth_not_configured" });
    return;
  }
  if (typeof req.query.error === "string") {
    loginRedirect(res, "oauth");
    return;
  }

  const code = req.query.code;
  const state = req.query.state;
  const expectedState = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, baseCookie);

  if (typeof code !== "string" || typeof state !== "string" || state !== expectedState) {
    loginRedirect(res, "state");
    return;
  }

  try {
    const profile = await exchangeCodeForProfile(code);
    const result = await resolveLogin(profile);

    if (!result.ok) {
      loginRedirect(res, result.reason);
      return;
    }

    const token = signSession({
      sub: result.user.id,
      email: result.user.email,
      role: result.user.role,
    });
    res.cookie(SESSION_COOKIE, token, { ...baseCookie, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.redirect(env.FRONTEND_URL);
  } catch (err) {
    console.error("OAuth callback error:", err);
    loginRedirect(res, "server");
  }
});

// Current session — reads fresh role/profile from the DB.
authRouter.get("/me", loadUser, requireAuth, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.sub },
    select: { id: true, email: true, name: true, avatarUrl: true, role: true, isActive: true },
  });
  if (!user || !user.isActive) {
    res.clearCookie(SESSION_COOKIE, baseCookie);
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.json({ user });
});

authRouter.post("/logout", (_req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE, baseCookie);
  res.json({ ok: true });
});
