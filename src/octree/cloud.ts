import * as THREE from 'three';

import { createFrame, boundsToScene, type Frame } from '../ept/frame';
import { Hierarchy, SUBTREE } from '../ept/hierarchy';
import { fetchEpt, type EptInfo } from '../ept/info';
import { ROOT_KEY, childKeys, intersectBounds, keyBounds, keyString, type Key } from '../ept/key';
import { PointMaterials } from '../render/pointMaterial';
import type { WorkerPool } from '../worker/pool';
import { selectNodes, type LodNode } from './lod';
import { writeVisibility } from './visibility';

type NodeState = 'idle' | 'loading' | 'loaded' | 'failed';
/** Transient network errors happen when dozens of tiles stream at once: retry after 2 s, 4 s, 8 s… up to 1 min. */
const retryDelay = (failures: number) => Math.min(60_000, 2000 * 2 ** (failures - 1));

export class PointNode implements LodNode<PointNode> {
  readonly id: string;
  readonly depth: number;
  readonly box = new THREE.Box3();
  /** Scene-space origin of this node's positions (the box centre keeps float32 offsets small). */
  readonly center = new THREE.Vector3();
  readonly width: number;
  state: NodeState = 'idle';
  object: THREE.Points | null = null;
  failedAt = 0;
  failures = 0;
  lastVisible = -1;
  private kids: PointNode[] | null = null;

  constructor(
    private readonly cloud: PointCloud,
    readonly key: Key,
    readonly parent: PointNode | null,
  ) {
    this.id = keyString(key);
    this.depth = key.d;
    const { info, frame } = cloud;
    const cube = keyBounds(info.bounds, key);
    // Clip the cube to where data actually is: the root cube is as tall as it is wide (tens of km),
    // which would ruin both culling and distance estimates.
    const { min, max } = boundsToScene(frame, intersectBounds(cube, info.conforming));
    this.box.min.set(...min);
    this.box.max.set(...max);
    this.box.getCenter(this.center);
    this.width = (cube[3] - cube[0]) * frame.k;
  }

  get count(): number {
    return this.cloud.hierarchy.count(this.id) ?? 0;
  }

  get hasColor(): boolean {
    return !!this.object?.geometry.getAttribute('rgb');
  }

  get loaded(): boolean {
    return this.state === 'loaded' || this.count === 0;
  }

  children(): PointNode[] {
    if (this.kids) return this.kids;
    if (this.count === SUBTREE) return [];
    // Once a node's own count is known, the same hierarchy file listed all of its children.
    this.kids = childKeys(this.key)
      .filter((k) => this.cloud.hierarchy.has(keyString(k)))
      .map((k) => new PointNode(this.cloud, k, this));
    return this.kids;
  }
}

export interface CloudStats {
  visibleNodes: number;
  visiblePoints: number;
  loadedNodes: number;
  loadedPoints: number;
  loading: number;
  downloadedBytes: number;
  failed: number;
}

export interface PickResult {
  position: THREE.Vector3;
  classification: number;
  intensity: number;
  rgb: [number, number, number] | null;
}

export interface DataSample {
  /** 2nd–98th percentile of elevation, noise excluded. */
  z: [number, number];
  /** 1st–99th percentile of intensity. */
  intensity: [number, number];
  /** Point count per class in the sample. */
  classes: Map<number, number>;
}

/**
 * A streaming EPT point cloud. Every frame `update()` re-selects the visible cut of the octree
 * (lod.ts), starts downloads for the most important missing nodes, and evicts the least recently
 * seen nodes once memory goes past `cacheFactor × budget` points.
 */
export class PointCloud {
  readonly group = new THREE.Group();
  readonly frame: Frame;
  readonly materials: PointMaterials;
  readonly root: PointNode;
  /** Scene-space box of the real data extent. */
  readonly extent: THREE.Box3;

  budget = 3_000_000;
  minSpacingPx = 1.5;
  cacheFactor = 2.5;
  onLoad: (() => void) | null = null;

  readonly stats: CloudStats = {
    visibleNodes: 0,
    visiblePoints: 0,
    loadedNodes: 0,
    loadedPoints: 0,
    loading: 0,
    downloadedBytes: 0,
    failed: 0,
  };

  private visible: PointNode[] = [];
  private readonly loadedSet = new Set<PointNode>();
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private frameNo = 0;
  private disposed = false;

