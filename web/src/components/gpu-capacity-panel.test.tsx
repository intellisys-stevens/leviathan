import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GPUCapacity } from '../gpu-capacity';
import { GPUCapacityPanel } from './gpu-capacity-panel';

const hook = vi.hoisted(() => ({ use: vi.fn() }));
vi.mock('../use-gpu-capacity', () => ({ useGPUCapacity: hook.use }));
const snapshot: GPUCapacity = {
  status: 'partial',
  observedAt: '2026-09-06T12:00:00Z',
  revision: 4,
  rows: [
    {
      id: 'native',
      mode: 'native',
      model: 'Synthetic GPU',
      memoryBytes: 80 * 1024 ** 3,
      available: 0,
      status: 'available',
    },
    {
      id: 'mig',
      mode: 'mig',
      model: 'Synthetic GPU',
      profile: '2g.40gb',
      memoryBytes: 40 * 1024 ** 3,
      available: null,
      status: 'unavailable',
    },
  ],
};
const refresh = vi.fn();
const state = (overrides = {}) => ({
  data: snapshot,
  loading: false,
  refreshing: false,
  error: null,
  expired: false,
  refresh,
  ...overrides,
});
beforeEach(() => {
  hook.use.mockReturnValue(state());
  refresh.mockClear();
});

describe('GPU capacity panel', () => {
  it('distinguishes zero availability from unknown and labels alternative profiles', () => {
    render(<GPUCapacityPanel hostKey="host-a" />);
    expect(
      screen
        .getByTestId('gpu-capacity-panel')
        .querySelector('[data-available="0"]'),
    ).toHaveTextContent('0');
    expect(
      screen
        .getByTestId('gpu-capacity-panel')
        .querySelector('[data-available="unknown"]'),
    ).toHaveTextContent('—');
    expect(screen.getByText('Availability unknown')).toBeVisible();
    expect(
      screen.getByText(/Profile counts are alternatives, not additive/),
    ).toBeVisible();
    expect(screen.getByText('80.0 GiB')).toBeVisible();
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh live GPU capacity' }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each([
    state({ expired: true }),
    state({ error: 'Capacity could not be refreshed.' }),
    state({ data: { ...snapshot, status: 'stale' } }),
  ])(
    'hides all counts when the snapshot is stale or a refresh fails %#',
    (value) => {
      hook.use.mockReturnValue(value);
      render(<GPUCapacityPanel hostKey="host-a" />);
      expect(
        screen
          .getByTestId('gpu-capacity-panel')
          .querySelectorAll('[data-available="unknown"]'),
      ).toHaveLength(2);
      expect(screen.queryByText('available now')).not.toBeInTheDocument();
    },
  );

  it('handles a monitor without the new endpoint without inventing profiles', () => {
    hook.use.mockReturnValue(
      state({
        data: null,
        error: 'Capacity reporting is not available on this monitor.',
      }),
    );
    render(<GPUCapacityPanel hostKey="legacy" />);
    expect(screen.getByText(/not available on this monitor/)).toBeVisible();
    expect(screen.queryByRole('definition')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Refresh live GPU capacity' }),
    ).toBeEnabled();
  });
});
