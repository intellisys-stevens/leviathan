import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SnowCap, snowCapVariant, snowCapVariants } from './snow-cap';

describe('SnowCap', () => {
  it('renders static decorative powder, contact shadow, and highlight layers', () => {
    const view = render(<SnowCap variant="left" />);
    const cap = view.container.querySelector<HTMLElement>(
      '[data-slot="snow-cap"]',
    );
    const art = view.container.querySelector('svg');
    const body = view.container.querySelector('[data-slot="snow-cap-body"]');
    const shadow = view.container.querySelector(
      '[data-slot="snow-cap-shadow"]',
    );
    const highlight = view.container.querySelector(
      '[data-slot="snow-cap-highlight"]',
    );

    expect(cap).toHaveAttribute('aria-hidden', 'true');
    expect(cap).toHaveAttribute('data-snow-profile', 'left');
    expect(cap).toContainElement(art);
    expect(art).toHaveAttribute('viewBox', '0 0 200 24');
    expect(art).toHaveAttribute('focusable', 'false');
    expect(body?.querySelectorAll('path').length).toBeGreaterThan(0);
    expect(shadow?.querySelectorAll('path').length).toBeGreaterThan(0);
    expect(highlight?.querySelectorAll('path').length).toBeGreaterThan(0);
    expect(
      view.container.querySelector('[data-slot="snow-cap-reflection"]'),
    ).toBeNull();
    expect(
      view.container.querySelector(
        'animate, animateTransform, script, image, use',
      ),
    ).toBeNull();
  });

  it('renders five distinct deterministic drift profiles', () => {
    const view = render(<SnowCap variant="left" />);
    const profiles = snowCapVariants.map((variant) => {
      view.rerender(<SnowCap variant={variant} />);
      const cap = view.container.querySelector('[data-slot="snow-cap"]')!;
      return {
        variant: cap.getAttribute('data-snow-profile'),
        body: [...cap.querySelectorAll('[data-slot="snow-cap-body"] path')]
          .map((path) => path.getAttribute('d'))
          .join('|'),
      };
    });

    expect(profiles.map(({ variant }) => variant)).toEqual(snowCapVariants);
    expect(new Set(profiles.map(({ body }) => body)).size).toBe(5);
    for (const body of profiles.flatMap(({ body }) => body.split('|'))) {
      expect(body).toMatch(/^M(\d+) 15\b.*\s\1 15 Z$/u);
      expect(body).not.toContain(' L');
    }
    expect(snowCapVariant('gpu-0')).toBe('center');
    expect(snowCapVariant('gpu-1')).toBe('split');
    expect(snowCapVariant('synthetic-owner')).toBe('left');
    expect(snowCapVariant('alpha')).toBe('split');
    expect(snowCapVariant('beta')).toBe('right');
  });
});
