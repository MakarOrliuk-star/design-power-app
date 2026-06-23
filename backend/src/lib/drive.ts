/**
 * Minimal Google Drive v3 REST client (read-only) for the Smartico feature.
 * We talk to the REST endpoints directly with the user's access token instead
 * of pulling in the heavyweight `googleapis` package — we only need three
 * operations: read folder metadata, list a folder's children, and download a
 * file's bytes. `supportsAllDrives`/`includeItemsFromAllDrives` keep it working
 * for folders that are "Shared with me" or live on a shared drive.
 */

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** A Drive REST error carrying the HTTP status so callers can map 401/404. */
export class DriveApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DriveApiError";
  }
}

export interface DriveItem {
  id: string;
  name: string;
  isFolder: boolean;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
}

/**
 * Extract a folder id from a pasted Drive URL (or accept a bare id).
 * Handles the common shapes:
 *   - https://drive.google.com/drive/folders/<id>
 *   - https://drive.google.com/drive/u/0/folders/<id>?usp=sharing
 *   - https://drive.google.com/open?id=<id>
 *   - <id>  (already just the id)
 * Drive ids are URL-safe base64-ish: letters, digits, `-` and `_`.
 */
export function parseDriveFolderId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  // /folders/<id>
  const folders = raw.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folders?.[1]) return folders[1];

  // ?id=<id> or &id=<id>
  const idParam = raw.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParam?.[1]) return idParam[1];

  // Bare id (no slashes, looks like a Drive id and long enough to be real).
  if (/^[a-zA-Z0-9_-]{10,}$/.test(raw)) return raw;

  return null;
}

async function driveGet(accessToken: string, url: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (err) {
    throw new DriveApiError(`Drive request failed: ${String(err)}`, 0);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new DriveApiError(
      `Drive API ${res.status}: ${text.slice(0, 200)}`,
      res.status,
    );
  }
  return res;
}

/** Folder/file metadata — used for breadcrumbs and root-descendant checks. */
export async function getDriveItem(accessToken: string, fileId: string): Promise<DriveFile> {
  const params = new URLSearchParams({
    fields: "id,name,mimeType,parents",
    supportsAllDrives: "true",
  });
  const res = await driveGet(accessToken, `${DRIVE_API}/files/${fileId}?${params.toString()}`);
  return (await res.json()) as DriveFile;
}

/**
 * List the immediate children of a folder (folders + files), following
 * pagination. Sorted folders-first then by name for a stable UI.
 */
export async function listFolderChildren(
  accessToken: string,
  folderId: string,
): Promise<DriveItem[]> {
  const items: DriveItem[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType)",
      pageSize: "1000",
      orderBy: "folder,name",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await driveGet(accessToken, `${DRIVE_API}/files?${params.toString()}`);
    const data = (await res.json()) as {
      nextPageToken?: string;
      files?: Array<{ id: string; name: string; mimeType: string }>;
    };
    for (const f of data.files ?? []) {
      items.push({ id: f.id, name: f.name, isFolder: f.mimeType === FOLDER_MIME });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return items;
}

/** Download a file's raw bytes (alt=media). */
export async function downloadDriveFile(accessToken: string, fileId: string): Promise<Buffer> {
  const params = new URLSearchParams({ alt: "media", supportsAllDrives: "true" });
  const res = await driveGet(accessToken, `${DRIVE_API}/files/${fileId}?${params.toString()}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

/** Find a direct child folder by (case-insensitive, trimmed) name. */
export function findChildFolder(items: DriveItem[], name: string): DriveItem | undefined {
  const target = name.trim().toLowerCase();
  return items.find((i) => i.isFolder && i.name.trim().toLowerCase() === target);
}

/** Find a direct child file by exact name (e.g. "email.webp"). */
export function findChildFile(items: DriveItem[], name: string): DriveItem | undefined {
  const target = name.trim().toLowerCase();
  return items.find((i) => !i.isFolder && i.name.trim().toLowerCase() === target);
}
