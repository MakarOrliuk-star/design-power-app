import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Job } from "bullmq";

// Keep the real findChildFolder/findChildFile/DriveApiError; mock the network.
const drive = vi.hoisted(() => ({ list: vi.fn(), download: vi.fn() }));
vi.mock("../src/lib/drive.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/drive.js")>();
  return { ...actual, listFolderChildren: drive.list, downloadDriveFile: drive.download };
});

const tokens = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../src/lib/driveTokens.js", () => ({ getDriveToken: tokens.get }));

const asset = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("../src/lib/smartico/uploadAsset.js", () => ({ uploadSmarticoAsset: asset.upload }));

const db = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { smarticoBrand: { findMany: db.findMany } },
}));

import { processDriveSmarticoJob } from "../src/queues/drive-smartico.processor.js";
import { DriveApiError, type DriveItem } from "../src/lib/drive.js";
import type { DriveSmarticoJobData } from "../src/queues/index.js";

const folder = (id: string, name: string): DriveItem => ({ id, name, isFolder: true });
const file = (id: string, name: string): DriveItem => ({ id, name, isFolder: false });

function makeJob(data: Partial<DriveSmarticoJobData> = {}): Job<DriveSmarticoJobData> {
  return {
    data: {
      userId: "user1",
      branchId: "branch1",
      branchName: "Tournaments",
      eventName: "Tournament Summer VIP",
      packName: "Tournaments — Tournament Summer VIP",
      selectedTypes: ["email", "push"],
      ...data,
    },
    updateProgress: vi.fn(),
  } as unknown as Job<DriveSmarticoJobData>;
}

beforeEach(() => {
  drive.list.mockReset();
  drive.download.mockReset();
  tokens.get.mockReset();
  asset.upload.mockReset();
  db.findMany.mockReset();
  tokens.get.mockResolvedValue("tok");
  db.findMany.mockResolvedValue([]); // no canonical brands → raw names used as-is
  drive.download.mockResolvedValue(Buffer.from([1, 2, 3]));
  asset.upload.mockImplementation(async (_b: Buffer, p: { brand: string; type: string }) => ({
    url: `https://cdn/${p.brand}_${p.type}`,
    status: "uploaded",
  }));
});

// Folder tree:
//   branch1 → [BrandA, BrandB, note.txt]
//   BrandA  → [event "Tournament Summer VIP", "Tournament Summer"]
//   event   → [CRM, SMARTICO, CONTENT]
//   CRM     → [email.webp, push.webp, pop-up.webp]
//   BrandB  → [only a different event] → skipped
function wireHappyTree() {
  drive.list.mockImplementation(async (_tok: string, folderId: string) => {
    switch (folderId) {
      case "branch1":
        return [folder("brandA", "BrandA"), folder("brandB", "BrandB"), file("n", "note.txt")];
      case "brandA":
        return [folder("evtA", "Tournament Summer VIP"), folder("o", "Tournament Summer")];
      case "evtA":
        return [folder("crmA", "CRM"), folder("smA", "SMARTICO"), folder("coA", "CONTENT")];
      case "crmA":
        return [file("e", "email.webp"), file("p", "push.webp"), file("u", "pop-up.webp")];
      case "brandB":
        return [folder("evtB", "Some Other Event")]; // lacks the chosen event
      default:
        return [];
    }
  });
}

// Like wireHappyTree but with a single brand whose event has CRM + SMARTICO,
// and SMARTICO holds card.webp.
function wireWithSmartico() {
  drive.list.mockImplementation(async (_tok: string, folderId: string) => {
    switch (folderId) {
      case "branch1":
        return [folder("brandA", "BrandA")];
      case "brandA":
        return [folder("evtA", "Tournament Summer VIP")];
      case "evtA":
        return [folder("crmA", "CRM"), folder("smA", "SMARTICO")];
      case "crmA":
        return [file("e", "email.webp"), file("p", "push.webp")];
      case "smA":
        return [file("c", "card.webp")];
      default:
        return [];
    }
  });
}

