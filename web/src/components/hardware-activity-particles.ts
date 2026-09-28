import * as THREE from 'three';

export const VISIBLE_PARTICLE_LIMIT = 256;
export const GPU_PARTICLE_LIMIT = 64;
export const MOTHERBOARD_PARTICLE_LIMIT = 48;

/** Deterministic proportional budgets keep every active visible scene represented. */
export function particleBudgets(demands: readonly number[], limit: number) {
  const total = demands.reduce((sum, demand) => sum + demand, 0);
  if (total <= limit) return [...demands];
  const budgets = demands.map((demand) => Math.floor((demand * limit) / total));
  let remaining = limit - budgets.reduce((sum, budget) => sum + budget, 0);
  for (let index = 0; remaining > 0; index = (index + 1) % demands.length) {
    if (budgets[index] < demands[index]) {
      budgets[index]++;
      remaining--;
    }
  }
  return budgets;
}

export function createActivityParticleTexture() {
  const pixels = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const radius = Math.hypot((x - 15.5) / 15.5, (y - 15.5) / 15.5);
      const alpha = Math.max(0, 1 - radius) ** 1.7;
      pixels.set([255, 255, 255, Math.round(255 * alpha)], (y * 32 + x) * 4);
    }
  }
  const texture = new THREE.DataTexture(pixels, 32, 32);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** One preallocated field follows a component's rim, leaving the label center clear. */
export function createActivityParticles({
  id,
  bounds,
  maximum,
  color,
  theme,
  texture,
  size,
}: {
  id: string;
  bounds: { x: number; y: number; z: number; width: number; depth: number };
  maximum: number;
  color: THREE.ColorRepresentation;
  theme: 'dark' | 'light';
  texture: THREE.Texture;
  size?: number;
}) {
  const geometry = new THREE.BufferGeometry();
  const positions = new THREE.BufferAttribute(new Float32Array(maximum * 3), 3);
  const colors = new THREE.BufferAttribute(new Float32Array(maximum * 4), 4);
  positions.setUsage(THREE.DynamicDrawUsage);
  colors.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positions);
  geometry.setAttribute('color', colors);
  geometry.setDrawRange(0, 0);
  // Stable bounds are decorative only; framing explicitly ignores this object.
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(
      bounds.x - bounds.width / 2,
      bounds.y,
      bounds.z - bounds.depth / 2,
    ),
    new THREE.Vector3(
      bounds.x + bounds.width / 2,
      bounds.y + 0.28,
      bounds.z + bounds.depth / 2,
    ),
  );
  const material = new THREE.PointsMaterial({
    map: texture,
    color,
    size: size ?? Math.min(0.13, bounds.width * 0.13, bounds.depth * 0.17),
    transparent: true,
    opacity: 0,
    vertexColors: true,
    depthWrite: false,
    toneMapped: false,
  });
  const points = new THREE.Points(geometry, material);
  points.name = `${id} activity particles`;
  points.userData.excludeFromFraming = true;
  points.userData.regionId = id;
  points.raycast = () => {};
  points.visible = false;
  points.frustumCulled = false;
  let phase = 0;
  let seed = 0;
  for (let index = 0; index < id.length; index++)
    seed = (seed * 31 + id.charCodeAt(index)) >>> 0;
  const offset = (seed % 1000) / 1000;
  return {
    points,
    maximum,
    get phase() {
      return phase;
    },
    paint(intensity: number, active: boolean, budget: number, deltaMs = 0) {
      const level = Math.max(0, Math.min(1, intensity));
      const count = active
        ? Math.min(budget, Math.ceil(maximum * (0.12 + level * 0.88)))
        : 0;
      geometry.setDrawRange(0, count);
      points.visible = count > 0;
      material.opacity = (theme === 'dark' ? 0.48 : 0.44) + level * 0.34;
      if (!count) return;
      phase += (deltaMs / 1000) * (0.15 + level * 0.5);
      for (let index = 0; index < maximum; index++) {
        const life = (phase + offset + index * 0.61803398875) % 1;
        const along = (offset + index * 0.38196601125 + phase * 0.18) % 1;
        const edge = index % 4;
        // Narrow rim paths and gentle upward drift keep lettering legible.
        const x = edge < 2 ? (edge === 0 ? -0.44 : 0.44) : (along - 0.5) * 0.86;
        const z = edge < 2 ? (along - 0.5) * 0.86 : edge === 2 ? -0.44 : 0.44;
        positions.setXYZ(
          index,
          bounds.x + bounds.width * x,
          bounds.y + 0.008 + life * (0.07 + level * 0.18),
          bounds.z + bounds.depth * z,
        );
        colors.setXYZW(index, 1, 1, 1, Math.sin(life * Math.PI) ** 1.5);
      }
      positions.needsUpdate = true;
      colors.needsUpdate = true;
    },
  };
}

export type ActivityParticles = ReturnType<typeof createActivityParticles>;
