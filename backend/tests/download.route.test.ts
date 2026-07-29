import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import request from "supertest";

// ---- Mocks (hoisted so the route's module graph picks them up) ----
const db = vi.hoisted(() => ({
  findFirst: vi.fn(),
}));

vi.mock("../src/env.js", () => ({
  personPipelineReady: true,
  itemPipelineReady: true,
  editPipelineReady: true,
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { generation: { findFirst: db.findFirst } },
}));
vi.mock("../src/lib/cloudinary.js", () => ({ uploadBase64: vi.fn(), withRetry: vi.fn() }));
vi.mock("../src/services/finalize.js", () => ({ recomputeBatchStatus: vi.fn() }));
vi.mock("../src/queues/index.js", () => ({
  getPersonQueue: () => ({ addBulk: vi.fn() }),
  getItemQueue: () => ({ addBulk: vi.fn() }),
}));

import { generateRouter, imageExtOf, rfc5987 } from "../src/routes/generate.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  // Stand in for loadUser + requireAuth.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { sub: string } }).user = { sub: "user1" };
    next();
  });
  app.use("/api", generateRouter);
  return app;
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function okFetch(contentType = "image/png") {
  return vi.fn().mockResolvedValue({
    ok: true,
    headers: new Headers({ "content-type": contentType }),
    arrayBuffer: () => Promise.resolve(PNG_BYTES.buffer),
  });
}

beforeEach(() => {
  db.findFirst.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * BE Test — direct single-image download (TASK download-and-edit-style §1).
 * Cloudinary is cross-origin, so the file is proxied with a Content-Disposition
 * attachment; the row is scoped to the caller (userId in the where clause).
 */
describe("GET /api/generations/:id/download", () => {
  it("streams the file as an attachment named {brandName}.{ext}", async () => {
    db.findFirst.mockResolvedValue({
      brandName: "Nike",
      generatedImageUrl: "https://cdn/img.png",
    });
    vi.stubGlobal("fetch", okFetch());

    const res = await request(makeApp()).get("/api/generations/g1/download");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.headers["content-disposition"]).toContain('filename="Nike.png"');
    expect(res.headers["content-disposition"]).toContain("filename*=UTF-8''Nike.png");
    expect(Buffer.from(res.body)).toEqual(Buffer.from(PNG_BYTES));
    // Ownership rides in the where clause — the caller only downloads own rows.
    expect(db.findFirst.mock.calls[0]![0].where).toMatchObject({ id: "g1", userId: "user1" });
  });

  it("survives cyrillic/bracketed brand names via an ASCII fallback + RFC 5987", async () => {
    db.findFirst.mockResolvedValue({
      brandName: "Спиногамбино (Men)",
      generatedImageUrl: "https://cdn/img.jpg",
    });
    vi.stubGlobal("fetch", okFetch("image/jpeg"));

    const res = await request(makeApp()).get("/api/generations/g1/download");

    expect(res.status).toBe(200);
    const cd = String(res.headers["content-disposition"]);
    // The plain filename= must be pure ASCII; the full name rides in filename*.
    const ascii = /filename="([^"]+)"/.exec(cd)![1]!;
    expect(ascii).toMatch(/^[\x20-\x7E]+$/);
    expect(ascii.endsWith(".jpg")).toBe(true);
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).not.toContain("("); // parens are not RFC 5987 attr-chars
  });

  it("404s a missing or foreign generation", async () => {
    db.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).get("/api/generations/nope/download");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("generation_not_found");
  });

  it("502s when the image host errors", async () => {
    db.findFirst.mockResolvedValue({
      brandName: "Nike",
      generatedImageUrl: "https://cdn/img.png",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const res = await request(makeApp()).get("/api/generations/g1/download");
    expect(res.status).toBe(502);
  });

  it("502s when the fetch itself throws", async () => {
    db.findFirst.mockResolvedValue({
      brandName: "Nike",
      generatedImageUrl: "https://cdn/img.png",
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const res = await request(makeApp()).get("/api/generations/g1/download");
    expect(res.status).toBe(502);
  });
});

describe("filename helpers", () => {
  it("imageExtOf: extension from the URL, png fallback, query-string safe", () => {
    expect(imageExtOf("https://cdn/a.JPG")).toBe("jpg");
    expect(imageExtOf("https://cdn/a.webp?v=1")).toBe("webp");
    expect(imageExtOf("https://cdn/no-extension")).toBe("png");
  });

  it("rfc5987: percent-encodes the chars encodeURIComponent leaves bare", () => {
    expect(rfc5987("a(b)'c*d!e")).toBe("a%28b%29%27c%2Ad%21e");
    expect(rfc5987("Ника.png")).toBe(encodeURIComponent("Ника.png"));
  });
});
