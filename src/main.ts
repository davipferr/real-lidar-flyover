import * as THREE from 'three';

import { CameraRig, type ControlMode, type View } from './controls/rig';
import { DEFAULT_PLACE, PLACES, formatCount, listDatasets, prettyName, type Place } from './data/places';
import { latLonToScene, sceneToLatLon } from './ept/frame';
import { PointCloud, type DataSample } from './octree/cloud';
import { EdlRenderer } from './render/edl';
import { CLASSES, ELEVATION_STOPS, classColor, className } from './render/palette';
import type { ColorMode } from './render/pointMaterial';
import { createToast } from './ui/toast';
import { WorkerPool } from './worker/pool';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const toast = createToast($('toast'));
const isMobile = matchMedia('(pointer: coarse), (max-width: 760px)').matches;

// ——— Renderer, camera, workers ———

const canvas = $<HTMLCanvasElement>('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
renderer.setPixelRatio(pixelRatio);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 1, 100_000);
const edl = new EdlRenderer();
const rig = new CameraRig(camera, canvas);
const pool = new WorkerPool(Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)), 3);

function resize(): void {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  edl.setSize(size.x, size.y);
}
window.addEventListener('resize', resize);
resize();

// ——— Settings (remembered per browser) ———

interface Settings {
  budget: number; // millions of points
  detail: number; // target spacing in pixels
  size: number;
  edl: number;
}
const DEFAULTS: Settings = { budget: isMobile ? 1.5 : 4, detail: 1.5, size: 1.7, edl: 0.6 };
const settings: Settings = { ...DEFAULTS, ...readJson<Partial<Settings>>('lidar-settings') };

function readJson<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}
function saveSettings(): void {
  try {
    localStorage.setItem('lidar-settings', JSON.stringify(settings));
  } catch {
    /* private mode: settings just won't persist */
  }
}

// ——— State ———

let cloud: PointCloud | null = null;
let sample: DataSample | null = null;
let place: Place | null = null;
let mode: ColorMode = 'elevation';
let startView: View | null = null;
let openToken = 0;
/** True until the user moves the camera; while true, the start view may settle onto better data. */
let settling = false;

function applySettings(): void {
  if (!cloud) return;
  cloud.budget = settings.budget * 1e6;
  cloud.minSpacingPx = settings.detail * pixelRatio;
  cloud.materials.setPointScale(settings.size);
  cloud.materials.setMinPixels(Math.max(1, settings.detail * 0.8) * pixelRatio);
  edl.strength = settings.edl;
}

// ——— Opening a dataset ———

interface Target {
  dataset: string;
  place: Place | null;
  /** From a shared link. */
  view?: { lat: number; lon: number; elev: number; heading: number; pitch: number; distance: number };
}

async function open(t: Target): Promise<void> {
  const token = ++openToken;
  const loading = $('loading');
  loading.textContent = `Loading ${t.place?.title ?? prettyName(t.dataset)}…`;
  loading.classList.remove('hidden');
  highlightPlace(t.place?.slug ?? null);

  let next: PointCloud;
  try {
    next = await PointCloud.open(t.dataset, pool);
  } catch (err) {
    if (token !== openToken) return;
    loading.classList.add('hidden');
    toast(err instanceof Error ? err.message : String(err), 'error');
    highlightPlace(place?.slug ?? null);
    return;
  }
  if (token !== openToken) {
    next.dispose();
    return;
  }

  cloud?.dispose();
  cloud = next;
  place = t.place;
  scene.add(cloud.group);
  sample = cloud.sample(1);
  cloud.materials.setElevationRange(...sample.z);
  cloud.materials.setIntensityRange(...sample.intensity);
  applySettings();
  cloud.onLoad = () => {
    if (!cloud) return;
    // Refine the colour ranges from a bigger sample once the first levels arrive.
    if (cloud.stats.loadedNodes <= 12) {
      sample = cloud.sample(2);
      cloud.materials.setElevationRange(...sample.z);
      cloud.materials.setIntensityRange(...sample.intensity);
      renderLegend();
      renderClasses();
    }
    if (settling && startView && cloud.stats.loadedNodes <= 40) settleView(cloud, startView);
  };

  const hasColor = cloud.root.hasColor;
  const wanted = t.place?.mode ?? (hasColor ? 'rgb' : 'elevation');
  $<HTMLButtonElement>('color-modes').querySelector<HTMLButtonElement>('[data-mode="rgb"]')!.disabled = !hasColor;
  setMode(wanted === 'rgb' && !hasColor ? 'elevation' : wanted);
  renderClasses();

  $('dataset-name').textContent = t.place ? t.place.title : prettyName(t.dataset);
  $('dataset-name').title = t.dataset;
  $('dataset-total').textContent = `· ${formatCount(cloud.info.points)} points`;
  document.title = `${t.place?.title ?? prettyName(t.dataset)} · Real LiDAR Flyover`;
  $('info').hidden = true;

  startView = initialView(cloud, t);
  rig.setMode('orbit');
  setControlMode('orbit');
  rig.setView(t.view ? viewFromHash(cloud, t.view) : startView);
  // A shared link carries its own elevation; a preset was only estimated from the root tile.
  settling = !t.view;
  loading.classList.add('hidden');
}

