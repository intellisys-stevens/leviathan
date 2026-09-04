import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../types';
import { systemCapability, systemFixture } from '../test/system-fixture';
import { FilesystemTable, SystemOverview } from './system-overview';

const sampledAt = '2026-09-02T12:00:00Z';

function snapshot(): Snapshot {
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
      proc: { name: '/proc', available: false, status: 'unsupported' },
      profileMetrics: false,
    },
  };
}

describe('whole-machine telemetry', () => {
  it('renders CPU, RAM, and storage without a GPU', () => {
    render(
      <SystemOverview snapshot={snapshot()} chartWindowMs={30 * 60_000} />,
    );
    expect(screen.getByRole('heading', { name: 'CPU' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'RAM' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Storage' }),
    ).toBeInTheDocument();
    expect(screen.getByText('37.0%')).toBeInTheDocument();
  });

  it('renders only sanitized filesystem identity and capacity', () => {
    render(<FilesystemTable snapshot={snapshot()} />);
    expect(screen.getByText('/')).toBeInTheDocument();
    expect(screen.getByText('ext4')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('/dev/');
  });
});
