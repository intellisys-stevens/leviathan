import { useEffect, useRef } from 'react';

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

export type AmbientSnowState = 'running' | 'paused' | 'static' | 'hidden';

const coarseMinimumParticleCount = 44;
const coarseMaximumParticleCount = 80;
const desktopMinimumParticleCount = 80;
const desktopMaximumParticleCount = 160;
const particleArea = 8_000;
const maximumFrameDeltaMs = 50;
const maximumBackingPixels = 8_294_400;
const coarseViewportWidth = 768;
const coarsePixelRatio = 1.25;
const desktopPixelRatio = 1.25;
const defaultSeed = 0x1e71a7a;
const spriteSize = 8;
const dotColor = 'rgb(225 250 255)';

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

function usesCoarseProfile(width: number, coarsePointer: boolean): boolean {
  return coarsePointer || (width > 0 && width < coarseViewportWidth);
}

export function snowParticleCount(
  width: number,
  height: number,
  coarsePointer = false,
): number {
  const area = Math.max(0, width) * Math.max(0, height);
  const coarse = usesCoarseProfile(width, coarsePointer);
  return clamp(
    Math.round(area / particleArea),
    coarse ? coarseMinimumParticleCount : desktopMinimumParticleCount,
    coarse ? coarseMaximumParticleCount : desktopMaximumParticleCount,
  );
}

export function snowPixelRatio(
  devicePixelRatio: number,
  width = 0,
  height = 0,
  coarsePointer = false,
): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return 1;
  const ratioLimit = usesCoarseProfile(width, coarsePointer)
    ? coarsePixelRatio
    : desktopPixelRatio;
  const hardwareRatio = clamp(devicePixelRatio, 1, ratioLimit);
  const area = Math.max(0, width) * Math.max(0, height);
  if (area === 0) return hardwareRatio;
  return Math.min(hardwareRatio, Math.sqrt(maximumBackingPixels / area));
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
  seed = defaultSeed,
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

