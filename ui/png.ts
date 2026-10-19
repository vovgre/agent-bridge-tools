// Synthetic PNG pictures without dependencies: 8-bit grayscale, filled rectangles. For test plans and size limits.
import { deflateSync } from "node:zlib";

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 = black … 255 = white. */
  gray: number;
}

/** A width × height grayscale PNG on `background`, with `rects` painted in order (pixel coordinates, clipped). */
export function png(width: number, height: number, rects: Rect[] = [], background = 255): Buffer {
  const stride = width + 1;
  const raw = Buffer.alloc(stride * height, background);
  for (let y = 0; y < height; y++) raw[y * stride] = 0;
  for (const r of rects) {
    const x0 = Math.max(0, Math.round(r.x)), x1 = Math.min(width, Math.round(r.x + r.w));
    const y0 = Math.max(0, Math.round(r.y)), y1 = Math.min(height, Math.round(r.y + r.h));
    for (let y = y0; y < y1; y++) raw.fill(r.gray, y * stride + 1 + x0, y * stride + 1 + x1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Wall outlines (`thickness` px) around boxes given as fractions of the picture, like a floor plan drawing. */
export function outlines(width: number, height: number, boxes: { x0: number; y0: number; x1: number; y1: number }[], thickness = 6, gray = 40): Rect[] {
  return boxes.flatMap((b) => {
    const x = b.x0 * width, y = b.y0 * height, w = (b.x1 - b.x0) * width, h = (b.y1 - b.y0) * height, t = thickness / 2;
    return [
      { x: x - t, y: y - t, w: w + 2 * t, h: thickness, gray },
      { x: x - t, y: y + h - t, w: w + 2 * t, h: thickness, gray },
      { x: x - t, y: y - t, w: thickness, h: h + 2 * t, gray },
      { x: x + w - t, y: y - t, w: thickness, h: h + 2 * t, gray },
    ];
  });
}
