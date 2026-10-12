import * as THREE from 'three';

import { CLASSES, ELEVATION_STOPS, HIDDEN_BY_DEFAULT, hexToRgb, sampleRamp } from './palette';

export type ColorMode = 'rgb' | 'elevation' | 'intensity' | 'classification';
const MODE_INDEX: Record<ColorMode, number> = { rgb: 0, elevation: 1, intensity: 2, classification: 3 };

/** Max visible nodes the visibility texture can describe. */
export const VIS_CAPACITY = 4096;

/**
 * Adaptive point size. Each point looks up the deepest visible octree node at its own position
 * (see octree/visibility.ts). At depth d the points are rootSpacing / 2^d metres apart, so each one
 * is drawn as a disc of that size, projected to pixels: close enough to touch, no bigger.
 */
const vertexShader = /* glsl */ `
  attribute vec3 rgb;
  attribute float intensity;
  attribute float classification;

  uniform sampler2D uVisTex;
  uniform vec3 uRootMin;      // octree root cube in local east/north/up metres
  uniform vec3 uRootSize;
  uniform float uRootSpacing; // point spacing at depth 0, metres
  uniform float uProj;
  uniform float uPointScale;
  uniform float uMinPx;
  uniform float uMaxPx;
  uniform int uMode;
  uniform vec2 uZRange;
  uniform vec2 uIntensityRange;
  uniform sampler2D uClassTex;
  uniform sampler2D uRampTex;

  varying vec3 vColor;

  float lodAt(vec3 world) {
    // Scene (east, up, −north) → EPT axes (east, north, up), in root-cube units.
    vec3 p = (vec3(world.x, -world.z, world.y) - uRootMin) / uRootSize;
    int idx = 0;
    float depth = 0.0;
    for (int i = 0; i < 24; i++) {
      vec4 v = texelFetch(uVisTex, ivec2(idx, 0), 0);
      int mask = int(v.r * 255.0 + 0.5);
      p *= 2.0;
      ivec3 c = clamp(ivec3(floor(p)), 0, 1);
      int o = c.x | (c.y << 1) | (c.z << 2);
      if ((mask & (1 << o)) == 0) break;
      int before = 0;
      for (int b = 0; b < 8; b++) if (b < o && (mask & (1 << b)) != 0) before++;
      idx += int(v.g * 255.0 + 0.5) * 256 + int(v.b * 255.0 + 0.5) + before;
      p -= vec3(c);
      depth += 1.0;
    }
    return depth;
  }

  void main() {
    vec4 cls = texelFetch(uClassTex, ivec2(int(classification + 0.5), 0), 0);
    if (cls.a < 0.5) {
      // Hidden class: move the vertex outside the clip volume, so it is dropped before rasterising.
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    vec4 world = modelMatrix * vec4(position, 1.0);
    vec4 mv = viewMatrix * world;
    gl_Position = projectionMatrix * mv;
    float spacing = uRootSpacing / exp2(lodAt(world.xyz));
    gl_PointSize = clamp(uPointScale * spacing * uProj / max(-mv.z, 1e-3), uMinPx, uMaxPx);

    if (uMode == 0) {
      vColor = rgb;
    } else if (uMode == 1) {
      float t = clamp((world.y - uZRange.x) / (uZRange.y - uZRange.x), 0.0, 1.0);
      vColor = texture2D(uRampTex, vec2(t, 0.5)).rgb;
    } else if (uMode == 2) {
      float t = clamp((intensity * 65535.0 - uIntensityRange.x) / (uIntensityRange.y - uIntensityRange.x), 0.0, 1.0);
      vColor = vec3(pow(t, 0.75));
    } else {
      vColor = cls.rgb;
    }
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;

  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    if (dot(c, c) > 1.0) discard;
    gl_FragColor = vec4(vColor, 1.0);
  }
`;

const dataTexture = (width: number) => {
  const t = new THREE.DataTexture(new Uint8Array(width * 4), width, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
};

export class PointMaterials {
  readonly material: THREE.ShaderMaterial;
  readonly visData: Uint8Array;
  readonly hiddenClasses = new Set(HIDDEN_BY_DEFAULT);
  private readonly visTex = dataTexture(VIS_CAPACITY);
  private readonly classTex = dataTexture(256);
  private readonly rampTex = dataTexture(256);
  private readonly u: Record<string, THREE.IUniform>;

  /**
   * @param rootMin  root cube corner in local east/north/up metres
   * @param rootSize root cube size in local east/north/up metres
   * @param span     EPT span (voxels per node axis)
   */
  constructor(rootMin: THREE.Vector3, rootSize: THREE.Vector3, span: number) {
    this.visData = this.visTex.image.data as Uint8Array;
    this.updateClassTexture();
    const ramp = this.rampTex.image.data as Uint8Array;
    for (let i = 0; i < 256; i++) {
      const [r, g, b] = sampleRamp(ELEVATION_STOPS, i / 255);
      ramp.set([r, g, b, 255], i * 4);
    }
    this.rampTex.magFilter = THREE.LinearFilter;
    this.rampTex.minFilter = THREE.LinearFilter;

    this.u = {
      uVisTex: { value: this.visTex },
      uRootMin: { value: rootMin },
      uRootSize: { value: rootSize },
      uRootSpacing: { value: rootSize.x / span },
      uProj: { value: 1 },
      uPointScale: { value: 1 },
      uMinPx: { value: 1.5 },
      uMaxPx: { value: 40 },
      uMode: { value: MODE_INDEX.elevation },
      uZRange: { value: new THREE.Vector2(0, 100) },
      uIntensityRange: { value: new THREE.Vector2(0, 65535) },
      uClassTex: { value: this.classTex },
      uRampTex: { value: this.rampTex },
    };
    this.material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: this.u });
    // Datasets without colour: draw white instead of black in RGB mode.
    (this.material.defaultAttributeValues as Record<string, number[]>).rgb = [1, 1, 1];
  }

  /** Call after writing `visData`. */
  visibilityChanged(): void {
    this.visTex.needsUpdate = true;
  }

  setProjection(projFactor: number): void {
    this.u.uProj.value = projFactor;
  }

  setPointScale(scale: number): void {
    this.u.uPointScale.value = scale;
  }

  setMinPixels(px: number): void {
    this.u.uMinPx.value = px;
  }

  setMode(mode: ColorMode): void {
    this.u.uMode.value = MODE_INDEX[mode];
  }

  setElevationRange(min: number, max: number): void {
    (this.u.uZRange.value as THREE.Vector2).set(min, Math.max(max, min + 1));
  }

  setIntensityRange(min: number, max: number): void {
    (this.u.uIntensityRange.value as THREE.Vector2).set(min, Math.max(max, min + 1));
  }

  setClassVisible(c: number, visible: boolean): void {
    if (visible) this.hiddenClasses.delete(c);
    else this.hiddenClasses.add(c);
    this.updateClassTexture();
  }

  dispose(): void {
    this.material.dispose();
    this.visTex.dispose();
    this.classTex.dispose();
    this.rampTex.dispose();
  }

  /** One texel per class: RGB = colour, A = visible. */
  private updateClassTexture(): void {
    const data = this.classTex.image.data as Uint8Array;
    for (let c = 0; c < 256; c++) {
      const [r, g, b] = hexToRgb(CLASSES[c]?.color ?? '#b0b0b0');
      data.set([r, g, b, this.hiddenClasses.has(c) ? 0 : 255], c * 4);
    }
    this.classTex.needsUpdate = true;
  }
}
