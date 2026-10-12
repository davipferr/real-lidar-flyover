import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';

export type ControlMode = 'orbit' | 'fly';

export interface View {
  target: THREE.Vector3;
  /** Compass heading the camera looks toward, degrees clockwise from north. */
  heading: number;
  /** Degrees below the horizon. */
  pitch: number;
  distance: number;
}

/** Camera position for a view: back off from the target, opposite the heading, raised by the pitch. */
export function viewToPosition(v: View): THREE.Vector3 {
  const h = THREE.MathUtils.degToRad(v.heading);
  const p = THREE.MathUtils.degToRad(v.pitch);
  const horizontal = Math.cos(p) * v.distance;
  // Scene axes: x = east, y = up, z = −north.
  return new THREE.Vector3(
    v.target.x - Math.sin(h) * horizontal,
    v.target.y + Math.sin(p) * v.distance,
    v.target.z + Math.cos(h) * horizontal,
  );
}

export function positionToView(position: THREE.Vector3, target: THREE.Vector3): View {
  const d = position.clone().sub(target);
  const distance = d.length();
  const heading = (THREE.MathUtils.radToDeg(Math.atan2(-d.x, d.z)) + 360) % 360;
  const pitch = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(d.y / Math.max(distance, 1e-9), -1, 1)));
  return { target: target.clone(), heading, pitch, distance };
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Two ways to move:
 * - Orbit (default): MapControls. Left-drag pans over the ground, right-drag rotates, wheel zooms to the cursor.
 * - Fly: WASD / arrows to move, Q/E down/up, drag to look, wheel changes speed, Shift goes 4× faster.
 */
export class CameraRig {
  readonly orbit: MapControls;
  mode: ControlMode = 'orbit';
  /** Fly speed, metres per second. */
  flySpeed = 100;
  onChange: (() => void) | null = null;

  private readonly keys = new Set<string>();
  private dragging = false;
  private lastPointer = new THREE.Vector2();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private tween: { from: THREE.Vector3; to: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3; t: number; dur: number } | null =
    null;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
  ) {
    this.orbit = new MapControls(camera, dom);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.screenSpacePanning = false;
    this.orbit.zoomToCursor = true;
    this.orbit.maxPolarAngle = Math.PI / 2 - 0.01;
    this.orbit.minDistance = 2;
    this.orbit.addEventListener('change', () => this.onChange?.());
    this.orbit.addEventListener('start', () => (this.tween = null));

    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    dom.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'fly') return;
      this.dragging = true;
      this.tween = null;
      this.lastPointer.set(e.clientX, e.clientY);
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (this.mode !== 'fly' || !this.dragging) return;
      const dx = e.clientX - this.lastPointer.x;
      const dy = e.clientY - this.lastPointer.y;
      this.lastPointer.set(e.clientX, e.clientY);
      this.euler.setFromQuaternion(camera.quaternion);
      this.euler.y -= dx * 0.0035;
      this.euler.x = THREE.MathUtils.clamp(this.euler.x - dy * 0.0035, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
      camera.quaternion.setFromEuler(this.euler);
      this.onChange?.();
    });
    dom.addEventListener('pointerup', () => (this.dragging = false));
    dom.addEventListener(
      'wheel',
      (e) => {
        if (this.mode !== 'fly') return;
        e.preventDefault();
        this.flySpeed = THREE.MathUtils.clamp(this.flySpeed * (e.deltaY > 0 ? 0.85 : 1 / 0.85), 1, 20_000);
        this.onChange?.();
      },
      { passive: false },
    );
  }

  get target(): THREE.Vector3 {
    return this.orbit.target;
  }

  setMode(mode: ControlMode, pivotDistance?: number): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.tween = null;
    if (mode === 'fly') {
      this.orbit.enabled = false;
      this.flySpeed = THREE.MathUtils.clamp(this.camera.position.distanceTo(this.orbit.target) * 0.4, 5, 5000);
    } else {
      // Pivot around a point straight ahead.
      const dist = pivotDistance ?? Math.max(this.flySpeed * 2.5, 50);
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.orbit.target.copy(this.camera.position).addScaledVector(forward, dist);
      this.orbit.enabled = true;
      this.orbit.update();
    }
    this.onChange?.();
  }

  setView(v: View): void {
    this.tween = null;
    this.camera.position.copy(viewToPosition(v));
    this.orbit.target.copy(v.target);
    this.camera.lookAt(v.target);
    this.orbit.update();
    this.onChange?.();
  }

  getView(): View {
    if (this.mode === 'orbit') return positionToView(this.camera.position, this.orbit.target);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const dist = Math.max(this.flySpeed * 2.5, 50);
    return positionToView(this.camera.position, this.camera.position.clone().addScaledVector(forward, dist));
  }

  /** Glide to look at `point` from `distance` metres, keeping the current viewing direction. */
  flyTo(point: THREE.Vector3, distance: number, duration = 1.2): void {
    if (this.mode === 'fly') this.setMode('orbit', this.camera.position.distanceTo(point));
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.tween = {
      from: this.camera.position.clone(),
      to: point.clone().addScaledVector(dir, distance),
      fromT: this.orbit.target.clone(),
      toT: point.clone(),
      t: 0,
      dur: duration,
    };
  }

  /** @returns true while the camera is moving */
  update(dt: number): boolean {
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(tw.t + dt / tw.dur, 1);
      const e = easeInOutCubic(tw.t);
      this.camera.position.lerpVectors(tw.from, tw.to, e);
      this.orbit.target.lerpVectors(tw.fromT, tw.toT, e);
      if (tw.t >= 1) this.tween = null;
      this.orbit.update();
      this.onChange?.();
      return true;
    }
    if (this.mode === 'orbit') return this.orbit.update();

    const k = this.keys;
    const move = new THREE.Vector3(
      (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0),
      (k.has('KeyE') || k.has('Space') ? 1 : 0) - (k.has('KeyQ') || k.has('KeyC') ? 1 : 0),
      (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0),
    );
    if (move.lengthSq() === 0) return false;
    const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1;
    const up = move.y;
    move.y = 0;
    move.normalize().applyQuaternion(this.camera.quaternion);
    move.y += up;
    this.camera.position.addScaledVector(move, this.flySpeed * boost * dt);
    this.onChange?.();
    return true;
  }
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
