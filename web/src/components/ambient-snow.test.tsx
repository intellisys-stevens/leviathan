import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  advanceSnowParticles,
  AmbientSnow,
  createSnowParticles,
  snowParticleCount,
  snowPixelRatio,
  type SnowParticle,
} from './ambient-snow';

type MutableMediaQuery = Pick<
  MediaQueryList,
  'matches' | 'media' | 'addEventListener' | 'removeEventListener'
> & {
  setMatches: (matches: boolean) => void;
};

const mediaQueries = new Map<string, MutableMediaQuery>();
const animationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrame = 1;

const context = {
  arc: vi.fn(),
  beginPath: vi.fn(),
  clearRect: vi.fn(),
  drawImage: vi.fn(),
  fill: vi.fn(),
  fillRect: vi.fn(),
  fillStyle: '',
  globalAlpha: 1,
  setTransform: vi.fn(),
};

const atlasContext = {
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  fillStyle: '',
};

function mutableMediaQuery(query: string): MutableMediaQuery {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  let matches: boolean = false;
  const result = {
    get matches() {
      return matches;
    },
    media: query,
    addEventListener: (
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) => {
      if (type === 'change') listeners.add(listener);
    },
    removeEventListener: (
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) => {
      if (type === 'change') listeners.delete(listener);
    },
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      const event = new Event('change');
      for (const listener of listeners) {
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      }
    },
  } satisfies MutableMediaQuery;
  return result;
}

function query(query: string): MutableMediaQuery {
  let result = mediaQueries.get(query);
  if (!result) {
    result = mutableMediaQuery(query);
    mediaQueries.set(query, result);
  }
  return result;
}

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    value: hidden,
  });
}

function setViewport(width: number, height: number, devicePixelRatio = 3) {
  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: width },
    innerHeight: { configurable: true, value: height },
    devicePixelRatio: { configurable: true, value: devicePixelRatio },
  });
}

function runNextFrame(timestamp: number) {
  const entry = animationFrames.entries().next().value as
    | [number, FrameRequestCallback]
    | undefined;
  if (!entry) throw new Error('Expected a pending animation frame');
  animationFrames.delete(entry[0]);
  entry[1](timestamp);
}

function lastDrawGeometry(count: number) {
  return context.drawImage.mock.calls
    .slice(-count)
    .map((call) => call.slice(-4));
}

beforeEach(() => {
  mediaQueries.clear();
  animationFrames.clear();
  nextAnimationFrame = 1;
  setDocumentHidden(false);
  setViewport(800, 600);
  Object.defineProperties(window, {
    CanvasRenderingContext2D: {
      configurable: true,
      value: class CanvasRenderingContext2DMock {},
    },
    matchMedia: {
      configurable: true,
      value: vi.fn((media: string) => query(media)),
    },
    requestAnimationFrame: {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        const identifier = nextAnimationFrame;
        nextAnimationFrame += 1;
        animationFrames.set(identifier, callback);
        return identifier;
      }),
    },
    cancelAnimationFrame: {
      configurable: true,
      value: vi.fn((identifier: number) => {
        animationFrames.delete(identifier);
      }),
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    function (this: HTMLCanvasElement) {
      return (this.getAttribute('data-testid') === 'ambient-snow'
        ? context
        : atlasContext) as unknown as CanvasRenderingContext2D;
    },
  );
  for (const mock of [
    context.arc,
    context.beginPath,
    context.clearRect,
    context.drawImage,
    context.fill,
    context.fillRect,
    context.setTransform,
    atlasContext.clearRect,
    atlasContext.fillRect,
  ])
    mock.mockClear();
  context.fillStyle = '';
  context.globalAlpha = 1;
  atlasContext.fillStyle = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  setDocumentHidden(false);
});

