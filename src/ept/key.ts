/**
 * EPT octree keys. A node is "D-X-Y-Z": depth D, and its cell index along each axis at that depth.
 * The root is 0-0-0-0; node D-X-Y-Z has 8 children at D+1 with indices 2X+{0,1}, 2Y+{0,1}, 2Z+{0,1}.
 */

/** [minX, minY, minZ, maxX, maxY, maxZ], in the dataset's native SRS (EPSG:3857 metres for USGS). */
export type Bounds = [number, number, number, number, number, number];

export interface Key {
  d: number;
  x: number;
  y: number;
  z: number;
}

export const ROOT_KEY: Key = { d: 0, x: 0, y: 0, z: 0 };

export function keyString(k: Key): string {
  return `${k.d}-${k.x}-${k.y}-${k.z}`;
}

export function parseKey(s: string): Key {
  const parts = s.split('-').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0)) throw new Error(`Bad EPT key "${s}"`);
  const [d, x, y, z] = parts;
  return { d, x, y, z };
}

export function childKeys(k: Key): Key[] {
  const out: Key[] = [];
  for (let i = 0; i < 8; i++) {
    out.push({ d: k.d + 1, x: 2 * k.x + (i & 1), y: 2 * k.y + ((i >> 1) & 1), z: 2 * k.z + ((i >> 2) & 1) });
  }
  return out;
}

export function parentKey(k: Key): Key | null {
  if (k.d === 0) return null;
  return { d: k.d - 1, x: k.x >> 1, y: k.y >> 1, z: k.z >> 1 };
}

/** The cube a node covers: the root cube split in half D times. */
export function keyBounds(root: Bounds, k: Key): Bounds {
  const n = 2 ** k.d;
  const sx = (root[3] - root[0]) / n;
  const sy = (root[4] - root[1]) / n;
  const sz = (root[5] - root[2]) / n;
  const minX = root[0] + k.x * sx;
  const minY = root[1] + k.y * sy;
  const minZ = root[2] + k.z * sz;
  return [minX, minY, minZ, minX + sx, minY + sy, minZ + sz];
}

/** Intersection of two boxes (assumed to overlap). */
export function intersectBounds(a: Bounds, b: Bounds): Bounds {
  return [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.min(a[3], b[3]),
    Math.min(a[4], b[4]),
    Math.min(a[5], b[5]),
  ];
}
