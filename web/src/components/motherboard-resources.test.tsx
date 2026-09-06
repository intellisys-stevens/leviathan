import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../types';
import { systemCapability, systemFixture } from '../test/system-fixture';
import type { HardwareBoardViewProps } from './hardware-board-view';
import type { MotherboardCategoryId } from './motherboard-appearance';
import { MotherboardResources } from './motherboard-resources';

vi.mock('./hardware-board-view', () => ({
  HardwareBoardView: ({
    scene,
    selectedId,
    highlightedId,
    onSelect,
    onHighlight,
    fallback,
  }: HardwareBoardViewProps) => (
    <div
      data-testid="motherboard-view"
      data-scene={JSON.stringify(scene)}
      data-selected={selectedId}
      data-highlighted={highlightedId}
    >
      {(['cpu', 'memory', 'storage'] as const).map((id) => (
        <button
          type="button"
          key={id}
          aria-label={`Pick ${id} on board`}
          onClick={() => onSelect(id)}
          onMouseEnter={() => onHighlight(id)}
          onMouseLeave={() => onHighlight(null)}
        >
          {id}
        </button>
      ))}
      {fallback}
    </div>
  ),
}));

function fixture(): Snapshot {
  const sampledAt = '2026-09-05T12:00:00Z';
  return {
    schemaVersion: 'v1',
    sequence: 1,
    sampledAt,
    host: { hostname: 'cpu-only', os: 'linux', arch: 'amd64' },
    system: systemFixture(sampledAt),
    gpus: [],
    processes: [],
    diagnostics: [],
    capabilities: {
      system: systemCapability,
      nvml: { name: 'NVML', available: false, status: 'unsupported' },
      gpm: { name: 'GPM', available: false, status: 'unsupported' },
      dcgm: { name: 'DCGM', available: false, status: 'unsupported' },
      proc: { name: '/proc', available: true, status: 'available' },
      profileMetrics: false,
    },
  };
}

function panel(
  snapshot = fixture(),
  live = true,
  selected: MotherboardCategoryId = 'cpu',
) {
  return (
    <MotherboardResources
      snapshot={snapshot}
      theme="dark"
      live={live}
      selected={selected}
      onSelect={vi.fn()}
    />
  );
}

function region(name: 'CPU' | 'RAM' | 'Storage') {
  return screen.getByRole('region', { name });
}

function fact(section: HTMLElement, label: string) {
  if (label === 'Read' || label === 'Write')
    return within(section).getByLabelText(label);
  return within(section).getByText(label, { exact: true }).closest('div')!;
}

