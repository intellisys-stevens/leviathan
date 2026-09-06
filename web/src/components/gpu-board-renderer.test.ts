import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createGPUBoard } from './gpu-board-model';
import { resolveHardwarePick } from './hardware-scene';
import {
  boardFitDistance,
  boardFramingPoints,
  boardViewportBounds,
  isBoardClick,
  BoardFrameScheduler,
} from './gpu-board-renderer';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('GPU ambient frame scheduling', () => {
  it('limits ambient wakeups to 30fps while letting interaction preempt the timer', () => {
    vi.useFakeTimers();
    const callbacks: FrameRequestCallback[] = [];
    const raf = vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const draw = vi.fn();
    const scheduler = new BoardFrameScheduler(draw, () => true);
    scheduler.ambient(performance.now());
    vi.advanceTimersByTime(33);
    expect(raf).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(raf).toHaveBeenCalledOnce();
    callbacks[0](performance.now());
    expect(draw).toHaveBeenCalledOnce();
    scheduler.ambient(performance.now());
    scheduler.request();
    expect(raf).toHaveBeenCalledTimes(2);
    callbacks[1](performance.now());
    vi.advanceTimersByTime(40);
    expect(raf).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('cancels queued work for hidden, idle or disposed renderers', () => {
    vi.useFakeTimers();
    const raf = vi.fn(() => 9),
      cancel = vi.fn(),
      draw = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', cancel);
    let enabled = true;
    const scheduler = new BoardFrameScheduler(draw, () => enabled);
    scheduler.ambient(performance.now());
    enabled = false;
    vi.advanceTimersByTime(50);
    expect(raf).not.toHaveBeenCalled();
    scheduler.request();
    expect(raf).not.toHaveBeenCalled();
    enabled = true;
    scheduler.request();
    scheduler.stop();
    expect(cancel).toHaveBeenCalledWith(9);
    scheduler.ambient(performance.now());
    scheduler.stop();
    vi.advanceTimersByTime(50);
    expect(raf).toHaveBeenCalledOnce();
    expect(draw).not.toHaveBeenCalled();
  });
});

describe('complete-board camera framing', () => {
  it('includes transformed components and every repeated contact', () => {
    const group = new THREE.Group();
    group.position.set(3, 1, -2);
    const geometry = new THREE.BoxGeometry(2, 1, 2);
    const material = new THREE.MeshBasicMaterial();
    const contacts = new THREE.InstancedMesh(geometry, material, 2);
    contacts.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-4, 0, 0));
    contacts.setMatrixAt(1, new THREE.Matrix4().makeTranslation(6, 0, 0));
    group.add(contacts);
    const points = boardFramingPoints(group);
    expect(points).toHaveLength(16);
    const bounds = new THREE.Box3().setFromPoints(points);
    expect(bounds.min.toArray()).toEqual([-2, 0.5, -3]);
    expect(bounds.max.toArray()).toEqual([10, 1.5, -1]);
    contacts.dispose();
    geometry.dispose();
    material.dispose();
  });

  it.each([288 / 280, 358 / 280, 480 / 320, 680 / 320, 1000 / 320])(
    'fits the complete physical board at aspect %s with tighter default framing',
    (aspect) => {
      const context = vi
        .spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockReturnValue(null);
      const model = createGPUBoard([], 'dark');
      try {
        const points = boardFramingPoints(model.group);
        const bounds = new THREE.Box3().setFromObject(model.group);
        const target = bounds.getCenter(new THREE.Vector3());
        const camera = new THREE.PerspectiveCamera(32, aspect, 0.05, 1000);
        for (const direction of [
          new THREE.Vector3(5, 8.5, 11).normalize(),
          new THREE.Vector3(-8, 10, -4).normalize(),
          new THREE.Vector3(0, 12, 2).normalize(),
        ]) {
          camera.position.copy(target).add(direction);
          camera.lookAt(target);
          const distance = boardFitDistance(points, camera, target);
          camera.position.copy(target).addScaledVector(direction, distance);
          camera.updateMatrixWorld(true);
          for (const point of points) {
            const projected = point.clone().project(camera);
            expect(Math.abs(projected.x)).toBeLessThan(0.98);
            expect(Math.abs(projected.y)).toBeLessThan(0.98);
            expect(projected.z).toBeGreaterThan(-1);
            expect(projected.z).toBeLessThan(1);
          }
          const previousCorners: THREE.Vector3[] = [];
          for (const x of [bounds.min.x, bounds.max.x])
            for (const y of [bounds.min.y, bounds.max.y])
              for (const z of [bounds.min.z, bounds.max.z])
                previousCorners.push(new THREE.Vector3(x, y, z));
          const previousDistance =
            (boardFitDistance(previousCorners, camera, target) / 1.035) * 1.08;
          expect(distance).toBeLessThan(previousDistance * 0.96);
        }
      } finally {
        model.dispose();
        context.mockRestore();
      }
    },
  );
});