function initialView(c: PointCloud, t: Target): View {
  const [z0, z1] = sample!.z;
  if (t.place) {
    const p = t.place;
    const { x, z } = latLonToScene(c.frame, p.lat, p.lon);
    const radius = (c.info.bounds[3] - c.info.bounds[0]) * c.frame.k / c.info.span * 3;
    const y = c.heightAt(x, z, radius) ?? (z0 + z1) / 2;
    return { target: new THREE.Vector3(x, y, z), heading: p.heading, pitch: p.pitch, distance: p.distance };
  }
  const e = c.extent;
  const center = e.getCenter(new THREE.Vector3());
  center.y = c.heightAt(center.x, center.z, Math.max(e.max.x - e.min.x, 100) / 20) ?? (z0 + z1) / 2;
  const size = Math.max(e.max.x - e.min.x, e.max.z - e.min.z);
  return { target: center, heading: 0, pitch: 45, distance: size * 0.9 };
}

/**
 * The start target's elevation comes from the root tile alone (a few points per 100 m). As finer tiles
 * arrive, re-measure it and slide the camera up or down with it, so the view lands on the real ground.
 */
function settleView(c: PointCloud, v: View): void {
  const radius = THREE.MathUtils.clamp(v.distance * 0.05, 30, 500);
  const y = c.heightAt(v.target.x, v.target.z, radius);
  if (y === null || Math.abs(y - v.target.y) < 1) return;
  const dy = y - v.target.y;
  v.target.y = y;
  camera.position.y += dy;
  rig.target.y += dy;
  rig.orbit.update();
}

function viewFromHash(c: PointCloud, v: NonNullable<Target['view']>): View {
  const { x, z } = latLonToScene(c.frame, v.lat, v.lon);
  return { target: new THREE.Vector3(x, v.elev, z), heading: v.heading, pitch: v.pitch, distance: v.distance };
}

// ——— Shareable links: #slug or #dataset:NAME, then @lat,lon,elev,heading,pitch,distance ———

function parseHash(hash: string): Target | null {
  const m = decodeURIComponent(hash.replace(/^#/, '')).match(/^([^@]+)(?:@(.+))?$/);
  if (!m) return null;
  const id = m[1];
  const found = PLACES.find((p) => p.slug === id);
  const dataset = found?.dataset ?? (id.startsWith('dataset:') ? id.slice(8) : null);
  if (!dataset) return null;
  const nums = m[2]?.split(',').map(Number);
  const view =
    nums && nums.length === 6 && nums.every(Number.isFinite)
      ? { lat: nums[0], lon: nums[1], elev: nums[2], heading: nums[3], pitch: nums[4], distance: nums[5] }
      : undefined;
  return { dataset, place: found ?? null, view };
}

let hashTimer = 0;
function scheduleHash(): void {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => {
    if (!cloud) return;
    const v = rig.getView();
    const { lat, lon } = sceneToLatLon(cloud.frame, v.target.x, v.target.z);
    const id = place ? place.slug : `dataset:${cloud.info.name}`;
    const nums = [lat.toFixed(5), lon.toFixed(5), v.target.y.toFixed(0), v.heading.toFixed(0), v.pitch.toFixed(0), v.distance.toFixed(0)];
    history.replaceState(null, '', `#${id}@${nums.join(',')}`);
  }, 600);
}
rig.onChange = scheduleHash;
const stopSettling = () => (settling = false);
rig.orbit.addEventListener('start', stopSettling);
canvas.addEventListener('wheel', stopSettling, { passive: true });
canvas.addEventListener('dblclick', stopSettling);
window.addEventListener('keydown', stopSettling);

// ——— Places & dataset browser ———

const placesEl = $('places');
for (const p of PLACES) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.dataset.slug = p.slug;
  b.innerHTML = `<span></span><small></small>`;
  b.querySelector('span')!.textContent = p.title;
  b.querySelector('small')!.textContent = `${p.region} · ${formatCount(p.points)} pts`;
  b.addEventListener('click', () => {
    if (isMobile) collapse('place-panel', true);
    void open({ dataset: p.dataset, place: p });
  });
  li.append(b);
  placesEl.append(li);
}

