import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import request from "supertest";

// Isolate the router: stub env + the Drive token store, and override the live
// Drive REST calls (keep the real DriveApiError + parseDriveFolderId).
vi.mock("../src/env.js", () => ({
  cloudinaryConfigured: true,
  driveConfigured: true,
  env: { SMARTICO_DRIVE_ROOT_ID: "root1" },
}));

const tokens = vi.hoisted(() => ({ get: vi.fn(), clear: vi.fn() }));
vi.mock("../src/lib/driveTokens.js", () => ({
  getDriveToken: tokens.get,
  clearDriveToken: tokens.clear,
}));

vi.mock("../src/services/smartico.service.js", () => ({ analyzeZip: vi.fn() }));
vi.mock("../src/queues/index.js", () => ({ getSmarticoQueue: vi.fn() }));

const drive = vi.hoisted(() => ({ getItem: vi.fn(), list: vi.fn() }));
vi.mock("../src/lib/drive.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/drive.js")>();
  return { ...actual, getDriveItem: drive.getItem, listFolderChildren: drive.list };
});

import { smarticoRouter } from "../src/routes/smartico.js";
import { DriveApiError } from "../src/lib/drive.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { sub: string; email: string } }).user = {
      sub: "user1",
      email: "u@co.com",
    };
    next();
  });
  app.use("/api/smartico", smarticoRouter);
  return app;
}

beforeEach(() => {
  tokens.get.mockReset();
  tokens.clear.mockReset();
  drive.getItem.mockReset();
  drive.list.mockReset();
});

describe("GET /api/smartico/drive/status", () => {
  it("reports connected when a token exists", async () => {
    tokens.get.mockResolvedValue("tok");
    const res = await request(makeApp()).get("/api/smartico/drive/status");
    expect(res.body).toEqual({ configured: true, connected: true });
  });

  it("reports disconnected when no token", async () => {
    tokens.get.mockResolvedValue(null);
    const res = await request(makeApp()).get("/api/smartico/drive/status");
    expect(res.body).toEqual({ configured: true, connected: false });
  });
});

describe("POST /api/smartico/drive/resolve", () => {
  it("rejects an unparseable URL", async () => {
    tokens.get.mockResolvedValue("tok");
    const res = await request(makeApp())
      .post("/api/smartico/drive/resolve")
      .send({ url: "https://example.com/nope" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_drive_url" });
  });

  it("rejects a folder id other than the configured root", async () => {
    tokens.get.mockResolvedValue("tok");
    const res = await request(makeApp())
      .post("/api/smartico/drive/resolve")
      .send({ url: "https://drive.google.com/drive/folders/someOtherId123" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "unexpected_root" });
  });

  it("401s when Drive isn't connected", async () => {
    tokens.get.mockResolvedValue(null);
    const res = await request(makeApp())
      .post("/api/smartico/drive/resolve")
      .send({ url: "https://drive.google.com/drive/folders/root1" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "drive_not_connected" });
  });

  it("returns only subfolders of the root", async () => {
    tokens.get.mockResolvedValue("tok");
    drive.getItem.mockResolvedValue({ id: "root1", name: "Promotional packs", mimeType: "x" });
    drive.list.mockResolvedValue([
      { id: "f1", name: "Tournaments", isFolder: true },
      { id: "f2", name: "Maiking (CRM only)", isFolder: true },
      { id: "x", name: "readme.txt", isFolder: false },
    ]);
    const res = await request(makeApp())
      .post("/api/smartico/drive/resolve")
      .send({ url: "https://drive.google.com/drive/u/0/folders/root1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      rootId: "root1",
      rootName: "Promotional packs",
      folders: [
        { id: "f1", name: "Tournaments" },
        { id: "f2", name: "Maiking (CRM only)" },
      ],
    });
  });
});

describe("GET /api/smartico/drive/children", () => {
  it("lists subfolders of a folder", async () => {
    tokens.get.mockResolvedValue("tok");
    drive.list.mockResolvedValue([{ id: "b1", name: "BrandA", isFolder: true }]);
    const res = await request(makeApp()).get("/api/smartico/drive/children?folderId=abc");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ folders: [{ id: "b1", name: "BrandA" }] });
  });

  it("maps a 401 from Drive to drive_not_connected and clears the dead token", async () => {
    tokens.get.mockResolvedValue("tok");
    drive.list.mockRejectedValue(new DriveApiError("expired", 401));
    const res = await request(makeApp()).get("/api/smartico/drive/children?folderId=abc");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "drive_not_connected" });
    expect(tokens.clear).toHaveBeenCalledWith("user1");
  });

  it("400s when folderId is missing", async () => {
    tokens.get.mockResolvedValue("tok");
    const res = await request(makeApp()).get("/api/smartico/drive/children");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_query" });
  });
});