function resizeSnowParticlePool(
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
  const random = seededRandom(defaultSeed ^ particles.length);

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
  const deltaSeconds = clamp(deltaMilliseconds, 0, maximumFrameDeltaMs) / 1_000;
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

function drawSnow(
  context: CanvasRenderingContext2D,
  atlas: SnowSpriteAtlas,
  particles: readonly SnowParticle[],
  width: number,
  height: number,
) {
  context.clearRect(0, 0, width, height);

  for (const particle of particles) {
    const diameter = particle.radius * 2;
    context.globalAlpha = particle.alpha;
    context.drawImage(
      atlas.source,
      particle.x - particle.radius,
      particle.y - particle.radius,
      diameter,
      diameter,
    );
  }

  context.globalAlpha = 1;
}

type SnowSpriteAtlas = {
  source: HTMLCanvasElement;
};

const snowSpriteAtlases = new WeakMap<Document, SnowSpriteAtlas>();

function createSnowSpriteAtlas(
  ownerDocument: Document,
): SnowSpriteAtlas | null {
  const source = ownerDocument.createElement('canvas');
  source.width = spriteSize;
  source.height = spriteSize;
  const context = source.getContext('2d');
  if (!context) return null;

  context.fillStyle = dotColor;
  context.fillRect(2, 0, 4, 1);
  context.fillRect(1, 1, 6, 1);
  context.fillRect(0, 2, 8, 4);
  context.fillRect(1, 6, 6, 1);
  context.fillRect(2, 7, 4, 1);

  return { source };
}

function getSnowSpriteAtlas(ownerDocument: Document): SnowSpriteAtlas | null {
  const cached = snowSpriteAtlases.get(ownerDocument);
  if (cached) return cached;
  const atlas = createSnowSpriteAtlas(ownerDocument);
  if (atlas) snowSpriteAtlases.set(ownerDocument, atlas);
  return atlas;
}

type AmbientMediaQueryList = Pick<
  MediaQueryList,
  'matches' | 'addEventListener' | 'removeEventListener'
>;

const fallbackMediaQueryList: AmbientMediaQueryList = {
  matches: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

function mediaQuery(query: string): AmbientMediaQueryList {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : fallbackMediaQueryList;
}

export function AmbientSnow({ enabled }: { enabled: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (typeof CanvasRenderingContext2D === 'undefined') {
      canvas.dataset.state = 'hidden';
      return;
    }
    const context = canvas.getContext('2d');
    if (!context) {
      canvas.dataset.state = 'hidden';
      return;
    }
    if (!enabled) {
      canvas.dataset.state = 'hidden';
      canvas.dataset.particleCount = '0';
      canvas.dataset.effectiveDpr = '1';
      context.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 1;
      canvas.height = 1;
      return;
    }
    const atlas = getSnowSpriteAtlas(canvas.ownerDocument);
    if (!atlas) {
      canvas.dataset.state = 'hidden';
      return;
    }

    const reducedMotion = mediaQuery('(prefers-reduced-motion: reduce)');
    const reducedTransparency = mediaQuery(
      '(prefers-reduced-transparency: reduce)',
    );
    const increasedContrast = mediaQuery('(prefers-contrast: more)');
    const forcedColors = mediaQuery('(forced-colors: active)');
    const slowUpdates = mediaQuery('(update: slow)');
    const coarsePointer = mediaQuery('(pointer: coarse)');
    const media = [
      reducedMotion,
      reducedTransparency,
      increasedContrast,
      forcedColors,
      slowUpdates,
      coarsePointer,
    ];

    let width = 1;
    let height = 1;
    let particles: SnowParticle[] = [];
    let animationFrame: number | null = null;
    let resizeFrame: number | null = null;
    let lastTimestamp: number | null = null;
    let configured = false;
    let configuredCoarse = false;

    const setState = (state: AmbientSnowState) => {
      canvas.dataset.state = state;
    };
    const cancelFrame = () => {
      if (animationFrame != null) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
      lastTimestamp = null;
    };
    const clear = () => {
      context.clearRect(0, 0, width, height);
    };
    const release = () => {
      if (configured) clear();
      else context.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 1;
      canvas.height = 1;
      particles.length = 0;
      configured = false;
      configuredCoarse = false;
      width = 1;
      height = 1;
      canvas.dataset.particleCount = '0';
      canvas.dataset.effectiveDpr = '1';
    };
    const blocked = () =>
      reducedTransparency.matches ||
      increasedContrast.matches ||
      forcedColors.matches ||
      slowUpdates.matches;

    const frame = (timestamp: number) => {
      animationFrame = null;
      if (document.hidden || blocked() || reducedMotion.matches) {
        applyMode();
        return;
      }
      if (lastTimestamp == null) {
        lastTimestamp = timestamp;
        animationFrame = window.requestAnimationFrame(frame);
        return;
      }
      const delta = timestamp - lastTimestamp;
      lastTimestamp = timestamp;
      advanceSnowParticles(particles, width, height, delta);
      drawSnow(context, atlas, particles, width, height);
      animationFrame = window.requestAnimationFrame(frame);
    };

    const applyMode = () => {
      cancelFrame();
      if (blocked()) {
        release();
        setState('hidden');
        return;
      }
      if (document.hidden) {
        setState('paused');
        return;
      }
      configureCanvas();
      if (reducedMotion.matches) {
        // Reduced motion is also the deterministic visual-baseline mode. A
        // fresh field prevents prior animation time or intermediate viewport
        // sizes from changing the pixels rendered once motion is disabled.
        particles = createSnowParticles(
          width,
          height,
          defaultSeed,
          configuredCoarse,
        );
        drawSnow(context, atlas, particles, width, height);
        setState('static');
        return;
      }
      drawSnow(context, atlas, particles, width, height);
      setState('running');
      animationFrame = window.requestAnimationFrame(frame);
    };

    const configureCanvas = () => {
      const bounds = canvas.getBoundingClientRect();
      const nextWidth = Math.max(
        1,
        Math.round(bounds.width || window.innerWidth),
      );
      const nextHeight = Math.max(
        1,
        Math.round(bounds.height || window.innerHeight),
      );
      const coarse = usesCoarseProfile(nextWidth, coarsePointer.matches);
      const ratio = snowPixelRatio(
        window.devicePixelRatio,
        nextWidth,
        nextHeight,
        coarse,
      );
      const backingWidth = Math.max(1, Math.round(nextWidth * ratio));
      const backingHeight = Math.max(1, Math.round(nextHeight * ratio));
      if (
        configured &&
        configuredCoarse === coarse &&
        width === nextWidth &&
        height === nextHeight &&
        canvas.width === backingWidth &&
        canvas.height === backingHeight
      )
        return;

      const previousWidth = width;
      const previousHeight = height;
      width = nextWidth;
      height = nextHeight;
      canvas.width = backingWidth;
      canvas.height = backingHeight;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (particles.length === 0)
        particles = createSnowParticles(width, height, defaultSeed, coarse);
      else
        resizeSnowParticlePool(
          particles,
          previousWidth,
          previousHeight,
          width,
          height,
          coarse,
        );
      canvas.dataset.particleCount = String(particles.length);
      canvas.dataset.effectiveDpr = String(ratio);
      configured = true;
      configuredCoarse = coarse;
    };
    const resize = () => {
      if (resizeFrame != null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        applyMode();
      });
    };
    const onVisibilityChange = () => applyMode();
    const onMediaChange = () => applyMode();

    for (const query of media) query.addEventListener('change', onMediaChange);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('resize', resize, { passive: true });
    window.visualViewport?.addEventListener('resize', resize, {
      passive: true,
    });
    applyMode();

    return () => {
      if (resizeFrame != null) window.cancelAnimationFrame(resizeFrame);
      cancelFrame();
      release();
      setState('hidden');
      for (const query of media)
        query.removeEventListener('change', onMediaChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
    };
  }, [enabled]);

  return (
    <canvas
      ref={canvasRef}
      className="ambient-snow"
      data-testid="ambient-snow"
      data-state={enabled ? 'paused' : 'hidden'}
      data-particle-count="0"
      data-effective-dpr="1"
      aria-hidden="true"
      style={{ pointerEvents: 'none' }}
    />
  );
}
