import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "express";

// env.ts validates process.env and calls process.exit() at import — mock it so
// the module under test can be imported in isolation.
vi.mock("../src/env.js", () => ({ JWT_SECRET: "test-secret-key" }));

const db = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { securityAuditLog: { create: db.create } },
}));

import { record, AuditAction } from "../src/lib/audit.js";

/** Minimal Express request stand-in carrying an IP and a user-agent. */
function fakeReq(ip?: string, ua?: string): Request {
  return {
    ip,
    get: (name: string) => (name.toLowerCase() === "user-agent" ? ua : undefined),
  } as unknown as Request;
}

/** The `data` object handed to prisma on the most recent call. */
function lastData(): Record<string, unknown> {
  return db.create.mock.calls.at(-1)![0].data as Record<string, unknown>;
}

beforeEach(() => {
  db.create.mockReset();
  db.create.mockResolvedValue({});
});

/**
 * BE Test — security audit trail (TASK security, §3.1).
 *
 * The trail exists to answer "who did what, from where, when" during an
 * incident. These tests pin the two properties that make it trustworthy:
 * it records what it was given, and it never takes the request down with it.
 */
describe("audit.record", () => {
  it("writes the action with actor, target and context", async () => {
    await record({
      action: AuditAction.ROLE_CHANGED,
      actorId: "admin-1",
      actorEmail: "Admin@Example.com",
      targetId: "user-9",
      targetEmail: "Victim@Example.com",
      details: { from: "DESIGNER", to: "ADMIN" },
      req: fakeReq("203.0.113.7", "Mozilla/5.0"),
    });

    const data = lastData();
    expect(data.action).toBe("ROLE_CHANGED");
    expect(data.actorId).toBe("admin-1");
    expect(data.targetId).toBe("user-9");
    expect(data.details).toEqual({ from: "DESIGNER", to: "ADMIN" });
    expect(data.ip).toBe("203.0.113.7");
    expect(data.userAgent).toBe("Mozilla/5.0");
  });

  it("normalises both email addresses to lower case", async () => {
    // Otherwise "Admin@x" and "admin@x" become two different actors in the
    // trail and a search for one silently misses the other.
    await record({
      action: AuditAction.LOGIN_SUCCESS,
      actorEmail: "MiXeD@Example.COM",
      targetEmail: "OTHER@Example.COM",
    });

    const data = lastData();
    expect(data.actorEmail).toBe("mixed@example.com");
    expect(data.targetEmail).toBe("other@example.com");
  });

  it("records a denied login with no actor", async () => {
    // A denial has no authenticated actor — the address is the target, and the
    // reason is the whole point of the row.
    await record({
      action: AuditAction.LOGIN_DENIED,
      targetEmail: "stranger@example.com",
      details: { reason: "not_allowed" },
    });

    const data = lastData();
    expect(data.actorId).toBeNull();
    expect(data.actorEmail).toBeNull();
    expect(data.targetEmail).toBe("stranger@example.com");
    expect(data.details).toEqual({ reason: "not_allowed" });
  });

  it("truncates an over-long user-agent instead of storing it whole", async () => {
    await record({
      action: AuditAction.LOGIN_SUCCESS,
      req: fakeReq("203.0.113.7", "U".repeat(5000)),
    });
    expect((lastData().userAgent as string).length).toBe(512);
  });

  it("nulls IP and user-agent when no request is supplied", async () => {
    await record({ action: AuditAction.LOGOUT, actorId: "u1" });
    const data = lastData();
    expect(data.ip).toBeNull();
    expect(data.userAgent).toBeNull();
  });

  it("NEVER throws when the database write fails", async () => {
    // The rule the whole design rests on: an audit failure must not turn into a
    // failed login. If this test ever goes red, logging can take the app down.
    db.create.mockRejectedValue(new Error("db down"));
    await expect(
      record({ action: AuditAction.LOGIN_SUCCESS, actorId: "u1" }),
    ).resolves.toBeUndefined();
  });
});
