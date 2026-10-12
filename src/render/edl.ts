import * as THREE from 'three';

/**
 * Eye-Dome Lighting (Boucheny, 2009), the shading Potree and CloudCompare use for point clouds.
 *
 * Points have no normals, so ordinary lighting can't shade them, and an unlit cloud reads as flat
 * noise. EDL works in screen space on depth alone: for each pixel, look at a few neighbours; where a
 * neighbour is closer to the camera, this pixel sits in a "valley" behind an edge and gets darker.
 * Working on log₂(depth) makes the effect the same strength near and far. Pixels next to empty sky
 * count as a big step, which draws a dark outline around every silhouette.
 */
const fragmentShader = /* glsl */ `
  #include <packing>

  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 uTexel;
  uniform float uNear;
  uniform float uFar;
  uniform float uStrength;
  uniform float uRadius;
  uniform vec3 uSkyTop;
  uniform vec3 uSkyBottom;

  varying vec2 vUv;

  // log2 of the view-space distance, or 0 where nothing was drawn.
  float logDepth(vec2 uv) {
    // Explicit LOD: no derivatives needed inside the loop.
    float d = textureLod(tDepth, uv, 0.0).x;
    if (d >= 1.0) return 0.0;
    return log2(-perspectiveDepthToViewZ(d, uNear, uFar));
  }

  void main() {
    float depth = logDepth(vUv);
    if (depth == 0.0) {
      gl_FragColor = vec4(mix(uSkyBottom, uSkyTop, smoothstep(0.0, 1.0, vUv.y)), 1.0);
      return;
    }

    vec2 dirs[8] = vec2[8](
      vec2(1.0, 0.0), vec2(0.7071, 0.7071), vec2(0.0, 1.0), vec2(-0.7071, 0.7071),
      vec2(-1.0, 0.0), vec2(-0.7071, -0.7071), vec2(0.0, -1.0), vec2(0.7071, -0.7071)
    );
    float sum = 0.0;
    for (int i = 0; i < 8; i++) {
      float n = logDepth(vUv + dirs[i] * uTexel * uRadius);
      sum += n == 0.0 ? 100.0 : max(0.0, depth - n);
    }
    float shade = exp(-sum / 8.0 * 300.0 * uStrength);
    gl_FragColor = vec4(texture2D(tColor, vUv).rgb * shade, 1.0);
  }
`;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export class EdlRenderer {
  readonly target: THREE.WebGLRenderTarget;
  private readonly quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor() {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });
    this.target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uNear: { value: 1 },
        uFar: { value: 1000 },
        uStrength: { value: 0.6 },
        uRadius: { value: 1.4 },
        uSkyTop: { value: new THREE.Color(0x070b14) },
        uSkyBottom: { value: new THREE.Color(0x1b2638) },
      },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    this.quad.frustumCulled = false;
  }

  /** 0 turns the shading off (the outline included). */
  set strength(v: number) {
    this.quad.material.uniforms.uStrength.value = v;
  }

  setSize(width: number, height: number): void {
    width = Math.max(1, width);
    height = Math.max(1, height);
    this.target.setSize(width, height);
    this.quad.material.uniforms.uTexel.value.set(1 / width, 1 / height);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const u = this.quad.material.uniforms;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.quad, this.quadCamera);
  }
}
