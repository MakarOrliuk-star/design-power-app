import type { Request } from "express";
import { prisma } from "./prisma.js";

/**
 * Security audit trail (TASK security, §3.1).
 *
 * Answers the question an incident actually asks — "who did what, from where,
 * when" — which nothing in this codebase could answer before: logins, denials,
 * role changes, deactivations and deletions of shared work all happened without
 * leaving a trace.
 *
 * Two rules govern everything below.
 *
 * 1. LOGGING NEVER BREAKS THE REQUEST. Every write goes through `record()`,
 *    which swallows its own errors. An audit trail that can 500 the login route
 *    turns a logging bug into an outage, and a security control that takes the
 *    product down gets removed by the next person who has a bad morning. The
 *    failure is reported to stderr instead, where the platform logs pick it up.
 *
 * 2. NOTHING SENSITIVE GOES IN `details`. It carries small structured facts
 *    ({ from, to }, { reason }), never a request body, never a token. The table
 *    is read during incidents by whoever is on hand; it must not become a second
 *    place where secrets live.
 *
 * RETENTION: rows carry `ip` and `userAgent`, which are personal data. Nothing
 * prunes them yet — that is a deliberate gap, not an oversight: a retention job
 * is only worth writing once someone has decided how long the window should be.
 * Until then the table grows, slowly (a handful of rows per user per day).
 */

/**
 * The event vocabulary. Kept as a const object rather than a Prisma enum so that
 * adding an event is a code change, not a migration — the column is plain text,
 * exactly like `action` on the other change logs in this schema.
 */
export const AuditAction = {
  /** A session was issued. */
  LOGIN_SUCCESS: "LOGIN_SUCCESS",
  /** Google authenticated them, but this app refused: not on the allowlist,
   *  deactivated, or an unverified Google address. `details.reason` says which. */
  LOGIN_DENIED: "LOGIN_DENIED",
  LOGOUT: "LOGOUT",
  /** An admin changed somebody's role. `details` carries { from, to }. */
  ROLE_CHANGED: "ROLE_CHANGED",
  USER_DEACTIVATED: "USER_DEACTIVATED",
  USER_ACTIVATED: "USER_ACTIVATED",
  /** Allowlist edits — the control that decides who can ever log in at all. */
  ALLOWLIST_ADDED: "ALLOWLIST_ADDED",
  ALLOWLIST_REMOVED: "ALLOWLIST_REMOVED",
  /** Deletion of work shared across a role (bundles), where the only record of
   *  who removed it used to be nothing at all. */
  SHARED_DELETED: "SHARED_DELETED",
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  action: AuditAction;
  actorId?: string | null;
  actorEmail?: string | null;
  targetId?: string | null;
  targetEmail?: string | null;
  targetLabel?: string | null;
  details?: Record<string, unknown> | null;
  /** Pass the request to capture IP + user-agent. Omit for background actions. */
  req?: Request;
}

/** User-agent strings are unbounded; keep the column sane. */
const MAX_UA_LENGTH = 512;

/**
 * Write one audit row. Never throws, never rejects — callers may `void` it.
 *
 * Awaiting it is still preferred on paths that then redirect or delete, so the
 * row is committed before the process has any chance to move on.
 */
export async function record(entry: AuditEntry): Promise<void> {
  try {
    const ua = entry.req?.get("user-agent");
    await prisma.securityAuditLog.create({
      data: {
        action: entry.action,
        actorId: entry.actorId ?? null,
        actorEmail: entry.actorEmail?.toLowerCase() ?? null,
        targetId: entry.targetId ?? null,
        targetEmail: entry.targetEmail?.toLowerCase() ?? null,
        targetLabel: entry.targetLabel ?? null,
        // Prisma's Json column rejects `undefined`; normalise to null.
        details: (entry.details ?? undefined) as never,
        // req.ip is only trustworthy because index.ts sets `trust proxy` —
        // without it this would record the Railway/Nitro hop, not the client.
        ip: entry.req?.ip ?? null,
        userAgent: ua ? ua.slice(0, MAX_UA_LENGTH) : null,
      },
    });
  } catch (err) {
    // Rule 1: the request continues regardless.
    console.error(`audit: failed to record ${entry.action}:`, err);
  }
}
