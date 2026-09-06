import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  registerHardwareBoardView,
  type HardwareBoardViewHandle,
  type HardwareBoardViewOptions,
} from './gpu-board-renderer';
import type { HardwareScene, HardwareSceneModel } from './hardware-scene';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  render: vi.fn(),
  contexts: vi.fn(),
}));
vi.mock('./hardware-scene', async (original) => ({
  ...(await original<typeof import('./hardware-scene')>()),
  createHardwareScene: mocks.create,
}));
vi.mock('three', async (original) => ({
  ...(await original<typeof import('three')>()),
  WebGLRenderer: class {
    domElement: HTMLCanvasElement;
    private ratio = 1;
    constructor(options: { canvas: HTMLCanvasElement }) {
      this.domElement = options.canvas;
      mocks.contexts();
    }
    setPixelRatio(value: number) {
      this.ratio = value;
    }
    getPixelRatio() {
      return this.ratio;
    }
    setSize(width: number, height: number) {
      this.domElement.width = Math.floor(width * this.ratio);
      this.domElement.height = Math.floor(height * this.ratio);
    }
    setClearColor() {}
    setScissorTest() {}
    clear() {}
    setViewport() {}
    setScissor() {}
    render = mocks.render;
    dispose() {}
    forceContextLoss() {}
  },
}));

const handles: HardwareBoardViewHandle[] = [];
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
const models = new Map<string, HardwareSceneModel>();

function model(scene: HardwareScene): HardwareSceneModel {
  const group = new THREE.Group();
  const geometry = new THREE.BoxGeometry(8, 0.2, 10);
  const material = new THREE.MeshBasicMaterial();
  group.add(new THREE.Mesh(geometry, material));
  const frame = (x: number, size: number) => ({
    target: new THREE.Vector3(x, 0, 0),
    points: [
      new THREE.Vector3(x - size, -0.1, -size),
      new THREE.Vector3(x + size, 0.1, size),
    ],
  });
  const result: HardwareSceneModel = {
    group,
    pickables: [],
    frames: {
      board: frame(0, 5),
      chip: frame(0, 1.4),
      cpu: frame(-1, 1),
      memory: frame(2, 0.75),
      storage: frame(1, 0.8),
    },
    defaultFrame: scene.kind === 'gpu' ? 'chip' : 'board',
    setState: vi.fn(() => false),
    setHighlight: vi.fn(),
    setSelected: vi.fn(),
    setMotionEnabled: vi.fn(),
    update: vi.fn(),
    isTransitioning: () => false,
    hasAmbientActivity: () => false,
    dispose: vi.fn(() => {
      geometry.dispose();
      material.dispose();
    }),
  };
  models.set(scene.kind, result);
  return result;
}

function options(kind: HardwareScene['kind']): HardwareBoardViewOptions {
  return {
    sceneKey: `host:${kind}`,
    topologyKey: 'v1',
    scene:
      kind === 'gpu'
        ? { kind, regions: [] }
        : { kind, appearance: { cpu: 50, memory: 20 } },
    selectedId: kind === 'motherboard' ? 'cpu' : null,
    highlightedId: null,
    theme: 'dark',
    interactive: true,
    onHighlight: vi.fn(),
    onSelect: vi.fn(),
    onRenderMode: vi.fn(),
    onViewState: vi.fn(),
  };
}

function mount(next: HardwareBoardViewOptions, top = 100) {
  const root = document.createElement('div');
  root.className = 'hardware-board-view';
  const viewport = document.createElement('div');
  root.append(viewport);
  document.body.append(root);
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: top,
    left: 0,
    top,
    width: 600,
    height: 280,
    right: 600,
    bottom: top + 280,
    toJSON: () => {},
  });
  const handle = registerHardwareBoardView(viewport, next);
  handles.push(handle);
  return { handle, root };
}

function draw() {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((callback) => callback(performance.now() + 1000));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  mocks.create.mockImplementation(model);
});

