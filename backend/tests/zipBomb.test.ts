import { describe, it, expect, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import archiver from "archiver";
import {
  extractAndProcess,
  MAX_ENTRY_BYTES,
  ZipBombError,
} from "../src/lib/smartico/zip.js";

const tmpFiles: string[] = [];

/**
 * Build a real archive on disk (same helper shape as smarticoZip.test.ts).
 * `entries` maps a path to the raw bytes stored under it.
 */
function makeZip(entries: Record<string, Buffer>): Promise<string> {
  const file = path.join(os.tmpdir(), `zipbomb-test-${randomUUID()}.zip`);
  tmpFiles.push(file);
  return new Promise((resolve, reject) => {
    const out = createWriteStream(file);
    const archive = archiver("zip", { zlib: { level: 9 } });
    out.on("close", () => resolve(file));
    archive.on("error", reject);
    archive.pipe(out);
    for (const [name, content] of Object.entries(entries)) {
      archive.append(content, { name });
    }
    void archive.finalize();
  });
}

afterAll(async () => {
  await Promise.all(tmpFiles.map((f) => rm(f, { force: true })));
});

/**
 * BE Test — zip-bomb guard.
 *
 * The upload layer caps the ARCHIVE at 200 MB, which is no protection at all:
 * highly-compressible content expands by orders of magnitude, and every entry
 * is read fully into memory. These tests build genuinely compressed archives
 * (a zeroed buffer packs down to a few KB) and assert the decompression ceiling
 * stops them.
 */
describe("zip decompression limits", () => {
  it("aborts an entry that expands past MAX_ENTRY_BYTES", async () => {
    // 120 MB of zeroes — compresses to a handful of KB on disk, so it sails
    // through every archive-size check, and is 20 MB over the entry ceiling.
    const bomb = Buffer.alloc(MAX_ENTRY_BYTES + 20 * 1024 * 1024);
    const zipPath = await makeZip({ "bomb.bin": bomb });

    let handled = 0;
    await expect(
      extractAndProcess(zipPath, new Set(["bomb.bin"]), 1, async () => {
        handled++;
      }),
    ).rejects.toBeInstanceOf(ZipBombError);

    // The point of the guard: the handler never got a fully materialised bomb.
    expect(handled).toBe(0);
  }, 120_000);

  it("passes a normal entry through untouched", async () => {
    const payload = Buffer.from("a real, small asset");
    const zipPath = await makeZip({ "ok.txt": payload });

    const seen: Array<{ name: string; bytes: number }> = [];
    await extractAndProcess(zipPath, new Set(["ok.txt"]), 1, async (name, buf) => {
      seen.push({ name, bytes: buf.length });
    });

    expect(seen).toEqual([{ name: "ok.txt", bytes: payload.length }]);
  }, 30_000);

  it("ignores entries the caller did not ask for", async () => {
    // Regression guard: the size check must not change which entries are read.
    const zipPath = await makeZip({
      "wanted.txt": Buffer.from("yes"),
      "skipped.txt": Buffer.from("no"),
    });

    const names: string[] = [];
    await extractAndProcess(zipPath, new Set(["wanted.txt"]), 1, async (name) => {
      names.push(name);
    });

    expect(names).toEqual(["wanted.txt"]);
  }, 30_000);
});