describe('ambient snow particle helpers', () => {
  it('uses bounded mobile and desktop density and backing-store profiles', () => {
    expect(snowParticleCount(320, 568)).toBe(44);
    expect(snowParticleCount(1280, 720)).toBe(115);
    expect(snowParticleCount(3840, 2160)).toBe(160);
    expect(snowParticleCount(3840, 2160, true)).toBe(80);

    expect(snowPixelRatio(Number.NaN)).toBe(1);
    expect(snowPixelRatio(0.75)).toBe(1);
    expect(snowPixelRatio(3)).toBe(1.25);
    expect(snowPixelRatio(2, 320, 800)).toBe(1.25);
    expect(snowPixelRatio(2, 1280, 720, true)).toBe(1.25);
    expect(snowPixelRatio(2, 3840, 2160)).toBe(1);
    expect(Math.round(320 * snowPixelRatio(2, 320, 800))).toBeLessThanOrEqual(
      400,
    );
    expect(Math.round(800 * snowPixelRatio(2, 320, 800))).toBeLessThanOrEqual(
      1_000,
    );
  });

  it('generates deterministic three-layer pools within the intended speed bands', () => {
    const first = createSnowParticles(1280, 720, 42);
    const second = createSnowParticles(1280, 720, 42);
    expect(second).toEqual(first);
    expect(createSnowParticles(1280, 720, 43)).not.toEqual(first);

    const far = first.filter(({ layer }) => layer === 'far');
    const mid = first.filter(({ layer }) => layer === 'mid');
    const near = first.filter(({ layer }) => layer === 'near');
    expect([far.length, mid.length, near.length]).toEqual([67, 36, 12]);
    expect(far.length).toBeGreaterThan(mid.length);
    expect(mid.length).toBeGreaterThan(near.length);
    expect(new Set(first.map(({ layer }) => layer))).toEqual(
      new Set(['far', 'mid', 'near']),
    );
    expect(far.every(({ speed }) => speed >= 14 && speed <= 24)).toBe(true);
    expect(mid.every(({ speed }) => speed >= 28 && speed <= 48)).toBe(true);
    expect(near.every(({ speed }) => speed >= 60 && speed <= 90)).toBe(true);
    expect(far.every(({ radius }) => radius >= 0.6 && radius <= 1.1)).toBe(
      true,
    );
    expect(mid.every(({ radius }) => radius >= 1 && radius <= 1.8)).toBe(true);
    expect(near.every(({ radius }) => radius >= 2 && radius <= 3)).toBe(true);
    expect(far.every(({ drift }) => drift >= -0.7 && drift <= 0.7)).toBe(true);
    expect(mid.every(({ drift }) => drift >= -2.2 && drift <= 2.2)).toBe(true);
    expect(near.every(({ drift }) => drift >= -3.2 && drift <= 3.2)).toBe(true);
    expect(Math.min(...near.map(({ sway }) => sway))).toBeGreaterThan(
      Math.max(...far.map(({ sway }) => sway)),
    );
    expect(Math.min(...near.map(({ alpha }) => alpha))).toBeGreaterThan(
      Math.max(...far.map(({ alpha }) => alpha)),
    );
  });

  it('updates reusable particle objects with a frame delta capped at 50ms', () => {
    const particle: SnowParticle = {
      layer: 'mid',
      x: 10,
      y: 10,
      radius: 1,
      speed: 100,
      drift: 0,
      sway: 0,
      swayRate: 0,
      phase: 0,
      alpha: 0.3,
    };
    const particles = [particle];

    expect(advanceSnowParticles(particles, 100, 100, 1_000)).toBe(particles);
    expect(particles[0]).toBe(particle);
    expect(particle.y).toBeCloseTo(15);

    particle.x = -2;
    particle.y = 102;
    advanceSnowParticles(particles, 100, 100, 0);
    expect(particle.x).toBe(101);
    expect(particle.y).toBe(-1);
  });
});

