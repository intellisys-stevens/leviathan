import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { BoardRegion } from './gpu-board-model';
import {
  createHardwareScene,
  resolveHardwarePick,
  type HardwareScene,
  type HardwareSceneModel,
} from './hardware-scene';
import type { GPUChipAppearance } from './gpu-chip-appearance';

export type BoardViewState = {
  focus: string;
  canFocusSelected?: boolean;
  canZoomIn: boolean;
  canZoomOut: boolean;
};
export type BoardViewOptions = {
  gpuKey: string;
  topologyKey: string;
  regions: readonly BoardRegion[];
  appearances?: readonly GPUChipAppearance[];
  theme: 'dark' | 'light';
  highlightedId: string | null;
  interactive: boolean;
  onHighlight: (id: string | null) => void;
  onSelect: (id: string) => void;
  onRenderMode: (mode: 'webgl' | 'fallback') => void;
  onViewState: (state: BoardViewState) => void;
};
export type BoardViewHandle = {
  update: (options: BoardViewOptions) => void;
  zoom: (direction: 'in' | 'out') => void;
  focusChip: () => void;
  reset: () => void;
  dispose: () => void;
};
export type HardwareBoardViewOptions = Omit<
  BoardViewOptions,
  'gpuKey' | 'regions' | 'appearances'
> & {
  sceneKey: string;
  scene: HardwareScene;
  selectedId: string | null;
};
export type HardwareBoardViewHandle = {
  update: (options: HardwareBoardViewOptions) => void;
  zoom: (direction: 'in' | 'out') => void;
  focus: (frameId: string) => void;
  reset: () => void;
  dispose: () => void;
};
type Rect = { left: number; top: number; width: number; height: number };
type CameraState = {
  theta: number;
  phi: number;
  ratio: number;
  focus: string;
};
type BoardModel = HardwareSceneModel;
type Gesture = {
  pointerId: number;
  x: number;
  y: number;
  key: string | null;
  maxDistance: number;
  cancelled: boolean;
  touch: boolean;
};
type Tween = {
  from: THREE.Vector3;
  to: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  started: number;
};
type View = {
  element: HTMLElement;
  options: HardwareBoardViewOptions;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  model: BoardModel | null;
  bounds: THREE.Box3;
  framingPoints: THREE.Vector3[];
  focus: string;
  baseDistance: number;
  rect: Rect;
  gesture: Gesture | null;
  pointers: Set<number>;
  hover: string | null;
  tween: Tween | null;
  resizing: boolean;
  ready: boolean;
  mode: 'loading' | 'webgl' | 'fallback';
  renderSequence: number;
  cleanup: () => void;
};

const cameras = new Map<string, CameraState>();
const defaultDirection = new THREE.Vector3(5, 8.5, 11).normalize();
const defaultSpherical = new THREE.Spherical().setFromVector3(defaultDirection);

/** Projection uses the full view; scissoring clips only its visible pixels. */
export function boardViewportBounds(view: Rect, clip: Rect) {
  const left = Math.max(view.left, clip.left);
  const top = Math.max(view.top, clip.top);
  const right = Math.min(view.left + view.width, clip.left + clip.width);
  const bottom = Math.min(view.top + view.height, clip.top + clip.height);
  if (view.width <= 0 || view.height <= 0 || right <= left || bottom <= top)
    return null;
  return { left, top, width: right - left, height: bottom - top };
}

export function isBoardClick(
  gesture: Pick<Gesture, 'key' | 'maxDistance' | 'cancelled' | 'touch'>,
  hit: string | null,
) {
  return (
    !gesture.cancelled &&
    gesture.key !== null &&
    hit === gesture.key &&
    gesture.maxDistance <= (gesture.touch ? 10 : 6)
  );
}

function boxCorners(bounds: THREE.Box3) {
  const points: THREE.Vector3[] = [];
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z])
        points.push(new THREE.Vector3(x, y, z));
  return points;
}

