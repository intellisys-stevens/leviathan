import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createGPUBoard, type BoardRegion } from './gpu-board-model';
import { GPU_CHIP_COLORS, type GPUChipAppearance } from './gpu-chip-appearance';

const quadrants: BoardRegion[] = [
  { id: 'a', label: 'GI 1 · CI 0', x: 0, y: 0, width: 0.5, height: 0.5 },
  { id: 'b', label: 'GI 2 · CI 0', x: 0.5, y: 0, width: 0.5, height: 0.5 },
  { id: 'c', label: 'GI 3 · CI 0', x: 0, y: 0.5, width: 0.5, height: 0.5 },
  { id: 'd', label: 'GI 4 · CI 0', x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
];

const boards: ReturnType<typeof createGPUBoard>[] = [];
function board(regions = quadrants, theme: 'dark' | 'light' = 'dark') {
  const value = createGPUBoard(regions, theme);
  boards.push(value);
  return value;
}
function regionMaterial(object: THREE.Object3D) {
  if (!(object instanceof THREE.Mesh))
    throw new Error('Expected a pickable mesh');
  if (!(object.material instanceof THREE.MeshStandardMaterial)) {
    throw new Error('Expected a lit region material');
  }
  return object.material;
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  for (const value of boards) value.dispose();
  boards.length = 0;
  vi.restoreAllMocks();
});

