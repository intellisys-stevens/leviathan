import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type {
  SnowMode,
  SnowWorkerInput,
  SnowWorkerOutput,
} from '../ambient-snow-protocol';
import {
  advanceSnowParticles,
  createSnowParticles,
  defaultSnowSeed,
  drawSnowParticles,
  resizeSnowParticlePool,
  snowDotColor,
  snowPixelRatio,
  snowSpriteSize,
  usesCoarseSnowProfile,
  type SnowParticle,
} from '../snow-particles';

export {
  advanceSnowParticles,
  createSnowParticles,
  snowParticleCount,
  snowPixelRatio,
  type SnowLayer,
  type SnowParticle,
} from '../snow-particles';

export type AmbientSnowState = SnowMode;

type SnowSpriteAtlas = { source: HTMLCanvasElement };
type AmbientMediaQueryList = Pick<
  MediaQueryList,
  'matches' | 'addEventListener' | 'removeEventListener'
>;

const fallbackFrameIntervalMs = 1_000 / 30;
const snowSpriteAtlases = new WeakMap<Document, SnowSpriteAtlas>();
const fallbackMediaQueryList: AmbientMediaQueryList = {
  matches: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

function createSnowSpriteAtlas(
  ownerDocument: Document,
): SnowSpriteAtlas | null {
  const source = ownerDocument.createElement('canvas');
  source.width = snowSpriteSize;
  source.height = snowSpriteSize;
  const context = source.getContext('2d');
  if (!context) return null;
  context.fillStyle = snowDotColor;
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

function mediaQuery(query: string): AmbientMediaQueryList {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : fallbackMediaQueryList;
}

function snowMode(
  enabled: boolean,
  reducedMotion: AmbientMediaQueryList,
  reducedTransparency: AmbientMediaQueryList,
  increasedContrast: AmbientMediaQueryList,
  forcedColors: AmbientMediaQueryList,
  slowUpdates: AmbientMediaQueryList,
): SnowMode {
  if (
    !enabled ||
    reducedTransparency.matches ||
    increasedContrast.matches ||
    forcedColors.matches ||
    slowUpdates.matches
  )
    return 'hidden';
  if (document.hidden) return 'paused';
  return reducedMotion.matches ? 'static' : 'running';
}

function snowGeometry(
  canvas: HTMLCanvasElement,
  coarsePointer: AmbientMediaQueryList,
) {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width || window.innerWidth));
  const height = Math.max(1, Math.round(bounds.height || window.innerHeight));
  const coarse = usesCoarseSnowProfile(width, coarsePointer.matches);
  return {
    width,
    height,
    coarse,
    pixelRatio: snowPixelRatio(window.devicePixelRatio, width, height),
  };
}

function SnowCanvas({
  canvasRef,
  renderer,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  renderer: 'main' | 'worker-pending';
}) {
  return (
    <canvas
      ref={canvasRef}
      className="ambient-snow"
      data-testid="ambient-snow"
      data-state="hidden"
      data-renderer={renderer}
      data-particle-count="0"
      data-effective-dpr="1"
      data-frame-sequence="0"
      aria-hidden="true"
      style={{ pointerEvents: 'none' }}
    />
  );
}

