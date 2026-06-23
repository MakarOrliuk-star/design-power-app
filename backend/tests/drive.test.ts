import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseDriveFolderId,
  listFolderChildren,
  getDriveItem,
  downloadDriveFile,
  findChildFolder,
  findChildFile,
  DriveApiError,
  type DriveItem,
} from "../src/lib/drive.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";

function jsonResponse(bodyObj: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => bodyObj,
    text: async () => JSON.stringify(bodyObj),
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("parseDriveFolderId", () => {
  const ID = "1f8jxV6k7Hb5a2sp-_vQR6bVleFF2pgPf";

  it("extracts the id from a /u/0/folders/ share URL", () => {
    expect(parseDriveFolderId(`https://drive.google.com/drive/u/0/folders/${ID}`)).toBe(ID);
  });

  it("extracts the id from a plain /folders/ URL with query params", () => {
    expect(parseDriveFolderId(`https://drive.google.com/drive/folders/${ID}?usp=sharing`)).toBe(ID);
  });

  it("extracts the id from an open?id= URL", () => {
    expect(parseDriveFolderId(`https://drive.google.com/open?id=${ID}`)).toBe(ID);
  });

  it("accepts a bare id", () => {
    expect(parseDriveFolderId(`  ${ID}  `)).toBe(ID);
  });

  it("returns null for junk / non-Drive input", () => {
    expect(parseDriveFolderId("")).toBeNull();
    expect(parseDriveFolderId("https://example.com/foo")).toBeNull();
    expect(parseDriveFolderId("short")).toBeNull();
  });
});

describe("listFolderChildren", () => {
  it("classifies folders vs files and follows pagination", async () => {
    const page1 = jsonResponse({
      nextPageToken: "tok2",
      files: [
        { id: "a", name: "Tournaments", mimeType: FOLDER_MIME },
        { id: "b", name: "email.webp", mimeType: "image/webp" },
      ],
    });
    const page2 = jsonResponse({
      files: [{ id: "c", name: "Maiking (CRM only)", mimeType: FOLDER_MIME }],
    });
    const fetchMock = vi.fn(async () => page1).mockImplementationOnce(async () => page1).mockImplementationOnce(async () => page2);
    vi.stubGlobal("fetch", fetchMock);

    const items = await listFolderChildren("tok", "root");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First call has no pageToken; second carries it.
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("pageToken");
    expect(String(fetchMock.mock.calls[1]![0])).toContain("pageToken=tok2");
    expect(items).toEqual([
      { id: "a", name: "Tournaments", isFolder: true },
      { id: "b", name: "email.webp", isFolder: false },
      { id: "c", name: "Maiking (CRM only)", isFolder: true },
    ]);
    // Auth header is sent.
    const opts = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(opts.headers.Authorization).toBe("Bearer tok");
  });

  it("throws DriveApiError with the HTTP status on 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "invalid" }, 401)));
    await expect(listFolderChildren("bad", "root")).rejects.toMatchObject({
      name: "DriveApiError",
      status: 401,
    });
  });
});

describe("getDriveItem / downloadDriveFile", () => {
  it("returns folder metadata including parents", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ id: "x", name: "CRM", mimeType: FOLDER_MIME, parents: ["p1"] }),
      ),
    );
    const meta = await getDriveItem("tok", "x");
    expect(meta).toEqual({ id: "x", name: "CRM", mimeType: FOLDER_MIME, parents: ["p1"] });
  });

  it("downloads raw bytes as a Buffer", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer,
      })) as unknown as typeof fetch,
    );
    const buf = await downloadDriveFile("tok", "x");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect([...buf]).toEqual([1, 2, 3, 4]);
  });
});

describe("findChildFolder / findChildFile", () => {
  const items: DriveItem[] = [
    { id: "1", name: "CRM", isFolder: true },
    { id: "2", name: "SMARTICO", isFolder: true },
    { id: "3", name: "email.webp", isFolder: false },
    { id: "4", name: "CRM", isFolder: false }, // a file also named CRM — must not match the folder lookup
  ];

  it("matches a folder by case-insensitive name", () => {
    expect(findChildFolder(items, "crm")?.id).toBe("1");
  });

  it("matches a file by name and ignores same-named folders", () => {
    expect(findChildFile(items, "email.webp")?.id).toBe("3");
    expect(findChildFile(items, "CRM")?.id).toBe("4");
  });

  it("returns undefined when absent", () => {
    expect(findChildFolder(items, "CONTENT")).toBeUndefined();
  });
});

describe("DriveApiError", () => {
  it("carries the status code", () => {
    const e = new DriveApiError("nope", 404);
    expect(e.status).toBe(404);
    expect(e).toBeInstanceOf(Error);
  });
});
