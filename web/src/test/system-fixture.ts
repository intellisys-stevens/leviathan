import type { Capabilities, System } from '../types';

export const systemCapability: Capabilities['system'] = {
  name: 'fixture host telemetry',
  available: true,
  status: 'available',
};

export function systemFixture(sampledAt: string): System {
  const metric = (value: number, unit: string) => ({
    value,
    unit,
    source: 'synthetic' as const,
    scope: 'host' as const,
    sampledAt,
    status: 'available' as const,
  });
  return {
    cpu: {
      model: 'Fixture CPU',
      logicalProcessors: 16,
      utilization: metric(37, 'percent'),
      load1: metric(1.2, 'load'),
      load5: metric(1, 'load'),
      load15: metric(0.8, 'load'),
      source: 'synthetic',
      sampledAt,
      status: 'available',
    },
    memory: {
      totalBytes: 128 * 1024 ** 3,
      usedBytes: 52 * 1024 ** 3,
      availableBytes: 76 * 1024 ** 3,
      utilization: metric((52 / 128) * 100, 'percent'),
      source: 'synthetic',
      scope: 'host',
      sampledAt,
      status: 'available',
    },
    storage: {
      totalBytes: 1024 ** 4,
      usedBytes: 420 * 1024 ** 3,
      availableBytes: 604 * 1024 ** 3,
      readBytesPerSecond: metric(180 * 1024 ** 2, 'bytes_per_second'),
      writeBytesPerSecond: metric(72 * 1024 ** 2, 'bytes_per_second'),
      filesystems: [
        {
          id: 'fs_fixture_root',
          mountPoint: '/',
          fsType: 'ext4',
          totalBytes: 1024 ** 4,
          usedBytes: 420 * 1024 ** 3,
          availableBytes: 604 * 1024 ** 3,
          source: 'synthetic',
          scope: 'host',
          sampledAt,
          status: 'available',
        },
      ],
      source: 'synthetic',
      scope: 'host',
      sampledAt,
      status: 'available',
    },
    sampledAt,
    status: 'available',
  };
}
