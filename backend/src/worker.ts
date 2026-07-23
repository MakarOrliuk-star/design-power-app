import { Worker } from "bullmq";
import { env } from "./env.js";
import {
  PERSON_QUEUE,
  ITEM_QUEUE,
  BUNDLE_QUEUE,
  getBullConnection,
  type GenerationJobData,
  type BundleQueueData,
  type BundleJobName,
  type BundleAssetJobData,
} from "./queues/index.js";
import { processPersonJob } from "./queues/person.processor.js";
import { processItemJob } from "./queues/item.processor.js";
import {
  processEditAssetJob,
  processPrepareVariantJob,
  processRenderAssetJob,
} from "./queues/bundle.processor.js";

/**
 * Worker entrypoint (separate process / Railway service). Drains the person +
 * item queues. Both providers are synchronous (fal.run / nano-gpt), so jobs can
 * run for a while — the long lockDuration keeps BullMQ from reclaiming an
 * in-flight job. Run with `npm run worker`.
 *
 * Smartico jobs are intentionally NOT handled here: they read the uploaded ZIP
 * from local temp storage on the API container, so they run inside the API
 * process instead (see `queues/smartico.worker.ts`).
 */

const LONG_LOCK_MS = 5 * 60 * 1000;
const connection = getBullConnection();

const personWorker = new Worker<GenerationJobData, void, "submit">(
  PERSON_QUEUE,
  (job) => processPersonJob(job.data.generationId, job.data.aspectRatio),
  { connection, concurrency: 8, lockDuration: LONG_LOCK_MS },
);

const itemWorker = new Worker<GenerationJobData, void, "generate">(
  ITEM_QUEUE,
  (job) => processItemJob(job.data.generationId, job.data.aspectRatio),
  { connection, concurrency: 5, lockDuration: LONG_LOCK_MS },
);

// Image Bundles (TASK crm-bundle Phase 4): stage A runs two sequential fal
// generations (person + item), so it gets an extra-long lock.
const bundleWorker = new Worker<BundleQueueData, void, BundleJobName>(
  BUNDLE_QUEUE,
  async (job) => {
    if (job.name === "render-asset") {
      const data = job.data as BundleAssetJobData;
      await processRenderAssetJob(data.bundleId, data.variantId, data.assetId);
    } else if (job.name === "edit-asset") {
      const data = job.data as BundleAssetJobData;
      await processEditAssetJob(data.bundleId, data.variantId, data.assetId, data.editPrompt ?? "");
    } else {
      await processPrepareVariantJob(job.data.bundleId, job.data.variantId);
    }
  },
  { connection, concurrency: 4, lockDuration: 2 * LONG_LOCK_MS },
);

for (const [name, w] of [
  ["person", personWorker],
  ["item", itemWorker],
  ["bundle", bundleWorker],
] as const) {
  w.on("failed", (job, err) => console.error(`❌ ${name} job ${job?.id} failed:`, err.message));
  w.on("error", (err) => console.error(`⚠️ ${name} worker error:`, err.message));
}

console.log(`👷 Workers started (${env.NODE_ENV}) — person + item + bundle`);

async function shutdown(signal: string) {
  console.log(`\n${signal} received — closing workers`);
  await Promise.allSettled([personWorker.close(), itemWorker.close(), bundleWorker.close()]);
  process.exit(0);
}
for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => void shutdown(s));