function highlightPlace(slug: string | null): void {
  for (const b of placesEl.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('active', b.dataset.slug === slug);
}

let allDatasets: string[] | null = null;
const browse = $<HTMLDetailsElement>('browse');
const search = $<HTMLInputElement>('dataset-search');
browse.addEventListener('toggle', async () => {
  if (!browse.open || allDatasets) return;
  $('dataset-status').textContent = 'Listing the bucket…';
  try {
    allDatasets = await listDatasets();
    renderDatasets();
  } catch (err) {
    $('dataset-status').textContent = err instanceof Error ? err.message : String(err);
  }
});
search.addEventListener('input', () => renderDatasets());

function renderDatasets(): void {
  if (!allDatasets) return;
  const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = allDatasets.filter((n) => {
    const hay = `${n} ${prettyName(n)}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  $('dataset-status').textContent = `${matches.length.toLocaleString()} of ${allDatasets.length.toLocaleString()} datasets`;
  const ul = $('datasets');
  ul.replaceChildren(
    ...matches.slice(0, 150).map((n) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.innerHTML = '<span></span><small></small>';
      b.querySelector('span')!.textContent = prettyName(n);
      b.querySelector('small')!.textContent = n;
      b.addEventListener('click', () => {
        if (isMobile) collapse('place-panel', true);
        void open({ dataset: n, place: null });
      });
      li.append(b);
      return li;
    }),
  );
}

// ——— Display panel ———

const modeButtons = $('color-modes').querySelectorAll<HTMLButtonElement>('button');
for (const b of modeButtons) b.addEventListener('click', () => setMode(b.dataset.mode as ColorMode));

function setMode(m: ColorMode): void {
  if (m === 'rgb' && cloud && !cloud.root.hasColor) return;
  mode = m;
  cloud?.materials.setMode(m);
  for (const b of modeButtons) b.classList.toggle('active', b.dataset.mode === m);
  renderLegend();
}

function renderLegend(): void {
  const el = $('legend');
  if (!sample || (mode !== 'elevation' && mode !== 'intensity')) {
    el.replaceChildren();
    return;
  }
  const gradient =
    mode === 'elevation' ? `linear-gradient(90deg, ${ELEVATION_STOPS.join(', ')})` : 'linear-gradient(90deg, #000, #fff)';
  const [lo, hi] = mode === 'elevation' ? sample.z : sample.intensity;
  const unit = mode === 'elevation' ? ' m' : '';
  el.innerHTML = `<div class="ramp"></div><div class="ends"><span></span><span></span></div>`;
  el.querySelector<HTMLElement>('.ramp')!.style.background = gradient;
  const [a, b] = el.querySelectorAll('.ends span');
  a.textContent = `${Math.round(lo).toLocaleString()}${unit}`;
  b.textContent = `${Math.round(hi).toLocaleString()}${unit}`;
}

function renderClasses(): void {
  if (!cloud || !sample) return;
  const c = cloud;
  const present = [...sample.classes.entries()].sort((a, b) => a[0] - b[0]);
  const total = present.reduce((s, [, n]) => s + n, 0);
  $('classes').replaceChildren(
    ...present.map(([cls, n]) => {
      const li = document.createElement('li');
      li.innerHTML = `<label><input type="checkbox" /><i></i><span></span><span class="n mono"></span></label>`;
      const box = li.querySelector('input')!;
      box.checked = !c.materials.hiddenClasses.has(cls);
      box.addEventListener('change', () => c.materials.setClassVisible(cls, box.checked));
      li.querySelector('i')!.style.background = classColor(cls);
      li.querySelector('span')!.textContent = className(cls);
      li.querySelector('.n')!.textContent = `${((n / total) * 100).toFixed(n / total < 0.01 ? 1 : 0)}%`;
      return li;
    }),
  );
}

function bindRange(id: keyof Settings, format: (v: number) => string): void {
  const input = $<HTMLInputElement>(id);
  const label = $(`${id}-label`);
  input.value = String(settings[id]);
  label.textContent = format(settings[id]);
  input.addEventListener('input', () => {
    settings[id] = Number(input.value);
    label.textContent = format(settings[id]);
    applySettings();
    saveSettings();
  });
}
bindRange('budget', (v) => `${v} M points`);
bindRange('detail', (v) => `a point every ${v.toFixed(1)} px`);
bindRange('size', (v) => `${v.toFixed(2)}×`);
bindRange('edl', (v) => (v === 0 ? 'off' : v.toFixed(2)));
edl.strength = settings.edl;

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-collapse]')) {
  const panel = $(b.dataset.collapse!);
  b.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    b.textContent = collapsed ? '+' : '–';
  });
}
// Phones: start with both panels folded so the cloud is visible.
const collapse = (id: string, collapsed: boolean) => {
  $(id).classList.toggle('collapsed', collapsed);
  $(id).querySelector<HTMLButtonElement>('[data-collapse]')!.textContent = collapsed ? '+' : '–';
};
if (isMobile) {
  collapse('display-panel', true);
  collapse('place-panel', true);
}

// ——— Toolbar ———

const controlButtons = document.querySelectorAll<HTMLButtonElement>('[data-control]');
for (const b of controlButtons) b.addEventListener('click', () => setControlMode(b.dataset.control as ControlMode));

function setControlMode(m: ControlMode): void {
  if (m === 'fly') setAutoRotate(false);
  rig.setMode(m);
  for (const b of controlButtons) b.classList.toggle('active', b.dataset.control === m);
  $('speed').hidden = m !== 'fly';
  $('hint').textContent =
    m === 'fly' ? 'WASD move · Q/E down/up · drag to look · wheel = speed · Shift = 4×' : 'Double-click a point to fly to it';
}

const autoBtn = $<HTMLButtonElement>('autorotate');
function setAutoRotate(on: boolean): void {
  if (on && rig.mode === 'fly') setControlMode('orbit');
  rig.orbit.autoRotate = on;
  rig.orbit.autoRotateSpeed = -0.5;
  autoBtn.classList.toggle('active', on);
}
autoBtn.addEventListener('click', () => setAutoRotate(!rig.orbit.autoRotate));
$('reset').addEventListener('click', resetView);
function resetView(): void {
  if (!startView) return;
  setControlMode('orbit');
  rig.setView(startView);
}

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
  const modes: Record<string, ColorMode> = { Digit1: 'rgb', Digit2: 'elevation', Digit3: 'intensity', Digit4: 'classification' };
  if (modes[e.code]) setMode(modes[e.code]);
  else if (e.code === 'KeyF') setControlMode(rig.mode === 'fly' ? 'orbit' : 'fly');
  else if (e.code === 'KeyR') setAutoRotate(!rig.orbit.autoRotate);
  else if (e.code === 'Home') resetView();
  else if (e.code === 'Escape') $('info').hidden = true;
});

// ——— Picking ———

const raycaster = new THREE.Raycaster();
canvas.addEventListener('dblclick', (e) => {
  if (!cloud) return;
  const ndc = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const projFactor = window.innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  const hit = cloud.pick(raycaster.ray, 6, projFactor);
  if (!hit) {
    toast('No point under the cursor');
    return;
  }
  setAutoRotate(false);
  const dist = camera.position.distanceTo(hit.position);
  rig.flyTo(hit.position, THREE.MathUtils.clamp(dist * 0.4, 25, 3000));
  showInfo(hit, dist);
});

function showInfo(hit: NonNullable<ReturnType<PointCloud['pick']>>, dist: number): void {
  const { lat, lon } = sceneToLatLon(cloud!.frame, hit.position.x, hit.position.z);
  const rows: [string, string][] = [
    ['Latitude', lat.toFixed(6)],
    ['Longitude', lon.toFixed(6)],
    ['Elevation', `${hit.position.y.toFixed(2)} m · ${(hit.position.y * 3.28084).toFixed(0)} ft`],
    ['Class', `<span class="swatch" style="background:${classColor(hit.classification)}"></span>${className(hit.classification)}`],
    ['Intensity', String(hit.intensity)],
  ];
  if (hit.rgb) {
    const hex = `#${hit.rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    rows.push(['Colour', `<span class="swatch" style="background:${hex}"></span>${hex}`]);
  }
  rows.push(['Distance', `${dist < 1000 ? dist.toFixed(0) + ' m' : (dist / 1000).toFixed(2) + ' km'}`]);
  $('info-rows').innerHTML = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
  $('info').hidden = false;
}
$('info-close').addEventListener('click', () => ($('info').hidden = true));

// ——— Frame loop ———

const timer = new THREE.Timer();
timer.connect(document);
let fps = 60;
let statsTimer = 0;

function frame(): void {
  requestAnimationFrame(frame);
  timer.update();
  step(Math.min(timer.getDelta(), 0.1));
}

function step(dt: number): void {
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
  rig.update(dt);

  if (cloud) {
    // Depth precision: keep far/near as small as the view allows (EDL reads this depth buffer).
    const ground = sample ? sample.z[0] : 0;
    const altitude = Math.max(camera.position.y - ground, cloud.extent.distanceToPoint(camera.position), 1);
    camera.near = THREE.MathUtils.clamp(altitude * 0.002, 0.1, 50);
    const size = cloud.extent.getSize(new THREE.Vector3()).length();
    camera.far = Math.max(size * 1.5 + cloud.extent.distanceToPoint(camera.position), altitude * 20, 2000);
    camera.updateProjectionMatrix();
    cloud.update(camera, renderer.getDrawingBufferSize(new THREE.Vector2()).y);
  }
  edl.render(renderer, scene, camera);

  statsTimer -= dt;
  if (statsTimer <= 0) {
    statsTimer = 0.25;
    renderStats();
  }
}

function renderStats(): void {
  $('st-fps').textContent = `${fps.toFixed(0)} fps`;
  if (rig.mode === 'fly') $('speed').textContent = `${rig.flySpeed < 100 ? rig.flySpeed.toFixed(0) : (rig.flySpeed / 1000).toFixed(2) + ' k'} m/s`;
  if (!cloud) return;
  const s = cloud.stats;
  $('st-visible').textContent = `${(s.visiblePoints / 1e6).toFixed(2)} M pts · ${s.visibleNodes} tiles`;
  $('st-memory').textContent = `${(s.loadedPoints / 1e6).toFixed(2)} M pts · ${s.loadedNodes} tiles`;
  $('st-loading').textContent = s.loading ? `${s.loading} tiles` : 'idle';
  $('st-bytes').textContent = `${(s.downloadedBytes / 1048576).toFixed(1)} MB${s.failed ? ` · ${s.failed} failed` : ''}`;
  const v = rig.getView();
  const { lat, lon } = sceneToLatLon(cloud.frame, camera.position.x, camera.position.z);
  $('cursor-line').textContent = `cam ${lat.toFixed(4)}, ${lon.toFixed(4)} · ${camera.position.y.toFixed(0)} m · hdg ${v.heading.toFixed(0)}°`;
}

// ——— Start ———

const first = parseHash(location.hash) ?? { dataset: DEFAULT_PLACE.dataset, place: DEFAULT_PLACE };
void open(first);
frame();

window.addEventListener('hashchange', () => {
  const t = parseHash(location.hash);
  // Our own replaceState doesn't fire hashchange, so this only runs for pasted/edited links.
  if (t && (t.dataset !== cloud?.info.name || t.view)) void open(t);
});

if (import.meta.env.DEV) {
  // tick(): advance frames by hand, e.g. while the tab is hidden and requestAnimationFrame is paused.
  const tick = (n = 1, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) step(dt);
  };
  Object.assign(window, { __dbg: { get cloud() { return cloud; }, rig, camera, renderer, scene, CLASSES, tick } });
}
