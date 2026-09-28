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
      const bounds = new THREE.Box3().setFromPoints(value.frames.board.points);
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
      value.updateState(
        { cpu: utilization, memory: utilization, storageBytesPerSecond: null },
        true,
      );
      expect(
        value.getActivityState().map((item) => item.emissiveIntensity),
      ).toEqual([
        0.15 + (0.65 * utilization) / 100,
        0.15 + (0.65 * utilization) / 100,
        0,
      ]);
      expect(value.group.children).toEqual(children);
      expect(value.frames).toBe(frames);
      expect(value.hasAmbientActivity()).toBe(utilization > 0);
      expect(value.update(1000)).toBe(utilization > 0);
    }
    value.updateState(
      { cpu: null, memory: Number.NaN, storageBytesPerSecond: null },
      true,
    );
    expect(
      value.getActivityState().every((item) => item.emissiveIntensity === 0),
    ).toBe(true);
  });

  it('changes selection and hover outlines without falsifying activity', () => {
    const value = board();
    value.updateState(
      { cpu: 20, memory: 70, storageBytesPerSecond: null },
      true,
    );
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
    expect(value.update(90)).toBe(true);
    expect(value.isTransitioning()).toBe(false);
    expect(storage.material.opacity).toBeCloseTo(0.98);
    expect(
      value.getActivityState().map((item) => item.emissiveIntensity),
    ).toEqual(emission);
    value.setHighlight(null, true);
    expect(storage.material.opacity).toBeCloseTo(0.98);
    value.setSelected(null, true);
    expect(storage.material.opacity).toBe(0);
  });

  it('finishes 180ms transitions, deduplicates polling and continues only measured activity', () => {
    const value = board();
    expect(
      value.updateState({ cpu: 100, memory: 50, storageBytesPerSecond: null }),
    ).toBe(true);
    expect(value.update(90)).toBe(true);
    const halfway = value.getActivityState()[0].emissiveIntensity;
    expect(
      value.updateState({ cpu: 100, memory: 50, storageBytesPerSecond: null }),
    ).toBe(false);
    expect(value.update(90)).toBe(true);
    expect(value.getActivityState()[0].emissiveIntensity).toBeGreaterThan(
      halfway,
    );
    expect(value.getActivityState()[0].emissiveIntensity).toBeCloseTo(0.8);
    expect(value.isTransitioning()).toBe(false);
    expect(value.hasAmbientActivity()).toBe(true);
    expect(value.update(10_000)).toBe(true);
    expect(
      value.group.children.some((child) => child instanceof THREE.Points),
    ).toBe(true);
    value.updateState(
      { cpu: null, memory: null, storageBytesPerSecond: null },
      true,
    );
    expect(value.hasAmbientActivity()).toBe(false);
    expect(value.update(1000)).toBe(false);
  });

  it('scales CPU, RAM, and SSD particle density from their independent measured activity', () => {
    const value = board();
    const frames = value.frames;
    const children = [...value.group.children];
    const buffers = children
      .filter((child) => child instanceof THREE.Points)
      .map((child) => child.geometry.getAttribute('position').array);
    let previous = [0, 0, 0];
    for (const activity of [5, 50, 100]) {
      value.updateState(
        {
          cpu: activity,
          memory: activity,
          storageBytesPerSecond: (1025 ** (activity / 100) - 1) * 1024 ** 2,
        },
        true,
      );
      value.update(1000);
      const states = value.getActivityState();
      states.forEach((state, index) =>
        expect(state.particleCount).toBeGreaterThan(previous[index]),
      );
      previous = states.map((state) => state.particleCount);
      expect(states[2].activity).toBeNull();
      expect(states[2].bytesPerSecond).toBeGreaterThan(0);
      expect(value.frames).toBe(frames);
      expect(value.group.children).toEqual(children);
    }
    expect(previous.reduce((sum, count) => sum + count, 0)).toBe(48);
    children
      .filter((child) => child instanceof THREE.Points)
      .forEach((child, index) => {
        expect(child.geometry.getAttribute('position').array).toBe(
          buffers[index],
        );
        expect(child.userData.excludeFromFraming).toBe(true);
        expect(value.pickables).not.toContain(child);
      });
    value.setParticleBudget(9);
    expect(
      value
        .getActivityState()
        .reduce((sum, state) => sum + state.particleCount, 0),
    ).toBe(9);
    value.setMotionEnabled(false);
    expect(value.hasAmbientActivity()).toBe(false);
    expect(value.getParticleDemand()).toBe(0);
    expect(value.update(1000)).toBe(false);
    expect(
      value.getActivityState().every((state) => state.emissiveIntensity > 0),
    ).toBe(true);
  });

  it('keeps a static cyan rim on the actual chamfered board perimeter outside framing and raycasts', () => {
    const value = board();
    for (const name of ['Motherboard edge halo', 'Motherboard edge rim']) {
      const edge = value.group.getObjectByName(name) as THREE.Mesh<
        THREE.TubeGeometry,
        THREE.MeshBasicMaterial
      >;
      expect(edge.userData.excludeFromFraming).toBe(true);
      expect(edge.raycast(new THREE.Raycaster(), [])).toBeUndefined();
      expect(value.pickables).not.toContain(edge);
      expect(edge.material.opacity).toBeGreaterThan(0);
      expect(edge.material.depthWrite).toBe(false);
      const path = edge.geometry.parameters
        .path as THREE.CurvePath<THREE.Vector3>;
      expect(path.curves).toHaveLength(7);
      expect(path.curves[1].getPoint(0).toArray()).toEqual([4.1, 0.105, -5.15]);
      expect(path.curves[1].getPoint(1).toArray()).toEqual([4.45, 0.105, -4.8]);
      const opacity = edge.material.opacity;
      value.setSelected('cpu', true);
      value.updateState(
        { cpu: 100, memory: 100, storageBytesPerSecond: 1024 ** 3 },
        true,
      );
      expect(edge.material.opacity).toBe(opacity);
    }
  });

  it('applies reduced motion immediately to activity and inspection outlines', () => {
    const value = board();
    value.updateState({ cpu: 90, memory: 30, storageBytesPerSecond: null });
    value.setSelected('memory');
    value.setMotionEnabled(false);
    expect(value.isTransitioning()).toBe(false);
    expect(value.getActivityState()[0].emissiveIntensity).toBeCloseTo(0.735);
    expect(
      value.updateState({ cpu: 0, memory: null, storageBytesPerSecond: null }),
    ).toBe(true);
    value.setHighlight('cpu');
    expect(value.isTransitioning()).toBe(false);
    expect(
      value.getActivityState().map((item) => item.emissiveIntensity),
    ).toEqual([0.15, 0, 0]);
    expect(
      value.updateState(
        { cpu: 0, memory: null, storageBytesPerSecond: null },
        true,
      ),
    ).toBe(false);
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
    value.updateState({ cpu: 0, memory: 0, storageBytesPerSecond: null }, true);
    const idle = halos.map((halo) => halo.material.opacity);
    expect(idle.every((opacity) => opacity > 0)).toBe(true);
    value.updateState(
      { cpu: 100, memory: 100, storageBytesPerSecond: null },
      true,
    );
    const active = halos.map((halo) => halo.material.opacity);
    expect(
      active.every((opacity, index) => opacity > idle[index] && opacity < 0.6),
    ).toBe(true);
    value.setSelected('cpu', true);
    value.setHighlight('memory', true);
    expect(halos.map((halo) => halo.material.opacity)).toEqual(active);
    value.updateState(
      { cpu: null, memory: null, storageBytesPerSecond: null },
      true,
    );
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
      if (
        object instanceof THREE.Mesh ||
        object instanceof THREE.Line ||
        object instanceof THREE.Points
      ) {
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
    second.updateState(
      { cpu: 50, memory: 50, storageBytesPerSecond: null },
      true,
    );
    expect(second.getActivityState()[0].emissiveIntensity).toBeCloseTo(0.475);
  });
});
