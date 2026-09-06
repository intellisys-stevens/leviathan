import type { WorkloadOwnerTelemetry } from '../types';

export function ownerFixture(
  ref = 'owner-test',
  name = 'test-owner',
  sampledAt = '2026-09-05T12:00:00Z',
): WorkloadOwnerTelemetry {
  return {
    ref,
    name,
    platform: 'coder',
    sampledAt,
    status: 'available',
    workspaces: [
      {
        ref: `workspace-${ref}`,
        name: 'CPU workspace',
        ownerName: name,
        platform: 'coder',
        kind: 'workspace',
      },
    ],
    metrics: Object.fromEntries(
      [
        ['cpu_cores', 1.5, 'cores'],
        ['memory_used_bytes', 2 ** 30, 'bytes'],
        ['storage_read_bps', 0, 'B/s'],
        ['storage_write_bps', 1024, 'B/s'],
      ].map(([key, value, unit]) => [
        key,
        {
          value: value as number,
          unit: unit as string,
          source: 'cgroupfs' as const,
          scope: 'workload_owner' as const,
          status: 'available' as const,
          sampledAt,
        },
      ]),
    ),
  };
}
