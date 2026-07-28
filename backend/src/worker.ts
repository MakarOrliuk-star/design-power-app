import { Worker } from "bullmq";
import { env } from "./env.js";
import {
  PERSON_QUEUE,
  ITEM_QUEUE,
  BUNDLE_QUEUE,
  SMS_QUEUE,
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
import { processSmsJob, processSmsPollingJob } from "./queues/sms.processor.js";

/**
 * Worker entrypoint (separate process / Railway service). Drains the person +
 * item + bundle + sms queues.
 */

const LONG_LOCK_MS = 5 * 60 * 1000;
const connection = getBullConnection();

const personWorker = new Worker<GenerationJobData, void, "submit">(
  PERSON_QUEUE,
  (job) => processPersonJob(job.data.generationId, job.data.aspectRatio),
  { connection, concurrency: 8, lockDuration: LONG_LOCK_MS }
);

const itemWorker = new Worker<GenerationJobData, void, "generate">(
  ITEM_QUEUE,
  (job) => processItemJob(job.data.generationId, job.data.aspectRatio),
  { connection, concurrency: 5, lockDuration: LONG_LOCK_MS }
);

// Image Bundles worker
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
  { connection, concurrency: 4, lockDuration: 2 * LONG_LOCK_MS }
);

// SMS Route Tester worker 
const smsWorker = new Worker<any, void, string>(
  SMS_QUEUE,
  async (job) => {
    if (job.name === "poll-status") {
      await processSmsPollingJob(job.data);
    } else {
      await processSmsJob(job.data);
    }
  },
  { connection, concurrency: 5, lockDuration: LONG_LOCK_MS }
);

// Logging for SMS Script
for (const [name, w] of [
  ["person", personWorker],
  ["item", itemWorker],
  ["bundle", bundleWorker],
  ["sms", smsWorker],
] as const) {
  w.on("failed", (job, err) => console.error(`❌ ${name} job ${job?.id} failed:`, err.message));
  w.on("error", (err) => console.error(`⚠️ ${name} worker error:`, err.message));
}

console.log(`👷 Workers started (${env.NODE_ENV}) — person + item + bundle + sms`);

async function shutdown(signal: string) {
  console.log(`\n${signal} received — closing workers`);
  await Promise.allSettled([
    personWorker.close(),
    itemWorker.close(),
    bundleWorker.close(),
    smsWorker.close(),
  ]);
  process.exit(0);
}

for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => void shutdown(s));