  private constructor(
    readonly info: EptInfo,
    readonly hierarchy: Hierarchy,
    private readonly pool: WorkerPool,
  ) {
    this.frame = createFrame(info.conforming);
    const { min, max } = boundsToScene(this.frame, info.conforming);
    this.extent = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
    // The root cube in local east/north/up metres, for the shader's octree lookup.
    const b = info.bounds;
    const f = this.frame;
    this.materials = new PointMaterials(
      new THREE.Vector3((b[0] - f.cx) * f.k, (b[1] - f.cy) * f.k, b[2]),
      new THREE.Vector3((b[3] - b[0]) * f.k, (b[4] - b[1]) * f.k, b[5] - b[2]),
      info.span,
    );
    this.root = new PointNode(this, ROOT_KEY, null);
  }

  /** Fetches ept.json and the top of the hierarchy, then the root tile. */
  static async open(name: string, pool: WorkerPool, signal?: AbortSignal): Promise<PointCloud> {
    const info = await fetchEpt(name, signal);
    const hierarchy = new Hierarchy(info.baseUrl);
    await hierarchy.load('0-0-0-0');
    if (!hierarchy.has('0-0-0-0')) throw new Error(`${name}: could not read the octree hierarchy`);
    const cloud = new PointCloud(info, hierarchy, pool);
    await cloud.load(cloud.root);
    if (cloud.root.state !== 'loaded') throw new Error(`${name}: could not download the root tile`);
    return cloud;
  }

  update(camera: THREE.PerspectiveCamera, viewportHeightPx: number): void {
    if (this.disposed) return;
    this.frameNo++;
    camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const projFactor = viewportHeightPx / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    this.materials.setProjection(projFactor);

    const result = selectNodes(this.root, {
      camera: camera.position,
      frustum: this.frustum,
      projFactor,
      span: this.info.span,
      budget: this.budget,
      minSpacingPx: this.minSpacingPx,
    });

    for (const n of this.visible) if (n.object) n.object.visible = false;
    this.visible = result.visible;
    for (const n of this.visible) {
      n.lastVisible = this.frameNo;
      if (n.object) n.object.visible = true;
    }
    if (this.visible.length > 0) {
      writeVisibility(this.root, new Set(this.visible), this.materials.visData);
      this.materials.visibilityChanged();
    }

    for (const n of result.needHierarchy.slice(0, 4)) void this.hierarchy.load(n.id).then(() => this.onLoad?.());

    const now = performance.now();
    for (const n of result.toLoad) {
      if (!this.pool.hasCapacity()) break;
      if (n.state === 'idle' || (n.state === 'failed' && now - n.failedAt > retryDelay(n.failures))) void this.load(n);
    }

    this.evict();

    const s = this.stats;
    s.visibleNodes = result.visible.length;
    s.visiblePoints = result.visiblePoints;
    s.loadedNodes = this.loadedSet.size;
    s.loading = this.pool.inFlight;
  }

