import { describe, expect, it, vi } from 'vitest';
import { buildTrendRows } from './chart-trend';
import type { AttributedPerson } from './attribution';
import type { LoadAlignedHistory } from './overview-history';
import type { GPU, GpuInstance, Selection } from './types';
import {
  buildWorkloadTelemetryEntities,
  currentWorkloadRow,
  loadWorkloadHistory,
  mergeWorkloadRows,
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

  it('distinguishes other history batches from an absent descriptor in its own response', () => {
    const { selections } = topology();
    const [entity] = buildWorkloadTelemetryEntities(
      [person('owner-a', 'alice', selections)],
      'owner-a',
    );
    const entities = [entity, { ...entity, key: 'other', entity: 'GI-other' }];
    const descriptors = workloadHistoryDescriptors(entities);
    const rows = workloadRowsFromHistory(
      descriptors.map((descriptor, index) => ({
        window: '5m',
        series: [descriptor],
        points: [0, 2, 4].map((second) => ({
          sampledAt: new Date(
            Date.parse(sampledAt) + second * 1000 + index * 500,
          ).toISOString(),
          values:
            index === 0 && second === 2
              ? {}
              : { [descriptor.key]: { sm_activity: 40 + second } },
        })),
      })),
      entities,
    );
    const keys = entities.map(
      (_, index) => workloadHistoryKeys(index).activity,
    );
    expect(rows[0][keys[1]]).toBeUndefined();
    expect(rows[2][keys[0]]).toBeNull();
    const trend = buildTrendRows(rows, keys, 5 * 60_000);
    expect(trend.map((row) => row[keys[0]])).toEqual([40, null, 44]);
    expect(trend.map((row) => row[keys[1]])).toEqual([40, 42, 44]);
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

  it('does not append unchanged GPU measurements at host or cgroup publication times', () => {
    const { selections } = topology();
    const entities = buildWorkloadTelemetryEntities(
      [person('owner-a', 'alice', selections)],
      'owner-a',
    );
    const first = currentWorkloadRow(sampledAt, entities)!;
    let rows = [first];
    for (const seconds of [1, 2, 3, 10, 20]) {
      const publication = new Date(
        Date.parse(sampledAt) + seconds * 1000,
      ).toISOString();
      const retained = currentWorkloadRow(publication, entities)!;
      expect(retained.time).toBe(Date.parse(sampledAt));
      const previous = rows;
      rows = mergeWorkloadRows(rows, retained, 30 * 60000);
      expect(rows).toBe(previous);
    }
    expect(rows).toEqual([first]);
  });

  it('keeps corrected values, unavailable samples and retention changes observable', () => {
    const initial = [
      { time: 1000, activity: 0 },
      { time: 2000, activity: 25 },
    ];
    expect(mergeWorkloadRows(initial, { time: 2000, activity: 25 }, 2000)).toBe(
      initial,
    );
    const corrected = mergeWorkloadRows(
      initial,
      { time: 2000, activity: 50 },
      2000,
    );
    expect(corrected).not.toBe(initial);
    expect(corrected.at(-1)?.activity).toBe(50);
    const unavailable = mergeWorkloadRows(
      corrected,
      { time: 2000, activity: null },
      2000,
    );
    expect(unavailable.at(-1)?.activity).toBeNull();
    const pruned = mergeWorkloadRows(
      initial,
      { time: 2000, activity: 25 },
      500,
    );
    expect(pruned).toEqual([{ time: 2000, activity: 25 }]);
    expect(initial).toHaveLength(2);
  });

  it('aligns independently observed entities without inventing a gap for an unchanged GPU', () => {
    const { selections } = topology();
    const [first] = buildWorkloadTelemetryEntities(
      [person('owner-a', 'alice', selections)],
      'owner-a',
    );
    const second = structuredClone(first);
    second.key = 'gi:another';
    second.entity = 'GI-another';
    const observed = '2026-08-30T12:00:02Z';
    second.source.memory.sampledAt = observed;
    second.source.memory.usedBytes = 0;
    for (const metric of Object.values(second.source.metrics))
      metric.sampledAt = observed;
    second.source.metrics.sm_activity.value = 0;
    const entities = [first, second];
    const current = currentWorkloadRow('2026-08-30T12:00:20Z', entities)!;
    expect(current.time).toBe(Date.parse(observed));
    expect(current).toMatchObject({
      [workloadHistoryKeys(0).activity]: 50,
      [workloadHistoryKeys(0).memory]: 40,
      [workloadHistoryKeys(1).activity]: 0,
      [workloadHistoryKeys(1).memory]: 0,
    });
    const laterHost = currentWorkloadRow('2026-08-30T12:00:22Z', entities)!;
    expect(mergeWorkloadRows([current], laterHost, 30 * 60000)).toEqual([
      current,
    ]);
  });

  it('adds an all-unavailable observation at publication time without replacing the last good GPU sample', () => {
    const { selections } = topology();
    const entities = buildWorkloadTelemetryEntities(
      [person('owner-a', 'alice', selections)],
      'owner-a',
    );
    const first = currentWorkloadRow(sampledAt, entities)!;
    const source = entities[0].source;
    source.memory.status = 'stale';
    for (const metric of Object.values(source.metrics)) metric.status = 'stale';
    const gapTime = '2026-08-30T12:00:20Z';
    const gap = currentWorkloadRow(gapTime, entities)!;
    expect(gap.time).toBe(Date.parse(gapTime));
    for (const key of Object.values(workloadHistoryKeys(0)).filter(
      (key) => key !== 'assigned_0',
    ))
      expect(gap[key]).toBeNull();
    const rows = mergeWorkloadRows([first], gap, 5 * 60000);
    expect(rows[0]).toEqual(first);
    source.memory.status = 'available';
    source.memory.sampledAt = '2026-08-30T12:00:21Z';
    for (const metric of Object.values(source.metrics)) {
      metric.status = 'available';
      metric.sampledAt = source.memory.sampledAt;
    }
    const recovered = currentWorkloadRow('2026-08-30T12:00:25Z', entities)!;
    const complete = mergeWorkloadRows(rows, recovered, 5 * 60000);
    expect(complete.map((row) => row[workloadHistoryKeys(0).activity])).toEqual(
      [50, null, 50],
    );
    expect(complete.map((row) => row.time)).toEqual(
      [sampledAt, gapTime, source.memory.sampledAt].map(Date.parse),
    );
  });

  it('preserves per-metric unavailability and does not add transfer rates sampled at different times', () => {
    const { selections } = topology();
    const entities = buildWorkloadTelemetryEntities(
      [person('owner-a', 'alice', selections)],
      'owner-a',
    );
    const source = entities[0].source;
    const observed = '2026-08-30T12:00:02Z';
    source.memory.sampledAt = observed;
    source.metrics.sm_activity.sampledAt = observed;
    source.metrics.dram_activity.status = 'unsupported';
    source.metrics.pcie_tx_bytes_per_second.sampledAt = observed;
    const row = currentWorkloadRow('2026-08-30T12:00:20Z', entities)!;
    expect(row.time).toBe(Date.parse(observed));
    expect(row[workloadHistoryKeys(0).activity]).toBe(50);
    expect(row[workloadHistoryKeys(0).memoryActivity]).toBeNull();
    expect(row[workloadHistoryKeys(0).pcieTotal]).toBeNull();
  });

  it('uses only parent GI telemetry and rejects values without valid provenance', () => {
    const { selections } = topology();
    const selection = selections[0];
    if (selection.kind !== 'compute_instance')
      throw new Error('expected a compute instance');
    selection.ci.metrics.sm_activity = {
      ...selection.gi.metrics.sm_activity,
      scope: 'compute_instance',
      value: 99,
    };
    const entities = buildWorkloadTelemetryEntities(
      [person('owner-a', 'alice', selections)],
      'owner-a',
    );
    expect(
      currentWorkloadRow(sampledAt, entities)?.[
        workloadHistoryKeys(0).activity
      ],
    ).toBe(50);
    entities[0].source.memory.sampledAt = 'invalid';
    for (const metric of Object.values(entities[0].source.metrics))
      metric.sampledAt = 'invalid';
    const unavailable = currentWorkloadRow('2026-08-30T12:00:10Z', entities)!;
    expect(unavailable.time).toBe(Date.parse('2026-08-30T12:00:10Z'));
    expect(unavailable[workloadHistoryKeys(0).activity]).toBeNull();
    expect(unavailable[workloadHistoryKeys(0).memory]).toBeNull();
  });

  it('does not reinsert old GPU points outside the currently retained window', () => {
    const key = workloadHistoryKeys(0).activity;
    const existing = [
      { time: 10000, [key]: 1 },
      { time: 60000, [key]: 2 },
    ];
    expect(mergeWorkloadRows(existing, { time: 0, [key]: 3 }, 30000)).toEqual([
      { time: 60000, [key]: 2 },
    ]);
  });
});
