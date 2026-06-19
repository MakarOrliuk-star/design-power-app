import { Worker } from "bullmq";
import { SMARTICO_QUEUE, getBullConnection, type SmarticoJobData } from "./index.js";
import { processSmarticoJob } from "./smartico.processor.js";

/**
 * Smartico worker — embedded in the API process (NOT the dedicated worker).
 *
 * A Smartico job reads the uploaded ZIP from local temp storage
 * (`os.tmpdir()/smartico-uploads`), which is written by the `analyze` request in
 * the API container. On Railway the dedicated worker is a SEPARATE container with
 * its own disk and cannot see that file, so the job must run in the same process
 * that received the upload. Job state still flows through the shared Redis queue,
 * so the polling endpoint keeps working unchanged.
 *
 * NOTE: this assumes a single API instance (Railway default). If the API is
 * scaled to multiple replicas, the temp ZIP must move to shared storage
 * (Redis/Cloudinary) so any replica can read it.
 */

const LONG_LOCK_MS = 5 * 60 * 1000;

let _worker: Worker<SmarticoJobData, unknown, "generate"> | null = null;

export function startSmarticoWorker(): Worker<SmarticoJobData, unknown, "generate"> {
  if (_worker) return _worker;
  _worker = new Worker<SmarticoJobData, unknown, "generate">(
    SMARTICO_QUEUE,
    (job) => processSmarticoJob(job),
    { connection: getBullConnection(), concurrency: 2, lockDuration: LONG_LOCK_MS },
  );
  _worker.on("failed", (job, err) =>
    console.error(`❌ smartico job ${job?.id} failed:`, err.message),
  );
  _worker.on("error", (err) => console.error("⚠️ smartico worker error:", err.message));
  console.log("👷 Smartico worker started (embedded in API process)");
  return _worker;
}

export async function stopSmarticoWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = null;
  }
}