describe("processDriveSmarticoJob", () => {
  it("walks every brand, pulls the chosen types, and builds functions", async () => {
    wireHappyTree();
    const result = await processDriveSmarticoJob(makeJob());

    // Only the two selected types were downloaded for BrandA (not pop-up).
    expect(drive.download).toHaveBeenCalledTimes(2);
    expect(asset.upload).toHaveBeenCalledTimes(2);

    expect(result.stats).toEqual({
      total: 2,
      uploaded: 2,
      reused: 0,
      failed: 0,
      failedItems: [],
    });

    // BrandB produced nothing (no matching event) → not in the brand list.
    expect(result.brands.map((b) => b.raw)).toEqual(["BrandA"]);

    const titles = result.outputs.map((o) => o.title);
    expect(titles).toContain("Email — Function");
    expect(titles).toContain("Push — Function");
    const emailBlock = result.outputs.find((o) => o.title === "Email — Function")!;
    expect(emailBlock.code).toContain('"BrandA": "https://cdn/BrandA_email"');
  });

  it("counts a missing type file as failed only when expected, else just skips", async () => {
    // CRM has email but not push → push is simply absent (not a failure).
    drive.list.mockImplementation(async (_tok: string, folderId: string) => {
      switch (folderId) {
        case "branch1":
          return [folder("brandA", "BrandA")];
        case "brandA":
          return [folder("evtA", "Tournament Summer VIP")];
        case "evtA":
          return [folder("crmA", "CRM")];
        case "crmA":
          return [file("e", "email.webp")]; // no push.webp
        default:
          return [];
      }
    });
    const result = await processDriveSmarticoJob(makeJob());
    expect(drive.download).toHaveBeenCalledTimes(1); // only email
    expect(result.stats.uploaded).toBe(1);
    expect(result.stats.failed).toBe(0);
  });

  it("records a per-image upload failure without aborting the job", async () => {
    wireHappyTree();
    asset.upload.mockImplementation(async (_b: Buffer, p: { brand: string; type: string }) =>
      p.type === "push"
        ? { url: null, status: "failed", error: "cloudinary down" }
        : { url: `https://cdn/${p.brand}_${p.type}`, status: "uploaded" },
    );
    const result = await processDriveSmarticoJob(makeJob());
    expect(result.stats.uploaded).toBe(1);
    expect(result.stats.failed).toBe(1);
    expect(result.stats.failedItems).toContain("BrandA/push");
  });

  it("adds a Smartico card.webp function when includeSmartico is on", async () => {
    wireWithSmartico();
    const result = await processDriveSmarticoJob(makeJob({ includeSmartico: true }));

    // email + push (CRM) + card (SMARTICO)
    expect(drive.download).toHaveBeenCalledTimes(3);
    const cardCall = asset.upload.mock.calls.find(
      (c: unknown[]) => (c[1] as { type: string }).type === "card",
    );
    expect(cardCall).toBeTruthy();
    expect(cardCall![1]).toMatchObject({ brand: "BrandA", type: "card", locale: "default" });

    const titles = result.outputs.map((o) => o.title);
    expect(titles).toContain("Smartico — Card");
    const cardBlock = result.outputs.find((o) => o.title === "Smartico — Card")!;
    expect(cardBlock.code).toContain('"BrandA": "https://cdn/BrandA_card"');
    expect(result.stats.uploaded).toBe(3);
  });

  it("ignores the SMARTICO folder when includeSmartico is off", async () => {
    wireWithSmartico();
    const result = await processDriveSmarticoJob(makeJob()); // flag absent

    expect(drive.download).toHaveBeenCalledTimes(2); // email + push only
    expect(asset.upload.mock.calls.some((c: unknown[]) => (c[1] as { type: string }).type === "card")).toBe(false);
    expect(result.outputs.map((o) => o.title)).not.toContain("Smartico — Card");
  });

  it("throws when the Drive token is missing", async () => {
    tokens.get.mockResolvedValue(null);
    await expect(processDriveSmarticoJob(makeJob())).rejects.toThrow("drive_not_connected");
  });

  it("propagates a 401 from Drive as a fatal job error", async () => {
    drive.list.mockRejectedValue(new DriveApiError("expired", 401));
    await expect(processDriveSmarticoJob(makeJob())).rejects.toBeInstanceOf(DriveApiError);
  });
});
