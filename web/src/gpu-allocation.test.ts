import { describe, expect, it } from 'vitest';
import type { GPU, ResourceAssignment, Snapshot } from './types';
import { systemCapability, systemFixture } from './test/system-fixture';
import { buildGPUAllocationView } from './gpu-allocation';

const sampledAt = '2026-09-05T05:00:00Z';
function gpu(uuid: string, mig = false): GPU {
  const memory = {
    totalBytes: 80 * 1024 ** 3,
    usedBytes: 0,
    freeBytes: 80 * 1024 ** 3,
    source: 'nvml' as const,
    scope: 'physical_gpu' as const,
    sampledAt,
    status: 'available' as const,
  };
  return {
    uuid,
    index: 0,
    name: 'NVIDIA test GPU',
    migEnabled: mig,
    maxMigDevices: 7,
    memory,
    metrics: {},
    gpuInstances: mig
      ? [
          {
            uuid: `${uuid}/gi/1`,
            id: 1,
            profile: '2g.20gb',
            generation: 'gi-generation',
            memory: {
              ...memory,
              scope: 'gpu_instance',
              totalBytes: 20 * 1024 ** 3,
            },
            metrics: {},
            computeInstances: [0, 1].map((id) => ({
              uuid: `MIG-${uuid}-${id}`,
              id,
              profile: '1c.2g.20gb',
              generation: `ci-${id}`,
              memory: {
                ...memory,
                scope: 'gpu_instance',
                status: 'unsupported',
                totalBytes: null,
              },
              metrics: {},
            })),
          },
        ]
      : [],
  };
}
function snapshot(): Snapshot {
  return {
    schemaVersion: 'v1',
    sequence: 1,
    sampledAt,
    host: { hostname: 'test', os: 'linux', arch: 'amd64' },
    system: systemFixture(sampledAt),
    gpus: [gpu('GPU-full'), gpu('GPU-mig', true)],
    processes: [],
    diagnostics: [],
    capabilities: {
      system: systemCapability,
      nvml: { name: 'NVML', available: true, status: 'available' },
      gpm: { name: 'GPM', available: false, status: 'unsupported' },
      dcgm: { name: 'DCGM', available: false, status: 'unsupported' },
      proc: { name: '/proc', available: false, status: 'unsupported' },
      profileMetrics: false,
    },
    attribution: {
      provider: 'kubernetes_dra',
      resolution: {
        status: 'complete',
        unresolvedAssignments: 0,
        reasonCodes: [],
        workloads: [],
      },
      status: 'available',
      observedAt: sampledAt,
      workloads: [
        {
          ref: 'workspace-one',
          platform: 'coder',
          kind: 'workspace',
          ownerName: 'owner',
          name: 'one',
        },
      ],
      assignments: [],
    },
  };
}
function assign(
  data: Snapshot,
  entityType: ResourceAssignment['entityType'],
  entityUuid: string,
  state: ResourceAssignment['state'] = 'allocated',
) {
  data.attribution!.assignments.push({
    workloadRef: 'workspace-one',
    entityType,
    entityUuid,
    state,
  });
}

