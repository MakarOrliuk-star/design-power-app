import os from "node:os";
import path from "node:path";
import { mkdir, readdir, stat, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/**
 * Temp storage for uploaded Smartico ZIPs. A ZIP is uploaded once during
 * `analyze`, kept under a random token, and reused by `generate` (so the user
 * never re-uploads 100 MB). Orphaned files are swept after a TTL.
 */

const DIR = path.join(os.tmpdir(), "smartico-uploads");
const TTL_MS = 60 * 60 * 1000; // 1 hour

/** Directory formidable writes uploads into (same dir we keep token ZIPs in). */
export const STORAGE_DIR = DIR;

export async function ensureStorageDir(): Promise<void> {
  await mkdir(DIR, { recursive: true });
}

export function newToken(): string {
  return randomUUID();
}

/** Tokens are UUIDs — validate before using one in a filesystem path. */
export function isValidToken(token: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
}

export function zipPathForToken(token: string): string {
  return path.join(DIR, `${token}.zip`);
}

export async function removeToken(token: string): Promise<void> {
  if (!isValidToken(token)) return;
  await rm(zipPathForToken(token), { force: true });
}

/** Delete any temp ZIPs older than the TTL (best-effort). */
export async function sweepOldUploads(): Promise<void> {
  let names: string[];
  try {
    names = await readdir(DIR);
  } catch {
    return; // dir not created yet
  }
  const now = Date.now();
  await Promise.all(
    names.map(async (name) => {
      const full = path.join(DIR, name);
      try {
        const s = await stat(full);
        if (now - s.mtimeMs > TTL_MS) await rm(full, { force: true });
      } catch {
        /* ignore */
      }
    }),
  );
}
