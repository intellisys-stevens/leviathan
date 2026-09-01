import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PerimeterLight } from './perimeter-light';

describe('PerimeterLight', () => {
  it('keeps the stationary mask and rotating beam decorative', () => {
    const view = render(<PerimeterLight />);
    const mask = view.container.querySelector<HTMLElement>(
      '[data-slot=perimeter-light]',
    );
    const beam = view.container.querySelector<HTMLElement>(
      '[data-slot=perimeter-light-beam]',
    );

    expect(mask).toHaveAttribute('aria-hidden', 'true');
    expect(mask).toHaveClass('perimeter-light');
    expect(mask).toContainElement(beam);
    expect(beam).toHaveClass('perimeter-light-beam');
    expect(mask).not.toHaveAttribute('role');
    expect(beam).not.toHaveAttribute('role');
  });
});
