import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../env.js";

/**
 * Lazily-constructed BullMQ connection + queues. Constructing a BullMQ Queue
 * eagerly opens the Redis connection, so we defer construction until first use
 * (the first /generate request, or the worker process). This lets the API boot
 * without Redis present.
 */

export const PERSON_QUEUE = "person";
export const ITEM_QUEUE = "item";

export interface GenerationJobData {
  generationId: string;
  batchId: string;
}

let _connection: Redis | null = null;
export function getBullConnection(): Redis {
  if (!_connection) {
    _connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    // Prevent an unhandled 'error' event (which would crash the process) when
    // Redis is briefly unreachable; BullMQ reconnects on its own.
    _connection.on("error", (e: Error) => console.error("⚠️ Redis (bull) error:", e.message));
  }
  return _connection;
}

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

let _personQueue: Queue<GenerationJobData, void, "submit"> | null = null;
export function getPersonQueue(): Queue<GenerationJobData, void, "submit"> {
  if (!_personQueue) {
    _personQueue = new Queue<GenerationJobData, void, "submit">(PERSON_QUEUE, {
      connection: getBullConnection(),
      defaultJobOptions,
    });
  }
  return _personQueue;
}

let _itemQueue: Queue<GenerationJobData, void, "generate"> | null = null;
export function getItemQueue(): Queue<GenerationJobData, void, "generate"> {
  if (!_itemQueue) {
    _itemQueue = new Queue<GenerationJobData, void, "generate">(ITEM_QUEUE, {
      connection: getBullConnection(),
      defaultJobOptions,
    });
  }
  return _itemQueue;
}
