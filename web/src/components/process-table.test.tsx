import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Attribution, Process, Snapshot } from '../types';
import { ProcessTable } from './process-table';

const procCapability: Snapshot['capabilities']['proc'] = {
  name: '/proc GPU clients',
  available: true,
  status: 'available',
};

const attribution: Attribution = {
  provider: 'kubernetes_dra',
  status: 'available',
  workloads: [
    {
      ref: 'opaque-workspace-ref',
      platform: 'coder',
      kind: 'workspace',
      name: 'training-lab',
      ownerName: 'alice',
    },
  ],
  assignments: [],
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

function ControlledProcessTable({
  initialQuery = '',
  onQueryChange,
  ...props
}: Omit<
  React.ComponentProps<typeof ProcessTable>,
  'query' | 'onQueryChange'
> & {
  initialQuery?: string;
  onQueryChange?: (query: string) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  return (
    <ProcessTable
      {...props}
      query={query}
      onQueryChange={(nextQuery) => {
        setQuery(nextQuery);
        onQueryChange?.(nextQuery);
      }}
    />
  );
}

function installMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    get matches() {
      return matches;
    },
    media: '(min-width: 768px)',
    onchange: null,
    addEventListener: (
      _type: string,
      listener: EventListenerOrEventListenerObject,
    ) => listeners.add(listener as (event: MediaQueryListEvent) => void),
    removeEventListener: (
      _type: string,
      listener: EventListenerOrEventListenerObject,
    ) => listeners.delete(listener as (event: MediaQueryListEvent) => void),
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media),
  );
  return {
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches, media: media.media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProcessTable viewport', () => {
  it('labels host-wide data and keeps search outside its scroll region', () => {
    render(
      <ControlledProcessTable
        processes={processes(12)}
        procCapability={procCapability}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Processes' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/CUDA clients/)).toBeNull();
    expect(screen.queryByText(/current PID namespace/)).toBeNull();
    expect(screen.queryByText(/not workspace-attributed/)).toBeNull();
    expect(
      screen.queryByRole('columnheader', { name: 'Workspace' }),
    ).toBeNull();
    expect(screen.getByLabelText('Filter GPU processes')).toHaveAttribute(
      'placeholder',
      'Filter processes',
    );

    const viewport = screen.getByRole('region', {
      name: 'GPU processes table',
    });
    expect(viewport).toHaveClass(
      'max-h-[22rem]',
      'md:max-h-[24rem]',
      'overflow-auto',
      '[scrollbar-gutter:stable]',
    );
    expect(viewport).not.toHaveAttribute('aria-describedby');
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
      <ControlledProcessTable
        processes={initial}
        procCapability={procCapability}
      />,
    );
    const viewport = screen.getByRole('region', {
      name: 'GPU processes table',
    });
    viewport.scrollTop = 180;
    viewport.scrollLeft = 72;

    const refreshed = initial.map((process) => ({ ...process }));
    view.rerender(
      <ControlledProcessTable
        processes={refreshed}
        procCapability={procCapability}
      />,
    );
    expect(viewport.scrollTop).toBe(180);
    expect(viewport.scrollLeft).toBe(72);

    fireEvent.change(screen.getByLabelText('Filter GPU processes'), {
      target: { value: 'alice' },
    });
    expect(viewport.scrollTop).toBe(0);
    expect(viewport.scrollLeft).toBe(72);
    await waitFor(() =>
      expect(within(viewport).getAllByRole('row')).toHaveLength(5),
    );
  });

  it('shows and searches sanitized workspaces only when attribution is configured', async () => {
    const attributed = processes(3).map((process, index) =>
      index === 0
        ? ({ ...process, workloadRef: 'opaque-workspace-ref' } as Process)
        : process,
    );
    const view = render(
      <ControlledProcessTable
        processes={attributed}
        procCapability={procCapability}
        attribution={attribution}
      />,
    );

    expect(
      screen.getByRole('columnheader', { name: 'Workspace' }),
    ).toBeInTheDocument();
    expect(screen.getByText('alice / training-lab')).toBeInTheDocument();
    expect(view.container).not.toHaveTextContent('opaque-workspace-ref');

    fireEvent.change(screen.getByLabelText('Filter GPU processes'), {
      target: { value: 'training-lab' },
    });
    await waitFor(() =>
      expect(screen.getByRole('cell', { name: '4000' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('cell', { name: '4001' })).toBeNull();
  });

  it('reports a controlled result count and clears through its callback', async () => {
    const onQueryChange = vi.fn();
    render(
      <ControlledProcessTable
        processes={processes(12)}
        procCapability={procCapability}
        initialQuery="alice"
        onQueryChange={onQueryChange}
      />,
    );

    expect(screen.getByLabelText('Filter GPU processes')).toHaveValue('alice');
    await waitFor(() =>
      expect(screen.getByText('4 of 12 processes')).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Clear process filter' }),
    );
    expect(onQueryChange).toHaveBeenLastCalledWith('');
    expect(screen.getByLabelText('Filter GPU processes')).toHaveValue('');
    await waitFor(() =>
      expect(screen.getByText('12 processes')).toBeInTheDocument(),
    );
  });

  it('renders one compact mobile card representation and switches at the breakpoint', () => {
    const media = installMatchMedia(false);
    const attributed = processes(2).map((process, index) =>
      index === 0
        ? ({
            ...process,
            workloadRef: 'opaque-workspace-ref',
            executable: `/very/long/path/${'worker/'.repeat(12)}worker-0`,
            commandLine: `worker-0 ${'--very-long-argument '.repeat(12)}`,
          } as Process)
        : process,
    );
    render(
      <ControlledProcessTable
        processes={attributed}
        procCapability={procCapability}
        attribution={attribution}
      />,
    );

    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getAllByTestId('process-card')).toHaveLength(2);
    expect(screen.getByText('PID 4000')).toBeInTheDocument();
    expect(screen.getByText('alice / training-lab')).toBeInTheDocument();
    expect(screen.getAllByText('available')).toHaveLength(2);
    const viewport = screen.getByRole('region', {
      name: 'Host-wide GPU process cards',
    });
    expect(viewport).toHaveClass('max-w-full', 'overflow-x-hidden');

    const summary = screen.getByLabelText(
      'Show executable and command for PID 4000',
    );
    fireEvent.click(summary);
    expect(summary.closest('details')).toHaveAttribute('open');
    expect(screen.getByText(/very-long-argument/)).toHaveClass('break-all');

    act(() => media.setMatches(true));
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByTestId('process-card')).toBeNull();
  });
});
