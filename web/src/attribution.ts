import type {
  Attribution,
  GPU,
  ResourceAssignment,
  Selection,
  Snapshot,
  WorkloadAttribution,
} from './types';

export type AttributionTarget = Pick<
  ResourceAssignment,
  'entityType' | 'entityUuid'
>;

export type AttributedWorkload = {
  workload: WorkloadAttribution;
  state: ResourceAssignment['state'];
};

export type AssignedResource = {
  state: ResourceAssignment['state'];
  selection: Selection;
};

export type AttributedWorkspace = {
  workload: WorkloadAttribution;
  resources: AssignedResource[];
};

export type AttributedPerson = {
  key: string;
  platform: WorkloadAttribution['platform'];
  ownerName: string;
  workspaces: AttributedWorkspace[];
  resourceCount: number;
};

export type PeopleAttributionView = {
  people: AttributedPerson[];
  unresolvedAssignments: number;
};

export function attributionProviderLabel(provider: string): string {
  return provider === 'kubernetes_dra' ? 'Kubernetes DRA' : provider;
}

export function workloadLabel(workload: WorkloadAttribution): string {
  return `${workload.ownerName} / ${workload.name}`;
}

export function attributedWorkloads(
  attribution: Attribution | undefined,
  targets: readonly AttributionTarget[],
): AttributedWorkload[] {
  if (!attribution || targets.length === 0) return [];
  const targetKeys = new Set(
    targets.map(
      ({ entityType, entityUuid }) => `${entityType}\u0000${entityUuid}`,
    ),
  );
  const workloadsByRef = new Map(
    attribution.workloads.map((workload) => [workload.ref, workload]),
  );
  const byRef = new Map<string, AttributedWorkload>();
  for (const assignment of attribution.assignments) {
    if (
      !targetKeys.has(`${assignment.entityType}\u0000${assignment.entityUuid}`)
    )
      continue;
    const workload = workloadsByRef.get(assignment.workloadRef);
    if (!workload) continue;
    const existing = byRef.get(workload.ref);
    if (!existing || assignment.state === 'allocated')
      byRef.set(workload.ref, { workload, state: assignment.state });
  }
  return [...byRef.values()].sort((left, right) => {
    if (left.state !== right.state) return left.state === 'allocated' ? -1 : 1;
    return workloadLabel(left.workload).localeCompare(
      workloadLabel(right.workload),
    );
  });
}

export function gpuAttributionTargets(gpu: GPU): AttributionTarget[] {
  const targets: AttributionTarget[] = [
    { entityType: 'physical_gpu', entityUuid: gpu.uuid },
  ];
  for (const instance of gpu.gpuInstances) {
    for (const computeInstance of instance.computeInstances) {
      targets.push({
        entityType: 'compute_instance',
        entityUuid: computeInstance.uuid,
      });
    }
  }
  return targets;
}

export function assignmentSummary(attribution: Attribution): {
  workloads: number;
  resources: number;
} {
  return {
    workloads: new Set(
      attribution.assignments.map((assignment) => assignment.workloadRef),
    ).size,
    resources: new Set(
      attribution.assignments.map(
        (assignment) =>
          `${assignment.entityType}\u0000${assignment.entityUuid}`,
      ),
    ).size,
  };
}

function selectionSortKey(selection: Selection): string {
  if (selection.kind === 'physical_gpu')
    return `${String(selection.gpu.index).padStart(8, '0')}\u0000`;
  return `${String(selection.gpu.index).padStart(8, '0')}\u0001${String(selection.gi.id).padStart(8, '0')}\u0000${String(selection.ci.id).padStart(8, '0')}`;
}

// Build the owner-first view from the sanitized scheduler assignments. The
// opaque workspace reference is used only as a join key and is never rendered.
export function buildPeopleAttributionView(
  snapshot: Snapshot,
): PeopleAttributionView {
  const attribution = snapshot.attribution;
  if (!attribution) return { people: [], unresolvedAssignments: 0 };

  const workloads = new Map(
    attribution.workloads.map((workload) => [workload.ref, workload]),
  );
  const physical = new Map<string, Selection>();
  const compute = new Map<string, Selection>();
  for (const gpu of snapshot.gpus) {
    physical.set(gpu.uuid, { kind: 'physical_gpu', gpu });
    for (const gi of gpu.gpuInstances) {
      for (const ci of gi.computeInstances) {
        compute.set(ci.uuid, { kind: 'compute_instance', gpu, gi, ci });
      }
    }
  }

  const deduplicated = new Map<string, ResourceAssignment>();
  for (const assignment of attribution.assignments) {
    const key = `${assignment.workloadRef}\u0000${assignment.entityType}\u0000${assignment.entityUuid}`;
    const current = deduplicated.get(key);
    if (!current || assignment.state === 'allocated')
      deduplicated.set(key, assignment);
  }

  const resourcesByWorkload = new Map<string, AssignedResource[]>();
  let unresolvedAssignments = 0;
  for (const assignment of deduplicated.values()) {
    if (!workloads.has(assignment.workloadRef)) {
      unresolvedAssignments += 1;
      continue;
    }
    const selection =
      assignment.entityType === 'physical_gpu'
        ? physical.get(assignment.entityUuid)
        : compute.get(assignment.entityUuid);
    if (!selection) {
      unresolvedAssignments += 1;
      continue;
    }
    const resources = resourcesByWorkload.get(assignment.workloadRef);
    const resource = { selection, state: assignment.state };
    if (resources) resources.push(resource);
    else resourcesByWorkload.set(assignment.workloadRef, [resource]);
  }

  const people = new Map<
    string,
    Omit<AttributedPerson, 'workspaces' | 'resourceCount'> & {
      workspaces: AttributedWorkspace[];
    }
  >();
  for (const [workloadRef, resources] of resourcesByWorkload) {
    const workload = workloads.get(workloadRef);
    if (!workload) continue;
    resources.sort((left, right) =>
      selectionSortKey(left.selection).localeCompare(
        selectionSortKey(right.selection),
      ),
    );
    const personKey = `${workload.platform}\u0000${workload.ownerName}`;
    const person = people.get(personKey) ?? {
      key: personKey,
      platform: workload.platform,
      ownerName: workload.ownerName,
      workspaces: [],
    };
    person.workspaces.push({ workload, resources });
    people.set(personKey, person);
  }

  return {
    people: [...people.values()]
      .map((person) => {
        person.workspaces.sort((left, right) => {
          const byName = left.workload.name.localeCompare(right.workload.name);
          return byName || left.workload.ref.localeCompare(right.workload.ref);
        });
        return {
          ...person,
          resourceCount: person.workspaces.reduce(
            (count, workspace) => count + workspace.resources.length,
            0,
          ),
        };
      })
      .sort((left, right) => {
        const byOwner = left.ownerName.localeCompare(right.ownerName);
        return byOwner || left.platform.localeCompare(right.platform);
      }),
    unresolvedAssignments,
  };
}