  /** Closest visible point to a ray, within `tolerancePx` pixels of it on screen. */
  pick(ray: THREE.Ray, tolerancePx: number, projFactor: number): PickResult | null {
    const hidden = this.materials.hiddenClasses;
    const o = ray.origin;
    const d = ray.direction;
    const tolPerT = tolerancePx / projFactor;
    let bestT = Infinity;
    let best: { node: PointNode; i: number } | null = null;
    const grown = new THREE.Box3();

    for (const node of this.visible) {
      const obj = node.object;
      if (!obj) continue;
      const far = Math.max(node.box.distanceToPoint(o), 1) + node.width;
      grown.copy(node.box).expandByScalar(far * tolPerT);
      if (!ray.intersectsBox(grown)) continue;
      const pos = obj.geometry.getAttribute('position').array as Float32Array;
      const cls = obj.geometry.getAttribute('classification').array as Uint8Array;
      const ox = node.center.x - o.x;
      const oy = node.center.y - o.y;
      const oz = node.center.z - o.z;
      for (let i = 0, j = 0; i < cls.length; i++, j += 3) {
        const vx = pos[j] + ox;
        const vy = pos[j + 1] + oy;
        const vz = pos[j + 2] + oz;
        const t = vx * d.x + vy * d.y + vz * d.z;
        if (t <= 0 || t >= bestT) continue;
        const perp2 = vx * vx + vy * vy + vz * vz - t * t;
        const tol = tolPerT * t;
        if (perp2 > tol * tol || hidden.has(cls[i])) continue;
        bestT = t;
        best = { node, i };
      }
    }
    if (!best) return null;

    const g = best.node.object!.geometry;
    const i = best.i;
    const pos = g.getAttribute('position').array as Float32Array;
    const rgb = g.getAttribute('rgb')?.array as Uint8Array | undefined;
    return {
      position: new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).add(best.node.center),
      classification: (g.getAttribute('classification').array as Uint8Array)[i],
      intensity: (g.getAttribute('intensity').array as Uint16Array)[i],
      rgb: rgb ? [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]] : null,
    };
  }

  /** Median elevation of loaded points within `radius` metres (horizontally) of (x, z). */
  heightAt(x: number, z: number, radius: number): number | null {
    const hidden = this.materials.hiddenClasses;
    const ys: number[] = [];
    const r2 = radius * radius;
    for (const node of this.loadedSet) {
      const b = node.box;
      if (x < b.min.x - radius || x > b.max.x + radius || z < b.min.z - radius || z > b.max.z + radius) continue;
      const g = node.object!.geometry;
      const pos = g.getAttribute('position').array as Float32Array;
      const cls = g.getAttribute('classification').array as Uint8Array;
      for (let i = 0, j = 0; i < cls.length; i++, j += 3) {
        const dx = pos[j] + node.center.x - x;
        const dz = pos[j + 2] + node.center.z - z;
        if (dx * dx + dz * dz <= r2 && !hidden.has(cls[i])) ys.push(pos[j + 1] + node.center.y);
      }
    }
    if (ys.length === 0) return null;
    ys.sort((a, b) => a - b);
    return ys[ys.length >> 1];
  }

  /** Elevation, intensity and class statistics from the loaded nodes down to `maxDepth`. */
  sample(maxDepth = 1): DataSample {
    const hidden = this.materials.hiddenClasses;
    const zs: number[] = [];
    const is: number[] = [];
    const classes = new Map<number, number>();
    for (const node of this.loadedSet) {
      if (node.depth > maxDepth) continue;
      const g = node.object!.geometry;
      const pos = g.getAttribute('position').array as Float32Array;
      const cls = g.getAttribute('classification').array as Uint8Array;
      const inten = g.getAttribute('intensity').array as Uint16Array;
      for (let i = 0; i < cls.length; i++) {
        classes.set(cls[i], (classes.get(cls[i]) ?? 0) + 1);
        if (hidden.has(cls[i])) continue;
        zs.push(pos[i * 3 + 1] + node.center.y);
        is.push(inten[i]);
      }
    }
    return {
      z: [percentile(zs, 0.02), percentile(zs, 0.98)],
      intensity: [percentile(is, 0.01), percentile(is, 0.99)],
      classes,
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const n of this.loadedSet) n.object?.geometry.dispose();
    this.loadedSet.clear();
    this.group.removeFromParent();
    this.group.clear();
    this.materials.dispose();
  }

  private async load(node: PointNode): Promise<void> {
    node.state = 'loading';
    try {
      const res = await this.pool.decode(`${this.info.baseUrl}ept-data/${node.id}.laz`, {
        cx: this.frame.cx,
        cy: this.frame.cy,
        k: this.frame.k,
        origin: [node.center.x, node.center.y, node.center.z],
      });
      if (this.disposed) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(res.positions, 3));
      if (res.rgb) g.setAttribute('rgb', new THREE.BufferAttribute(res.rgb, 3, true));
      g.setAttribute('intensity', new THREE.BufferAttribute(res.intensity, 1, true));
      g.setAttribute('classification', new THREE.BufferAttribute(res.classification, 1, false));
      g.boundingBox = node.box.clone().translate(node.center.clone().negate());
      g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());

      const points = new THREE.Points(g, this.materials.material);
      points.position.copy(node.center);
      points.updateMatrix();
      points.matrixAutoUpdate = false;
      points.frustumCulled = false; // culled per node by the LOD walk
      points.visible = false;
      points.name = node.id;
      this.group.add(points);

      node.object = points;
      node.state = 'loaded';
      node.failures = 0;
      this.loadedSet.add(node);
      this.stats.loadedPoints += res.count;
      this.stats.downloadedBytes += res.bytes;
      this.onLoad?.();
    } catch (err) {
      if (this.disposed) return;
      node.state = 'failed';
      node.failedAt = performance.now();
      node.failures++;
      this.stats.failed++;
      console.warn(`Tile ${node.id} failed`, err);
    }
  }

  /** Least-recently-visible first, never anything visible right now. */
  private evict(): void {
    const limit = this.budget * this.cacheFactor;
    if (this.stats.loadedPoints <= limit) return;
    const candidates = [...this.loadedSet]
      .filter((n) => n.lastVisible < this.frameNo && n !== this.root)
      .sort((a, b) => a.lastVisible - b.lastVisible || b.depth - a.depth);
    for (const n of candidates) {
      if (this.stats.loadedPoints <= limit) break;
      const obj = n.object!;
      obj.geometry.dispose();
      obj.removeFromParent();
      n.object = null;
      n.state = 'idle';
      this.loadedSet.delete(n);
      this.stats.loadedPoints -= n.count;
    }
  }
}

export function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}
