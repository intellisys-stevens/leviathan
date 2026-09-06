import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createMotherboardModel } from './motherboard-model';

const boards: ReturnType<typeof createMotherboardModel>[] = [];
function board(theme: 'dark' | 'light' = 'dark') {
  const value = createMotherboardModel(theme);
  boards.push(value);
  return value;
}
beforeEach(() =>
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null),
);
afterEach(() => {
  for (const value of boards) value.dispose();
  boards.length = 0;
  vi.restoreAllMocks();
});

describe('procedural whole-machine motherboard', () => {
  it.each(['dark', 'light'] as const)(
    'keeps detailed %s hardware in finite board and component frames',
    (theme) => {
      const value = board(theme);
      const bounds = new THREE.Box3().setFromObject(value.group);
      const size = bounds.getSize(new THREE.Vector3());
      expect(size.x).toBeGreaterThan(8);
      expect(size.x).toBeLessThan(10);
      expect(size.z).toBeGreaterThan(10);
      expect(size.z).toBeLessThan(11);
      expect(size.y).toBeGreaterThan(1.3);
      expect(size.y).toBeLessThan(1.6);
      expect(value.defaultFrame).toBe('board');
      for (const [id, frame] of Object.entries(value.frames)) {
        expect(frame.points).toHaveLength(8);
        expect(
          [
            ...frame.target.toArray(),
            ...frame.points.flatMap((point) => point.toArray()),
          ].every(Number.isFinite),
        ).toBe(true);
        if (id === 'board')
          for (const point of frame.points)
            expect(bounds.containsPoint(point)).toBe(true);
      }
      for (const name of [
        'CPU socket locking arm',
        'Aggregate RAM packages',
        'M.2 controller',
        'Fine routed motherboard copper traces',
        'Rear I/O metal housings',
        '24-pin power socket',
        'Solid-state capacitors',
        'Motherboard mounting rings',
      ])
        expect(value.group.getObjectByName(name)).toBeDefined();
    },
  );

  it('offers exactly three category raycast targets, with all memory in one aggregate', () => {
    const value = board();
    expect(value.pickables.map((target) => target.userData.regionId)).toEqual([
      'cpu',
      'memory',
      'storage',
    ]);
    value.group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    for (const target of value.pickables) {
      const position = target.getWorldPosition(new THREE.Vector3());
      ray.set(
        new THREE.Vector3(position.x, 5, position.z),
        new THREE.Vector3(0, -1, 0),
      );
      expect(
        ray.intersectObjects(value.pickables, false)[0]?.object.userData
          .regionId,
      ).toBe(target.userData.regionId);
    }
  });

  it('applies the specified measured glow without changing geometry or camera frames', () => {
    const value = board();
    const children = [...value.group.children];
    const frames = value.frames;
    for (const utilization of [0, 50, 100]) {
      value.updateState({ cpu: utilization, memory: utilization }, true);
      expect(
        value.getActivityState().map((item) => item.emissiveIntensity),
      ).toEqual([
        0.15 + (0.65 * utilization) / 100,
        0.15 + (0.65 * utilization) / 100,
        0,
      ]);
      expect(value.group.children).toEqual(children);
      expect(value.frames).toBe(frames);
      expect(value.hasAmbientActivity()).toBe(false);
      expect(value.update(1000)).toBe(false);
    }
    value.updateState({ cpu: null, memory: Number.NaN }, true);
    expect(
      value.getActivityState().every((item) => item.emissiveIntensity === 0),
    ).toBe(true);
  });

  it('changes selection and hover outlines without falsifying activity', () => {
    const value = board();
    value.updateState({ cpu: 20, memory: 70 }, true);
    const emission = value
      .getActivityState()
      .map((item) => item.emissiveIntensity);
    value.setSelected('storage');
    value.setHighlight('cpu');
    expect(value.update(90)).toBe(true);
    const storage = value.group.getObjectByName(
      'storage selection outline',
    ) as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
    expect(storage.material.opacity).toBeGreaterThan(0);
    value.setHighlight('cpu');
    expect(value.update(90)).toBe(false);
    expect(storage.material.opacity).toBeCloseTo(0.98);
    expect(
      value.getActivityState().map((item) => item.emissiveIntensity),
    ).toEqual(emission);
    value.setHighlight(null, true);
    expect(storage.material.opacity).toBeCloseTo(0.98);
    value.setSelected(null, true);
    expect(storage.material.opacity).toBe(0);
  });

  it('finishes 180ms transitions, deduplicates polling and never schedules ambient frames', () => {
    const value = board();
    expect(value.updateState({ cpu: 100, memory: 50 })).toBe(true);
    expect(value.update(90)).toBe(true);
    const halfway = value.getActivityState()[0].emissiveIntensity;
    expect(value.updateState({ cpu: 100, memory: 50 })).toBe(false);
    expect(value.update(90)).toBe(false);
    expect(value.getActivityState()[0].emissiveIntensity).toBeGreaterThan(
      halfway,
    );
    expect(value.getActivityState()[0].emissiveIntensity).toBeCloseTo(0.8);
    expect(value.isTransitioning()).toBe(false);
    expect(value.hasAmbientActivity()).toBe(false);
    expect(value.update(10_000)).toBe(false);
    expect(
      value.group.children.some((child) => child instanceof THREE.Points),
    ).toBe(false);
  });

  it('applies reduced motion immediately to activity and inspection outlines', () => {
    const value = board();
    value.updateState({ cpu: 90, memory: 30 });
    value.setSelected('memory');
    value.setMotionEnabled(false);
    expect(value.isTransitioning()).toBe(false);
    expect(value.getActivityState()[0].emissiveIntensity).toBeCloseTo(0.735);
    expect(value.updateState({ cpu: 0, memory: null })).toBe(true);
    value.setHighlight('cpu');
    expect(value.isTransitioning()).toBe(false);
    expect(
      value.getActivityState().map((item) => item.emissiveIntensity),
    ).toEqual([0.15, 0, 0]);
    expect(value.updateState({ cpu: 0, memory: null }, true)).toBe(false);
  });

  it('keeps soft local halos independent of selection, neutral when unavailable and out of picking', () => {
    const value = board();
    const halos = ['cpu', 'memory'].map(
      (id) =>
        value.group.getObjectByName(
          `${id} measured activity halo`,
        ) as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>,
    );
    for (const halo of halos) {
      expect(value.pickables).not.toContain(halo);
      expect(halo.userData.excludeFromFraming).toBe(true);
      expect(halo.material.depthWrite).toBe(false);
      expect(halo.material.opacity).toBe(0);
      expect(halo.material.map).toBeInstanceOf(THREE.DataTexture);
      const data = (halo.material.map as THREE.DataTexture).image.data;
      if (!data) throw new Error('Expected local halo texture pixels');
      expect(data[(32 * 64 + 32) * 4 + 3]).toBe(0);
      expect(data[(32 * 64 + 57) * 4 + 3]).toBeGreaterThan(200);
    }
    value.updateState({ cpu: 0, memory: 0 }, true);
    const idle = halos.map((halo) => halo.material.opacity);
    expect(idle.every((opacity) => opacity > 0)).toBe(true);
    value.updateState({ cpu: 100, memory: 100 }, true);
    const active = halos.map((halo) => halo.material.opacity);
    expect(
      active.every((opacity, index) => opacity > idle[index] && opacity < 0.6),
    ).toBe(true);
    value.setSelected('cpu', true);
    value.setHighlight('memory', true);
    expect(halos.map((halo) => halo.material.opacity)).toEqual(active);
    value.updateState({ cpu: null, memory: null }, true);
    expect(halos.every((halo) => halo.material.opacity === 0)).toBe(true);
    expect(value.hasAmbientActivity()).toBe(false);
  });

  it('owns and disposes each resource once without invalidating another model', () => {
    const first = board(),
      second = board();
    const resources = new Set<
      | THREE.BufferGeometry
      | THREE.Material
      | THREE.InstancedMesh
      | THREE.Texture
    >();
    first.group.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
        resources.add(object.geometry);
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material]) {
          resources.add(material);
          if ('map' in material && material.map instanceof THREE.Texture)
            resources.add(material.map);
        }
      }
      if (object instanceof THREE.InstancedMesh) resources.add(object);
    });
    const disposals = [...resources].map((resource) =>
      vi.spyOn(resource, 'dispose'),
    );
    first.dispose();
    first.dispose();
    for (const disposal of disposals) expect(disposal).toHaveBeenCalledOnce();
    expect(first.group.children).toHaveLength(0);
    expect(first.pickables).toHaveLength(0);
    expect(first.update(90)).toBe(false);
    second.updateState({ cpu: 50, memory: 50 }, true);
    expect(second.getActivityState()[0].emissiveIntensity).toBeCloseTo(0.475);
  });
});