describe('observed GPU assignment capacity', () => {
  it('counts full GPUs and existing CIs, without inventing max-MIG slots or multiplying shared GI memory', () => {
    const view = buildGPUAllocationView(snapshot());
    expect(view).toMatchObject({
      status: 'available',
      total: 3,
      unassigned: 3,
      assigned: 0,
      reserved: 0,
    });
    expect(view.groups).toEqual([
      { entityType: 'physical_gpu', profile: 'NVIDIA test GPU', count: 1 },
      { entityType: 'compute_instance', profile: '1c.2g.20gb', count: 2 },
    ]);
    expect(
      view.units
        .filter(({ entityType }) => entityType === 'compute_instance')
        .map(({ giUuid }) => giUuid),
    ).toEqual(['GPU-mig/gi/1', 'GPU-mig/gi/1']);
    expect(view).not.toHaveProperty('memory');
  });
  it('deduplicates topology and assignments, with allocated taking precedence over reserved', () => {
    const data = snapshot();
    data.gpus.push(data.gpus[0]);
    assign(data, 'physical_gpu', 'GPU-full', 'reserved');
    assign(data, 'physical_gpu', 'GPU-full');
    assign(data, 'physical_gpu', 'GPU-full', 'reserved');
    assign(data, 'compute_instance', 'MIG-GPU-mig-0', 'reserved');
    expect(buildGPUAllocationView(data)).toMatchObject({
      total: 3,
      assigned: 1,
      reserved: 1,
      unassigned: 1,
    });
  });
  it('lets parent reservations block children without counting an extra full GPU', () => {
    const data = snapshot();
    assign(data, 'physical_gpu', 'GPU-mig', 'reserved');
    assign(data, 'compute_instance', 'MIG-GPU-mig-0');
    expect(buildGPUAllocationView(data)).toMatchObject({
      total: 3,
      assigned: 1,
      reserved: 1,
      unassigned: 1,
    });
  });
  it('makes unresolved assignments incomplete instead of silently increasing unassigned capacity', () => {
    const data = snapshot();
    assign(data, 'compute_instance', 'MIG-not-discovered');
    assign(data, 'physical_gpu', 'GPU-full');
    const view = buildGPUAllocationView(data);
    expect(view).toMatchObject({
      status: 'incomplete',
      assigned: 1,
      unassigned: null,
      unresolvedAssignments: 1,
      groups: [],
    });
    expect(
      view.units.filter(({ state }) => state === 'unassigned'),
    ).toHaveLength(0);
  });
  it('treats a missing workload identity as unresolved but keeps its device occupied', () => {
    const data = snapshot();
    assign(data, 'physical_gpu', 'GPU-full');
    data.attribution!.workloads = [];
    expect(buildGPUAllocationView(data)).toMatchObject({
      status: 'incomplete',
      assigned: 1,
      unassigned: null,
      unresolvedAssignments: 1,
    });
  });
  it.each(['stale', 'unavailable'] as const)(
    'withholds %s attribution, including retained assignments',
    (status) => {
      const data = snapshot();
      assign(data, 'physical_gpu', 'GPU-full');
      data.attribution!.status = status;
      expect(buildGPUAllocationView(data)).toMatchObject({
        status: 'unknown',
        assigned: 0,
        unassigned: null,
        groups: [],
      });
    },
  );
  it('withholds counts without attribution, observation time, fresh connection, or GPU collection', () => {
    const data = snapshot();
    expect(buildGPUAllocationView(data, { stale: true })).toMatchObject({
      status: 'unknown',
      unassigned: null,
    });
    data.attribution!.observedAt = undefined;
    expect(buildGPUAllocationView(data)).toMatchObject({
      status: 'unknown',
      unassigned: null,
    });
    data.attribution = undefined;
    expect(buildGPUAllocationView(data)).toMatchObject({
      status: 'unknown',
      unassigned: null,
    });
    for (const status of ['stale', 'unsupported', 'error'] as const) {
      const fresh = snapshot();
      fresh.capabilities.nvml = { name: 'NVML', available: false, status };
      expect(buildGPUAllocationView(fresh)).toMatchObject({
        status: 'unknown',
        unassigned: null,
      });
    }
  });
  it('withholds inferred free units on topology failures but does not depend on VRAM metrics', () => {
    const data = snapshot();
    data.gpus[0].memory.status = 'error';
    expect(buildGPUAllocationView(data).unassigned).toBe(3);
    data.diagnostics.push({
      code: 'mig_enumeration',
      component: 'nvml',
      severity: 'error',
      status: 'error',
      summary: 'Enumeration failed',
    });
    expect(buildGPUAllocationView(data)).toMatchObject({
      status: 'incomplete',
      unassigned: null,
    });
  });
  it('counts no units on an empty MIG board and never treats its max devices as spare slots', () => {
    const data = snapshot();
    data.gpus = [gpu('GPU-empty', true)];
    data.gpus[0].gpuInstances = [];
    expect(buildGPUAllocationView(data)).toMatchObject({
      status: 'available',
      total: 0,
      unassigned: 0,
    });
  });
  it('recomputes on topology replacement without retaining unassigned instances from old generations', () => {
    const data = snapshot();
    const previous = buildGPUAllocationView(data);
    data.gpus = [gpu('GPU-replacement')];
    const next = buildGPUAllocationView(data);
    expect(previous.units).toHaveLength(3);
    expect(next.units.map(({ entityUuid }) => entityUuid)).toEqual([
      'GPU-replacement',
    ]);
  });
  it('withholds counts for conflicting duplicate topology while accepting opaque identity and unknown profiles', () => {
    const data = snapshot();
    data.gpus[1].gpuInstances[0].computeInstances[0].uuid =
      'opaque-compute-device';
    data.gpus[1].gpuInstances[0].computeInstances[0].profile = '';
    expect(buildGPUAllocationView(data).groups).toContainEqual({
      entityType: 'compute_instance',
      profile: 'Unknown profile',
      count: 1,
    });
    data.gpus.push({ ...data.gpus[0], migEnabled: true });
    expect(buildGPUAllocationView(data)).toMatchObject({
      status: 'incomplete',
      unassigned: null,
    });
  });
});

it('keeps verified assignments while bridge resolution is incomplete, then resolves dynamic MIG capacity', () => {
  const data = snapshot();
  data.gpus.push(gpu('GPU-free-a'), gpu('GPU-free-b'));
  assign(data, 'physical_gpu', 'GPU-full');
  data.attribution!.resolution = {
    status: 'incomplete',
    unresolvedAssignments: 2,
    reasonCodes: ['preparation_pending'],
    workloads: [
      {
        workloadRef: 'workspace-one',
        unresolvedAssignments: 2,
        reasonCodes: ['preparation_pending'],
      },
    ],
  };
  let view = buildGPUAllocationView(data);
  expect(view).toMatchObject({
    status: 'incomplete',
    assigned: 1,
    unassigned: null,
    total: 5,
    unresolvedAssignments: 2,
  });
  expect(view.units.filter((unit) => unit.state === 'unknown')).toHaveLength(4);
  assign(data, 'compute_instance', 'MIG-GPU-mig-0');
  assign(data, 'compute_instance', 'MIG-GPU-mig-1');
  data.attribution!.resolution = {
    status: 'complete',
    unresolvedAssignments: 0,
    reasonCodes: [],
    workloads: [],
  };
  view = buildGPUAllocationView(data);
  expect(view).toMatchObject({
    status: 'available',
    assigned: 3,
    unassigned: 2,
    total: 5,
  });
  data.attribution!.status = 'stale';
  expect(buildGPUAllocationView(data)).toMatchObject({
    status: 'unknown',
    unassigned: null,
  });
});

it('cannot infer unassigned resources from a legacy handoff without completeness evidence', () => {
  const data = snapshot();
  delete data.attribution!.resolution;
  assign(data, 'physical_gpu', 'GPU-full');
  expect(buildGPUAllocationView(data)).toMatchObject({
    status: 'incomplete',
    assigned: 1,
    unassigned: null,
  });
});