function MainThreadSnow({ enabled }: { enabled: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.dataset.renderer = 'main';
    if (typeof CanvasRenderingContext2D === 'undefined') {
      canvas.dataset.state = 'hidden';
      return;
    }
    const context = canvas.getContext('2d');
    if (!context) {
      canvas.dataset.state = 'hidden';
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
    let frameSequence = 0;

    const cancelFrame = () => {
      if (animationFrame != null) window.cancelAnimationFrame(animationFrame);
      animationFrame = null;
      lastTimestamp = null;
    };
    const clear = () => context.clearRect(0, 0, width, height);
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
    const configureCanvas = () => {
      const geometry = snowGeometry(canvas, coarsePointer);
      const backingWidth = Math.max(
        1,
        Math.round(geometry.width * geometry.pixelRatio),
      );
      const backingHeight = Math.max(
        1,
        Math.round(geometry.height * geometry.pixelRatio),
      );
      if (
        configured &&
        configuredCoarse === geometry.coarse &&
        width === geometry.width &&
        height === geometry.height &&
        canvas.width === backingWidth &&
        canvas.height === backingHeight
      )
        return;

      const previousWidth = width;
      const previousHeight = height;
      width = geometry.width;
      height = geometry.height;
      canvas.width = backingWidth;
      canvas.height = backingHeight;
      context.setTransform(
        geometry.pixelRatio,
        0,
        0,
        geometry.pixelRatio,
        0,
        0,
      );
      if (particles.length === 0)
        particles = createSnowParticles(
          width,
          height,
          defaultSnowSeed,
          geometry.coarse,
        );
      else
        resizeSnowParticlePool(
          particles,
          previousWidth,
          previousHeight,
          width,
          height,
          geometry.coarse,
        );
      canvas.dataset.particleCount = String(particles.length);
      canvas.dataset.effectiveDpr = String(geometry.pixelRatio);
      configured = true;
      configuredCoarse = geometry.coarse;
    };
    const draw = () =>
      drawSnowParticles(context, atlas.source, particles, width, height);
    const frame = (timestamp: number) => {
      animationFrame = null;
      if (
        snowMode(
          enabled,
          reducedMotion,
          reducedTransparency,
          increasedContrast,
          forcedColors,
          slowUpdates,
        ) !== 'running'
      ) {
        applyMode();
        return;
      }
      if (lastTimestamp == null) {
        lastTimestamp = timestamp;
      } else if (timestamp - lastTimestamp >= fallbackFrameIntervalMs) {
        const delta = timestamp - lastTimestamp;
        lastTimestamp = timestamp;
        advanceSnowParticles(particles, width, height, delta);
        draw();
        frameSequence += 1;
        canvas.dataset.frameSequence = String(frameSequence);
      }
      animationFrame = window.requestAnimationFrame(frame);
    };
    const applyMode = () => {
      cancelFrame();
      const mode = snowMode(
        enabled,
        reducedMotion,
        reducedTransparency,
        increasedContrast,
        forcedColors,
        slowUpdates,
      );
      canvas.dataset.state = mode;
      if (mode === 'hidden') {
        release();
        return;
      }
      if (mode === 'paused') return;
      configureCanvas();
      if (mode === 'static') {
        particles = createSnowParticles(
          width,
          height,
          defaultSnowSeed,
          configuredCoarse,
        );
        draw();
        return;
      }
      draw();
      animationFrame = window.requestAnimationFrame(frame);
    };
    const resize = () => {
      if (resizeFrame != null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        applyMode();
      });
    };
    const onModeChange = () => applyMode();

    for (const query of media) query.addEventListener('change', onModeChange);
    document.addEventListener('visibilitychange', onModeChange);
    window.addEventListener('resize', resize, { passive: true });
    window.visualViewport?.addEventListener('resize', resize, {
      passive: true,
    });
    applyMode();

    return () => {
      if (resizeFrame != null) window.cancelAnimationFrame(resizeFrame);
      cancelFrame();
      release();
      canvas.dataset.state = 'hidden';
      for (const query of media)
        query.removeEventListener('change', onModeChange);
      document.removeEventListener('visibilitychange', onModeChange);
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
    };
  }, [enabled]);

  return <SnowCanvas canvasRef={canvasRef} renderer="main" />;
}

