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
export const SMARTICO_QUEUE = "smartico";
export const BUNDLE_QUEUE = "bundle";

export interface GenerationJobData {
  generationId: string;
  batchId: string;
  aspectRatio?: string; // fal aspect_ratio (Person); durable across retries
}

export interface SmarticoJobData {
  token: string; // temp-storage token for the uploaded ZIP
  zipName: string; // Cloudinary folder name (ZIP name without .zip)
  selectedTypes: string[]; // canonical TypeKeys to generate
}

// Google Drive source: iterate every brand folder under `branchId`, pull the
// chosen event's CRM image per type, and build the same Smartico functions.
export interface DriveSmarticoJobData {
  userId: string; // whose Drive token (Redis) to read with
  branchId: string; // the "Maiking" or "Tournaments" folder id
  branchName: string; // its display name (for the pack namespace)
  eventName: string; // chosen event/tournament folder name, identical per brand
  packName: string; // dedup namespace + Cloudinary folder ("<branch> — <event>")
  selectedTypes: string[]; // subset of email | pop-up | push
  // Tournament-only (TASK D3): also read <brand>/<event>/SMARTICO/card.webp and
  // emit a separate Smartico function. Guarded to Tournament branches in the route.
  includeSmartico?: boolean;
}

export type SmarticoQueueData = SmarticoJobData | DriveSmarticoJobData;
export type SmarticoJobName = "generate" | "drive";

// Image Bundles (TASK crm-bundle, R-PLAN §6): two-stage pipeline.
// "prepare-variant" generates the variant's shared person + item (stage A) and
// then enqueues one "render-asset" per asset (stage B: template composition).
// A per-asset regenerate enqueues "render-asset" directly, reusing stage A.
// "edit-asset" (D9) is a text-prompt img2img edit of the CURRENT asset image,
// preserving the canonical canvas size.
export interface BundleVariantJobData {
  bundleId: string;
  variantId: string;
}
export interface BundleAssetJobData {
  bundleId: string;
  variantId: string;
  assetId: string;
  editPrompt?: string; // set for "edit-asset" jobs only
}
export type BundleQueueData = BundleVariantJobData | BundleAssetJobData;
export type BundleJobName = "prepare-variant" | "render-asset" | "edit-asset";

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

// Smartico jobs keep their full result as the BullMQ return value (read back by
// the polling endpoint), so they retain it longer and don't retry on partial
// image failures (those are reported in the result's stats instead).
const smarticoJobOptions = {
  attempts: 1,
  removeOnComplete: { age: 3600, count: 500 },
  removeOnFail: { age: 3600, count: 500 },
};

let _bundleQueue: Queue<BundleQueueData, void, BundleJobName> | null = null;
export function getBundleQueue(): Queue<BundleQueueData, void, BundleJobName> {
  if (!_bundleQueue) {
    _bundleQueue = new Queue<BundleQueueData, void, BundleJobName>(BUNDLE_QUEUE, {
      connection: getBullConnection(),
      defaultJobOptions,
    });
  }
  return _bundleQueue;
}

let _smarticoQueue: Queue<SmarticoQueueData, unknown, SmarticoJobName> | null = null;
export function getSmarticoQueue(): Queue<SmarticoQueueData, unknown, SmarticoJobName> {
  if (!_smarticoQueue) {
    _smarticoQueue = new Queue<SmarticoQueueData, unknown, SmarticoJobName>(SMARTICO_QUEUE, {
      connection: getBullConnection(),
      defaultJobOptions: smarticoJobOptions,
    });
  }
  return _smarticoQueue;
}
