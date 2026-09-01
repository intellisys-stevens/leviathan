export type SnowLayer = 'far' | 'mid' | 'near';

export type SnowParticle = {
  layer: SnowLayer;
  x: number;
  y: number;
  radius: number;
  speed: number;
  drift: number;
  sway: number;
  swayRate: number;
  phase: number;
  alpha: number;
};

export const snowParticleArea = 6_000;
export const maximumSnowFrameDeltaMs = 50;
export const maximumSnowBackingPixels = 8_294_400;
export const snowPixelRatioLimit = 1.25;
export const defaultSnowSeed = 0x1e71a7a;
export const snowSpriteSize = 8;
export const snowDotColor = 'rgb(225 250 255)';

const coarseMinimumParticleCount = 60;
const coarseMaximumParticleCount = 100;
const desktopMinimumParticleCount = 120;
const desktopMaximumParticleCount = 220;
const coarseViewportWidth = 768;

const layerRanges: Record<
  SnowLayer,
  {
    radius: readonly [number, number];
    speed: readonly [number, number];
    drift: readonly [number, number];
    sway: readonly [number, number];
    swayRate: readonly [number, number];
    alpha: readonly [number, number];
  }
> = {
  far: {
    radius: [0.6, 1.1],
    speed: [14, 24],
    drift: [-0.7, 0.7],
    sway: [1, 3],
    swayRate: [0.35, 0.7],
    alpha: [0.12, 0.24],
  },
  mid: {
    radius: [1, 1.8],
    speed: [28, 48],
    drift: [-2.2, 2.2],
    sway: [4, 9],
    swayRate: [0.55, 1.05],
    alpha: [0.24, 0.42],
  },
  near: {
    radius: [2, 3],
    speed: [60, 90],
    drift: [-3.2, 3.2],
    sway: [12, 22],
    swayRate: [0.7, 1.25],
    alpha: [0.52, 0.76],
  },
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function randomBetween(
  random: () => number,
  [minimum, maximum]: readonly [number, number],
): number {
  return minimum + random() * (maximum - minimum);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function usesCoarseSnowProfile(
  width: number,
  coarsePointer: boolean,
): boolean {
  return coarsePointer || (width > 0 && width < coarseViewportWidth);
}

export function snowParticleCount(
  width: number,
  height: number,
  coarsePointer = false,
): number {
  const area = Math.max(0, width) * Math.max(0, height);
  const coarse = usesCoarseSnowProfile(width, coarsePointer);
  return clamp(
    Math.round(area / snowParticleArea),
    coarse ? coarseMinimumParticleCount : desktopMinimumParticleCount,
    coarse ? coarseMaximumParticleCount : desktopMaximumParticleCount,
  );
}

export function snowPixelRatio(
  devicePixelRatio: number,
  width = 0,
  height = 0,
  _coarsePointer = false,
): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return 1;
  const hardwareRatio = clamp(devicePixelRatio, 1, snowPixelRatioLimit);
  const area = Math.max(0, width) * Math.max(0, height);
  if (area === 0) return hardwareRatio;
  return Math.min(hardwareRatio, Math.sqrt(maximumSnowBackingPixels / area));
}

function layerAt(index: number, count: number): SnowLayer {
  const nearStart = count - Math.max(1, Math.round(count * 0.1));
  const midStart = Math.round(count * 0.58);
  if (index >= nearStart) return 'near';
  if (index >= midStart) return 'mid';
  return 'far';
}

function createSnowParticle(
  layer: SnowLayer,
  width: number,
  height: number,
  random: () => number,
): SnowParticle {
  const range = layerRanges[layer];
  return {
    layer,
    x: random() * width,
    y: random() * height,
    radius: randomBetween(random, range.radius),
    speed: randomBetween(random, range.speed),
    drift: randomBetween(random, range.drift),
    sway: randomBetween(random, range.sway),
    swayRate: randomBetween(random, range.swayRate),
    phase: random() * Math.PI * 2,
    alpha: randomBetween(random, range.alpha),
  };
}

export function createSnowParticles(
  width: number,
  height: number,
  seed = defaultSnowSeed,
  coarsePointer = false,
): SnowParticle[] {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const count = snowParticleCount(width, height, coarsePointer);
  const random = seededRandom(seed);
  const particles: SnowParticle[] = [];

  for (let index = 0; index < count; index += 1) {
    const layer = layerAt(index, count);
    particles.push(createSnowParticle(layer, safeWidth, safeHeight, random));
  }

  return particles;
}

export function resizeSnowParticlePool(
  particles: SnowParticle[],
  previousWidth: number,
  previousHeight: number,
  width: number,
  height: number,
  coarsePointer: boolean,
) {
  const scaleX = previousWidth > 0 ? width / previousWidth : 1;
  const scaleY = previousHeight > 0 ? height / previousHeight : 1;
  const pools: Record<SnowLayer, SnowParticle[]> = {
    far: [],
    mid: [],
    near: [],
  };
  for (const particle of particles) {
    particle.x *= scaleX;
    particle.y *= scaleY;
    pools[particle.layer].push(particle);
  }

  const count = snowParticleCount(width, height, coarsePointer);
  const desired = {
    far: Math.round(count * 0.58),
    near: Math.max(1, Math.round(count * 0.1)),
  };
  const targets: Record<SnowLayer, number> = {
    far: desired.far,
    mid: count - desired.far - desired.near,
    near: desired.near,
  };
  const random = seededRandom(defaultSnowSeed ^ particles.length);

  for (const layer of ['far', 'mid', 'near'] as const) {
    const pool = pools[layer];
    if (pool.length > targets[layer]) pool.length = targets[layer];
    while (pool.length < targets[layer]) {
      pool.push(createSnowParticle(layer, width, height, random));
    }
  }

  particles.length = 0;
  particles.push(...pools.far, ...pools.mid, ...pools.near);
}

/** Advances the existing particle objects in place to avoid frame allocations. */
export function advanceSnowParticles(
  particles: SnowParticle[],
  width: number,
  height: number,
  deltaMilliseconds: number,
): SnowParticle[] {
  const deltaSeconds =
    clamp(deltaMilliseconds, 0, maximumSnowFrameDeltaMs) / 1_000;
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);

  for (const particle of particles) {
    particle.phase += particle.swayRate * deltaSeconds;
    particle.x +=
      particle.drift * deltaSeconds +
      Math.sin(particle.phase) * particle.sway * deltaSeconds;
    particle.y += particle.speed * deltaSeconds;

    if (particle.y - particle.radius > safeHeight) {
      particle.y = -particle.radius;
    }
    if (particle.x + particle.radius < 0) {
      particle.x = safeWidth + particle.radius;
    } else if (particle.x - particle.radius > safeWidth) {
      particle.x = -particle.radius;
    }
  }

  return particles;
}

export function drawSnowParticles(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  sprite: CanvasImageSource,
  particles: readonly SnowParticle[],
  width: number,
  height: number,
) {
  context.clearRect(0, 0, width, height);
  for (const particle of particles) {
    const diameter = particle.radius * 2;
    context.globalAlpha = particle.alpha;
    context.drawImage(
      sprite,
      particle.x - particle.radius,
      particle.y - particle.radius,
      diameter,
      diameter,
    );
  }
  context.globalAlpha = 1;
}