/** Cache component corners rather than inventing empty corners above the PCB. */
export function boardFramingPoints(group: THREE.Object3D) {
  const points: THREE.Vector3[] = [];
  const instanceMatrix = new THREE.Matrix4();
  const worldMatrix = new THREE.Matrix4();
  group.updateWorldMatrix(true, true);
  group.traverseVisible((object) => {
    if (object.userData.excludeFromFraming === true) return;
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Line)) return;
    const geometry = object.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) return;
    const corners = boxCorners(geometry.boundingBox);
    if (object instanceof THREE.InstancedMesh) {
      for (let index = 0; index < object.count; index++) {
        object.getMatrixAt(index, instanceMatrix);
        worldMatrix.multiplyMatrices(object.matrixWorld, instanceMatrix);
        for (const corner of corners)
          points.push(corner.clone().applyMatrix4(worldMatrix));
      }
    } else {
      for (const corner of corners)
        points.push(corner.applyMatrix4(object.matrixWorld));
    }
  });
  return points;
}

export function boardFitDistance(
  points: readonly THREE.Vector3[],
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
) {
  const inverseRotation = new THREE.Quaternion()
    .copy(camera.quaternion)
    .invert();
  const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  let distance = 1;
  for (const corner of points) {
    const point = corner.clone().sub(target).applyQuaternion(inverseRotation);
    distance = Math.max(
      distance,
      point.z + Math.abs(point.x) / (tangent * camera.aspect),
      point.z + Math.abs(point.y) / tangent,
    );
  }
  return distance * 1.035;
}

function chromeClip(width: number, height: number): Rect {
  let top = 0;
  let bottom = height;
  for (const element of document.querySelectorAll<HTMLElement>(
    '.leviathan-header, .workbench-nav',
  )) {
    const style = getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      !['sticky', 'fixed'].includes(style.position)
    )
      continue;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const inset = Number.parseFloat(style.top);
    if (
      Number.isFinite(inset) &&
      rect.top <= inset + 1 &&
      rect.bottom > 0 &&
      rect.top < height / 2
    )
      top = Math.max(top, rect.bottom);
    if (
      style.position === 'fixed' &&
      style.bottom !== 'auto' &&
      rect.top > height / 2
    )
      bottom = Math.min(bottom, rect.top);
  }
  return { left: 0, top, width, height: Math.max(0, bottom - top) };
}

function visibleClip(element: HTMLElement, clip: Rect) {
  let result: Rect | null = clip;
  for (
    let parent = element.parentElement;
    parent && result;
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent);
    const clipX = /auto|scroll|hidden|clip/.test(style.overflowX);
    const clipY = /auto|scroll|hidden|clip/.test(style.overflowY);
    if (!clipX && !clipY) continue;
    const rect = parent.getBoundingClientRect();
    result = boardViewportBounds(result, {
      left: clipX ? rect.left : result.left,
      top: clipY ? rect.top : result.top,
      width: clipX ? rect.width : result.width,
      height: clipY ? rect.height : result.height,
    });
  }
  return result;
}

/** Interaction frames bypass the 30fps ambient cadence and cancel its pending wakeup. */
export class BoardFrameScheduler {
  private frame: number | null = null;
  private ambientTimer: number | null = null;

  constructor(
    private draw: (time: number) => void,
    private enabled: () => boolean,
  ) {}

  request() {
    if (this.ambientTimer !== null) window.clearTimeout(this.ambientTimer);
    this.ambientTimer = null;
    if (this.frame !== null || !this.enabled()) return;
    this.frame = requestAnimationFrame((time) => {
      this.frame = null;
      if (this.enabled()) this.draw(time);
    });
  }

  ambient(lastFrameTime: number) {
    if (this.frame !== null || this.ambientTimer !== null || !this.enabled())
      return;
    const delay = Math.max(0, 1000 / 30 - (performance.now() - lastFrameTime));
    this.ambientTimer = window.setTimeout(() => {
      this.ambientTimer = null;
      this.request();
    }, Math.ceil(delay));
  }

  stop() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    if (this.ambientTimer !== null) window.clearTimeout(this.ambientTimer);
    this.frame = null;
    this.ambientTimer = null;
  }
}

class HardwareBoardRenderer {
  private renderer: THREE.WebGLRenderer | null = null;
  private views = new Set<View>();
  private schedule: BoardFrameScheduler;
  private lastFrame = 0;
  private movingUntil = 0;
  private lost = false;
  private failed = false;
  private teardown: number | null = null;
  private observer: ResizeObserver | null = null;
  private forced = window.matchMedia('(forced-colors: active)');
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  constructor() {
    this.schedule = new BoardFrameScheduler(
      (time) => this.render(time),
      () => this.views.size > 0 && !document.hidden && !this.lost,
    );
    this.observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(this.invalidate);
    window.addEventListener('resize', this.invalidate);
    document.addEventListener('scroll', this.onScroll, {
      capture: true,
      passive: true,
    });
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('animationstart', this.onAnimation, true);
    document.addEventListener('animationend', this.invalidate, true);
    document.addEventListener('animationcancel', this.invalidate, true);
    this.forced.addEventListener('change', this.onMedia);
    this.reduced.addEventListener('change', this.onMedia);
    window.visualViewport?.addEventListener('resize', this.invalidate);
    window.visualViewport?.addEventListener('scroll', this.onScroll);
  }

