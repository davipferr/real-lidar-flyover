# Real LiDAR Flyover

Fly over real airborne laser scans of the United States. The USGS 3D Elevation Program has measured most of the country with LiDAR. On AWS Open Data the scans are published as streamable octrees: 2,289 datasets, from 0.8 million to 467 billion points each (`CA_NorthernCA_5_B22`). This app streams only the part you're looking at, decompresses it in Web Workers, and draws it with Three.js.

TypeScript + Vite + Three.js + [laz-perf](https://github.com/hobuinc/laz-perf) (LASzip compiled to WebAssembly). There's no backend: the S3 bucket is public with `Access-Control-Allow-Origin: *`, so the app runs as a static site on GitHub Pages.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # vitest
npm run build    # type-checks, then builds to dist/
```

## What you can do

- Twelve preset places: Midtown Manhattan, Grand Canyon, Devils Tower, Golden Gate Bridge, Kīlauea, Grand Teton, Niagara Falls, the Las Vegas Strip, Gateway Arch, the US Capitol, the Space Needle and the Hollywood Sign. You can also **browse all 2,289 datasets** with a search box.
- **Orbit**: drag to pan, right-drag to rotate, wheel to zoom toward the cursor.
- **Fly** (`F`): WASD to move, Q/E to go down/up, drag to look, wheel to change speed, Shift for 4×.
- **Circle** (`R`) slowly orbits the target. **Reset** (`Home`) returns to the start view.
- **Double-click** any point to fly to it. You get its latitude/longitude, elevation, class and laser intensity.
- Colour by **elevation**, **intensity**, **classification** (ground, vegetation, buildings, water…), or **RGB** when a dataset has colour. Keys `1`–`4`. Show or hide each class. Noise is hidden by default.
- Controls for the **point budget** (how many points are drawn), **detail**, **point size** and **eye-dome lighting**.
- Links are shareable: `#grand-canyon`, or `#dataset:NAME@lat,lon,elevation,heading,pitch,distance` for any view.

## How it works

### Entwine Point Tiles (`src/ept/`)

Each dataset is an octree. `ept.json` describes it: a root cube in Web Mercator metres, a `span`, and the point schema. Node `D-X-Y-Z` is the cell (X, Y, Z) at depth D, and its points are in `ept-data/D-X-Y-Z.laz`.

The tree is **additive**. The root holds a sparse sample of the whole area, roughly one point per span×span grid cell. Each child adds the points that double the density in its octant. So a view never replaces coarse data with fine data. It keeps the coarse levels and adds finer ones on top.

The node list (`ept-hierarchy/*.json`) is split into files too. An entry of `−1` means "this branch is described in its own file", which is fetched only once the camera needs that branch.

### Choosing what to draw (`src/octree/lod.ts`)

Every frame, a best-first walk through the octree:

1. Start from the root. Always expand the node that looks **biggest on screen** next (`width / distance`), using a binary heap.
2. Skip nodes outside the camera frustum.
3. Stop going deeper where points would already land closer than about 1.5 px apart.
4. Stop altogether when the **point budget** is full.

Whatever the budget, the nearest and biggest detail is chosen first. Children are only considered once their parent has loaded, so the scene sharpens from coarse to fine. Missing nodes are queued for download in the same priority order, and the least recently seen nodes are evicted once memory passes 2.5× the budget.

### Decoding (`src/las/decode.ts`, `src/worker/`)

Tiles are LAZ: compressed LAS. Up to four Web Workers each download tiles and run laz-perf (WASM) on them. Each worker returns typed arrays (positions, intensity, class, colour) as transferables, so nothing is copied.

LAS records are parsed by byte offset. Colour sits at byte 20, 28 or 30 depending on the point format. Classification is 5 bits of byte 15 in formats 0–5, and all of byte 16 in formats 6–10.

### Coordinates (`src/ept/frame.ts`)

Web Mercator stretches distances by 1/cos(latitude), so 1 km in New York reads as 1.32 "Mercator km". The scene uses a local frame centred on the dataset, and horizontal offsets are multiplied by cos φ₀ to get true proportions.

The frame also keeps float32 usable. A raw Mercator x in New York is −8,230,000, where float32 can only resolve 0.5 m. Each tile's points are also stored relative to the tile's own centre.

### Adaptive point size (`src/octree/visibility.ts`, `src/render/pointMaterial.ts`)

A point should be drawn exactly as wide as the local point spacing. Smaller leaves holes, and larger smears detail. Because the octree is additive, the spacing at any spot is set by the **deepest node drawn there**, which can vary within a single node.

So each frame, the visible part of the tree is packed into a small texture: one texel per node, holding a child bitmask and an offset to its first child. In the vertex shader, every point walks that texture from the root down to its own position and sizes itself as `rootSpacing / 2^depth`, projected to pixels. This is Potree's technique. `lodAt()` is a CPU twin of the shader, used in tests.

### Eye-dome lighting (`src/render/edl.ts`)

Points have no normals, so normal lighting can't shade them. EDL (Boucheny, 2009) works in screen space on depth alone. For each pixel it compares log₂(depth) with 8 neighbours, and darkens the pixel where neighbours are closer: creases, edges and silhouettes. The scene is rendered into a target with a depth texture, then one full-screen pass shades it.

## Data notes (found by calling the data, Oct 2026)

- **A bounding box is not coverage.** `CA_SierraNevada_11_B22`'s box contains Half Dome, but its points don't: the octant around the valley holds 37 points. Each preset was checked by walking its hierarchy and summing points in the cells around the target. Where datasets overlap, the densest won: Kīlauea uses `HI_Volcano_B1_2019`, not `HI_Hawaii_Island_2017`, which has nothing at the caldera.
- **Declared ≠ present.** `NY_NewYorkCity` lists Red/Green/Blue in its schema, and its tiles use LAS format 3, which has colour, but every value is 0. The app looks at the decoded data, and only enables RGB if some value is non-zero.
- **Noise.** The ASPRS noise classes (7 low, 18 high) can be most of a root tile: 92% in the Sierra Nevada set. `boundsConforming` includes them, which is why `HI_Hawaii_Island_2017`'s "max elevation" is 169,944 m. Noise is hidden, and colour ranges use the 2nd–98th percentile of the remaining points.
- **Some datasets have holes.** `AZ_GrandCanyonNP_1_2019` is missing a diagonal band across its western half, so the preset looks at the eastern canyon.
- With dozens of tiles in flight, an occasional request fails with "Failed to fetch". Tiles and hierarchy files retry with backoff (2 s, 4 s, 8 s… up to 1 min).
- All 2,281 readable `ept.json` files say LAZ tiles and EPSG:3857, the only combination the app supports. Anything else shows an error instead of rendering wrong.

USGS 3DEP data is public domain. Tiles by [Entwine](https://entwine.io) / Hobu, hosted on the [AWS Registry of Open Data](https://registry.opendata.aws/usgs-lidar/).

## Debugging

In dev builds, `window.__dbg` exposes:
- `cloud`: the current `PointCloud` (`stats`, `hierarchy`, `heightAt()`, `pick()`…);
- `tick(n, dt)` to step frames by hand, which is useful when the tab is hidden and requestAnimationFrame is paused;
- `rig`, `camera`, `renderer`, `scene`.
