import { describe, expect, it, vi } from 'vitest';
import type { AttributedPerson } from './attribution';
import type { LoadAlignedHistory } from './overview-history';
import type { GPU, GpuInstance, Selection } from './types';
import {
  buildWorkloadTelemetryEntities,
  currentWorkloadRow,
  loadWorkloadHistory,
  workloadHistoryBatches,
  workloadHistoryDescriptors,
  workloadHistoryKeys,
  workloadRowsFromHistory,
} from './workload-history';

const sampledAt = '2026-08-30T12:00:00Z';

function topology() {
  const memory = {
    totalBytes: 100,
    usedBytes: 40,
    freeBytes: 60,
    source: 'synthetic' as const,
    scope: 'gpu_instance' as const,
    sampledAt,
    status: 'available' as const,
  };
  const gi: GpuInstance = {
    uuid: 'GI-shared',
    id: 3,
    profile: '2g.synthetic',
    generation: 'GI-shared@g1',
    memory,
    metrics: {
      sm_activity: {
        value: 50,
        unit: 'percent',
        source: 'synthetic',
        scope: 'gpu_instance',
        sampledAt,
        status: 'available',
      },
      dram_activity: {
        value: 35,
        unit: 'percent',
        source: 'synthetic',
        scope: 'gpu_instance',
        sampledAt,
        status: 'available',
      },
      pcie_rx_bytes_per_second: {
        value: 100,
        unit: 'bytes_per_second',
        source: 'synthetic',
        scope: 'gpu_instance',
        sampledAt,
        status: 'available',
      },
      pcie_tx_bytes_per_second: {
        value: 50,
        unit: 'bytes_per_second',
        source: 'synthetic',
        scope: 'gpu_instance',
        sampledAt,
        status: 'available',
      },
    },
    computeInstances: [],
  };
  const gpu: GPU = {
    uuid: 'GPU-shared',
    index: 0,
    name: 'Shared GPU',
    migEnabled: true,
    maxMigDevices: 2,
    memory: { ...memory, scope: 'physical_gpu' },
    metrics: {},
    gpuInstances: [gi],
  };
  const selections: Selection[] = [0, 1].map((id) => {
    const ci = {
      uuid: `MIG-${id}`,
      id,
      profile: '1c.synthetic',
      generation: `MIG-${id}@g1`,
      memory,
      metrics: {},
    };
    gi.computeInstances.push(ci);
    return { kind: 'compute_instance' as const, gpu, gi, ci };
  });
  return { gpu, selections };
}

function person(
  key: string,
  ownerName: string,
  selections: Selection[],
): AttributedPerson {
  return {
    key,
    platform: 'coder',
    ownerName,
    resourceCount: selections.length,
    workspaces: [
      {
        workload: {
          ref: `opaque-${key}`,
          platform: 'coder',
          kind: 'workspace',
          name: `${ownerName}-workspace`,
          ownerName,
        },
        resources: selections.map((selection) => ({
          selection,
          state: 'allocated',
        })),
      },
    ],
  };
}

describe('workload history mapping', () => {
  it('deduplicates sibling CIs to their parent GI and marks cross-owner sharing', () => {
    const { selections } = topology();
    const people = [
      person('owner-a', 'alice', selections),
      person('owner-b', 'bob', [selections[0]]),
    ];

    const entities = buildWorkloadTelemetryEntities(people, 'owner-a');
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({
      entity: 'GI-shared',
      activityMetric: 'sm_activity',
      memoryActivityMetric: 'dram_activity',
      sharedAcrossOwners: true,
      label: 'GPU 0 · GI 3 · shared',
    });
    expect(entities[0].accessibleLabel).toContain('shared parent GI');
    expect(workloadHistoryDescriptors(entities)[0].metrics).toEqual([
      'sm_activity',
      'dram_activity',
      'memory_used_bytes',
      'memory_total_bytes',
      'pcie_rx_bytes_per_second',
      'pcie_tx_bytes_per_second',
    ]);
  });

  it('excludes reserved scopes and maps physical assignments to gpu_activity', () => {
    const { gpu, selections } = topology();
    const owner = person('owner-a', 'alice', [selections[0]]);
    owner.workspaces[0].resources[0].state = 'reserved';
    owner.workspaces[0].resources.push({
      state: 'allocated',
      selection: { kind: 'physical_gpu', gpu },
    });

    expect(buildWorkloadTelemetryEntities([owner], owner.key)).toMatchObject([
      {
        entity: 'GPU-shared',
        activityMetric: 'gpu_activity',
        memoryActivityMetric: 'memory_activity',
        sharedAcrossOwners: false,
      },
    ]);
  });

  it('maps all four charts while keeping unavailable PCIe local', () => {
    const { selections } = topology();
    const entities = buildWorkloadTelemetryEntities(
      [person('owner-a', 'alice', selections)],
      'owner-a',
    );
    const keys = workloadHistoryKeys(0);
    const [row] = workloadRowsFromHistory(
      [
        {
          window: '30m',
          series: workloadHistoryDescriptors(entities),
          points: [
            {
              sampledAt,
              values: {
                assigned_0: {
                  sm_activity: 45,
                  dram_activity: 32,
                  memory_used_bytes: 25,
                  memory_total_bytes: 100,
                  pcie_rx_bytes_per_second: 120,
                },
              },
            },
          ],
        },
      ],
      entities,
    );

    expect(row).toMatchObject({
      [keys.activity]: 45,
      [keys.memory]: 25,
      [keys.memoryActivity]: 32,
      [keys.pcieTotal]: null,
    });
    expect(currentWorkloadRow(sampledAt, entities)).toMatchObject({
      [keys.activity]: 50,
      [keys.memory]: 40,
      [keys.memoryActivity]: 35,
      [keys.pcieTotal]: 150,
    });
  });

  it('batches aligned requests under both series and metric limits', async () => {
    const descriptors = Array.from({ length: 257 }, (_, index) => ({
      key: `key_${index}`,
      entity: `GPU-${index}`,
      metrics: [
        'gpu_activity',
        'memory_activity',
        'memory_used_bytes',
        'memory_total_bytes',
        'pcie_rx_bytes_per_second',
        'pcie_tx_bytes_per_second',
      ],
    }));
    expect(
      workloadHistoryBatches(descriptors).map((batch) => batch.length),
    ).toEqual([170, 87]);

    const { gpu } = topology();
    const entities = Array.from({ length: 257 }, (_, index) => ({
      key: `gpu:${index}`,
      entity: `GPU-${index}`,
      label: `GPU ${index}`,
      accessibleLabel: `GPU ${index}, assigned physical GPU telemetry`,
      activityMetric: 'gpu_activity' as const,
      memoryActivityMetric: 'memory_activity' as const,
      source: gpu,
      sharedAcrossOwners: false,
    }));
    const loadHistory = vi.fn<LoadAlignedHistory>(async (request) => ({
      window: request.window,
      series: request.series,
      points: [],
    }));
    await loadWorkloadHistory(loadHistory, entities, 30 * 60 * 1000);
    expect(loadHistory).toHaveBeenCalledTimes(2);
    expect(
      loadHistory.mock.calls.map(([request]) => request.series.length),
    ).toEqual([170, 87]);
    for (const [request] of loadHistory.mock.calls)
      expect(request.series.every(({ metrics }) => metrics.length === 6)).toBe(
        true,
      );
  });
});
