/** ASPRS standard LiDAR classes (LAS 1.4 spec, table 17) and the colours used to draw them. */
export const CLASSES: Record<number, { name: string; color: string }> = {
  0: { name: 'Never classified', color: '#9aa3ad' },
  1: { name: 'Unclassified', color: '#c9ccd1' },
  2: { name: 'Ground', color: '#b3854f' },
  3: { name: 'Low vegetation', color: '#b6e36b' },
  4: { name: 'Medium vegetation', color: '#5cc84a' },
  5: { name: 'High vegetation', color: '#1f8a3a' },
  6: { name: 'Building', color: '#ef6a5b' },
  7: { name: 'Low noise', color: '#ff3df5' },
  8: { name: 'Model key point', color: '#d9d9d9' },
  9: { name: 'Water', color: '#3d8ff0' },
  10: { name: 'Rail', color: '#9a63d6' },
  11: { name: 'Road surface', color: '#6b6f78' },
  12: { name: 'Overlap', color: '#d8c060' },
  13: { name: 'Wire – guard', color: '#f5e663' },
  14: { name: 'Wire – conductor', color: '#f5c542' },
  15: { name: 'Transmission tower', color: '#f09a3e' },
  16: { name: 'Wire – connector', color: '#e0b050' },
  17: { name: 'Bridge deck', color: '#d68f5e' },
  18: { name: 'High noise', color: '#ff3df5' },
  19: { name: 'Overhead structure', color: '#c39bd3' },
  20: { name: 'Ignored ground', color: '#8c6d4f' },
  21: { name: 'Snow', color: '#f4fbff' },
  22: { name: 'Temporal exclusion', color: '#7f8c8d' },
};

/** Noise returns (birds, multipath, atmospheric junk) are hidden by default. */
export const HIDDEN_BY_DEFAULT = new Set([7, 18]);

export function className(c: number): string {
  return CLASSES[c]?.name ?? (c >= 64 ? `User class ${c}` : `Reserved class ${c}`);
}

export function classColor(c: number): string {
  return CLASSES[c]?.color ?? '#b0b0b0';
}

/** Elevation ramp, low → high (ColorBrewer "Spectral", reversed). */
export const ELEVATION_STOPS = ['#3288bd', '#66c2a5', '#abdda4', '#e6f598', '#fee08b', '#fdae61', '#f46d43', '#d53e4f'];

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Samples a multi-stop gradient at t ∈ [0, 1], linear in sRGB. */
export function sampleRamp(stops: string[], t: number): [number, number, number] {
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  return [0, 1, 2].map((c) => Math.round(a[c] + (b[c] - a[c]) * f)) as [number, number, number];
}
