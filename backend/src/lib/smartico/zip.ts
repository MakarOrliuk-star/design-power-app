import yauzl from "yauzl";

/**
 * Thin yauzl wrappers for the Smartico service. We read the ZIP central directory
 * to list entries WITHOUT decompressing (instant, memory-cheap even at 100 MB),
 * and decompress individual entries on demand during upload (Stage 3).
 */

/** List every entry path in the archive (files and directories). */
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

function readEntryBuffer(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error("zip_read_failed"));
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  });
}

/**
 * Decompress the `wanted` entries one at a time and hand each buffer to
 * `handler`. Decompression is sequential (a single buffer in memory at a time),
 * while up to `concurrency` handlers (uploads) run in parallel — so peak memory
 * is bounded by the in-flight upload count, never the whole archive.
 */
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
            buf = await readEntryBuffer(zip, entry);
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
