// Image Bundles state machine (TASK crm-bundle, R-PLAN §5, D1).
// Bundle:      DRAFT → GENERATING → COMPLETED | FAILED; regenerate re-enters
//              GENERATING from any non-DRAFT state. No Scheduled status.
// BundleAsset: PENDING → GENERATING → DONE | FAILED; regenerate re-enters
//              GENERATING and resets `approved`.
// The bundle status is DERIVED from its assets (mirrors recomputeBatchStatus).

export type BundleStatus = "DRAFT" | "GENERATING" | "COMPLETED" | "FAILED";
export type BundleAssetStatus = "PENDING" | "GENERATING" | "DONE" | "FAILED";

const ASSET_TRANSITIONS: Record<BundleAssetStatus, BundleAssetStatus[]> = {
  PENDING: ["GENERATING"],
  GENERATING: ["DONE", "FAILED"],
  // Regenerate (single asset or all): back into the pipeline.
  DONE: ["GENERATING", "PENDING"],
  FAILED: ["GENERATING", "PENDING"],
};

export function canAssetTransition(from: BundleAssetStatus, to: BundleAssetStatus): boolean {
  return ASSET_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Approve is only meaningful on a finished asset (Result screen buttons). */
export function canApproveAsset(status: BundleAssetStatus): boolean {
  return status === "DONE";
}

/**
 * Derive the bundle status from its assets. Called after every job finishes
 * and after (re)generation is enqueued.
 * - no assets yet → DRAFT (wizard not launched)
 * - anything in flight → GENERATING
 * - all terminal, at least one DONE → COMPLETED (partial failures still show
 *   their per-asset FAILED state + Regenerate button)
 * - all terminal, none DONE → FAILED
 */
export function deriveBundleStatus(assetStatuses: BundleAssetStatus[]): BundleStatus {
  if (assetStatuses.length === 0) return "DRAFT";
  if (assetStatuses.some((s) => s === "PENDING" || s === "GENERATING")) return "GENERATING";
  return assetStatuses.some((s) => s === "DONE") ? "COMPLETED" : "FAILED";
}

/** Generation may be (re)launched from any state except an in-flight one. */
export function canStartGeneration(status: BundleStatus): boolean {
  return status !== "GENERATING";
}
