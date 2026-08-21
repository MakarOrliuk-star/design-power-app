import yauzl from "yauzl";

/**
 * Decompression limits (zip-bomb guard).
 *
 * The upload layer caps the ARCHIVE at 200 MB (MAX_ZIP_BYTES), which says
 * nothing about what it expands to — a few hundred MB of zeroes compress to
 * kilobytes, and every entry here is read fully into memory, several at a time
 * under the caller's concurrency. Without a ceiling on the *decompressed* size,
 * one crafted upload from any authenticated user OOMs the container.
 *
 * Both limits are sized well above real payloads: packs hold PNG/WebP artwork,
 * which is already compressed, so a genuine entry never approaches 100 MB and a
 * genuine pack never approaches 1 GB in total.
 */
export const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

/** Thrown when an archive expands past the limits above. */
export class ZipBombError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipBombError";
  }
}

export function listEntryPaths(zipPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("zip_open_failed"));
      const paths: string[] = [];
      zip.on("entry", (entry: yauzl.Entry) => {
        paths.push(entry.fileName);
        zip.readEntry();
      });
      zip.on("end", () => resolve(paths));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

/**
 * Read one entry into memory, refusing anything that expands past the limits.
 *
 * `entry.uncompressedSize` comes from the archive's own central directory, so a
 * malicious archive can simply lie about it. It is still worth checking first —
 * it rejects the honest-but-oversized case without reading a single byte — but
 * the enforcing check is the running total below, which counts what actually
 * comes out of the decompressor and aborts the stream mid-flight.
 *
 * `budget` is the caller's remaining total allowance; it is consumed as bytes
 * arrive so a thousand small entries cannot add up to a bomb either.
 */
function readEntryBuffer(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  budget: { remaining: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
      return reject(
        new ZipBombError(
          `zip entry "${entry.fileName}" declares ${entry.uncompressedSize} bytes (limit ${MAX_ENTRY_BYTES})`,
        ),
      );
    }

    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error("zip_read_failed"));
      const chunks: Buffer[] = [];
      let written = 0;

      stream.on("data", (c: Buffer) => {
        written += c.length;
        budget.remaining -= c.length;
        if (written > MAX_ENTRY_BYTES || budget.remaining < 0) {
          // Stop decompressing immediately — the point is to not allocate the
          // rest of the bomb. destroy() fires 'error', handled just below.
          stream.destroy(
            new ZipBombError(
              written > MAX_ENTRY_BYTES
                ? `zip entry "${entry.fileName}" exceeds ${MAX_ENTRY_BYTES} bytes when decompressed`
                : `zip archive exceeds ${MAX_TOTAL_BYTES} bytes when decompressed`,
            ),
          );
          return;
        }
        chunks.push(c);
      });
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  });
}

export function extractAndProcess(
  zipPath: string,
  wanted: Set<string>,
  concurrency: number,
  handler: (path: string, buffer: Buffer) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("zip_open_failed"));

      let active = 0; // handlers in flight
      let ended = false;
      let settled = false;
      let waiter: (() => void) | null = null; // resumes reading when a slot frees
      // Shared across every entry in this archive — see readEntryBuffer.
      const budget = { remaining: MAX_TOTAL_BYTES };

      const fail = (e: unknown) => {
        if (settled) return;
        settled = true;
        reject(e instanceof Error ? e : new Error(String(e)));
      };
      const checkDone = () => {
        if (ended && active === 0 && !settled) {
          settled = true;
          resolve();
        }
      };
      const releaseSlot = () => {
        active--;
        if (waiter) {
          const w = waiter;
          waiter = null;
          w();
        }
        checkDone();
      };

      zip.on("error", fail);
      zip.on("end", () => {
        ended = true;
        checkDone();
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          if (entry.fileName.endsWith("/") || !wanted.has(entry.fileName)) {
            zip.readEntry();
            return;
          }
          let buf: Buffer;
          try {
            buf = await readEntryBuffer(zip, entry, budget);
          } catch (e) {
            return fail(e);
          }
          active++;
          handler(entry.fileName, buf).then(releaseSlot, fail);
          // Backpressure: don't read the next entry until a slot is free.
          if (active >= concurrency) {
            await new Promise<void>((r) => {
              waiter = r;
            });
          }
          if (!settled) zip.readEntry();
        })();
      });

      zip.readEntry();
    });
  });
}
