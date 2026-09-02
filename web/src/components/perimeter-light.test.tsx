import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PerimeterLight } from './perimeter-light';

describe('PerimeterLight', () => {
  it('keeps the stationary mask and breathing glow decorative', () => {
    const view = render(<PerimeterLight />);
    const mask = view.container.querySelector<HTMLElement>(
      '[data-slot=perimeter-light]',
    );
    const glow = view.container.querySelector<HTMLElement>(
      '[data-slot=perimeter-light-glow]',
    );

    expect(mask).toHaveAttribute('aria-hidden', 'true');
    expect(mask).toHaveClass('perimeter-light');
    expect(mask).toContainElement(glow);
    expect(glow).toHaveClass('perimeter-light-glow');
    expect(mask).not.toHaveAttribute('role');
    expect(glow).not.toHaveAttribute('role');
  });
});
