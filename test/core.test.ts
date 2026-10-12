import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createLazPerf } from 'laz-perf';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { positionToView, viewToPosition } from '../src/controls/rig';
import { PLACES, formatCount, prettyName } from '../src/data/places';
import { createFrame, fromScene, latLonToMercator, latLonToScene, mercatorToLatLon, toScene } from '../src/ept/frame';
import { Hierarchy, SUBTREE } from '../src/ept/hierarchy';
import { parseEpt, type EptJson } from '../src/ept/info';
import { childKeys, keyBounds, keyString, parentKey, parseKey, type Bounds, type Key } from '../src/ept/key';
import { classificationLayout, decodeLaz, parseLasHeader, rgbOffset } from '../src/las/decode';
import { percentile } from '../src/octree/cloud';
import { MaxHeap, selectNodes, type LodNode } from '../src/octree/lod';
import { lodAt, octant, writeVisibility } from '../src/octree/visibility';
import { ELEVATION_STOPS, sampleRamp } from '../src/render/palette';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const sfJson = JSON.parse(readFileSync(fixture('sf-ept.json'), 'utf8')) as EptJson;

describe('EPT keys', () => {
  it('round-trips and walks the tree', () => {
    const k = parseKey('3-5-2-7');
    expect(keyString(k)).toBe('3-5-2-7');
    const kids = childKeys(k);
    expect(kids).toHaveLength(8);
    expect(new Set(kids.map(keyString)).size).toBe(8);
    for (const c of kids) expect(parentKey(c)).toEqual(k);
    expect(parentKey({ d: 0, x: 0, y: 0, z: 0 })).toBeNull();
    expect(() => parseKey('1-2-3')).toThrow();
  });

  it('splits the root cube into octants that tile it exactly', () => {
    const root: Bounds = [0, 0, 0, 8, 8, 8];
    expect(keyBounds(root, { d: 1, x: 1, y: 0, z: 1 })).toEqual([4, 0, 4, 8, 4, 8]);
    const volume = childKeys({ d: 0, x: 0, y: 0, z: 0 })
      .map((k) => keyBounds(root, k))
      .reduce((s, b) => s + (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2]), 0);
    expect(volume).toBe(512);
  });
});

