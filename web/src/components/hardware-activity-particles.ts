import * as THREE from 'three';

export const VISIBLE_PARTICLE_LIMIT = 256;
export const GPU_PARTICLE_LIMIT = 32;
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
      // A fine core and faint falloff keep sparks crisp even when zoomed in.
      const alpha =
        0.76 * Math.exp(-radius * radius * 70) +
        0.16 * Math.exp(-radius * radius * 8);
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

/** Fine, irregular sparks drift over the die while leaving its label clear. */
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
      bounds.y + 0.13,
      bounds.z + bounds.depth / 2,
    ),
  );
  const baseSize =
    size ?? Math.min(0.075, bounds.width * 0.075, bounds.depth * 0.095);
  const material = new THREE.PointsMaterial({
    map: texture,
    color,
    size: baseSize,
    transparent: true,
    opacity: 0,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
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
  const anchors = new Float32Array(maximum * 4);
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  for (let index = 0; index < maximum; index++) {
    anchors[index * 4] = -0.41 + random() * 0.82;
    anchors[index * 4 + 1] = (index % 2 ? 1 : -1) * (0.27 + random() * 0.14);
    anchors[index * 4 + 2] = random();
    anchors[index * 4 + 3] = random();
  }
  return {
    points,
    maximum,
    get phase() {
      return phase;
    },
    paint(intensity: number, active: boolean, budget: number, deltaMs = 0) {
      const level = Math.max(0, Math.min(1, intensity));
      const count = active
        ? Math.min(budget, Math.ceil(maximum * (0.04 + level * 0.96)))
        : 0;
      geometry.setDrawRange(0, count);
      points.visible = count > 0;
      material.opacity =
        theme === 'dark' ? 0.2 + level * 0.56 : 0.32 + level * 0.6;
      material.size = baseSize * (0.6 + level * 0.4);
      if (!count) return;
      phase += (deltaMs / 1000) * (0.1 + level * 0.2);
      for (let index = 0; index < maximum; index++) {
        const offset = anchors[index * 4 + 2];
        const variation = anchors[index * 4 + 3];
        const life = (phase * (0.65 + variation * 0.7) + offset) % 1;
        const drift = phase * 1.4 + offset * Math.PI * 2;
        const x = anchors[index * 4] + Math.sin(drift) * 0.014;
        const z = anchors[index * 4 + 1] + Math.cos(drift * 0.7) * 0.016;
        positions.setXYZ(
          index,
          bounds.x + bounds.width * x,
          bounds.y + 0.008 + life * (0.022 + level * 0.055),
          bounds.z + bounds.depth * z,
        );
        colors.setXYZW(
          index,
          1,
          1,
          1,
          Math.sin(life * Math.PI) ** 2 * (0.55 + variation * 0.45),
        );
      }
      positions.needsUpdate = true;
      colors.needsUpdate = true;
    },
  };
}

export type ActivityParticles = ReturnType<typeof createActivityParticles>;