function WorkerSnow({
  enabled,
  onFailure,
}: {
  enabled: boolean;
  onFailure: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!enabled) {
      canvas.width = 1;
      canvas.height = 1;
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
    let active = true;
    let initialized = false;
    let resizeFrame: number | null = null;
    let probeTimer: number | null = null;
    let failed = false;
    let worker: Worker;

    const fail = () => {
      if (!active || failed) return;
      failed = true;
      onFailure();
    };
    const currentMode = () =>
      snowMode(
        enabled,
        reducedMotion,
        reducedTransparency,
        increasedContrast,
        forcedColors,
        slowUpdates,
      );
    const post = (message: SnowWorkerInput, transfer?: Transferable[]) => {
      if (!active) return;
      worker.postMessage(message, transfer ?? []);
    };
    const configureWorker = () => {
      const geometry = snowGeometry(canvas, coarsePointer);
      post({ type: 'configure', ...geometry });
      post({ type: 'mode', mode: currentMode() });
    };
    const initialize = () => {
      if (!active || initialized) return;
      try {
        const geometry = snowGeometry(canvas, coarsePointer);
        const offscreen = canvas.transferControlToOffscreen();
        initialized = true;
        canvas.dataset.renderer = 'worker';
        post(
          {
            type: 'init',
            canvas: offscreen,
            ...geometry,
            mode: currentMode(),
          },
          [offscreen],
        );
      } catch {
        fail();
      }
    };
    const onModeChange = () => {
      const mode = currentMode();
      canvas.dataset.state = mode;
      if (initialized) post({ type: 'mode', mode });
    };
    const onMediaChange = () => {
      const mode = currentMode();
      canvas.dataset.state = mode;
      if (initialized) configureWorker();
    };
    const resize = () => {
      if (resizeFrame != null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        if (initialized) configureWorker();
      });
    };

    try {
      worker = new Worker(
        new URL('../ambient-snow.worker.ts', import.meta.url),
        {
          type: 'module',
        },
      );
    } catch {
      fail();
      return;
    }
    worker.onmessage = ({ data }: MessageEvent<SnowWorkerOutput>) => {
      if (!active) return;
      if (data.type === 'probe-ready') {
        probeTimer = window.setTimeout(initialize, 0);
      } else if (data.type === 'state') {
        canvas.dataset.state = data.state;
        canvas.dataset.particleCount = String(data.particleCount);
        canvas.dataset.effectiveDpr = String(data.pixelRatio);
      } else if (data.type === 'frame') {
        canvas.dataset.frameSequence = String(data.sequence);
      } else if (data.type === 'error') {
        fail();
      }
    };
    worker.onerror = fail;

    for (const query of media) query.addEventListener('change', onMediaChange);
    document.addEventListener('visibilitychange', onModeChange);
    window.addEventListener('resize', resize, { passive: true });
    window.visualViewport?.addEventListener('resize', resize, {
      passive: true,
    });
    canvas.dataset.state = currentMode();
    post({ type: 'probe' });

    return () => {
      active = false;
      if (probeTimer != null) window.clearTimeout(probeTimer);
      if (resizeFrame != null) window.cancelAnimationFrame(resizeFrame);
      if (initialized) {
        try {
          worker.postMessage({ type: 'dispose' } satisfies SnowWorkerInput);
        } catch {
          // The worker may already be gone after a navigation or crash.
        }
      }
      worker.terminate();
      for (const query of media)
        query.removeEventListener('change', onMediaChange);
      document.removeEventListener('visibilitychange', onModeChange);
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
    };
  }, [enabled, onFailure]);

  return <SnowCanvas canvasRef={canvasRef} renderer="worker-pending" />;
}

function supportsWorkerSnow(): boolean {
  return (
    typeof Worker === 'function' &&
    typeof OffscreenCanvas === 'function' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function'
  );
}

export function AmbientSnow({ enabled }: { enabled: boolean }) {
  const [workerFailed, setWorkerFailed] = useState(false);
  const onWorkerFailure = useCallback(() => setWorkerFailed(true), []);
  const worker = supportsWorkerSnow() && !workerFailed;

  return worker ? (
    <WorkerSnow
      key={enabled ? 'worker-enabled' : 'worker-disabled'}
      enabled={enabled}
      onFailure={onWorkerFailure}
    />
  ) : (
    <MainThreadSnow enabled={enabled} />
  );
}
