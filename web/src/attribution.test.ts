import { describe, expect, it } from 'vitest';
import {
  assignmentSummary,
  attributionProviderLabel,
  attributedWorkloads,
  buildPeopleAttributionView,
  workloadLabel,
} from './attribution';
import type { Attribution, Snapshot } from './types';

const attribution: Attribution = {
  provider: 'coder-kubernetes',
  status: 'available',
  workloads: [
    {
      ref: 'opaque-a',
      platform: 'coder',
      kind: 'workspace',
      name: 'training',
      ownerName: 'alice',
    },
    {
      ref: 'opaque-b',
      platform: 'coder',
      kind: 'workspace',
      name: 'inference',
      ownerName: 'bob',
    },
  ],
  assignments: [
    {
      workloadRef: 'opaque-a',
      entityType: 'compute_instance',
      entityUuid: 'MIG-a',
      state: 'reserved',
    },
    {
      workloadRef: 'opaque-a',
      entityType: 'compute_instance',
      entityUuid: 'MIG-a',
      state: 'allocated',
    },
    {
      workloadRef: 'opaque-b',
      entityType: 'physical_gpu',
      entityUuid: 'GPU-b',
      state: 'allocated',
    },
  ],
};

describe('workspace attribution joins', () => {
  it('presents the Kubernetes DRA provider naturally', () => {
    expect(attributionProviderLabel('kubernetes_dra')).toBe('Kubernetes DRA');
    expect(attributionProviderLabel('custom-provider')).toBe('custom-provider');
  });

  it('joins by opaque ref, deduplicates, and gives allocated precedence', () => {
    expect(
      attributedWorkloads(attribution, [
        { entityType: 'compute_instance', entityUuid: 'MIG-a' },
      ]),
    ).toEqual([
      {
        workload: attribution.workloads[0],
        state: 'allocated',
      },
    ]);
    expect(workloadLabel(attribution.workloads[0])).toBe('alice / training');
  });

  it('summarizes unique workloads and resource assignments', () => {
    expect(assignmentSummary(attribution)).toEqual({
      workloads: 2,
      resources: 2,
    });
  });

  it('groups people and workspaces while resolving exact scheduler devices', () => {
    const memory = {
      totalBytes: 100,
      usedBytes: 40,
      freeBytes: 60,
      source: 'synthetic' as const,
      scope: 'physical_gpu' as const,
      sampledAt: '2026-08-30T12:00:00Z',
      status: 'available' as const,
    };
    const snapshot = {
      schemaVersion: 'v1',
      sequence: 1,
      sampledAt: memory.sampledAt,
      host: { hostname: 'synthetic', os: 'linux', arch: 'amd64' },
      capabilities: {
        nvml: { name: 'NVML', available: true, status: 'available' },
        gpm: { name: 'GPM', available: true, status: 'available' },
        dcgm: { name: 'DCGM', available: false, status: 'unsupported' },
        proc: { name: '/proc', available: true, status: 'available' },
        profileMetrics: true,
      },
      diagnostics: [],
      processes: [],
      gpus: [
        {
          uuid: 'GPU-synthetic',
          index: 0,
          name: 'Synthetic GPU',
          migEnabled: true,
          maxMigDevices: 1,
          memory,
          metrics: {},
          gpuInstances: [
            {
              uuid: 'GI-synthetic',
              id: 1,
              profile: '1g.synthetic',
              generation: 'GI-synthetic@g1',
              memory: { ...memory, scope: 'gpu_instance' },
              metrics: {},
              computeInstances: [
                {
                  uuid: 'MIG-synthetic',
                  id: 2,
                  profile: '1c.synthetic',
                  generation: 'MIG-synthetic@g1',
                  memory: { ...memory, scope: 'gpu_instance' },
                  metrics: {},
                },
              ],
            },
          ],
        },
      ],
      attribution: {
        provider: 'kubernetes_dra',
        status: 'available',
        workloads: [
          {
            ref: 'opaque-zeta',
            platform: 'coder',
            kind: 'workspace',
            name: 'zeta',
            ownerName: 'alice',
          },
          {
            ref: 'opaque-alpha',
            platform: 'coder',
            kind: 'workspace',
            name: 'alpha',
            ownerName: 'alice',
          },
        ],
        assignments: [
          {
            workloadRef: 'opaque-zeta',
            entityType: 'compute_instance',
            entityUuid: 'MIG-synthetic',
            state: 'reserved',
          },
          {
            workloadRef: 'opaque-zeta',
            entityType: 'compute_instance',
            entityUuid: 'MIG-synthetic',
            state: 'allocated',
          },
          {
            workloadRef: 'opaque-alpha',
            entityType: 'physical_gpu',
            entityUuid: 'GPU-synthetic',
            state: 'allocated',
          },
          {
            workloadRef: 'opaque-alpha',
            entityType: 'physical_gpu',
            entityUuid: 'GPU-missing',
            state: 'allocated',
          },
        ],
      },
    } satisfies Snapshot;

    const view = buildPeopleAttributionView(snapshot);
    expect(view.unresolvedAssignments).toBe(1);
    expect(view.people).toHaveLength(1);
    expect(view.people[0].ownerName).toBe('alice');
    expect(
      view.people[0].workspaces.map((workspace) => workspace.workload.name),
    ).toEqual(['alpha', 'zeta']);
    expect(view.people[0].resourceCount).toBe(2);
    expect(view.people[0].workspaces[1].resources[0]).toMatchObject({
      state: 'allocated',
      selection: { kind: 'compute_instance' },
    });
  });
});
