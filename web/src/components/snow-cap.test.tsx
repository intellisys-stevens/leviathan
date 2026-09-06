import { StrictMode } from 'react';
import { render } from '@testing-library/react';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SnowCap, generateSnowProfile } from './snow-cap';

const testSeed = vi.hoisted(() => {
  Object.defineProperty(globalThis, '__LEVIATHAN_TEST_SNOW_SEED__', {
    configurable: true,
    writable: true,
    value: 12_345,
  });
  return 12_345;
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, '__LEVIATHAN_TEST_SNOW_SEED__');
});

function bodyPaths(container: HTMLElement) {
  return [...container.querySelectorAll('[data-slot="snow-cap-body"] path')]
    .map((path) => path.getAttribute('d'))
    .join('|');
}

describe('SnowCap', () => {
  it('renders static decorative powder, contact shadow, and highlight layers', () => {
    const view = render(<SnowCap surfaceKey="gpu:test" />);
    const cap = view.container.querySelector('[data-slot="snow-cap"]');
    const art = view.container.querySelector('svg');
    const count = generateSnowProfile('gpu:test', testSeed).length;

    expect(cap).toHaveAttribute('aria-hidden', 'true');
    expect(cap).toHaveAttribute('data-snow-profile', 'generated');
    expect(cap).toHaveAttribute('data-snow-surface', 'gpu:test');
    expect(cap).toHaveAttribute('data-snow-piles', String(count));
    expect(cap).toContainElement(art);
    expect(art).toHaveAttribute('viewBox', '0 0 1000 24');
    expect(art).toHaveAttribute('focusable', 'false');
    for (const layer of ['body', 'shadow', 'highlight']) {
      expect(
        view.container.querySelectorAll(`[data-slot="snow-cap-${layer}"] path`),
      ).toHaveLength(count);
    }
    expect(
      view.container.querySelector(
        'animate, animateTransform, script, image, use, [data-slot="snow-cap-reflection"]',
      ),
    ).toBeNull();
  });

  it('derives arrangements from the page seed and stable surface identity', () => {
    const profile = generateSnowProfile('gpu:GPU-0', 123);
    expect(generateSnowProfile('gpu:GPU-0', 123)).toEqual(profile);
    expect(generateSnowProfile('gpu:GPU-0', 456)).not.toEqual(profile);
    expect(generateSnowProfile('gpu:GPU-1', 123)).not.toEqual(profile);
    expect(generateSnowProfile('owner:GPU-0', 123)).not.toEqual(profile);
    expect(generateSnowProfile('gpu:GPU-0', 0)).not.toEqual(
      generateSnowProfile('gpu:GPU-0', 0xffff_ffff),
    );
  });

  it('uses one or two shallow piles with independently varying dimensions and spacing', () => {
    const counts = new Map<number, number>();
    const heights = new Set<number>();
    const widths = new Set<number>();
    const gaps = new Set<number>();
    const positions = new Set<number>();
    for (let seed = 0; seed < 2048; seed++) {
      const profile = generateSnowProfile('gpu:GPU-0', seed);
      counts.set(profile.length, (counts.get(profile.length) ?? 0) + 1);
      expect([1, 2]).toContain(profile.length);
      const first = profile[0];
      const last = profile.at(-1)!;
      expect(first.start).toBeGreaterThanOrEqual(40);
      expect(last.start + last.width).toBeLessThanOrEqual(960);
      positions.add(Math.round(first.start));
      for (const [index, drift] of profile.entries()) {
        expect(drift.width).toBeGreaterThanOrEqual(
          profile.length === 1 ? 250 : 150,
        );
        expect(drift.width).toBeLessThanOrEqual(
          profile.length === 1 ? 550 : 280,
        );
        expect(drift.height).toBeGreaterThanOrEqual(3);
        expect(drift.height).toBeLessThanOrEqual(14);
        expect(drift.crest).toBeGreaterThanOrEqual(0.44);
        expect(drift.crest).toBeLessThanOrEqual(0.56);
        if (index > 0) {
          const previous = profile[index - 1];
          const gap = drift.start - previous.start - previous.width;
          expect(gap).toBeGreaterThanOrEqual(80);
          expect(gap).toBeLessThanOrEqual(240);
          gaps.add(Math.round(gap));
          expect(drift.width).not.toBe(previous.width);
          expect(drift.height).not.toBe(previous.height);
        }
        heights.add(Math.round(drift.height * 10));
        widths.add(Math.round(drift.width));
      }
    }
    expect([...counts.keys()].sort((left, right) => left - right)).toEqual([
      1, 2,
    ]);
    for (const count of counts.values()) {
      expect(count / 2048).toBeGreaterThan(0.45);
      expect(count / 2048).toBeLessThan(0.55);
    }
    expect(heights.size).toBeGreaterThan(50);
    expect(widths.size).toBeGreaterThan(50);
    expect(gaps.size).toBeGreaterThan(50);
    expect(positions.size).toBeGreaterThan(100);
  });

  it('keeps generated curves within the SVG strip and closes each pile at the border', () => {
    const view = render(<SnowCap surfaceKey="gpu:GPU-0" />);
    for (let index = 0; index < 24; index++) {
      view.rerender(<SnowCap surfaceKey={`gpu:GPU-${index}`} />);
      for (const path of view.container.querySelectorAll(
        '[data-slot="snow-cap-body"] path',
      )) {
        const data = path.getAttribute('d')!;
        expect(data).toMatch(/^M(\d+(?:\.\d+)?) 15\b.*\s\1 15 Z$/u);
        expect(data).not.toMatch(/NaN|Infinity| L/u);
        const coordinates = data.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
        const xs = coordinates.filter((_, index) => index % 2 === 0);
        const ys = coordinates.filter((_, index) => index % 2 === 1);
        expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
        expect(Math.max(...xs)).toBeLessThanOrEqual(1000);
        expect(Math.min(...ys)).toBeGreaterThanOrEqual(1);
        expect(Math.max(...ys)).toBeLessThanOrEqual(17);
      }
    }
  });

  it('preserves the arrangement through Strict Mode, rerenders, identity switches, and remounts', () => {
    const view = render(
      <StrictMode>
        <SnowCap surfaceKey="owner:alice" />
      </StrictMode>,
    );
    const original = bodyPaths(view.container);
    view.rerender(
      <StrictMode>
        <SnowCap surfaceKey="owner:alice" />
      </StrictMode>,
    );
    expect(bodyPaths(view.container)).toBe(original);
    view.rerender(
      <StrictMode>
        <SnowCap surfaceKey="owner:bob" />
      </StrictMode>,
    );
    expect(bodyPaths(view.container)).not.toBe(original);
    view.rerender(
      <StrictMode>
        <SnowCap surfaceKey="owner:alice" />
      </StrictMode>,
    );
    expect(bodyPaths(view.container)).toBe(original);
    view.unmount();
    const remounted = render(<SnowCap surfaceKey="owner:alice" />);
    expect(bodyPaths(remounted.container)).toBe(original);
  });
});