afterEach(() => {
  handles.splice(0).forEach((handle) => handle.dispose());
  vi.advanceTimersByTime(200);
  frames.clear();
  models.clear();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('mixed hardware renderer lifecycle', () => {
  it('shares one canvas, retains independent cameras, and hides only after the last scene leaves', () => {
    const gpuOptions = options('gpu');
    const motherOptions = options('motherboard');
    const gpu = mount(gpuOptions);
    const mother = mount(motherOptions, 400);
    draw();
    expect(mocks.contexts).toHaveBeenCalledOnce();
    expect(
      document.querySelectorAll('canvas.hardware-board-canvas'),
    ).toHaveLength(1);
    expect(gpu.root).toHaveAttribute('data-focus', 'chip');
    expect(mother.root).toHaveAttribute('data-focus', 'board');
    const camera = gpu.root.getAttribute('data-camera');
    const motherboardCamera = mother.root.getAttribute('data-camera');
    mother.handle.update({
      ...motherOptions,
      selectedId: 'memory',
      highlightedId: 'storage',
    });
    draw();
    expect(mother.root.getAttribute('data-camera')).toBe(motherboardCamera);
    expect(models.get('motherboard')?.setSelected).toHaveBeenLastCalledWith(
      'memory',
      true,
    );
    mother.handle.focus('memory');
    draw();
    expect(mother.root).toHaveAttribute('data-focus', 'memory');
    expect(mother.root.getAttribute('data-camera')).not.toBe(motherboardCamera);
    expect(gpu.root.getAttribute('data-camera')).toBe(camera);
    mother.handle.focus('missing-component');
    expect(mother.root).toHaveAttribute('data-focus', 'memory');
    mother.handle.reset();
    expect(mother.root).toHaveAttribute('data-focus', 'board');
    gpu.handle.dispose();
    expect(
      (document.querySelector('canvas.hardware-board-canvas') as HTMLElement)
        .style.visibility,
    ).toBe('visible');
    mother.handle.dispose();
    expect(
      (document.querySelector('canvas.hardware-board-canvas') as HTMLElement)
        .style.visibility,
    ).toBe('hidden');
  });

  it('falls back a failed motherboard model while the GPU continues rendering', () => {
    const gpuOptions = options('gpu');
    const motherOptions = options('motherboard');
    const gpu = mount(gpuOptions);
    mount(motherOptions, 400);
    vi.mocked(models.get('motherboard')!.update).mockImplementation(() => {
      throw new Error('Model failed');
    });
    draw();
    expect(motherOptions.onRenderMode).toHaveBeenLastCalledWith('fallback');
    expect(gpuOptions.onRenderMode).toHaveBeenLastCalledWith('webgl');
    expect(models.get('motherboard')?.dispose).toHaveBeenCalledOnce();
    expect(models.get('gpu')?.dispose).not.toHaveBeenCalled();
    const rendered = Number(gpu.root.getAttribute('data-render-sequence'));
    draw();
    expect(
      Number(gpu.root.getAttribute('data-render-sequence')),
    ).toBeGreaterThan(rendered);
    expect(mocks.contexts).toHaveBeenCalledOnce();
  });

  it('restores a named camera frame across navigation and recovers if that frame disappears', () => {
    const next = {
      ...options('motherboard'),
      sceneKey: 'host:motherboard-remembered',
    };
    const original = mount(next);
    draw();
    original.handle.focus('memory');
    const camera = original.root.getAttribute('data-camera');
    original.handle.dispose();
    vi.advanceTimersByTime(200);
    const restored = mount(next);
    draw();
    expect(restored.root).toHaveAttribute('data-focus', 'memory');
    const before = JSON.parse(camera!) as Record<string, number>;
    const after = JSON.parse(
      restored.root.getAttribute('data-camera')!,
    ) as Record<string, number>;
    for (const key of ['theta', 'phi', 'distance'])
      expect(after[key]).toBeCloseTo(before[key], 12);
    mocks.create.mockImplementation((scene: HardwareScene) => {
      const result = model(scene);
      result.frames = { board: result.frames.board, cpu: result.frames.cpu };
      return result;
    });
    restored.handle.update({
      ...next,
      topologyKey: 'replacement-without-memory',
    });
    expect(restored.root).toHaveAttribute('data-focus', 'board');
    expect(restored.root.getAttribute('data-camera')).not.toBe(camera);
  });
});
