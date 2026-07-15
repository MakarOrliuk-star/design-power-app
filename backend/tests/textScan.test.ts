import { describe, it, expect, beforeEach, vi } from "vitest";

// ---- Mocks ----
const db = vi.hoisted(() => ({ findUnique: vi.fn(), upsert: vi.fn() }));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { imageTextScan: { findUnique: db.findUnique, upsert: db.upsert } },
}));
vi.mock("../src/env.js", () => ({ env: { FAL_KEY: "test-key" } }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import {
  parseVerdict,
  sniffMime,
  scanImageBuffer,
  newScanBudget,
  TEXT_SCAN_ATTEMPTS,
  TEXT_SCAN_MAX_TEXT_LEN,
} from "../src/lib/textScan.js";

/**
 * Text scanner (TASK Трек A): verdict parsing, MD5 cache-first behavior, the
 * pack budget guard and best-effort failure semantics (never throws, never
 * caches a failure).
 */

const BUFFER = Buffer.from("fake-image-bytes");
// md5("fake-image-bytes")
const MD5 = "09ad9ca0b5e3046d2ccb5b63510cb267";

function falOk(output: string) {
  return { status: 200, text: async () => JSON.stringify({ output }) };
}

beforeEach(() => {
  db.findUnique.mockReset();
  db.upsert.mockReset();
  fetchMock.mockReset();
  db.findUnique.mockResolvedValue(null);
  db.upsert.mockResolvedValue({});
});

describe("parseVerdict", () => {
  it("extracts the JSON even when wrapped in prose or code fences", () => {
    const fenced = '```json\n{"has_marketing_text": true, "found_text": "FREE SPINS", "confidence": 0.9}\n```';
    expect(parseVerdict(fenced)).toEqual({ hasText: true, text: "FREE SPINS", confidence: 0.9 });
    expect(parseVerdict('ok: {"has_marketing_text": false, "found_text": "", "confidence": 1}')).toEqual({
      hasText: false, text: "", confidence: 1,
    });
  });

  it("rejects garbage and clamps out-of-range fields", () => {
    expect(parseVerdict("no json here")).toBeNull();
    expect(parseVerdict('{"found_text": "x"}')).toBeNull(); // no boolean verdict
    expect(parseVerdict(null)).toBeNull();

    const clamped = parseVerdict('{"has_marketing_text": true, "confidence": 7}')!;
    expect(clamped.confidence).toBe(1);
    expect(clamped.text).toBe(""); // non-string found_text → empty
    const long = parseVerdict(
      `{"has_marketing_text": true, "found_text": "${"A".repeat(900)}", "confidence": 0.5}`,
    )!;
    expect(long.text).toHaveLength(TEXT_SCAN_MAX_TEXT_LEN);
  });
});

describe("sniffMime", () => {
  it("recognizes webp / png / jpeg and falls back to png", () => {
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
    expect(sniffMime(webp)).toBe("image/webp");
    expect(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(sniffMime(Buffer.from("????"))).toBe("image/png");
  });
});

describe("scanImageBuffer", () => {
  it("returns the cached verdict (incl. whitelist) without calling fal", async () => {
    db.findUnique.mockResolvedValue({
      md5: MD5, hasText: true, text: "UP TO 500000$", confidence: 0.9, approvedOk: true,
    });
    const r = await scanImageBuffer(BUFFER);
    expect(r).toEqual({ md5: MD5, hasText: true, text: "UP TO 500000$", confidence: 0.9, approvedOk: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scans fresh bytes via fal and caches the verdict", async () => {
    fetchMock.mockResolvedValue(
      falOk('{"has_marketing_text": true, "found_text": "Start Playing", "confidence": 0.8}'),
    );
    const r = await scanImageBuffer(BUFFER);
    expect(r).toEqual({ md5: MD5, hasText: true, text: "Start Playing", confidence: 0.8, approvedOk: false });
    expect(db.upsert).toHaveBeenCalledWith({
      where: { md5: MD5 },
      create: { md5: MD5, hasText: true, text: "Start Playing", confidence: 0.8 },
      update: { hasText: true, text: "Start Playing", confidence: 0.8 },
    });
    // data URI went to fal (no dependency on the Cloudinary URL).
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.image_url).toMatch(/^data:image\/png;base64,/);
  });

  it("skips the fal call once the pack budget is spent (cache still served)", async () => {
    const spent = newScanBudget(-1); // deadline уже в прошлом
    expect(await scanImageBuffer(BUFFER, spent)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    db.findUnique.mockResolvedValue({
      md5: MD5, hasText: false, text: "", confidence: 1, approvedOk: false,
    });
    const cached = await scanImageBuffer(BUFFER, spent);
    expect(cached?.hasText).toBe(false); // кэш читается и после исчерпания бюджета
  });

  it("is best-effort: retries 5xx, gives up quietly, never caches a failure", async () => {
    fetchMock.mockResolvedValue({ status: 500, text: async () => "boom" });
    expect(await scanImageBuffer(BUFFER)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(TEXT_SCAN_ATTEMPTS);
    expect(db.upsert).not.toHaveBeenCalled();

    // Непарсибельный вердикт — тоже тихий null без кэширования.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(falOk("I cannot help with that"));
    expect(await scanImageBuffer(BUFFER)).toBeNull();
    expect(db.upsert).not.toHaveBeenCalled();
  });
});
