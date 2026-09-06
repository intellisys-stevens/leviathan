import type { ResourceAssignment, Snapshot } from './types';

export type GPUAllocationState =
  | 'assigned'
  | 'reserved'
  | 'unassigned'
  | 'unknown';
export type GPUAllocationUnit = {
  key: string;
  entityType: ResourceAssignment['entityType'];
  entityUuid: string;
  gpuUuid: string;
  giUuid?: string;
  profile: string;
  state: GPUAllocationState;
};
export type GPUAllocationGroup = {
  entityType: ResourceAssignment['entityType'];
  profile: string;
  count: number;
};
export type GPUAllocationView = {
  status: 'available' | 'incomplete' | 'unknown';
  reason: string;
  observedAt?: string;
  units: GPUAllocationUnit[];
  assigned: number;
  reserved: number;
  unassigned: number | null;
  total: number;
  groups: GPUAllocationGroup[];
  unresolvedAssignments: number;
};

const topologyErrors = new Set([
  'gpu_handle',
  'gpu_uuid',
  'mig_mode',
  'mig_enumeration',
  'mig_handle',
  'mig_identity',
]);

const keyFor = (type: ResourceAssignment['entityType'], uuid: string) =>
  `${type}\u0000${uuid}`;

/** Existing devices without observed workspace assignments, never an admission decision. */
export function buildGPUAllocationView(
  snapshot: Snapshot,
  { stale = false }: { stale?: boolean } = {},
): GPUAllocationView {
  const attribution = snapshot.attribution;
  const provider = snapshot.capabilities.nvml;
  let conflictingTopology = false;
  const topologies = new Map<string, string>();
  for (const gpu of snapshot.gpus) {
    const signature = JSON.stringify({
      migEnabled: gpu.migEnabled,
      instances: gpu.gpuInstances
        .map((gi) => ({
          uuid: gi.uuid,
          id: gi.id,
          profile: gi.profile,
          generation: gi.generation,
          compute: (gi.computeInstances ?? [])
            .map(({ uuid, id, profile, generation }) => ({
              uuid,
              id,
              profile,
              generation,
            }))
            .sort((a, b) => a.uuid.localeCompare(b.uuid)),
        }))
        .sort((a, b) => a.uuid.localeCompare(b.uuid)),
    });
    if (topologies.has(gpu.uuid) && topologies.get(gpu.uuid) !== signature)
      conflictingTopology = true;
    topologies.set(gpu.uuid, signature);
  }
  const physical = [
    ...new Map(snapshot.gpus.map((gpu) => [gpu.uuid, gpu])).values(),
  ];
  const known = new Set<string>();
  const unitsByKey = new Map<string, GPUAllocationUnit>();
  for (const gpu of physical) {
    known.add(keyFor('physical_gpu', gpu.uuid));
    if (!gpu.migEnabled) {
      const key = keyFor('physical_gpu', gpu.uuid);
      unitsByKey.set(key, {
        key,
        entityType: 'physical_gpu',
        entityUuid: gpu.uuid,
        gpuUuid: gpu.uuid,
        profile: gpu.name,
        state: 'unknown',
      });
    }
    for (const gi of gpu.gpuInstances) {
      for (const ci of gi.computeInstances ?? []) {
        const key = keyFor('compute_instance', ci.uuid);
        known.add(key);
        const existing = unitsByKey.get(key);
        if (
          existing &&
          (existing.gpuUuid !== gpu.uuid ||
            existing.giUuid !== gi.uuid ||
            existing.profile !== (ci.profile || 'Unknown profile'))
        )
          conflictingTopology = true;
        if (gpu.migEnabled)
          unitsByKey.set(key, {
            key,
            entityType: 'compute_instance',
            entityUuid: ci.uuid,
            gpuUuid: gpu.uuid,
            giUuid: gi.uuid,
            profile: ci.profile || 'Unknown profile',
            state: 'unknown',
          });
      }
    }
  }
  const units = [...unitsByKey.values()];
  const result: GPUAllocationView = {
    status: 'unknown',
    reason: '',
    observedAt: attribution?.observedAt,
    units,
    assigned: 0,
    reserved: 0,
    unassigned: null,
    total: units.length,
    groups: [],
    unresolvedAssignments: 0,
  };
  if (stale) {
    result.reason = 'Live assignment availability is stale';
    return result;
  }
  if (!provider.available || provider.status !== 'available') {
    result.reason =
      provider.status === 'stale'
        ? 'GPU discovery is stale'
        : 'GPU discovery unavailable';
    return result;
  }
  if (!attribution) {
    result.reason = 'Workspace attribution is not configured';
    return result;
  }
  if (attribution.status !== 'available') {
    result.reason =
      attribution.status === 'stale'
        ? 'Workspace assignments are stale'
        : 'Workspace assignments unavailable';
    return result;
  }
  if (
    !attribution.observedAt ||
    !Number.isFinite(Date.parse(attribution.observedAt))
  ) {
    result.reason = 'Assignment observation time unavailable';
    return result;
  }
  const assignments = new Map<string, ResourceAssignment['state']>();
  const workloadRefs = new Set(attribution.workloads.map(({ ref }) => ref));
  const unresolved = new Set<string>();
  for (const assignment of attribution.assignments) {
    const key = keyFor(assignment.entityType, assignment.entityUuid);
    if (!known.has(key) || !workloadRefs.has(assignment.workloadRef))
      unresolved.add(key);
    if (!assignments.has(key) || assignment.state === 'allocated')
      assignments.set(key, assignment.state);
  }
  result.unresolvedAssignments =
    unresolved.size + (attribution.resolution?.unresolvedAssignments ?? 0);
  const incomplete =
    attribution.resolution?.status !== 'complete' ||
    result.unresolvedAssignments > 0 ||
    conflictingTopology ||
    snapshot.diagnostics.some(({ code }) => topologyErrors.has(code)) ||
    physical.some(
      (gpu) =>
        !gpu.migEnabled &&
        gpu.gpuInstances.some((gi) => (gi.computeInstances ?? []).length > 0),
    );
  result.status = incomplete ? 'incomplete' : 'available';
  result.reason = incomplete
    ? 'Assignment or GPU discovery is incomplete'
    : 'Observed workspace assignments';
  const groups = new Map<string, GPUAllocationGroup>();
  for (const unit of units) {
    const direct = assignments.get(unit.key);
    const parent = assignments.get(keyFor('physical_gpu', unit.gpuUuid));
    // A parent reservation also occupies its children. Never invent additional
    // full-GPU capacity on a MIG-enabled card or divide shared GI memory.
    const state =
      direct === 'allocated' || parent === 'allocated'
        ? 'assigned'
        : direct === 'reserved' || parent === 'reserved'
          ? 'reserved'
          : incomplete
            ? 'unknown'
            : 'unassigned';
    unit.state = state;
    if (state === 'assigned') result.assigned++;
    if (state === 'reserved') result.reserved++;
    if (state === 'unassigned') {
      const key = `${unit.entityType}\u0000${unit.profile}`;
      const group = groups.get(key) ?? {
        entityType: unit.entityType,
        profile: unit.profile,
        count: 0,
      };
      group.count++;
      groups.set(key, group);
    }
  }
  result.unassigned = incomplete
    ? null
    : units.length - result.assigned - result.reserved;
  result.groups = [...groups.values()].sort((a, b) => {
    if (a.entityType !== b.entityType)
      return a.entityType === 'physical_gpu' ? -1 : 1;
    return a.profile.localeCompare(b.profile);
  });
  return result;
}