  private ensureRenderer() {
    if (this.failed || this.forced.matches) return false;
    if (this.renderer) return true;
    try {
      const canvas = document.createElement('canvas');
      canvas.className = 'hardware-board-canvas gpu-board-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: 'low-power',
        stencil: false,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = false;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      canvas.addEventListener('webglcontextlost', this.onContextLost);
      canvas.addEventListener('webglcontextrestored', this.onContextRestored);
      // This layer clips the translated canvas to the page without extending
      // its scroll height when filtering or navigating to shorter content.
      const layer = document.createElement('div');
      layer.className = 'hardware-board-layer gpu-board-layer';
      layer.setAttribute('aria-hidden', 'true');
      layer.append(canvas);
      (document.querySelector('.app-shell') ?? document.body).append(layer);
      this.renderer = renderer;
      return true;
    } catch {
      this.failed = true;
      return false;
    }
  }

  add(
    element: HTMLElement,
    options: HardwareBoardViewOptions,
  ): HardwareBoardViewHandle {
    if (this.teardown !== null) window.clearTimeout(this.teardown);
    this.teardown = null;
    const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 1000);
    camera.position.copy(defaultDirection).multiplyScalar(18);
    camera.lookAt(0, 0, 0);
    const controls = new OrbitControls(camera, element);
    controls.enablePan = false;
    controls.enableDamping = !this.reduced.matches;
    controls.dampingFactor = 0.16;
    controls.rotateSpeed = 0.65;
    controls.zoomSpeed = 0.75;
    controls.minPolarAngle = THREE.MathUtils.degToRad(15);
    controls.maxPolarAngle = THREE.MathUtils.degToRad(75);
    controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
    const view: View = {
      element,
      options,
      scene: new THREE.Scene(),
      camera,
      controls,
      model: null,
      bounds: new THREE.Box3(
        new THREE.Vector3(-5.75, -0.18, -2.3),
        new THREE.Vector3(5.55, 1.05, 2.78),
      ),
      framingPoints: [],
      focus:
        cameras.get(options.sceneKey)?.focus ??
        (options.scene.kind === 'gpu' ? 'chip' : 'board'),
      baseDistance: 18,
      rect: { left: 0, top: 0, width: 0, height: 0 },
      gesture: null,
      pointers: new Set(),
      hover: null,
      tween: null,
      resizing: false,
      ready: false,
      mode: 'loading',
      renderSequence: 0,
      cleanup: () => {},
    };
    const sky = new THREE.HemisphereLight(0xe8f1ff, 0x3e574b, 1.7);
    // A broad overhead key exposes the chip and component faces; weaker side
    // lights keep the metal bracket readable without flattening dark recesses.
    const keyLight = new THREE.DirectionalLight(0xffffff, 5.8);
    keyLight.position.set(-2, 9, 6);
    const fillLight = new THREE.DirectionalLight(0xe8efff, 1.8);
    fillLight.position.set(6, 5, 4);
    const rimLight = new THREE.DirectionalLight(0xf3f8ff, 1.2);
    rimLight.position.set(4, 5, -6);
    view.scene.add(sky, keyLight, fillLight, rimLight);
    this.views.add(view);
    this.buildModel(view);
    const remembered = cameras.get(options.sceneKey);
    this.frameCamera(view, remembered?.ratio ?? 1, remembered, false);
    this.configureControls(view);
    if (this.lost || this.failed || this.forced.matches)
      this.setMode(view, false);
    const changed = () => {
      if (!view.resizing) this.remember(view);
      this.invalidate();
    };
    const started = () => {
      view.tween = null;
      this.dismissHover(view);
    };
    controls.addEventListener('change', changed);
    controls.addEventListener('start', started);
    const down = (event: PointerEvent) => this.pointerDown(view, event);
    const move = (event: PointerEvent) => this.pointerMove(view, event);
    const up = (event: PointerEvent) => this.pointerUp(view, event);
    const cancel = (event: PointerEvent) => {
      view.pointers.delete(event.pointerId);
      if (view.gesture) view.gesture.cancelled = true;
      if (view.pointers.size === 0) view.gesture = null;
      this.dismissHover(view);
    };
    const leave = () => this.dismissHover(view);
    const wheel = (event: WheelEvent) => {
      view.gesture = null;
      if (
        event.ctrlKey ||
        event.metaKey ||
        !view.options.interactive ||
        !element.parentElement?.contains(document.activeElement)
      )
        event.stopImmediatePropagation();
    };
    const keydown = (event: KeyboardEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        !view.ready ||
        event.target !== element ||
        ![
          'ArrowLeft',
          'ArrowRight',
          'ArrowUp',
          'ArrowDown',
          '+',
          '=',
          '-',
          'Home',
        ].includes(event.key)
      )
        return;
      event.preventDefault();
      view.tween = null;
      if (event.key === 'ArrowLeft') controls.rotateLeft(0.15);
      if (event.key === 'ArrowRight') controls.rotateLeft(-0.15);
      if (event.key === 'ArrowUp') controls.rotateUp(0.1);
      if (event.key === 'ArrowDown') controls.rotateUp(-0.1);
      if (event.key === '+' || event.key === '=') controls.dollyIn(0.82);
      if (event.key === '-') controls.dollyOut(0.82);
      if (event.key === 'Home') this.reset(view);
      this.invalidate();
    };
    element.addEventListener('pointerdown', down, true);
    element.addEventListener('pointermove', move, true);
    element.addEventListener('pointerup', up, true);
    element.addEventListener('pointercancel', cancel, true);
    element.addEventListener('lostpointercapture', cancel, true);
    element.addEventListener('pointerleave', leave);
    element.addEventListener('wheel', wheel, { capture: true, passive: true });
    element.addEventListener('keydown', keydown);
    view.cleanup = () => {
      controls.removeEventListener('change', changed);
      controls.removeEventListener('start', started);
      controls.dispose();
      element.removeEventListener('pointerdown', down, true);
      element.removeEventListener('pointermove', move, true);
      element.removeEventListener('pointerup', up, true);
      element.removeEventListener('pointercancel', cancel, true);
      element.removeEventListener('lostpointercapture', cancel, true);
      element.removeEventListener('pointerleave', leave);
      element.removeEventListener('wheel', wheel, true);
      element.removeEventListener('keydown', keydown);
      element.style.touchAction = '';
    };
    this.observer?.observe(element);
    // Navigation transforms move elements without triggering ResizeObserver.
    this.movingUntil = Math.max(this.movingUntil, performance.now() + 280);
    this.invalidate();
    this.emitState(view);
    return {
      update: (next) => {
        const previous = view.options;
        view.options = next;
        if (
          previous.topologyKey !== next.topologyKey ||
          previous.theme !== next.theme ||
          previous.scene.kind !== next.scene.kind
        ) {
          const ratio = view.controls.getDistance() / view.baseDistance;
          this.buildModel(view);
          this.dismissHover(view);
          if (next.scene.kind !== 'gpu' || !this.frame(view, view.focus))
            this.frameCamera(view, ratio, undefined, false);
        }
        try {
          if (previous.selectedId !== next.selectedId) {
            view.model?.setSelected(next.selectedId, this.reduced.matches);
            this.emitState(view);
            this.invalidate();
          }
          if (previous.highlightedId !== next.highlightedId) {
            view.model?.setHighlight(next.highlightedId, this.reduced.matches);
            view.element.parentElement?.setAttribute(
              'data-highlighted-chip',
              next.highlightedId ?? '',
            );
            this.invalidate();
          }
          if (view.model?.setState(next.scene, this.reduced.matches))
            this.invalidate();
        } catch {
          this.failModel(view);
        }
        if (previous.interactive !== next.interactive)
          this.configureControls(view);
      },
      zoom: (direction) => {
        view.tween = null;
        if (direction === 'in') controls.dollyIn(0.82);
        else controls.dollyOut(0.82);
        this.invalidate();
      },
      focus: (frameId) => {
        if (!this.frame(view, frameId)) return;
        view.focus = frameId;
        this.frameCamera(view, 1, undefined, true);
      },
      reset: () => this.reset(view),
      dispose: () => this.remove(view),
    };
  }

  private buildModel(view: View) {
    view.gesture = null;
    view.pointers.clear();
    if (view.model) {
      view.scene.remove(view.model.group);
      view.model.dispose();
      view.model = null;
    }
    try {
      view.model = createHardwareScene(view.options.scene, view.options.theme);
      view.scene.add(view.model.group);
      view.framingPoints = boardFramingPoints(view.model.group);
      view.bounds.setFromPoints(view.framingPoints);
      view.model.setMotionEnabled(!this.reduced.matches);
      view.model.setState(view.options.scene, true);
      view.model.setSelected(view.options.selectedId, true);
      view.model.setHighlight(view.options.highlightedId, true);
    } catch {
      this.failModel(view);
    }
    this.invalidate();
  }

  private failModel(view: View) {
    const model = view.model;
    view.model = null;
    view.tween = null;
    if (model) {
      view.scene.remove(model.group);
      model.dispose();
    }
    this.setMode(view, false);
    this.invalidate();
  }

  private configureControls(view: View) {
    view.controls.enabled =
      view.ready &&
      view.options.interactive &&
      !this.forced.matches &&
      !this.lost &&
      !this.failed;
    view.controls.enableDamping = !this.reduced.matches;
    view.element.style.touchAction = view.controls.enabled
      ? 'none'
      : 'pan-y pinch-zoom';
    if (!view.options.interactive) {
      view.gesture = null;
      view.pointers.clear();
    }
  }

  private frame(view: View, id: string) {
    return (
      (view.model && Object.hasOwn(view.model.frames, id)
        ? view.model.frames[id]
        : null) ??
      (id === 'board'
        ? {
            target: view.bounds.getCenter(new THREE.Vector3()),
            points: view.framingPoints,
          }
        : null)
    );
  }

  private frameCamera(
    view: View,
    ratio: number,
    remembered?: CameraState,
    animate = false,
  ) {
    const rect = view.element.getBoundingClientRect();
    view.camera.aspect =
      rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 1.6;
    view.camera.updateProjectionMatrix();
    if (!this.frame(view, view.focus))
      view.focus = view.model?.defaultFrame ?? 'board';
    const frame = this.frame(view, view.focus)!;
    const target = frame.target.clone();
    const direction = new THREE.Vector3()
      .subVectors(view.camera.position, view.controls.target)
      .normalize();
    if (remembered)
      direction.setFromSpherical(
        new THREE.Spherical(1, remembered.phi, remembered.theta),
      );
    const from = view.camera.position.clone();
    const fromTarget = view.controls.target.clone();
    view.camera.position.copy(target).add(direction);
    view.camera.lookAt(target);
    view.baseDistance = boardFitDistance(frame.points, view.camera, target);
    view.controls.minDistance = view.baseDistance * 0.42;
    view.controls.maxDistance = view.baseDistance * 1.8;
    const to = target
      .clone()
      .addScaledVector(
        direction,
        view.baseDistance * THREE.MathUtils.clamp(ratio, 0.42, 1.8),
      );
    view.resizing = true;
    if (animate && !this.reduced.matches) {
      view.camera.position.copy(from);
      view.controls.target.copy(fromTarget);
      view.tween = {
        from,
        to,
        fromTarget,
        toTarget: target,
        started: performance.now(),
      };
      view.controls.maxDistance = Math.max(
        view.controls.maxDistance,
        from.distanceTo(fromTarget),
      );
      view.controls.minDistance = Math.min(
        view.controls.minDistance,
        from.distanceTo(fromTarget),
      );
    } else {
      view.tween = null;
      view.camera.position.copy(to);
      view.controls.target.copy(target);
    }
    // Flush any old damping delta before applying a deliberate camera frame.
    const damping = view.controls.enableDamping;
    view.controls.enableDamping = false;
    view.controls.update();
    view.controls.enableDamping = damping;
    view.resizing = false;
    view.rect = rect;
    this.remember(view);
    this.emitState(view);
    this.invalidate();
  }

  private reset(view: View) {
    view.focus = view.model?.defaultFrame ?? 'board';
    this.frameCamera(
      view,
      1,
      {
        theta: defaultSpherical.theta,
        phi: defaultSpherical.phi,
        ratio: 1,
        focus: view.focus,
      },
      true,
    );
  }

  private remember(view: View) {
    const value = {
      theta: view.controls.getAzimuthalAngle(),
      phi: view.controls.getPolarAngle(),
      ratio: view.controls.getDistance() / view.baseDistance,
      focus: view.focus,
    };
    cameras.set(view.options.sceneKey, value);
    if (cameras.size > 128) cameras.delete(cameras.keys().next().value!);
    this.emitState(view);
  }

  private emitState(view: View) {
    const distance = view.controls.getDistance();
    view.options.onViewState({
      focus: view.focus,
      canFocusSelected: Boolean(
        view.options.selectedId && this.frame(view, view.options.selectedId),
      ),
      canZoomIn: distance > view.controls.minDistance * 1.01,
      canZoomOut: distance < view.controls.maxDistance / 1.01,
    });
    const root = view.element.parentElement;
    root?.setAttribute('data-focus', view.focus);
    root?.setAttribute(
      'data-camera',
      JSON.stringify({
        theta: view.controls.getAzimuthalAngle(),
        phi: view.controls.getPolarAngle(),
        distance,
      }),
    );
  }

  private hit(view: View, x: number, y: number) {
    if (!view.ready || !view.model) return null;
    const rect = view.element.getBoundingClientRect();
    if (
      !rect.width ||
      !rect.height ||
      x < rect.left ||
      x > rect.right ||
      y < rect.top ||
      y > rect.bottom
    )
      return null;
    this.pointer.set(
      ((x - rect.left) / rect.width) * 2 - 1,
      -((y - rect.top) / rect.height) * 2 + 1,
    );
    view.scene.updateMatrixWorld(true);
    view.camera.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.pointer, view.camera);
    const hit = this.raycaster.intersectObjects(view.model.pickables, false)[0];
    return resolveHardwarePick(view.model, hit);
  }

  private pointerDown(view: View, event: PointerEvent) {
    if (!view.ready || event.button !== 0) return;
    view.tween = null;
    view.pointers.add(event.pointerId);
    if (view.pointers.size > 1) {
      if (view.gesture) view.gesture.cancelled = true;
      return;
    }
    view.gesture = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      key: this.hit(view, event.clientX, event.clientY),
      maxDistance: 0,
      cancelled: false,
      touch: event.pointerType === 'touch',
    };
    if (event.pointerType !== 'touch')
      view.element.focus({ preventScroll: true });
  }

  private pointerMove(view: View, event: PointerEvent) {
    if (view.gesture) {
      view.gesture.maxDistance = Math.max(
        view.gesture.maxDistance,
        Math.hypot(
          event.clientX - view.gesture.x,
          event.clientY - view.gesture.y,
        ),
      );
      return;
    }
    if (event.pointerType === 'touch') return;
    const key = this.hit(view, event.clientX, event.clientY);
    if (key !== view.hover) {
      view.hover = key;
      view.element.style.cursor = key
        ? 'pointer'
        : view.options.interactive
          ? 'grab'
          : 'default';
      view.options.onHighlight(key);
    }
  }

  private pointerUp(view: View, event: PointerEvent) {
    const gesture = view.gesture;
    view.pointers.delete(event.pointerId);
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    gesture.maxDistance = Math.max(
      gesture.maxDistance,
      Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y),
    );
    const hit = this.hit(view, event.clientX, event.clientY);
    view.gesture = null;
    if (isBoardClick(gesture, hit)) view.options.onSelect(hit!);
  }

  private dismissHover(view: View) {
    if (view.hover !== null) {
      view.hover = null;
      view.options.onHighlight(null);
    }
  }

  private onScroll = () => {
    for (const view of this.views) this.dismissHover(view);
    this.invalidate();
  };
  private onVisibility = () => {
    if (!document.hidden) this.invalidate();
    else {
      this.schedule.stop();
      this.lastFrame = 0;
    }
  };
  private onAnimation = (event: AnimationEvent) => {
    if (
      event.target instanceof Element &&
      event.target.classList.contains('workbench-view')
    ) {
      this.movingUntil = performance.now() + 400;
      this.invalidate();
    }
  };
  private onMedia = () => {
    for (const view of this.views) {
      this.configureControls(view);
      try {
        view.model?.setMotionEnabled(!this.reduced.matches);
        if (this.reduced.matches) {
          view.model?.setState(view.options.scene, true);
          view.model?.setSelected(view.options.selectedId, true);
          view.model?.setHighlight(view.options.highlightedId, true);
          if (view.tween) {
            view.camera.position.copy(view.tween.to);
            view.controls.target.copy(view.tween.toTarget);
            view.tween = null;
            view.controls.update();
          }
        }
      } catch {
        this.failModel(view);
      }
    }
    this.invalidate();
  };
  private onContextLost = (event: Event) => {
    event.preventDefault();
    this.lost = true;
    for (const view of this.views) {
      this.setMode(view, false);
      this.configureControls(view);
    }
    if (this.renderer) this.renderer.domElement.style.visibility = 'hidden';
    this.schedule.stop();
  };
  private onContextRestored = () => {
    this.lost = false;
    for (const view of this.views) this.configureControls(view);
    this.invalidate();
  };

  private setMode(view: View, ready: boolean) {
    const mode = ready ? 'webgl' : 'fallback';
    if (view.mode === mode) return;
    view.ready = ready;
    // The imperative inspector owns keyboard focus only while graphics are ready.
    view.element.tabIndex = ready ? 0 : -1;
    view.mode = mode;
    this.configureControls(view);
    view.options.onRenderMode(mode);
  }

  private invalidate = () => {
    this.schedule.request();
  };

  private render = (time: number) => {
    if (!this.views.size) return;
    if (this.forced.matches || !this.ensureRenderer() || this.lost) {
      if (this.renderer) this.renderer.domElement.style.visibility = 'hidden';
      for (const view of this.views) this.setMode(view, false);
      return;
    }
    const renderer = this.renderer!;
    const width = document.documentElement.clientWidth || window.innerWidth;
    const height = window.innerHeight;
    const canvas = renderer.domElement;
    const origin = canvas.parentElement!.getBoundingClientRect();
    // Move old pixels with the document between frames. Reposition and redraw
    // together so compositor scrolling cannot make boards lag behind cards.
    canvas.style.transform = `translate3d(${-origin.left}px, ${-origin.top}px, 0)`;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    if (renderer.getPixelRatio() !== dpr) renderer.setPixelRatio(dpr);
    if (
      canvas.width !== Math.floor(width * dpr) ||
      canvas.height !== Math.floor(height * dpr)
    )
      renderer.setSize(width, height, false);
    canvas.style.visibility = 'visible';
    const clip = chromeClip(width, height);
    const delta = Math.min(64, this.lastFrame ? time - this.lastFrame : 16);
    this.lastFrame = time;
    let again = time < this.movingUntil;
    let ambient = false;
    renderer.setScissorTest(false);
    renderer.clear(true, true, true);
    renderer.setScissorTest(true);
    try {
      for (const view of this.views) {
        if (!view.model) {
          this.setMode(view, false);
          continue;
        }
        try {
          const rect = view.element.getBoundingClientRect();
          const parentClip = visibleClip(view.element, clip);
          const scissor = parentClip && boardViewportBounds(rect, parentClip);
          if (!scissor) continue;
          if (
            Math.abs(rect.width - view.rect.width) > 0.1 ||
            Math.abs(rect.height - view.rect.height) > 0.1
          )
            this.frameCamera(
              view,
              view.controls.getDistance() / view.baseDistance,
              undefined,
              false,
            );
          if (view.tween) {
            const progress = Math.min(1, (time - view.tween.started) / 200);
            const t = 1 - (1 - progress) ** 3;
            view.camera.position.lerpVectors(view.tween.from, view.tween.to, t);
            view.controls.target.lerpVectors(
              view.tween.fromTarget,
              view.tween.toTarget,
              t,
            );
            if (progress === 1) {
              view.tween = null;
              view.controls.minDistance = view.baseDistance * 0.42;
              view.controls.maxDistance = view.baseDistance * 1.8;
            } else again = true;
          }
          if (view.controls.update()) again = true;
          view.model.update(delta);
          if (view.model.isTransitioning()) again = true;
          if (view.model.hasAmbientActivity()) ambient = true;
          renderer.setViewport(
            rect.left,
            height - rect.top - rect.height,
            rect.width,
            rect.height,
          );
          renderer.setScissor(
            scissor.left,
            height - scissor.top - scissor.height,
            scissor.width,
            scissor.height,
          );
          renderer.render(view.scene, view.camera);
          view.renderSequence++;
          this.setMode(view, true);
          if (import.meta.env.DEV) {
            view.element.parentElement?.setAttribute(
              'data-activity',
              JSON.stringify(view.model.getActivityState?.() ?? []),
            );
            view.element.parentElement?.setAttribute(
              'data-render-sequence',
              String(view.renderSequence),
            );
            const projected = view.framingPoints.map((point) =>
              point.clone().project(view.camera),
            );
            view.element.parentElement?.setAttribute(
              'data-board-bounds',
              JSON.stringify({
                left: Math.min(...projected.map((point) => point.x)),
                right: Math.max(...projected.map((point) => point.x)),
                top: Math.max(...projected.map((point) => point.y)),
                bottom: Math.min(...projected.map((point) => point.y)),
              }),
            );
            const targets = (view.model?.pickables ?? []).map((object) => {
              const point = new THREE.Box3()
                .setFromObject(object)
                .getCenter(new THREE.Vector3())
                .project(view.camera);
              const x = ((point.x + 1) * rect.width) / 2;
              const y = ((1 - point.y) * rect.height) / 2;
              return {
                key: object.userData.regionId,
                x,
                y,
                visible:
                  point.z >= -1 &&
                  point.z <= 1 &&
                  x >= 0 &&
                  x <= rect.width &&
                  y >= 0 &&
                  y <= rect.height,
              };
            });
            view.element.parentElement?.setAttribute(
              'data-chip-targets',
              JSON.stringify(targets),
            );
          }
        } catch {
          // A malformed scene falls back independently; context loss is shared.
          this.failModel(view);
        }
      }
    } catch {
      this.failed = true;
      canvas.style.visibility = 'hidden';
      for (const view of this.views) this.setMode(view, false);
      return;
    }
    if (again) this.invalidate();
    else if (ambient) this.schedule.ambient(time);
  };

  private remove(view: View) {
    if (!this.views.delete(view)) return;
    this.remember(view);
    this.observer?.unobserve(view.element);
    view.cleanup();
    view.model?.dispose();
    if (!this.views.size) {
      this.schedule.stop();
      if (this.renderer) this.renderer.domElement.style.visibility = 'hidden';
      this.teardown = window.setTimeout(() => this.dispose(), 180);
    } else this.invalidate();
  }

  private dispose() {
    if (this.views.size) return;
    this.schedule.stop();
    this.observer?.disconnect();
    window.removeEventListener('resize', this.invalidate);
    document.removeEventListener('scroll', this.onScroll, true);
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('animationstart', this.onAnimation, true);
    document.removeEventListener('animationend', this.invalidate, true);
    document.removeEventListener('animationcancel', this.invalidate, true);
    this.forced.removeEventListener('change', this.onMedia);
    this.reduced.removeEventListener('change', this.onMedia);
    window.visualViewport?.removeEventListener('resize', this.invalidate);
    window.visualViewport?.removeEventListener('scroll', this.onScroll);
    if (this.renderer) {
      const canvas = this.renderer.domElement;
      canvas.removeEventListener('webglcontextlost', this.onContextLost);
      canvas.removeEventListener(
        'webglcontextrestored',
        this.onContextRestored,
      );
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      canvas.parentElement?.remove();
    }
    if (shared === this) shared = null;
  }
}

let shared: HardwareBoardRenderer | null = null;
export function registerHardwareBoardView(
  element: HTMLElement,
  options: HardwareBoardViewOptions,
): HardwareBoardViewHandle {
  shared ??= new HardwareBoardRenderer();
  return shared.add(element, options);
}

/** Preserve the GPU bridge and chip-focus defaults while sharing all scenes. */
export function registerGPUBoardView(
  element: HTMLElement,
  options: BoardViewOptions,
): BoardViewHandle {
  let focus = 'chip';
  const convert = (next: BoardViewOptions): HardwareBoardViewOptions => ({
    ...next,
    sceneKey: next.gpuKey,
    scene: {
      kind: 'gpu',
      regions: next.regions,
      appearances: next.appearances,
    },
    selectedId: null,
    onViewState: (state) => {
      focus = state.focus;
      next.onViewState(state);
    },
  });
  const handle = registerHardwareBoardView(element, convert(options));
  return {
    update: (next) => handle.update(convert(next)),
    zoom: handle.zoom,
    focusChip: () => handle.focus(focus === 'chip' ? 'board' : 'chip'),
    reset: handle.reset,
    dispose: handle.dispose,
  };
}