describe('procedural GPU board', () => {
  it.each(['dark', 'light'] as const)(
    'keeps the whole %s board within a finite, long horizontal frame',
    (theme) => {
      const value = board(quadrants, theme);
      const bounds = new THREE.Box3().setFromObject(value.group);
      const size = bounds.getSize(new THREE.Vector3());
      expect(size.x).toBeGreaterThan(10);
      expect(size.x).toBeLessThan(12);
      expect(size.z).toBeGreaterThan(4);
      expect(size.z).toBeLessThan(5.5);
      expect(size.y).toBeGreaterThan(0.7);
      expect(size.y).toBeLessThan(1.5);
      expect(size.toArray().every(Number.isFinite)).toBe(true);
    },
  );

  it('places four independent raycast targets over the central chip', () => {
    const value = board();
    expect(value.pickables.map((region) => region.userData.regionId)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    value.group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    for (const [index, target] of value.pickables.entries()) {
      const position = target.getWorldPosition(new THREE.Vector3());
      expect(position.x).toBeCloseTo(index % 2 === 0 ? -0.77 : 0.77);
      expect(position.z).toBeCloseTo(index < 2 ? -0.585 : 0.585);
      ray.set(
        new THREE.Vector3(position.x, 4, position.z),
        new THREE.Vector3(0, -1, 0),
      );
      const hit = ray.intersectObjects(value.pickables, false)[0];
      expect(hit.object.userData.regionId).toBe(quadrants[index].id);
      expect(hit.point.y).toBeCloseTo(0.335);
    }
  });

  it('leaves empty MIG topology inert and full GPU topology undivided', () => {
    const empty = board([]);
    expect(empty.pickables).toHaveLength(0);
    empty.setHighlight('unknown');
    expect(empty.update(0)).toBe(false);
    const full = board([
      { id: 'gpu', label: 'GPU', x: 0, y: 0, width: 1, height: 1 },
    ]);
    expect(full.pickables).toHaveLength(1);
    expect(full.pickables[0].position.x).toBe(0);
    expect(full.pickables[0].position.z).toBe(0);
  });

  it('finishes outline-only highlighting in 180ms without replaying selection', () => {
    const value = board();
    value.setAppearance([{ id: 'a', state: 'assigned', activity: 75 }], true);
    const face = regionMaterial(value.pickables[0]);
    const color = face.color.clone(),
      emissive = face.emissive.clone(),
      intensity = face.emissiveIntensity;
    const edge = value.group.children.find(
      (object) => object.name === 'Logical chip region boundary',
    );
    if (
      !(edge instanceof THREE.LineLoop) ||
      !(edge.material instanceof THREE.LineBasicMaterial)
    )
      throw new Error('Expected outline');
    value.setHighlight('a');
    value.update(90);
    expect(value.isTransitioning()).toBe(true);
    expect(edge.material.opacity).toBeGreaterThan(0.62);
    value.setHighlight('a');
    value.update(90);
    expect(value.isTransitioning()).toBe(false);
    expect(edge.material.opacity).toBeCloseTo(1);
    expect(face.color.equals(color)).toBe(true);
    expect(face.emissive.equals(emissive)).toBe(true);
    expect(face.emissiveIntensity).toBe(intensity);
    value.setHighlight(null, true);
    expect(edge.material.opacity).toBeCloseTo(0.62);
    expect(face.emissiveIntensity).toBe(intensity);
  });

  it.each(['dark', 'light'] as const)(
    'keeps %s palette hues and increases glow with fresh SM activity',
    (theme) => {
      const value = board(quadrants, theme);
      for (const state of ['assigned', 'unassigned'] as const) {
        const intensities: number[] = [],
          halos: number[] = [];
        for (const activity of [0, 50, 100]) {
          value.setAppearance([{ id: 'a', state, activity }], true);
          const face = regionMaterial(value.pickables[0]);
          expect(
            face.emissive.equals(new THREE.Color(GPU_CHIP_COLORS.dark[state])),
          ).toBe(true);
          // Preserve neutral metal channels even when the assignment hue has no blue.
          expect(face.color.b).toBeGreaterThan(0.01);
          expect(
            Math.max(face.color.r, face.color.g, face.color.b),
          ).toBeLessThan(0.12);
          intensities.push(face.emissiveIntensity);
          halos.push(value.getActivityState()[0].haloOpacity);
        }
        expect(intensities[0]).toBeLessThan(intensities[1]);
        expect(intensities[1]).toBeLessThan(intensities[2]);
        expect(halos[0]).toBeLessThan(halos[1]);
        expect(halos[1]).toBeLessThan(halos[2]);
      }
      for (const state of ['reserved', 'unknown'] as const) {
        value.setAppearance([{ id: 'a', state, activity: 100 }], true);
        expect(
          regionMaterial(value.pickables[0]).emissive.equals(
            new THREE.Color(GPU_CHIP_COLORS.dark[state]),
          ),
        ).toBe(true);
        expect(value.getActivityState()[0]).toMatchObject({
          state,
          activity: 100,
          particleCount: 8,
        });
        expect(value.update(1000)).toBe(true);
      }
    },
  );

  it.each(['dark', 'light'] as const)(
    'keeps assigned %s chips visibly green at idle independently of utilization',
    (theme) => {
      const value = board(quadrants, theme);
      let idleColor: THREE.Color | undefined;
      for (const activity of [0, 50, 100, null]) {
        value.setAppearance([{ id: 'a', state: 'assigned', activity }], true);
        const face = regionMaterial(value.pickables[0]);
        // Green must be the surface color, even with no emitted light or sparks.
        expect(face.color.g).toBeGreaterThan(face.color.r * 2);
        expect(face.color.g).toBeGreaterThan(face.color.b * 3);
        if (idleColor) expect(face.color.equals(idleColor)).toBe(true);
        else idleColor = face.color.clone();
      }
      expect(value.getActivityState()[0]).toMatchObject({
        emissiveIntensity: 0,
        particleCount: 0,
      });
      value.setAppearance(
        [{ id: 'a', state: 'unassigned', activity: 0 }],
        true,
      );
      expect(regionMaterial(value.pickables[0]).color.equals(idleColor!)).toBe(
        false,
      );
    },
  );

  it('keeps light-theme emission visible on the dark die independently of status inks', () => {
    const dark = board(quadrants, 'dark');
    const light = board(quadrants, 'light');
    const luminance = (color: THREE.Color) =>
      color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
    const edge = light.group.getObjectByName(
      'Logical chip region boundary',
    ) as THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>;
    // With reduced motion there are no sparks to hide a lost static glow.
    dark.setMotionEnabled(false);
    light.setMotionEnabled(false);
    for (const state of [
      'assigned',
      'unassigned',
      'reserved',
      'unknown',
    ] as const) {
      for (const activity of [25, 50, 100]) {
        dark.setAppearance([{ id: 'a', state, activity }], true);
        light.setAppearance([{ id: 'a', state, activity }], true);
        const darkFace = regionMaterial(dark.pickables[0]);
        const lightFace = regionMaterial(light.pickables[0]);
        expect(
          luminance(lightFace.emissive) * lightFace.emissiveIntensity,
        ).toBeGreaterThanOrEqual(
          luminance(darkFace.emissive) * darkFace.emissiveIntensity,
        );
        expect(light.getActivityState()[0].haloOpacity).toBeGreaterThanOrEqual(
          dark.getActivityState()[0].haloOpacity,
        );
        expect(
          edge.material.color.equals(
            new THREE.Color(GPU_CHIP_COLORS.light[state]),
          ),
        ).toBe(true);
        expect(light.getActivityState()[0].particleCount).toBe(0);
        expect(light.update(500)).toBe(false);
      }
    }
  });

  it('keeps zero and missing readings static and stops stale particles immediately', () => {
    const value = board();
    for (const activity of [
      0,
      null,
      -1,
      101,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      value.setAppearance([{ id: 'a', state: 'assigned', activity }], true);
      expect(value.hasAmbientActivity()).toBe(false);
      expect(value.update(180)).toBe(false);
      expect(value.getActivityState()[0].particleCount).toBe(0);
    }
    value.setAppearance([{ id: 'a', state: 'assigned', activity: 100 }], true);
    expect(value.hasAmbientActivity()).toBe(true);
    value.update(500);
    const phase = value.getActivityState()[0].phase;
    value.setAppearance([{ id: 'a', state: 'assigned', activity: null }]);
    expect(value.hasAmbientActivity()).toBe(false);
    expect(value.getActivityState()[0].particleCount).toBe(0);
    expect(value.update(180)).toBe(false);
    expect(value.getActivityState()[0]).toMatchObject({
      phase,
      emissiveIntensity: 0,
      haloOpacity: 0,
    });
  });

  it('transitions appearance separately and preserves phases on unchanged polling', () => {
    const value = board();
    const appearances: GPUChipAppearance[] = [
      { id: 'a', state: 'unassigned', activity: 80 },
    ];
    value.setAppearance(appearances);
    value.update(90);
    const middle = value.getActivityState()[0];
    expect(middle.transitioning).toBe(true);
    expect(
      value.setAppearance(appearances.map((appearance) => ({ ...appearance }))),
    ).toBe(false);
    value.update(90);
    const complete = value.getActivityState()[0];
    expect(complete.transitioning).toBe(false);
    expect(complete.emissiveIntensity).toBeGreaterThan(
      middle.emissiveIntensity,
    );
    expect(complete.phase).toBeGreaterThan(middle.phase);
  });

  it('keeps fine sparks clear of labels with fixed buffers and no effect on framing or picking', () => {
    const value = board();
    const before = new THREE.Box3().setFromObject(value.group);
    value.setAppearance(
      quadrants.map(({ id }) => ({ id, state: 'assigned', activity: 100 })),
      true,
    );
    for (let time = 0; time < 20; time++) {
      value.update(137);
      for (const object of value.group.children.filter(
        (child) => child.userData.excludeFromFraming,
      )) {
        expect(value.pickables).not.toContain(object);
        expect(object.raycast(new THREE.Raycaster(), [])).toBeUndefined();
        if (!(object instanceof THREE.Points)) continue;
        const target = value.pickables.find(
          (pickable) => pickable.userData.regionId === object.userData.regionId,
        )!;
        expect(object.geometry.drawRange.count).toBe(8);
        const positions = object.geometry.getAttribute('position'),
          colors = object.geometry.getAttribute('color');
        for (let index = 0; index < positions.count; index++) {
          expect(
            Math.abs(positions.getX(index) - target.position.x),
          ).toBeLessThan(0.76);
          expect(
            Math.abs(positions.getZ(index) - target.position.z),
          ).toBeLessThan(0.57);
          expect(
            Math.abs(positions.getZ(index) - target.position.z),
          ).toBeGreaterThan(0.28);
          expect(positions.getY(index)).toBeGreaterThan(0.335);
          expect(positions.getY(index)).toBeLessThan(0.465);
          expect(colors.getW(index)).toBeGreaterThanOrEqual(0);
          expect(colors.getW(index)).toBeLessThanOrEqual(1);
        }
      }
    }
    expect(new THREE.Box3().setFromObject(value.group).equals(before)).toBe(
      true,
    );
  });

  it.each(['dark', 'light'] as const)(
    'scales %s particle density, brightness and speed with measured activity within fixed budgets',
    (theme) => {
      const value = board(
        [{ id: 'gpu', label: 'GPU', x: 0, y: 0, width: 1, height: 1 }],
        theme,
      );
      const particles = value.group.getObjectByName(
        'Chip activity particles',
      ) as THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
      const positions = particles.geometry.getAttribute('position').array;
      const colors = particles.geometry.getAttribute('color').array;
      let previousCount = 0;
      let previousSpeed = 0;
      let previousBrightness = 0;
      for (const activity of [5, 50, 100]) {
        value.setAppearance([{ id: 'gpu', state: 'unknown', activity }], true);
        const before = value.getActivityState()[0];
        value.update(1000);
        const after = value.getActivityState()[0];
        expect(after.particleCount).toBeGreaterThan(previousCount);
        expect(after.phase - before.phase).toBeGreaterThan(previousSpeed);
        expect(particles.material.opacity).toBeGreaterThan(previousBrightness);
        previousCount = after.particleCount;
        previousSpeed = after.phase - before.phase;
        previousBrightness = particles.material.opacity;
        expect(particles.geometry.getAttribute('position').array).toBe(
          positions,
        );
        expect(particles.geometry.getAttribute('color').array).toBe(colors);
      }
      expect(previousCount).toBe(32);
      value.setParticleBudget(11);
      expect(value.getActivityState()[0].particleCount).toBe(11);
      value.setParticleBudget(0);
      expect(value.hasAmbientActivity()).toBe(false);
      expect(value.getParticleDemand()).toBe(32);
      value.setParticleBudget(32);
      expect(value.hasAmbientActivity()).toBe(true);
    },
  );

  it('retains static activity glow under reduced motion without ongoing updates', () => {
    const value = board();
    value.setMotionEnabled(false);
    value.setAppearance([{ id: 'a', state: 'assigned', activity: 90 }], true);
    value.setHighlight('a', true);
    expect(value.update(500)).toBe(false);
    expect(value.getActivityState()[0]).toMatchObject({
      particleCount: 0,
      phase: 0,
      transitioning: false,
    });
    expect(value.getActivityState()[0].emissiveIntensity).toBeGreaterThan(0);
    expect(
      value.setAppearance([{ id: 'a', state: 'assigned', activity: 90 }], true),
    ).toBe(false);
    value.setAppearance([{ id: 'a', state: 'assigned', activity: 40 }]);
    expect(value.isTransitioning()).toBe(true);
    expect(
      value.setAppearance([{ id: 'a', state: 'assigned', activity: 40 }], true),
    ).toBe(true);
    expect(value.isTransitioning()).toBe(false);
    expect(
      value.setAppearance([{ id: 'a', state: 'assigned', activity: 40 }], true),
    ).toBe(false);
  });

  it('keeps the dim physical edge accent separate from chip selection', () => {
    const value = board();
    const edges = ['PCB edge halo', 'PCB edge rim'].map((name) => {
      const edge = value.group.getObjectByName(name);
      if (
        !(edge instanceof THREE.Mesh) ||
        !(edge.material instanceof THREE.MeshBasicMaterial)
      )
        throw new Error('Expected a static edge accent');
      expect(value.pickables).not.toContain(edge);
      expect(edge.material.depthWrite).toBe(false);
      expect(edge.material.opacity).toBeGreaterThan(0);
      expect(edge.material.opacity).toBeLessThan(0.4);
      const position = edge.geometry.getAttribute('position');
      for (let index = 0; index < position.count; index++) {
        // The glow stays at the perimeter, leaving the central chip untouched.
        expect(
          Math.abs(position.getX(index)) > 4.8 ||
            Math.abs(position.getZ(index)) > 1.7,
        ).toBe(true);
        expect(position.getY(index)).toBeLessThan(0.13);
      }
      return {
        edge,
        opacity: edge.material.opacity,
        color: edge.material.color.clone(),
      };
    });
    value.setHighlight('a');
    expect(value.update(180)).toBe(false);
    for (const { edge, opacity, color } of edges) {
      expect(edge.material.opacity).toBe(opacity);
      expect(edge.material.color.equals(color)).toBe(true);
    }
  });

  it('reduces edge-glow intensity in the light theme', () => {
    const dark = board([], 'dark');
    const light = board([], 'light');
    for (const name of ['PCB edge halo', 'PCB edge rim']) {
      const darkEdge = dark.group.getObjectByName(name);
      const lightEdge = light.group.getObjectByName(name);
      if (
        !(darkEdge instanceof THREE.Mesh) ||
        !(lightEdge instanceof THREE.Mesh) ||
        !(darkEdge.material instanceof THREE.MeshBasicMaterial) ||
        !(lightEdge.material instanceof THREE.MeshBasicMaterial)
      )
        throw new Error('Expected theme-aware edge materials');
      expect(lightEdge.material.opacity).toBeLessThan(
        darkEdge.material.opacity,
      );
      expect(lightEdge.material.color.equals(darkEdge.material.color)).toBe(
        true,
      );
    }
  });

  it('disposes each owned resource once without affecting another board', () => {
    const first = board();
    const second = board();
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
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of materials) {
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
    const secondMaterial = regionMaterial(second.pickables[0]);
    const secondDispose = vi.spyOn(secondMaterial, 'dispose');
    first.dispose();
    first.dispose();
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    expect(secondDispose).not.toHaveBeenCalled();
    expect(first.group.children).toHaveLength(0);
    expect(first.pickables).toHaveLength(0);
    second.setAppearance([{ id: 'a', state: 'assigned', activity: 100 }], true);
    expect(secondMaterial.emissiveIntensity).toBeGreaterThan(0);
  });
});
