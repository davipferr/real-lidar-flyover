import type { Box3, Frustum, Vector3 } from 'three';

import { SUBTREE } from '../ept/hierarchy';

/**
 * Level-of-detail selection: which octree nodes to draw this frame, and which to download next.
 *
 * EPT is *additive*: the root holds a sparse sample of the whole dataset, and each child adds the
 * points needed to double the density in its octant. So drawing a node never replaces its parent,
 * it adds to it. A view is a "cut" through the tree: the root plus every descendant the camera
 * needs, down to where points would land closer than a pixel or so apart on screen.
 *
 * The walk is best-first: nodes are taken in order of projected size (big, near nodes first), and it
 * stops when the point budget is full. Whatever the budget, the most visible detail is chosen first.
 * A node's children are only considered once the node itself is loaded, so the cloud refines from
 * coarse to fine instead of filling in random distant tiles.
 */

export interface LodNode<N> {
  readonly depth: number;
  /** Scene-space box (the octree cube clipped to the data's real extent). */
  readonly box: Box3;
  /** Horizontal width of the node's cube in metres. Points inside are about width / span apart. */
  readonly width: number;
  /** Number of points, or SUBTREE if the hierarchy below this node has not been fetched. */
  readonly count: number;
  readonly loaded: boolean;
  /** Children known so far. */
  children(): N[];
}

export interface LodParams {
  camera: Vector3;
  frustum: Frustum;
  /** Pixels per metre at distance 1: viewportHeight / (2·tan(fov/2)). */
  projFactor: number;
  span: number;
  /** Max points to draw (loaded nodes) plus points about to load. */
  budget: number;
  /** Stop refining once a node's points would be this close together on screen. */
  minSpacingPx: number;
}

export interface LodResult<N> {
  /** Loaded nodes to draw, in priority order (parents always before their children). */
  visible: N[];
  /** Nodes to download, highest priority first. */
  toLoad: N[];
  /** Nodes whose hierarchy file is needed before going deeper. */
  needHierarchy: N[];
  visiblePoints: number;
}

interface Entry<N> {
  node: N;
  dist: number;
  priority: number;
}

export function nodeDistance(box: Box3, camera: Vector3): number {
  return Math.max(box.distanceToPoint(camera), 1);
}

/** On-screen size of a node, in pixels. */
export function projectedSize(width: number, dist: number, projFactor: number): number {
  return (width * projFactor) / dist;
}

export function selectNodes<N extends LodNode<N>>(root: N, p: LodParams): LodResult<N> {
  const visible: N[] = [];
  const toLoad: N[] = [];
  const needHierarchy: N[] = [];
  let committed = 0;
  let visiblePoints = 0;

  const heap = new MaxHeap<Entry<N>>((a, b) => a.priority - b.priority);
  const push = (node: N) => {
    const dist = nodeDistance(node.box, p.camera);
    heap.push({ node, dist, priority: projectedSize(node.width, dist, p.projFactor) });
  };
  push(root);

  while (heap.size > 0) {
    const { node, dist } = heap.pop()!;
    if (!p.frustum.intersectsBox(node.box)) continue;
    if (node.count === SUBTREE) {
      needHierarchy.push(node);
      continue;
    }
    if (committed + node.count > p.budget) break;
    committed += node.count;

    if (!node.loaded) {
      toLoad.push(node);
      continue;
    }
    visible.push(node);
    visiblePoints += node.count;

    const spacingPx = projectedSize(node.width / p.span, dist, p.projFactor);
    if (spacingPx > p.minSpacingPx) for (const child of node.children()) push(child);
  }

  return { visible, toLoad, needHierarchy, visiblePoints };
}

/** Binary max-heap. */
export class MaxHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: (a: T, b: T) => number) {}

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(a[i], a[parent]) <= 0) break;
      [a[i], a[parent]] = [a[parent], a[i]];
      i = parent;
    }
  }

  pop(): T | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < a.length && this.compare(a[l], a[best]) > 0) best = l;
        if (r < a.length && this.compare(a[r], a[best]) > 0) best = r;
        if (best === i) break;
        [a[i], a[best]] = [a[best], a[i]];
        i = best;
      }
    }
    return top;
  }
}
