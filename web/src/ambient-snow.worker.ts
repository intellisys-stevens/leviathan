/// <reference lib="webworker" />

import type {
  SnowMode,
  SnowWorkerInput,
  SnowWorkerOutput,
} from './ambient-snow-protocol';
import {
  advanceSnowParticles,
  createSnowParticles,
  defaultSnowSeed,
  drawSnowParticles,
  resizeSnowParticlePool,
  snowDotColor,
  snowSpriteSize,
  type SnowParticle,
} from './snow-particles';

const workerScope: DedicatedWorkerGlobalScope =
  self as DedicatedWorkerGlobalScope;
const heartbeatInterval = 30;

let canvas: OffscreenCanvas | null = null;
let context: OffscreenCanvasRenderingContext2D | null = null;
let sprite: OffscreenCanvas | null = null;
let particles: SnowParticle[] = [];
let width = 1;
let height = 1;
let pixelRatio = 1;
let coarse = false;
let mode: SnowMode = 'hidden';
let animationFrame: number | null = null;
let lastTimestamp: number | null = null;
let frameSequence = 0;

function post(message: SnowWorkerOutput) {
  workerScope.postMessage(message);
}

function createDotSprite(): OffscreenCanvas {
  const dot = new OffscreenCanvas(snowSpriteSize, snowSpriteSize);
  const dotContext = dot.getContext('2d');
  if (!dotContext) throw new Error('Snow sprite canvas is unavailable');
  dotContext.fillStyle = snowDotColor;
  dotContext.fillRect(2, 0, 4, 1);
  dotContext.fillRect(1, 1, 6, 1);
  dotContext.fillRect(0, 2, 8, 4);
  dotContext.fillRect(1, 6, 6, 1);
  dotContext.fillRect(2, 7, 4, 1);
  return dot;
}

function cancelFrame() {
  if (animationFrame != null) workerScope.cancelAnimationFrame(animationFrame);
  animationFrame = null;
  lastTimestamp = null;
}

function release() {
  cancelFrame();
  if (canvas) {
    canvas.width = 1;
    canvas.height = 1;
  }
  particles.length = 0;
  width = 1;
  height = 1;
  pixelRatio = 1;
}

function configure(
  nextWidth: number,
  nextHeight: number,
  nextPixelRatio: number,
  nextCoarse: boolean,
) {
  if (!canvas || !context) return;
  const normalizedWidth = Math.max(1, Math.round(nextWidth));
  const normalizedHeight = Math.max(1, Math.round(nextHeight));
  const backingWidth = Math.max(
    1,
    Math.round(normalizedWidth * nextPixelRatio),
  );
  const backingHeight = Math.max(
    1,
    Math.round(normalizedHeight * nextPixelRatio),
  );
  if (
    width === normalizedWidth &&
    height === normalizedHeight &&
    pixelRatio === nextPixelRatio &&
    coarse === nextCoarse &&
    canvas.width === backingWidth &&
    canvas.height === backingHeight
  )
    return;

  const previousWidth = width;
  const previousHeight = height;
  width = normalizedWidth;
  height = normalizedHeight;
  pixelRatio = nextPixelRatio;
  coarse = nextCoarse;
  canvas.width = backingWidth;
  canvas.height = backingHeight;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  if (particles.length === 0)
    particles = createSnowParticles(width, height, defaultSnowSeed, coarse);
  else
    resizeSnowParticlePool(
      particles,
      previousWidth,
      previousHeight,
      width,
      height,
      coarse,
    );
}

function draw() {
  if (!context || !sprite) return;
  drawSnowParticles(context, sprite, particles, width, height);
}

function frame(timestamp: number) {
  animationFrame = null;
  if (mode !== 'running') return;
  if (lastTimestamp == null) {
    lastTimestamp = timestamp;
    animationFrame = workerScope.requestAnimationFrame(frame);
    return;
  }
  const delta = timestamp - lastTimestamp;
  lastTimestamp = timestamp;
  advanceSnowParticles(particles, width, height, delta);
  draw();
  frameSequence += 1;
  if (frameSequence % heartbeatInterval === 0)
    post({ type: 'frame', sequence: frameSequence });
  animationFrame = workerScope.requestAnimationFrame(frame);
}

function applyMode(nextMode: SnowMode) {
  mode = nextMode;
  cancelFrame();
  if (mode === 'hidden') {
    release();
  } else if (mode === 'static') {
    particles = createSnowParticles(width, height, defaultSnowSeed, coarse);
    draw();
  } else if (mode === 'running') {
    draw();
    animationFrame = workerScope.requestAnimationFrame(frame);
  }
  post({
    type: 'state',
    state: mode,
    particleCount: particles.length,
    pixelRatio,
  });
}

workerScope.onmessage = ({ data }: MessageEvent<SnowWorkerInput>) => {
  try {
    if (data.type === 'probe') {
      post({ type: 'probe-ready' });
      return;
    }
    if (data.type === 'dispose') {
      release();
      workerScope.close();
      return;
    }
    if (data.type === 'init') {
      canvas = data.canvas;
      context = canvas.getContext('2d');
      if (!context) throw new Error('Snow worker canvas is unavailable');
      sprite = createDotSprite();
      configure(data.width, data.height, data.pixelRatio, data.coarse);
      applyMode(data.mode);
      return;
    }
    if (data.type === 'configure') {
      configure(data.width, data.height, data.pixelRatio, data.coarse);
      if (mode === 'static') {
        particles = createSnowParticles(width, height, defaultSnowSeed, coarse);
        draw();
      } else if (mode === 'running') {
        draw();
      }
      post({
        type: 'state',
        state: mode,
        particleCount: particles.length,
        pixelRatio,
      });
      return;
    }
    applyMode(data.mode);
  } catch (reason) {
    post({
      type: 'error',
      message: reason instanceof Error ? reason.message : 'Snow worker failed',
    });
  }
};
