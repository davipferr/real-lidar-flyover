import type { LazPerf } from 'laz-perf';

/**
 * LAS is the standard LiDAR file format: a fixed header, then one fixed-size binary record per point.
 * LAZ is the same thing compressed (LASzip); laz-perf is LASzip compiled to WebAssembly, and it hands
 * back each point as an uncompressed LAS record, which is parsed here by byte offset.
 */

export interface LasHeader {
  versionMinor: number;
  /** Point data record format 0–10 (the LAZ "compressed" bits 6–7 are stripped). */
  pointFormat: number;
  pointLength: number;
  count: number;
  scale: [number, number, number];
  offset: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
}

export function parseLasHeader(buf: ArrayBuffer): LasHeader {
  const v = new DataView(buf);
  const magic = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
  if (magic !== 'LASF') throw new Error('Not a LAS/LAZ file');
  const versionMinor = v.getUint8(25);
  let count = v.getUint32(107, true);
  // LAS 1.4 moved the count to a 64-bit field; the legacy one is 0 when it overflows.
  if (versionMinor >= 4 && count === 0) count = Number(v.getBigUint64(247, true));
  const f = (o: number) => v.getFloat64(o, true);
  return {
    versionMinor,
    pointFormat: v.getUint8(104) & 0x3f,
    pointLength: v.getUint16(105, true),
    count,
    scale: [f(131), f(139), f(147)],
    offset: [f(155), f(163), f(171)],
    // The header stores max before min, per axis.
    max: [f(179), f(195), f(211)],
    min: [f(187), f(203), f(219)],
  };
}

/** Byte offset of Red/Green/Blue in a record, or −1 if the format has no colour. */
export function rgbOffset(format: number): number {
  switch (format) {
    case 2:
      return 20;
    case 3:
    case 5:
      return 28;
    case 7:
    case 8:
    case 10:
      return 30;
    default:
      return -1;
  }
}

/** Formats 0–5 pack classification into the low 5 bits of byte 15; formats 6–10 give it all of byte 16. */
export function classificationLayout(format: number): { offset: number; mask: number } {
  return format >= 6 ? { offset: 16, mask: 0xff } : { offset: 15, mask: 0x1f };
}

/** Where to put the points: the dataset frame (see ept/frame.ts) and the node's origin in scene space. */
export interface DecodeTransform {
  cx: number;
  cy: number;
  k: number;
  origin: [number, number, number];
}

export interface DecodedPoints {
  count: number;
  /** Scene-space xyz relative to `origin`. */
  positions: Float32Array;
  /** 8-bit RGB, or null if the file has no colour. */
  rgb: Uint8Array | null;
  intensity: Uint16Array;
  classification: Uint8Array;
}

export function decodeLaz(lp: LazPerf, buf: ArrayBuffer, t: DecodeTransform): DecodedPoints {
  const header = parseLasHeader(buf);
  const bytes = new Uint8Array(buf);
  const filePtr = lp._malloc(bytes.byteLength);
  lp.HEAPU8.set(bytes, filePtr);
  const laszip = new lp.LASZip();
  let pointPtr = 0;
  try {
    laszip.open(filePtr, bytes.byteLength);
    const count = laszip.getCount();
    const length = laszip.getPointLength();
    const format = laszip.getPointFormat() & 0x3f;
    pointPtr = lp._malloc(length);

    const positions = new Float32Array(count * 3);
    const intensity = new Uint16Array(count);
    const classification = new Uint8Array(count);
    const rgbAt = rgbOffset(format);
    const rgb16 = rgbAt >= 0 ? new Uint16Array(count * 3) : null;
    const cls = classificationLayout(format);

    const [sx, sy, sz] = header.scale;
    const [ox, oy, oz] = header.offset;
    const { cx, cy, k, origin } = t;

    let heap = lp.HEAPU8.buffer;
    let view = new DataView(heap, pointPtr, length);
    let rgbMax = 0;
    for (let i = 0; i < count; i++) {
      laszip.getPoint(pointPtr);
      // The WASM heap can be replaced if memory grows; re-wrap the view if so.
      if (lp.HEAPU8.buffer !== heap) {
        heap = lp.HEAPU8.buffer;
        view = new DataView(heap, pointPtr, length);
      }
      const x = view.getInt32(0, true) * sx + ox;
      const y = view.getInt32(4, true) * sy + oy;
      const z = view.getInt32(8, true) * sz + oz;
      const j = i * 3;
      positions[j] = (x - cx) * k - origin[0];
      positions[j + 1] = z - origin[1];
      positions[j + 2] = -(y - cy) * k - origin[2];
      intensity[i] = view.getUint16(12, true);
      classification[i] = view.getUint8(cls.offset) & cls.mask;
      if (rgb16) {
        const r = view.getUint16(rgbAt, true);
        const g = view.getUint16(rgbAt + 2, true);
        const b = view.getUint16(rgbAt + 4, true);
        rgb16[j] = r;
        rgb16[j + 1] = g;
        rgb16[j + 2] = b;
        rgbMax = Math.max(rgbMax, r, g, b);
      }
    }

    let rgb: Uint8Array | null = null;
    // Some datasets declare RGB but leave it all zero (USGS New York City does): treat as no colour.
    if (rgb16 && rgbMax > 0) {
      // The spec says 16-bit colour, but many files store 0–255. Only scale down true 16-bit data.
      const shift = rgbMax > 255 ? 8 : 0;
      rgb = new Uint8Array(rgb16.length);
      for (let i = 0; i < rgb16.length; i++) rgb[i] = rgb16[i] >> shift;
    }

    return { count, positions, rgb, intensity, classification };
  } finally {
    if (pointPtr) lp._free(pointPtr);
    laszip.delete();
    lp._free(filePtr);
  }
}