describe('shared GPU view geometry', () => {
  it('clips a partly scrolled view without shrinking its camera projection', () => {
    const view = { left: 40, top: -60, width: 600, height: 320 };
    expect(
      boardViewportBounds(view, {
        left: 0,
        top: 104,
        width: 1280,
        height: 720,
      }),
    ).toEqual({ left: 40, top: 104, width: 600, height: 156 });
    expect(view).toEqual({ left: 40, top: -60, width: 600, height: 320 });
  });
  it('clips phone content above the fixed navigation and avoids offscreen draws', () => {
    const screen = { left: 0, top: 80, width: 360, height: 620 };
    expect(
      boardViewportBounds(
        { left: 16, top: 610, width: 328, height: 280 },
        screen,
      ),
    ).toEqual({ left: 16, top: 610, width: 328, height: 90 });
    expect(
      boardViewportBounds(
        { left: 16, top: 701, width: 328, height: 280 },
        screen,
      ),
    ).toBeNull();
    expect(
      boardViewportBounds(
        { left: 16, top: 120, width: 0, height: 280 },
        screen,
      ),
    ).toBeNull();
  });
  it('keeps coordinates in CSS pixels for a single renderer DPR conversion', () => {
    expect(
      boardViewportBounds(
        { left: -12.5, top: 48.5, width: 400, height: 300 },
        { left: 0, top: 0, width: 390, height: 844 },
      ),
    ).toEqual({ left: 0, top: 48.5, width: 387.5, height: 300 });
  });
});

describe('chip click versus orbit gestures', () => {
  const click = { key: 'CI-a', maxDistance: 0, cancelled: false, touch: false };
  it('accepts only a release on the same current chip', () => {
    expect(isBoardClick(click, 'CI-a')).toBe(true);
    expect(isBoardClick(click, 'CI-b')).toBe(false);
    expect(isBoardClick(click, null)).toBe(false);
    expect(isBoardClick({ ...click, key: null }, null)).toBe(false);
  });
  it('rejects dragged gestures even if the pointer returned to its start', () => {
    expect(isBoardClick({ ...click, maxDistance: 48 }, 'CI-a')).toBe(false);
    expect(isBoardClick({ ...click, maxDistance: 6.1 }, 'CI-a')).toBe(false);
    expect(isBoardClick({ ...click, maxDistance: 5 }, 'CI-a')).toBe(true);
  });
  it('allows touch jitter but rejects cancelled and multi-touch gestures', () => {
    expect(
      isBoardClick({ ...click, touch: true, maxDistance: 9 }, 'CI-a'),
    ).toBe(true);
    expect(
      isBoardClick({ ...click, touch: true, maxDistance: 11 }, 'CI-a'),
    ).toBe(false);
    expect(isBoardClick({ ...click, cancelled: true }, 'CI-a')).toBe(false);
  });
});

describe('hardware target identity', () => {
  it('preserves simple region identities and passes instance identities to scene resolvers', () => {
    const object = new THREE.Object3D();
    object.userData.regionId = 'cpu';
    const hit: THREE.Intersection = {
      object,
      distance: 1,
      point: new THREE.Vector3(),
      instanceId: 2,
    };
    expect(resolveHardwarePick({}, hit)).toBe('cpu');
    expect(resolveHardwarePick({}, undefined)).toBeNull();
    const resolvePick = vi.fn(
      (intersection: THREE.Intersection) => `memory:${intersection.instanceId}`,
    );
    expect(resolveHardwarePick({ resolvePick }, hit)).toBe('memory:2');
    expect(resolvePick).toHaveBeenCalledExactlyOnceWith(hit);
    expect(resolveHardwarePick({ resolvePick: () => null }, hit)).toBeNull();
  });
});
