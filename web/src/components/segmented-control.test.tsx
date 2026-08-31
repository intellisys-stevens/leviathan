import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from './segmented-control';

describe('SegmentedControl', () => {
  it('exposes one labeled radiogroup and moves a transform-only thumb', () => {
    const onValueChange = vi.fn();
    const { rerender } = render(
      <SegmentedControl
        ariaLabel="Time range"
        options={[
          { value: 'short', label: 'Short' },
          { value: 'medium', label: 'Medium' },
          { value: 'long', label: 'Long' },
        ]}
        value="medium"
        onValueChange={onValueChange}
      />,
    );

    const group = screen.getByRole('radiogroup', { name: 'Time range' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios[1]).toBeChecked();
    expect(new Set(radios.map((radio) => radio.getAttribute('name')))).toEqual(
      new Set([radios[0].getAttribute('name')]),
    );
    expect(group).toHaveStyle('--segment-count: 3; --active-index: 1');

    const thumb = group.querySelector<HTMLElement>('.segmented-thumb');
    expect(thumb).toHaveClass(
      'transition-transform',
      'duration-200',
      'motion-reduce:transition-none',
    );
    expect(thumb?.className).not.toContain('transition-all');
    expect(group.querySelectorAll('.segmented-item')).toHaveLength(3);

    fireEvent.click(radios[2]);
    expect(onValueChange).toHaveBeenCalledOnce();
    expect(onValueChange).toHaveBeenCalledWith('long');

    rerender(
      <SegmentedControl
        ariaLabel="Time range"
        options={[
          { value: 'short', label: 'Short' },
          { value: 'medium', label: 'Medium' },
          { value: 'long', label: 'Long' },
        ]}
        value="long"
        onValueChange={onValueChange}
      />,
    );
    expect(group).toHaveStyle('--segment-count: 3; --active-index: 2');
    expect(group.querySelector('.segmented-thumb')).toBe(thumb);
  });

  it('preserves disabled radio semantics', () => {
    const onValueChange = vi.fn();
    render(
      <SegmentedControl
        ariaLabel="Time range"
        options={[
          { value: 5, label: '5m' },
          { value: 60, label: '1h', disabled: true },
        ]}
        value={5}
        onValueChange={onValueChange}
      />,
    );

    const disabled = screen.getByRole('radio', { name: '1h' });
    expect(disabled).toBeDisabled();
    fireEvent.click(disabled);
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
