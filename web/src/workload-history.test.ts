import { describe, expect, it, vi } from 'vitest';
import type { AttributedPerson } from './attribution';
import type { LoadAlignedHistory } from './overview-history';
import type { GPU, GpuInstance, Selection } from './types';
import {
  buildWorkloadTelemetryEntities,
  loadWorkloadHistory,
  workloadHistoryBatches,
  workloadHistoryDescriptors,
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
      sharedAcrossOwners: true,
      label: 'GPU 0 · GI 3 · shared',
    });
    expect(entities[0].accessibleLabel).toContain('shared parent GI');
    expect(workloadHistoryDescriptors(entities)[0].metrics).toEqual([
      'sm_activity',
      'memory_used_bytes',
      'memory_total_bytes',
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
        sharedAcrossOwners: false,
      },
    ]);
  });

  it('batches aligned requests at 256 descriptors with three metrics each', async () => {
    const descriptors = Array.from({ length: 257 }, (_, index) => ({
      key: `key_${index}`,
      entity: `GPU-${index}`,
      metrics: ['gpu_activity', 'memory_used_bytes', 'memory_total_bytes'],
    }));
    expect(
      workloadHistoryBatches(descriptors).map((batch) => batch.length),
    ).toEqual([256, 1]);

    const { gpu } = topology();
    const entities = Array.from({ length: 257 }, (_, index) => ({
      key: `gpu:${index}`,
      entity: `GPU-${index}`,
      label: `GPU ${index}`,
      accessibleLabel: `GPU ${index}, assigned physical GPU telemetry`,
      activityMetric: 'gpu_activity' as const,
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
    ).toEqual([256, 1]);
    for (const [request] of loadHistory.mock.calls)
      expect(request.series.every(({ metrics }) => metrics.length === 3)).toBe(
        true,
      );
  });
});