describe('motherboard resources', () => {
  it('keeps CPU, RAM, and storage facts visible together inside one outer panel', () => {
    const { container } = render(panel());
    for (const [label, id] of [
      ['CPU', 'cpu'],
      ['RAM', 'memory'],
      ['Storage', 'storage'],
    ]) {
      expect(screen.getByRole('heading', { name: label })).toBeVisible();
      expect(
        within(region(label as 'CPU' | 'RAM' | 'Storage')).getByRole('button', {
          name: label,
        }),
      ).toHaveAttribute('id', `resource-${id}`);
    }
    expect(region('CPU')).toHaveTextContent('Fixture CPU');
    expect(fact(region('CPU'), 'Logical processors')).toHaveTextContent('16');
    expect(fact(region('CPU'), 'Architecture')).toHaveTextContent('amd64');
    expect(fact(region('CPU'), 'Utilization')).toHaveTextContent('37.0%');
    expect(fact(region('CPU'), 'Load · 1 / 5 / 15 min')).toHaveTextContent(
      '1.20 / 1.00 / 0.80',
    );
    expect(fact(region('RAM'), 'Total')).toHaveTextContent('128.0 GiB');
    expect(fact(region('RAM'), 'Used')).toHaveTextContent('52.0 GiB');
    expect(fact(region('RAM'), 'Available')).toHaveTextContent('76.0 GiB');
    expect(fact(region('RAM'), 'Memory used')).toHaveTextContent('40.6%');
    expect(fact(region('Storage'), 'Read')).toHaveTextContent('180.0 MiB/s');
    expect(fact(region('Storage'), 'Write')).toHaveTextContent('72.0 MiB/s');
    expect(container.querySelectorAll('.frost-panel')).toHaveLength(1);
    expect(
      container.querySelectorAll(
        '.motherboard-resources > [data-slot="snow-cap"]',
      ),
    ).toHaveLength(1);
    expect(
      container.querySelector(
        '.host-hardware-grid, .host-filesystem-table, .host-filesystem-cards',
      ),
    ).toBeNull();
    expect(container.textContent).not.toContain('/dev/');
  });

  it('connects controlled selection and mirrored hover to native headings without replacing them on polling', () => {
    const select = vi.fn();
    const data = fixture();
    function Harness({ snapshot }: { snapshot: Snapshot }) {
      const [selected, setSelected] = useState<MotherboardCategoryId>('cpu');
      return (
        <MotherboardResources
          snapshot={snapshot}
          theme="dark"
          live
          selected={selected}
          onSelect={(next) => {
            select(next);
            setSelected(next);
          }}
        />
      );
    }
    const view = render(<Harness snapshot={data} />);
    const ram = within(region('RAM')).getByRole('button', { name: 'RAM' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Pick memory on board' }),
    );
    expect(select).toHaveBeenLastCalledWith('memory');
    expect(ram).toHaveFocus();
    expect(ram).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('motherboard-view')).toHaveAttribute(
      'data-selected',
      'memory',
    );
    const storage = within(region('Storage')).getByRole('button', {
      name: 'Storage',
    });
    fireEvent.mouseEnter(storage);
    expect(screen.getByTestId('motherboard-view')).toHaveAttribute(
      'data-highlighted',
      'storage',
    );
    fireEvent.mouseLeave(storage);
    fireEvent.click(storage);
    expect(select).toHaveBeenLastCalledWith('storage');
    expect(storage).toHaveAttribute('aria-pressed', 'true');
    const next = structuredClone(data);
    next.sequence++;
    next.system.cpu.utilization.value = 58;
    view.rerender(<Harness snapshot={next} />);
    expect(within(region('RAM')).getByRole('button', { name: 'RAM' })).toBe(
      ram,
    );
    expect(screen.getByTestId('motherboard-view')).toHaveAttribute(
      'data-selected',
      'storage',
    );
    expect(fact(region('CPU'), 'Utilization')).toHaveTextContent('58.0%');
  });

  it('keeps independent CPU measurements visible when a load or domain field failed', () => {
    const data = fixture();
    data.system.cpu.status = 'stale';
    data.system.cpu.load1.status = 'permission_denied';
    render(panel(data));
    expect(fact(region('CPU'), 'Utilization')).toHaveTextContent('37.0%');
    const loads = fact(region('CPU'), 'Load · 1 / 5 / 15 min');
    expect(loads).toHaveTextContent('Unavailable');
    expect(loads).toHaveTextContent('1.00 / 0.80');
    expect(loads).not.toHaveTextContent('1.20');
  });

  it('retains last-snapshot readings with stale labels while stopping motherboard activity', () => {
    const data = fixture();
    const view = render(panel(data));
    const cpu = within(region('CPU')).getByRole('button', { name: 'CPU' });
    act(() => cpu.focus());
    view.rerender(panel(data, false));
    expect(cpu).toHaveFocus();
    expect(fact(region('CPU'), 'Utilization')).toHaveTextContent('37.0%Stale');
    expect(fact(region('RAM'), 'Used')).toHaveTextContent('52.0 GiB');
    expect(fact(region('RAM'), 'Memory used')).toHaveTextContent('40.6%Stale');
    expect(fact(region('Storage'), 'Read')).toHaveTextContent(
      '180.0 MiB/sStale',
    );
    expect(within(region('Storage')).getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
    );
    expect(
      JSON.parse(
        screen.getByTestId('motherboard-view').getAttribute('data-scene')!,
      ),
    ).toEqual({ kind: 'motherboard', appearance: { cpu: null, memory: null } });
  });

  it('labels estimated RAM occupancy and capacity without animating it as measured activity', () => {
    const data = fixture();
    data.system.memory.status = 'estimated';
    data.system.memory.utilization.status = 'estimated';
    render(panel(data));
    expect(region('RAM')).toHaveTextContent('Estimated');
    expect(fact(region('RAM'), 'Used')).toHaveTextContent('52.0 GiB');
    expect(fact(region('RAM'), 'Memory used')).toHaveTextContent(
      '40.6%Estimated',
    );
    expect(
      JSON.parse(
        screen.getByTestId('motherboard-view').getAttribute('data-scene')!,
      ).appearance,
    ).toEqual({ cpu: 37, memory: null });
  });

  it('distinguishes measured zero from unavailable CPU, RAM, and rate readings', () => {
    const data = fixture();
    data.system.cpu.utilization.value = 0;
    data.system.memory.usedBytes = 0;
    data.system.memory.utilization.value = 0;
    data.system.storage.readBytesPerSecond.value = 0;
    data.system.storage.writeBytesPerSecond.status = 'stale';
    render(panel(data));
    expect(fact(region('CPU'), 'Utilization')).toHaveTextContent('0.0%');
    expect(fact(region('RAM'), 'Used')).toHaveTextContent('0 B');
    expect(fact(region('RAM'), 'Memory used')).toHaveTextContent('0.0%');
    expect(fact(region('Storage'), 'Read')).toHaveTextContent('0 B/s');
    expect(fact(region('Storage'), 'Write')).toHaveTextContent('—Stale');
  });

  it('labels partial filesystem totals and keeps the fullest small mount and reserved space explicit', () => {
    const data = fixture();
    const large = data.system.storage.filesystems[0];
    data.system.storage.filesystems = [
      {
        ...large,
        id: 'small',
        mountPoint: '/',
        totalBytes: 100,
        usedBytes: 95,
        availableBytes: 2,
      },
      { ...large, id: 'large', mountPoint: '/data' },
      {
        ...large,
        id: 'missing',
        mountPoint: '/private',
        status: 'permission_denied',
        totalBytes: null,
        usedBytes: null,
        availableBytes: null,
      },
    ];
    data.system.storage.status = 'stale';
    const { container } = render(panel(data));
    expect(region('Storage')).toHaveTextContent('Partial');
    expect(region('Storage')).toHaveTextContent('Reported used / total');
    const small = container.querySelector(
      '[data-filesystem-id="small"]',
    ) as HTMLElement;
    expect(small).toHaveTextContent('95 B / 100 B');
    expect(small).toHaveTextContent('Fullest');
    expect(small).toHaveTextContent('95.0%');
    expect(small).toHaveTextContent('Available2 B');
    expect(small).toHaveTextContent('Reserved3 B');
    expect(within(small).getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '95',
    );
    const missing = container.querySelector(
      '[data-filesystem-id="missing"]',
    ) as HTMLElement;
    expect(missing).toHaveTextContent('Unavailable');
    expect(within(missing).getByRole('progressbar')).toHaveAttribute(
      'aria-valuetext',
      'Unavailable',
    );
  });

  it('keeps complete mount names and marks invalid capacity unavailable instead of measured zero', () => {
    const data = fixture();
    data.system.storage.filesystems[0].mountPoint =
      '/mnt/very-long-project-name-that-must-wrap-without-truncation';
    data.system.storage.filesystems[0].usedBytes = null;
    const { container } = render(panel(data));
    const row = container.querySelector(
      '.motherboard-filesystem',
    ) as HTMLElement;
    expect(within(row).getByRole('heading')).toHaveTextContent(
      data.system.storage.filesystems[0].mountPoint,
    );
    expect(row).toHaveTextContent('Unavailable');
    expect(row).not.toHaveTextContent('Measured');
    expect(within(row).getByRole('progressbar')).not.toHaveAttribute(
      'aria-valuenow',
    );
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('keeps unavailable storage explicit and explains the schematic only in a disclosure', () => {
    const data = fixture();
    data.system.storage.filesystems = [];
    data.system.storage.status = 'unsupported';
    const { container } = render(panel(data));
    expect(region('Storage')).toHaveTextContent('No data');
    expect(region('Storage')).toHaveTextContent(
      'No persistent local filesystem capacity is available.',
    );
    expect(within(region('Storage')).queryByRole('progressbar')).toBeNull();
    const about = screen.getByLabelText('About this motherboard illustration');
    const disclosure = about.closest('details')!;
    expect(disclosure).not.toHaveAttribute('open');
    expect(disclosure).toHaveTextContent('aggregate RAM');
    expect(disclosure).toHaveTextContent('do not describe this host');
    expect(container.querySelector('.motherboard-fallback')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });
});
