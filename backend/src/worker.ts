import { Worker } from "bullmq";
import { env } from "./env.js";
import {
  PERSON_QUEUE,
  ITEM_QUEUE,
  getBullConnection,
  type GenerationJobData,
} from "./queues/index.js";
import { processPersonJob } from "./queues/person.processor.js";
import { processItemJob } from "./queues/item.processor.js";

/**
 * Worker entrypoint (separate process / Railway service). Drains the person +
 * item queues. Both providers are synchronous (fal.run / nano-gpt), so jobs can
 * run for a while — the long lockDuration keeps BullMQ from reclaiming an
 * in-flight job. Run with `npm run worker`.
 */

const LONG_LOCK_MS = 5 * 60 * 1000;
const connection = getBullConnection();

const personWorker = new Worker<GenerationJobData, void, "submit">(
  PERSON_QUEUE,
  (job) => processPersonJob(job.data.generationId),
  { connection, concurrency: 8, lockDuration: LONG_LOCK_MS },
);

const itemWorker = new Worker<GenerationJobData, void, "generate">(
  ITEM_QUEUE,
  (job) => processItemJob(job.data.generationId),
  { connection, concurrency: 5, lockDuration: LONG_LOCK_MS },
);

for (const [name, w] of [
  ["person", personWorker],
  ["item", itemWorker],
] as const) {
  w.on("failed", (job, err) => console.error(`❌ ${name} job ${job?.id} failed:`, err.message));
  w.on("error", (err) => console.error(`⚠️ ${name} worker error:`, err.message));
}

console.log(`👷 Workers started (${env.NODE_ENV}) — person + item`);

async function shutdown(signal: string) {
  console.log(`\n${signal} received — closing workers`);
  await Promise.allSettled([personWorker.close(), itemWorker.close()]);
  process.exit(0);
}
for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => void shutdown(s));
