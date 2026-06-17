import { describe, it, expect, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import archiver from "archiver";
import { listEntryPaths, extractAndProcess } from "../src/lib/smartico/zip.js";

const tmpFiles: string[] = [];

function makeZip(entries: Record<string, string>): Promise<string> {
  const file = path.join(os.tmpdir(), `smartico-test-${randomUUID()}.zip`);
  tmpFiles.push(file);
  return new Promise((resolve, reject) => {
    const out = createWriteStream(file);
    const archive = archiver("zip");
    out.on("close", () => resolve(file));
    archive.on("error", reject);
    archive.pipe(out);
    for (const [name, content] of Object.entries(entries)) {
      archive.append(Buffer.from(content), { name });
    }
    void archive.finalize();
  });
}

afterAll(async () => {
  await Promise.all(tmpFiles.map((f) => rm(f, { force: true })));
});

describe("listEntryPaths", () => {
  it("returns every entry path", async () => {
    const zip = await makeZip({
      "Nine/Summer/CRM/email/a.png": "AAA",
      "Nine/Summer/CRM/push/b.png": "BBB",
    });
    const paths = await listEntryPaths(zip);
    expect(paths).toContain("Nine/Summer/CRM/email/a.png");
    expect(paths).toContain("Nine/Summer/CRM/push/b.png");
  });
});

describe("extractAndProcess", () => {
  it("decompresses only the wanted entries and hands over correct bytes", async () => {
    const zip = await makeZip({
      "a.png": "alpha",
      "b.png": "bravo",
      "c.png": "charlie",
    });
    const wanted = new Set(["a.png", "c.png"]);
    const got = new Map<string, string>();
    await extractAndProcess(zip, wanted, 2, async (p, buf) => {
      got.set(p, buf.toString());
    });
    expect([...got.keys()].sort()).toEqual(["a.png", "c.png"]);
    expect(got.get("a.png")).toBe("alpha");
    expect(got.get("c.png")).toBe("charlie");
  });

  it("processes all wanted entries even with concurrency 1", async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 12; i++) entries[`f${i}.png`] = `data-${i}`;
    const zip = await makeZip(entries);
    const wanted = new Set(Object.keys(entries));
    const seen: string[] = [];
    await extractAndProcess(zip, wanted, 1, async (p) => {
      seen.push(p);
    });
    expect(seen.sort()).toEqual(Object.keys(entries).sort());
  });

  it("propagates handler errors", async () => {
    const zip = await makeZip({ "x.png": "boom" });
    await expect(
      extractAndProcess(zip, new Set(["x.png"]), 2, async () => {
        throw new Error("handler failed");
      }),
    ).rejects.toThrow("handler failed");
  });
});
