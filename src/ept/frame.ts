import type { Bounds } from './key';

/**
 * Coordinates.
 *
 * USGS EPT data is in Web Mercator (EPSG:3857) metres, which are only true metres at the equator:
 * at latitude φ every horizontal distance is stretched by 1/cos φ (about 1.32× in New York).
 * Heights are already true metres. So the scene uses a local frame centred on the dataset,
 * with horizontal offsets multiplied by k = cos φ₀ to get real proportions (the error across a
 * 50 km dataset is well under 1%).
 *
 * The frame is also what keeps 32-bit floats usable: raw Mercator x in New York is −8 230 000,
 * where a float32 only resolves to 0.5 m. Local offsets are a few km at most.
 *
 * Three.js is Y-up, so: x = east, y = elevation, z = −north.
 */

export const EARTH_RADIUS = 6378137;

export interface Frame {
  /** Mercator centre of the dataset. */
  cx: number;
  cy: number;
  /** Mercator → true metres scale at the centre latitude. */
  k: number;
}

export function mercatorToLatLon(x: number, y: number): { lat: number; lon: number } {
  return {
    lat: (Math.atan(Math.sinh(y / EARTH_RADIUS)) * 180) / Math.PI,
    lon: (x / EARTH_RADIUS) * (180 / Math.PI),
  };
}

export function latLonToMercator(lat: number, lon: number): { x: number; y: number } {
  const phi = (lat * Math.PI) / 180;
  return {
    x: EARTH_RADIUS * ((lon * Math.PI) / 180),
    y: EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + phi / 2)),
  };
}

export function createFrame(conforming: Bounds): Frame {
  const cx = (conforming[0] + conforming[3]) / 2;
  const cy = (conforming[1] + conforming[4]) / 2;
  const { lat } = mercatorToLatLon(cx, cy);
  return { cx, cy, k: Math.cos((lat * Math.PI) / 180) };
}

/** Mercator (x, y, z) → scene [x, y, z]. */
export function toScene(f: Frame, x: number, y: number, z: number): [number, number, number] {
  return [(x - f.cx) * f.k, z, -(y - f.cy) * f.k];
}

/** Scene [x, y, z] → Mercator (x, y, z). */
export function fromScene(f: Frame, sx: number, sy: number, sz: number): { x: number; y: number; z: number } {
  return { x: f.cx + sx / f.k, y: f.cy - sz / f.k, z: sy };
}

export function sceneToLatLon(f: Frame, sx: number, sz: number): { lat: number; lon: number } {
  const m = fromScene(f, sx, 0, sz);
  return mercatorToLatLon(m.x, m.y);
}

export function latLonToScene(f: Frame, lat: number, lon: number): { x: number; z: number } {
  const m = latLonToMercator(lat, lon);
  const [x, , z] = toScene(f, m.x, m.y, 0);
  return { x, z };
}

/** A Mercator box → scene-space min/max corners. North flips sign, so the y extremes swap. */
export function boundsToScene(f: Frame, b: Bounds): { min: [number, number, number]; max: [number, number, number] } {
  const a = toScene(f, b[0], b[4], b[2]);
  const c = toScene(f, b[3], b[1], b[5]);
  return { min: a, max: c };
}