describe('AmbientSnow', () => {
  it('draws cached sprites without path work and starts one DPR-capped loop', () => {
    const view = render(<AmbientSnow enabled />);
    const canvas = screen.getByTestId('ambient-snow');
    const count = snowParticleCount(800, 600);

    expect(canvas).toHaveAttribute('aria-hidden', 'true');
    expect(canvas).toHaveAttribute('data-state', 'running');
    expect(canvas).toHaveClass('ambient-snow');
    expect(canvas).toHaveStyle({ pointerEvents: 'none' });
    expect(canvas).toHaveAttribute('width', '1000');
    expect(canvas).toHaveAttribute('height', '750');
    expect(canvas).toHaveAttribute('data-particle-count', String(count));
    expect(canvas).toHaveAttribute('data-effective-dpr', '1.25');
    expect(view.container.children).toHaveLength(1);
    expect(view.container.querySelectorAll('canvas')).toHaveLength(1);
    expect(context.setTransform).toHaveBeenCalledWith(1.25, 0, 0, 1.25, 0, 0);
    expect(context.drawImage).toHaveBeenCalledTimes(count);
    expect(context.arc).not.toHaveBeenCalled();
    expect(context.beginPath).not.toHaveBeenCalled();
    expect(context.fill).not.toHaveBeenCalled();
    expect(context.fillRect).not.toHaveBeenCalled();
    expect(
      new Set(context.drawImage.mock.calls.map(([source]) => source)).size,
    ).toBe(1);
    const spriteAtlas = context.drawImage.mock.calls[0]?.[0];
    expect(spriteAtlas).toBeInstanceOf(HTMLCanvasElement);
    expect(spriteAtlas).not.toBe(canvas);
    expect(spriteAtlas).toHaveAttribute('width', '8');
    expect(spriteAtlas).toHaveAttribute('height', '8');
    expect(
      context.drawImage.mock.calls.every((call) => call.length === 5),
    ).toBe(true);
    expect(animationFrames.size).toBe(1);

    view.rerender(<AmbientSnow enabled={false} />);
    expect(canvas).toHaveAttribute('data-state', 'hidden');
    expect(canvas).toHaveAttribute('width', '1');
    expect(canvas).toHaveAttribute('height', '1');
    expect(canvas).toHaveAttribute('data-particle-count', '0');
    expect(canvas).toHaveAttribute('data-effective-dpr', '1');
    expect(animationFrames.size).toBe(0);
    expect(context.clearRect).toHaveBeenCalled();

    context.drawImage.mockClear();
    view.rerender(<AmbientSnow enabled />);
    expect(context.drawImage.mock.calls[0]?.[0]).toBe(spriteAtlas);
    expect(animationFrames.size).toBe(1);
  });

  it('draws on every display frame without allocating another loop', () => {
    render(<AmbientSnow enabled />);
    const count = snowParticleCount(800, 600);
    expect(context.drawImage).toHaveBeenCalledTimes(count);

    act(() => runNextFrame(0));
    expect(context.drawImage).toHaveBeenCalledTimes(count);

    act(() => runNextFrame(16));
    expect(context.drawImage).toHaveBeenCalledTimes(count * 2);

    act(() => runNextFrame(32));
    expect(context.drawImage).toHaveBeenCalledTimes(count * 3);
    expect(animationFrames.size).toBe(1);
  });

  it('caps a 320x800 DPR2 canvas at a 400x1000 backing store', () => {
    setViewport(320, 800, 2);
    render(<AmbientSnow enabled />);
    const canvas = screen.getByTestId('ambient-snow');

    expect(canvas).toHaveAttribute('width', '400');
    expect(canvas).toHaveAttribute('height', '1000');
    expect(canvas).toHaveAttribute('data-particle-count', '44');
    expect(canvas).toHaveAttribute('data-effective-dpr', '1.25');
    expect(context.setTransform).toHaveBeenCalledWith(1.25, 0, 0, 1.25, 0, 0);
    expect(context.drawImage).toHaveBeenCalledTimes(44);
  });

  it('uses the coarse profile when a coarse pointer is reported', () => {
    setViewport(1280, 720, 2);
    query('(pointer: coarse)').setMatches(true);
    render(<AmbientSnow enabled />);

    expect(screen.getByTestId('ambient-snow')).toHaveAttribute('width', '1600');
    expect(screen.getByTestId('ambient-snow')).toHaveAttribute('height', '900');
    expect(context.drawImage).toHaveBeenCalledTimes(80);
  });

  it('coalesces resize work and reacts to DPR-only resize notifications', () => {
    render(<AmbientSnow enabled />);
    const canvas = screen.getByTestId('ambient-snow');
    const requestFrame = vi.mocked(window.requestAnimationFrame);

    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 1,
    });
    act(() => {
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));
    });
    expect(requestFrame).toHaveBeenCalledTimes(2);

    const resizeEntry = [...animationFrames.entries()].at(-1);
    if (!resizeEntry) throw new Error('Expected a resize animation frame');
    act(() => {
      animationFrames.delete(resizeEntry[0]);
      resizeEntry[1](100);
    });
    expect(canvas).toHaveAttribute('width', '800');
    expect(canvas).toHaveAttribute('height', '600');
    expect(animationFrames.size).toBe(1);
  });

  it('pauses while hidden and resumes with a reset frame timestamp', () => {
    render(<AmbientSnow enabled />);
    const canvas = screen.getByTestId('ambient-snow');
    const count = snowParticleCount(800, 600);

    act(() => runNextFrame(1_000));
    setDocumentHidden(true);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(canvas).toHaveAttribute('data-state', 'paused');
    expect(animationFrames.size).toBe(0);

    setDocumentHidden(false);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(canvas).toHaveAttribute('data-state', 'running');
    expect(animationFrames.size).toBe(1);
    const resumedGeometry = lastDrawGeometry(count);
    const drawCount = context.drawImage.mock.calls.length;

    act(() => runNextFrame(60_000));
    expect(context.drawImage).toHaveBeenCalledTimes(drawCount);
    expect(lastDrawGeometry(count)).toEqual(resumedGeometry);
  });

  it('draws a deterministic field once when reduced motion is active', () => {
    query('(prefers-reduced-motion: reduce)').setMatches(true);
    render(<AmbientSnow enabled />);

    expect(screen.getByTestId('ambient-snow')).toHaveAttribute(
      'data-state',
      'static',
    );
    expect(context.drawImage).toHaveBeenCalledTimes(80);
    expect(context.arc).not.toHaveBeenCalled();
    expect(animationFrames.size).toBe(0);
  });

  it('re-seeds identical static geometry after animation and intermediate resizes', () => {
    render(<AmbientSnow enabled />);
    const reducedMotion = query('(prefers-reduced-motion: reduce)');

    act(() => runNextFrame(0));
    act(() => runNextFrame(16));
    setViewport(1_000, 700);
    act(() => reducedMotion.setMatches(true));
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    act(() => runNextFrame(100));

    const expected = createSnowParticles(1_000, 700).map(({ x, y, radius }) => [
      x - radius,
      y - radius,
      radius * 2,
      radius * 2,
    ]);
    const count = expected.length;
    expect(screen.getByTestId('ambient-snow')).toHaveAttribute(
      'data-state',
      'static',
    );
    expect(lastDrawGeometry(count)).toEqual(expected);

    act(() => reducedMotion.setMatches(false));
    act(() => runNextFrame(1_000));
    act(() => runNextFrame(1_016));
    act(() => reducedMotion.setMatches(true));

    expect(lastDrawGeometry(count)).toEqual(expected);
    expect(animationFrames.size).toBe(0);
  });

  it.each([
    '(prefers-reduced-transparency: reduce)',
    '(prefers-contrast: more)',
    '(forced-colors: active)',
    '(update: slow)',
  ])('clears and stays hidden for %s', (media) => {
    query(media).setMatches(true);
    render(<AmbientSnow enabled />);

    expect(screen.getByTestId('ambient-snow')).toHaveAttribute(
      'data-state',
      'hidden',
    );
    expect(screen.getByTestId('ambient-snow')).toHaveAttribute('width', '1');
    expect(screen.getByTestId('ambient-snow')).toHaveAttribute('height', '1');
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(context.arc).not.toHaveBeenCalled();
    expect(context.clearRect).toHaveBeenCalled();
    expect(animationFrames.size).toBe(0);
  });

  it('reacts to accessibility media changes without creating a second loop', () => {
    render(<AmbientSnow enabled />);
    const canvas = screen.getByTestId('ambient-snow');
    const transparency = query('(prefers-reduced-transparency: reduce)');

    act(() => transparency.setMatches(true));
    expect(canvas).toHaveAttribute('data-state', 'hidden');
    expect(animationFrames.size).toBe(0);

    act(() => transparency.setMatches(false));
    expect(canvas).toHaveAttribute('data-state', 'running');
    expect(animationFrames.size).toBe(1);
  });

  it('does not allocate sprites or start a loop while disabled', () => {
    render(<AmbientSnow enabled={false} />);

    expect(screen.getByTestId('ambient-snow')).toHaveAttribute(
      'data-state',
      'hidden',
    );
    expect(screen.getByTestId('ambient-snow')).toHaveAttribute('width', '1');
    expect(screen.getByTestId('ambient-snow')).toHaveAttribute('height', '1');
    expect(context.setTransform).not.toHaveBeenCalled();
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(context.arc).not.toHaveBeenCalled();
    expect(animationFrames.size).toBe(0);
  });

  it('uses non-matching media fallbacks when matchMedia is unavailable', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: undefined,
    });
    render(<AmbientSnow enabled />);

    expect(screen.getByTestId('ambient-snow')).toHaveAttribute(
      'data-state',
      'running',
    );
    expect(context.setTransform).toHaveBeenCalled();
    expect(context.drawImage).toHaveBeenCalledTimes(80);
    expect(context.arc).not.toHaveBeenCalled();
    expect(animationFrames.size).toBe(1);
  });
});
