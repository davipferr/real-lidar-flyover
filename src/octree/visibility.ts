import type { Key } from '../ept/key';

/**
 * The visible part of the octree, packed into a texture so the vertex shader can ask "what is the
 * deepest visible node at this point's position?" (Potree's adaptive point size).
 *
 * Why: EPT is additive, so the local point density at any spot is set by the deepest node drawn
 * there. A point should be drawn as big as that density's spacing, no bigger (blobs) and no smaller
 * (holes). That depth differs from point to point within a single node whenever its children are
 * only partly drawn, so it can't be a per-node constant.
 *
 * Layout: one RGBA8 texel per visible node, breadth-first, children in octant order.
 *   R = bitmask of visible children (bit i = octant i)
 *   G,B = 16-bit offset from this texel to its first visible child's texel
 * The shader starts at texel 0 (the root), picks the octant the point falls in, and if that child
 * is visible jumps to it: first child + number of visible siblings before it.
 */

export interface VisNode<N> {
  readonly key: Key;
  children(): N[];
}

export function octant(k: Key): number {
  return (k.x & 1) | ((k.y & 1) << 1) | ((k.z & 1) << 2);
}

/** Fills `out` (4 bytes per node) and returns how many nodes it holds. */
export function writeVisibility<N extends VisNode<N>>(root: N, visible: Set<N>, out: Uint8Array): number {
  const capacity = out.length / 4;
  const order: N[] = [root];
  for (let i = 0; i < order.length; i++) {
    const kids = order[i].children().filter((c) => visible.has(c));
    let mask = 0;
    let offset = 0;
    if (kids.length > 0 && order.length + kids.length <= capacity) {
      offset = order.length - i;
      for (const c of kids) mask |= 1 << octant(c.key);
      order.push(...kids);
    }
    out[i * 4] = mask;
    out[i * 4 + 1] = (offset >> 8) & 255;
    out[i * 4 + 2] = offset & 255;
    out[i * 4 + 3] = 255;
  }
  return order.length;
}

/** CPU twin of the shader lookup (used by tests). `p` is the position in root-cube units, 0..1 per axis. */
export function lodAt(tex: Uint8Array, p: [number, number, number], maxDepth = 24): number {
  let idx = 0;
  let depth = 0;
  let [x, y, z] = p;
  for (let i = 0; i < maxDepth; i++) {
    const mask = tex[idx * 4];
    x *= 2;
    y *= 2;
    z *= 2;
    const cx = Math.min(Math.max(Math.floor(x), 0), 1);
    const cy = Math.min(Math.max(Math.floor(y), 0), 1);
    const cz = Math.min(Math.max(Math.floor(z), 0), 1);
    const o = cx | (cy << 1) | (cz << 2);
    if ((mask & (1 << o)) === 0) break;
    const offset = tex[idx * 4 + 1] * 256 + tex[idx * 4 + 2];
    let before = 0;
    for (let b = 0; b < o; b++) if (mask & (1 << b)) before++;
    idx += offset + before;
    x -= cx;
    y -= cy;
    z -= cz;
    depth++;
  }
  return depth;
}