describe('frame', () => {
  it('converts lat/lon ↔ Web Mercator', () => {
    const m = latLonToMercator(40.7484, -73.9857);
    const back = mercatorToLatLon(m.x, m.y);
    expect(back.lat).toBeCloseTo(40.7484, 9);
    expect(back.lon).toBeCloseTo(-73.9857, 9);
    const zero = latLonToMercator(0, 0);
    expect(zero.x).toBe(0);
    expect(zero.y).toBeCloseTo(0, 6);
  });

  it('removes Mercator stretch: 1 km east is 1 km in the scene', () => {
    const f = createFrame(sfJson.boundsConforming);
    const lat = mercatorToLatLon(f.cx, f.cy).lat;
    expect(f.k).toBeCloseTo(Math.cos((lat * Math.PI) / 180), 12);
    // 1 km east along the parallel, measured on the sphere.
    const a = latLonToScene(f, lat, -122.45);
    const dLon = (1000 / (6378137 * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
    const b = latLonToScene(f, lat, -122.45 + dLon);
    expect(b.x - a.x).toBeCloseTo(1000, 6);
  });

  it('maps north to −z and round-trips', () => {
    const f = createFrame(sfJson.boundsConforming);
    const [, , z] = toScene(f, f.cx, f.cy + 100, 5);
    expect(z).toBeLessThan(0);
    const s = toScene(f, -13630000, 4550000, 123.4);
    const m = fromScene(f, ...s);
    expect(m.x).toBeCloseTo(-13630000, 6);
    expect(m.y).toBeCloseTo(4550000, 6);
    expect(m.z).toBe(123.4);
  });
});

describe('ept.json', () => {
  it('parses the San Francisco metadata', () => {
    const info = parseEpt('CA_SanFrancisco_1_B23', 'x/', sfJson);
    expect(info.span).toBe(128);
    expect(info.hasRgb).toBe(false);
    expect(info.points).toBeGreaterThan(1e10);
  });

  it('rejects data it cannot decode', () => {
    expect(() => parseEpt('a', 'x/', { ...sfJson, dataType: 'zstandard' })).toThrow(/LAZ/);
    expect(() => parseEpt('a', 'x/', { ...sfJson, srs: { horizontal: '26918' } })).toThrow(/3857/);
  });
});

describe('hierarchy', () => {
  it('merges subtree files over their −1 placeholders', async () => {
    const files: Record<string, Record<string, number>> = {
      'x/ept-hierarchy/0-0-0-0.json': { '0-0-0-0': 100, '1-0-0-0': SUBTREE },
      'x/ept-hierarchy/1-0-0-0.json': { '1-0-0-0': 40, '2-0-0-0': 10 },
    };
    const h = new Hierarchy('x/', async (url) => files[url]);
    await h.load('0-0-0-0');
    expect(h.count('1-0-0-0')).toBe(SUBTREE);
    expect(h.count('2-0-0-0')).toBeUndefined();
    await h.load('1-0-0-0');
    expect(h.count('1-0-0-0')).toBe(40);
    expect(h.count('2-0-0-0')).toBe(10);
    // A late merge of the parent file must not reset the real count.
    h.merge(files['x/ept-hierarchy/0-0-0-0.json']);
    expect(h.count('1-0-0-0')).toBe(40);
  });
});

describe('LAS/LAZ decoding', () => {
  it('knows the record layouts', () => {
    expect(rgbOffset(1)).toBe(-1);
    expect(rgbOffset(2)).toBe(20);
    expect(rgbOffset(3)).toBe(28);
    expect(rgbOffset(7)).toBe(30);
    expect(classificationLayout(1)).toEqual({ offset: 15, mask: 0x1f });
    expect(classificationLayout(6)).toEqual({ offset: 16, mask: 0xff });
  });

  it('decodes a real USGS tile (San Francisco root node)', async () => {
    const buf = readFileSync(fixture('sf-root.laz'));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const header = parseLasHeader(ab);
    expect(header.pointFormat).toBe(1);
    expect(header.count).toBe(11056);

    const f = createFrame(sfJson.boundsConforming);
    const origin: [number, number, number] = [100, 50, -200];
    const lp = await createLazPerf();
    const pts = decodeLaz(lp, ab, { cx: f.cx, cy: f.cy, k: f.k, origin });
    expect(pts.count).toBe(11056);
    expect(pts.rgb).toBeNull();

    // Every point, mapped back to Mercator, lies inside the header's bounding box.
    let inside = 0;
    for (let i = 0; i < pts.count; i++) {
      const m = fromScene(f, pts.positions[i * 3] + origin[0], pts.positions[i * 3 + 1] + origin[1], pts.positions[i * 3 + 2] + origin[2]);
      const ok =
        m.x >= header.min[0] - 0.02 && m.x <= header.max[0] + 0.02 &&
        m.y >= header.min[1] - 0.02 && m.y <= header.max[1] + 0.02 &&
        m.z >= header.min[2] - 0.02 && m.z <= header.max[2] + 0.02;
      if (ok) inside++;
    }
    expect(inside).toBe(pts.count);

    // A classified USGS tile: mostly ground (2), and every class code is a valid ASPRS value.
    const classes = new Map<number, number>();
    for (const c of pts.classification) classes.set(c, (classes.get(c) ?? 0) + 1);
    expect(classes.get(2)).toBeGreaterThan(pts.count * 0.1);
    for (const c of classes.keys()) expect(c).toBeLessThan(32);
    expect(Math.max(...pts.intensity)).toBeGreaterThan(0);
  });
});

// A synthetic octree: each node has 1000 points, 8 children, down to depth 4.
class FakeNode implements LodNode<FakeNode> {
  loaded = true;
  count = 1000;
  readonly width: number;
  private kids: FakeNode[] | null = null;
  constructor(
    readonly depth: number,
    readonly box: THREE.Box3,
  ) {
    this.width = box.max.x - box.min.x;
  }
  children(): FakeNode[] {
    if (this.depth >= 4) return [];
    if (!this.kids) {
      const c = this.box.getCenter(new THREE.Vector3());
      this.kids = [];
      for (let i = 0; i < 8; i++) {
        const min = new THREE.Vector3(i & 1 ? c.x : this.box.min.x, i & 2 ? c.y : this.box.min.y, i & 4 ? c.z : this.box.min.z);
        const max = min.clone().addScaledVector(this.box.max.clone().sub(this.box.min), 0.5);
        this.kids.push(new FakeNode(this.depth + 1, new THREE.Box3(min, max)));
      }
    }
    return this.kids;
  }
}

function lodSetup(budget: number, camPos = new THREE.Vector3(0, 0, 3000)) {
  const root = new FakeNode(0, new THREE.Box3(new THREE.Vector3(-1000, -1000, -1000), new THREE.Vector3(1000, 1000, 1000)));
  const cam = new THREE.PerspectiveCamera(60, 1, 1, 1e7);
  cam.position.copy(camPos);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
  );
  const params = { camera: cam.position, frustum, projFactor: 1000 / (2 * Math.tan(Math.PI / 6)), span: 128, budget, minSpacingPx: 1 };
  return { root, params };
}

describe('LOD selection', () => {
  it('fills the budget best-first and never exceeds it', () => {
    const { root, params } = lodSetup(20_000);
    const r = selectNodes(root, params);
    expect(r.visiblePoints).toBeLessThanOrEqual(20_000);
    expect(r.visible.length).toBe(20);
    expect(r.visible[0]).toBe(root);
    // Every node's parent is drawn too (a connected cut), and comes first.
    const order = new Map(r.visible.map((n, i) => [n, i]));
    for (const n of r.visible) for (const c of n.children()) if (order.has(c)) expect(order.get(c)!).toBeGreaterThan(order.get(n)!);
  });

  it('prefers the nodes nearest the camera', () => {
    const { root, params } = lodSetup(9_000);
    const r = selectNodes(root, params);
    const kids = r.visible.filter((n) => n.depth === 1);
    // The 4 octants facing the camera (+z) win over the 4 behind them.
    expect(kids.filter((n) => n.box.min.z >= 0).length).toBe(4);
  });

  it('stops refining once points are dense enough on screen', () => {
    const { root, params } = lodSetup(1e9, new THREE.Vector3(0, 0, 400_000));
    const r = selectNodes(root, params);
    // From 400 km, the root's 2000 m / 128 spacing is ~0.07 px: nothing more is needed.
    expect(r.visible).toEqual([root]);
  });

  it('skips nodes outside the frustum', () => {
    const { root, params } = lodSetup(1e9, new THREE.Vector3(0, 0, 1500));
    const r = selectNodes(root, params);
    for (const n of r.visible) expect(params.frustum.intersectsBox(n.box)).toBe(true);
    expect(r.visible.some((n) => n.box.max.z < -900)).toBe(false);
  });

  it('asks to download unloaded nodes and waits for parents before going deeper', () => {
    const { root, params } = lodSetup(1e9);
    const kids = root.children();
    for (const k of kids) k.loaded = false;
    const r = selectNodes(root, params);
    expect(r.visible).toEqual([root]);
    expect(r.toLoad.length).toBeGreaterThan(0);
    expect(r.toLoad.every((n) => n.depth === 1)).toBe(true);
  });

  it('requests hierarchy files for subtree placeholders', () => {
    const { root, params } = lodSetup(1e9);
    root.children()[7].count = SUBTREE;
    const r = selectNodes(root, params);
    expect(r.needHierarchy).toContain(root.children()[7]);
    expect(r.visible).not.toContain(root.children()[7]);
  });

  it('heap pops in descending order', () => {
    const h = new MaxHeap<number>((a, b) => a - b);
    const values = [5, 1, 9, 3, 7, 2, 8, 2];
    for (const v of values) h.push(v);
    const out: number[] = [];
    while (h.size) out.push(h.pop()!);
    expect(out).toEqual([...values].sort((a, b) => b - a));
  });
});

class KeyNode {
  readonly kids: KeyNode[];
  constructor(
    readonly key: Key,
    depthLeft: number,
  ) {
    this.kids = depthLeft > 0 ? childKeys(key).map((k) => new KeyNode(k, depthLeft - 1)) : [];
  }
  children(): KeyNode[] {
    return this.kids;
  }
}

describe('visibility texture (adaptive point size)', () => {
  // Root, plus octants 0 and 5; inside octant 5, its octant 3 too.
  const root = new KeyNode({ d: 0, x: 0, y: 0, z: 0 }, 3);
  const a = root.kids[0];
  const b = root.kids[5];
  const b3 = b.kids[3];
  const tex = new Uint8Array(64 * 4);
  const n = writeVisibility(root, new Set([root, a, b, b3]), tex);

  it('packs nodes breadth-first with child masks and offsets', () => {
    expect(n).toBe(4);
    expect(octant(b.key)).toBe(5);
    expect(tex[0]).toBe((1 << 0) | (1 << 5));
    expect(tex[1] * 256 + tex[2]).toBe(1); // root's first child is the next texel
    expect(tex[2 * 4]).toBe(1 << 3); // node b (third texel) has child 3
  });

  it('finds the deepest visible node at any position', () => {
    // Octant 0 = low x, y, z.
    expect(lodAt(tex, [0.1, 0.1, 0.1])).toBe(1);
    // Octant 5 = high x, low y, high z; its octant 3 = high x, high y, low z within it.
    expect(lodAt(tex, [0.6, 0.1, 0.6])).toBe(1);
    expect(lodAt(tex, [0.9, 0.4, 0.6])).toBe(2);
    // An octant with no visible child stays at the root.
    expect(lodAt(tex, [0.1, 0.9, 0.1])).toBe(0);
  });

  it('stops adding children when the texture is full', () => {
    const small = new Uint8Array(2 * 4);
    expect(writeVisibility(root, new Set([root, a, b, b3]), small)).toBe(1);
    expect(small[0]).toBe(0);
  });
});

describe('camera views', () => {
  it('round-trips heading, pitch and distance', () => {
    const v = { target: new THREE.Vector3(10, 20, 30), heading: 250, pitch: 35, distance: 800 };
    const back = positionToView(viewToPosition(v), v.target);
    expect(back.heading).toBeCloseTo(250, 6);
    expect(back.pitch).toBeCloseTo(35, 6);
    expect(back.distance).toBeCloseTo(800, 6);
  });

  it('looking north puts the camera south of the target', () => {
    const pos = viewToPosition({ target: new THREE.Vector3(), heading: 0, pitch: 0, distance: 100 });
    expect(pos.z).toBeCloseTo(100); // +z is south
    expect(pos.x).toBeCloseTo(0);
  });
});

describe('places and helpers', () => {
  it('the Golden Gate place lies inside its dataset', () => {
    const gg = PLACES.find((p) => p.slug === 'golden-gate')!;
    expect(gg.dataset).toBe('CA_SanFrancisco_1_B23');
    const m = latLonToMercator(gg.lat, gg.lon);
    const b = sfJson.boundsConforming;
    expect(m.x).toBeGreaterThan(b[0]);
    expect(m.x).toBeLessThan(b[3]);
    expect(m.y).toBeGreaterThan(b[1]);
    expect(m.y).toBeLessThan(b[4]);
  });

  it('has unique slugs', () => {
    expect(new Set(PLACES.map((p) => p.slug)).size).toBe(PLACES.length);
  });

  it('formats names and counts', () => {
    expect(prettyName('WY_YellowstoneNP_3_2020')).toBe('WY Yellowstone NP 3 2020');
    expect(prettyName('USGS_LPC_CA_LosAngeles_2016_LAS_2018')).toBe('CA Los Angeles 2016 LAS 2018');
    expect(formatCount(216.93e9)).toBe('217 billion');
    expect(formatCount(4.76e9)).toBe('4.8 billion');
  });

  it('percentiles and colour ramps', () => {
    expect(percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(percentile([], 0.5)).toBe(0);
    expect(sampleRamp(ELEVATION_STOPS, 0)).toEqual([0x32, 0x88, 0xbd]);
    expect(sampleRamp(ELEVATION_STOPS, 1)).toEqual([0xd5, 0x3e, 0x4f]);
  });
});
