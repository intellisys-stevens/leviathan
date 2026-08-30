import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Process, Snapshot } from '../types';
import { ProcessTable } from './process-table';

const procCapability: Snapshot['capabilities']['proc'] = {
  name: '/proc GPU clients',
  available: true,
  status: 'available',
};

function processes(count: number): Process[] {
  return Array.from({ length: count }, (_, index) => ({
    pid: 4000 + index,
    user: index % 3 === 0 ? 'alice' : 'bob',
    executable: `/usr/bin/worker-${index}`,
    commandLine: `worker-${index} --gpu`,
    startTime: `2026-08-29T12:00:${String(index).padStart(2, '0')}Z`,
    status: 'available' as const,
  }));
}

describe('ProcessTable viewport', () => {
  it('labels host-wide data, reports counts, and keeps search outside its scroll region', () => {
    render(
      <ProcessTable
        processes={processes(12)}
        procCapability={procCapability}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Host-wide GPU processes' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('process-count')).toHaveTextContent(
      '12 CUDA clients',
    );
    expect(screen.getByText(/not workspace-attributed/)).toBeInTheDocument();

    const viewport = screen.getByRole('region', {
      name: 'Host-wide GPU processes table',
    });
    expect(viewport).toHaveClass(
      'max-h-[22rem]',
      'md:max-h-[24rem]',
      'overflow-auto',
      '[scrollbar-gutter:stable]',
    );
    expect(viewport).toHaveAttribute(
      'aria-describedby',
      'process-table-description',
    );
    expect(viewport).not.toContainElement(
      screen.getByLabelText('Filter GPU processes'),
    );

    for (const heading of within(viewport).getAllByRole('columnheader')) {
      expect(heading).toHaveClass('sticky', 'top-0');
    }
    expect(within(viewport).getByRole('table')).toHaveClass('min-w-[58rem]');
  });

  it('preserves scroll through live updates and resets only vertical scroll on filtering', async () => {
    const initial = processes(12);
    const view = render(
      <ProcessTable processes={initial} procCapability={procCapability} />,
    );
    const viewport = screen.getByRole('region', {
      name: 'Host-wide GPU processes table',
    });
    viewport.scrollTop = 180;
    viewport.scrollLeft = 72;

    const refreshed = initial.map((process) => ({ ...process }));
    view.rerender(
      <ProcessTable processes={refreshed} procCapability={procCapability} />,
    );
    expect(viewport.scrollTop).toBe(180);
    expect(viewport.scrollLeft).toBe(72);

    fireEvent.change(screen.getByLabelText('Filter GPU processes'), {
      target: { value: 'alice' },
    });
    expect(viewport.scrollTop).toBe(0);
    expect(viewport.scrollLeft).toBe(72);
    await waitFor(() =>
      expect(screen.getByTestId('process-count')).toHaveTextContent('4 of 12'),
    );
  });
});
