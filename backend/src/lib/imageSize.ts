/**
 * Dependency-free image dimension reader + fal aspect-ratio mapper.
 *
 * Used by the Edit flow so an edited image keeps the SOURCE image's aspect ratio
 * (TASK: "если картинка была 1:1 — на edit идёт 1:1, если 9:16 — то 9:16"). The
 * source aspect isn't persisted anywhere (it only ever lived in the BullMQ job
 * payload), so we read it back from the actual pixels of the stored image.
 *
 * Supports the formats Cloudinary/fal can emit: PNG, JPEG, GIF, WebP.
 */

export interface ImageSize {
  width: number;
  height: number;
}

/** Parse width/height from the header bytes of an image buffer. Returns null if
 *  the format isn't recognised or the header is too short. */
export function readImageSize(buf: Buffer): ImageSize | null {
  if (buf.length < 24) return null;

  // PNG — 8-byte signature, then IHDR with width/height as big-endian uint32.
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF — "GIF87a"/"GIF89a", then little-endian uint16 width/height.
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // JPEG — scan segments for a Start-Of-Frame (SOFn) marker.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off += 1;
        continue;
      }
      const marker = buf[off + 1]!;
      // SOF0..SOF15, excluding DHT(C4), JPG(C8), DAC(CC).
      if (
        marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      ) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      // Standalone markers (no length payload): RSTn, SOI, EOI, TEM.
      if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
        off += 2;
        continue;
      }
      const segLen = buf.readUInt16BE(off + 2);
      if (segLen < 2) return null;
      off += 2 + segLen;
    }
    return null;
  }

  // WebP — "RIFF"...."WEBP" then a VP8/VP8L/VP8X chunk.
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    const fourcc = buf.toString("ascii", 12, 16);
    if (fourcc === "VP8X" && buf.length >= 30) {
      // 24-bit (width-1, height-1), little-endian.
      const w = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
      const h = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
      return { width: w, height: h };
    }
    if (fourcc === "VP8 " && buf.length >= 30) {
      // Lossy: 14-bit dimensions at offset 26/28 (after the 0x9d012a start code).
      const w = buf.readUInt16LE(26) & 0x3fff;
      const h = buf.readUInt16LE(28) & 0x3fff;
      return { width: w, height: h };
    }
    if (fourcc === "VP8L" && buf.length >= 25) {
      // Lossless: 14-bit each, packed after the 0x2f signature byte at offset 20.
      const b0 = buf[21]!, b1 = buf[22]!, b2 = buf[23]!, b3 = buf[24]!;
      const w = 1 + (((b1 & 0x3f) << 8) | b0);
      const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width: w, height: h };
    }
    return null;
  }

  return null;
}

// fal nano-banana-2 supported aspect ratios (the values the generator already
// sends). We pick whichever is closest to the source's pixel ratio.
const FAL_ASPECTS: { name: string; ratio: number }[] = [
  { name: "1:1", ratio: 1 },
  { name: "3:4", ratio: 3 / 4 },
  { name: "4:3", ratio: 4 / 3 },
  { name: "2:3", ratio: 2 / 3 },
  { name: "3:2", ratio: 3 / 2 },
  { name: "9:16", ratio: 9 / 16 },
  { name: "16:9", ratio: 16 / 9 },
  { name: "21:9", ratio: 21 / 9 },
  { name: "9:21", ratio: 9 / 21 },
];

/** Map pixel dimensions to the nearest fal aspect_ratio string. */
export function nearestFalAspect(width: number, height: number): string {
  if (!(width > 0) || !(height > 0)) return "1:1";
  const r = width / height;
  let best = FAL_ASPECTS[0]!;
  for (const a of FAL_ASPECTS) {
    if (Math.abs(a.ratio - r) < Math.abs(best.ratio - r)) best = a;
  }
  return best.name;
}

/**
 * Fetch an image and return its pixel dimensions, or null on any failure.
 * Downloads the whole image (avoids Range-support assumptions); callers here
 * deal with single images, so this is cheap enough. Shared by probeAspectRatio
 * and the Scale flow (which needs the exact source size to build the outpaint
 * canvas on the backend rather than trusting client-reported dimensions).
 */
export async function probeImageSize(url: string): Promise<ImageSize | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return readImageSize(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

/**
 * Fetch an image and return its nearest fal aspect_ratio, or null on any failure
 * (caller falls back to a default).
 */
export async function probeAspectRatio(url: string): Promise<string | null> {
  const size = await probeImageSize(url);
  return size ? nearestFalAspect(size.width, size.height) : null;
}
