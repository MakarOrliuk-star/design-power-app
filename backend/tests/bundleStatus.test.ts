import { describe, it, expect } from "vitest";
import {
  canApproveAsset,
  canAssetTransition,
  canStartGeneration,
  deriveBundleStatus,
} from "../src/services/bundleStatus.js";

/**
 * BE Test — Image Bundles state machine (TASK crm-bundle Phase 2 DoD, D1):
 * draft → generating → completed | failed, per-asset pending → generating →
 * done | failed, regenerate re-enters, approve only on DONE. No Scheduled.
 */
describe("bundle asset transitions", () => {
  it("follows the happy path PENDING → GENERATING → DONE", () => {
    expect(canAssetTransition("PENDING", "GENERATING")).toBe(true);
    expect(canAssetTransition("GENERATING", "DONE")).toBe(true);
    expect(canAssetTransition("GENERATING", "FAILED")).toBe(true);
  });

  it("allows regenerate from both terminal states", () => {
    expect(canAssetTransition("DONE", "GENERATING")).toBe(true);
    expect(canAssetTransition("FAILED", "GENERATING")).toBe(true);
    expect(canAssetTransition("DONE", "PENDING")).toBe(true);
    expect(canAssetTransition("FAILED", "PENDING")).toBe(true);
  });

  it("forbids skipping the pipeline", () => {
    expect(canAssetTransition("PENDING", "DONE")).toBe(false);
    expect(canAssetTransition("PENDING", "FAILED")).toBe(false);
    expect(canAssetTransition("GENERATING", "PENDING")).toBe(false);
  });

  it("approve is only possible on a DONE asset", () => {
    expect(canApproveAsset("DONE")).toBe(true);
    expect(canApproveAsset("PENDING")).toBe(false);
    expect(canApproveAsset("GENERATING")).toBe(false);
    expect(canApproveAsset("FAILED")).toBe(false);
  });
});

describe("deriveBundleStatus", () => {
  it("no assets yet → DRAFT (wizard not launched)", () => {
    expect(deriveBundleStatus([])).toBe("DRAFT");
  });

  it("anything in flight → GENERATING", () => {
    expect(deriveBundleStatus(["PENDING", "DONE", "DONE"])).toBe("GENERATING");
    expect(deriveBundleStatus(["GENERATING", "FAILED"])).toBe("GENERATING");
  });

  it("all terminal with at least one DONE → COMPLETED (partial failures included)", () => {
    expect(deriveBundleStatus(["DONE", "DONE", "DONE"])).toBe("COMPLETED");
    expect(deriveBundleStatus(["DONE", "FAILED"])).toBe("COMPLETED");
  });

  it("all failed → FAILED", () => {
    expect(deriveBundleStatus(["FAILED", "FAILED"])).toBe("FAILED");
  });
});

describe("canStartGeneration", () => {
  it("launches from DRAFT and both terminal states, never while in flight", () => {
    expect(canStartGeneration("DRAFT")).toBe(true);
    expect(canStartGeneration("COMPLETED")).toBe(true);
    expect(canStartGeneration("FAILED")).toBe(true);
    expect(canStartGeneration("GENERATING")).toBe(false);
  });
});
