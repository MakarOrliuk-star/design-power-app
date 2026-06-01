import { prisma } from "../lib/prisma.js";
import { bootstrapAdminEmails } from "../env.js";
import type { GoogleProfile } from "../lib/google.js";
import type { User } from "../../generated/prisma/client.js";

export type LoginResult =
  | { ok: true; user: User }
  | { ok: false; reason: "not_allowed" | "deactivated" | "email_unverified" };

/**
 * Allowlist gate + user upsert. Login is permitted only if the email is:
 *  - a bootstrap admin (env), OR
 *  - an existing active User, OR
 *  - present in the AllowedEmail table.
 * Bootstrap admins are promoted to ADMIN on login (existing admins never downgraded).
 */
export async function resolveLogin(profile: GoogleProfile): Promise<LoginResult> {
  if (!profile.emailVerified) {
    return { ok: false, reason: "email_unverified" };
  }

  const email = profile.email.toLowerCase();
  const isBootstrapAdmin = bootstrapAdminEmails.has(email);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing && !existing.isActive) {
    return { ok: false, reason: "deactivated" };
  }

  const allowed =
    isBootstrapAdmin ||
    existing !== null ||
    (await prisma.allowedEmail.findUnique({ where: { email } })) !== null;

  if (!allowed) {
    return { ok: false, reason: "not_allowed" };
  }

  const role = isBootstrapAdmin ? "ADMIN" : (existing?.role ?? "DESIGNER");

  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      googleId: profile.sub,
      role,
      name: profile.name ?? null,
      avatarUrl: profile.picture ?? null,
      lastLoginAt: new Date(),
    },
    update: {
      googleId: profile.sub,
      name: profile.name ?? null,
      avatarUrl: profile.picture ?? null,
      lastLoginAt: new Date(),
      // Promote bootstrap admins; otherwise leave the stored role untouched.
      ...(isBootstrapAdmin ? { role: "ADMIN" as const } : {}),
    },
  });

  return { ok: true, user };
}
