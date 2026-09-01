import { memo } from 'react';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { Boxes, ChevronDown, UserRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  assignmentSummary,
  attributionProviderLabel,
  attributedWorkloads,
  workloadLabel,
  type AttributionTarget,
} from '../attribution';
import type { Attribution, Snapshot } from '../types';
import { PerimeterLight } from './perimeter-light';

function observedLabel(observedAt: string | undefined): string | null {
  if (!observedAt) return null;
  const timestamp = new Date(observedAt);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toLocaleString();
}

export function WorkspaceBadges({
  attribution,
  targets,
  limit = 2,
  showUnassigned = false,
}: {
  attribution?: Attribution;
  targets: readonly AttributionTarget[];
  limit?: number;
  showUnassigned?: boolean;
}) {
  if (!attribution) return null;
  if (attribution.status !== 'available') return null;
  const attributed = attributedWorkloads(attribution, targets);
  if (attributed.length === 0) {
    return showUnassigned ? (
      <Badge
        variant="outline"
        className="rounded border-border font-mono text-[13px] text-muted-foreground"
      >
        Unassigned
      </Badge>
    ) : null;
  }
  const visible = attributed.slice(0, limit);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {visible.map(({ workload, state }) => (
        <Badge
          key={workload.ref}
          variant="outline"
          title={`${workload.platform} ${workload.kind} · ${state}`}
          className="max-w-52 rounded border-border bg-muted/45 font-mono text-[13px] text-foreground"
        >
          <span className="truncate">{workloadLabel(workload)}</span>
        </Badge>
      ))}
      {attributed.length > visible.length ? (
        <Badge
          variant="outline"
          className="rounded border-border font-mono text-[13px] text-muted-foreground"
        >
          +{attributed.length - visible.length}
        </Badge>
      ) : null}
    </span>
  );
}

function assignmentLabel(
  assignment: Attribution['assignments'][number],
  snapshot?: Snapshot,
): string {
  if (snapshot) {
    for (const gpu of snapshot.gpus) {
      if (
        assignment.entityType === 'physical_gpu' &&
        gpu.uuid === assignment.entityUuid
      )
        return `GPU ${gpu.index} · Full GPU`;
      if (assignment.entityType !== 'compute_instance') continue;
      for (const gi of gpu.gpuInstances) {
        const ci = gi.computeInstances.find(
          (candidate) => candidate.uuid === assignment.entityUuid,
        );
        if (ci) return `GPU ${gpu.index} · GI ${gi.id} · CI ${ci.id}`;
      }
    }
  }
  return assignment.entityType === 'physical_gpu'
    ? 'Physical GPU'
    : 'Compute instance';
}

function groupedAssignments(attribution: Attribution) {
  const assignmentsByWorkload = new Map<string, Attribution['assignments']>();
  for (const assignment of attribution.assignments) {
    const assignments = assignmentsByWorkload.get(assignment.workloadRef);
    if (assignments) assignments.push(assignment);
    else assignmentsByWorkload.set(assignment.workloadRef, [assignment]);
  }
  return attribution.workloads
    .flatMap((workload) => {
      const assignments = assignmentsByWorkload.get(workload.ref);
      return assignments?.length ? [{ workload, assignments }] : [];
    })
    .toSorted((left, right) =>
      workloadLabel(left.workload).localeCompare(workloadLabel(right.workload)),
    );
}

function AttributionSummaryComponent({
  attribution,
  snapshot,
}: {
  attribution?: Attribution;
  snapshot?: Snapshot;
}) {
  if (!attribution) {
    return (
      <div
        className="attribution-summary mt-2 inline-flex max-w-full items-center gap-2.5 rounded-md border border-border bg-muted/35 px-3 py-2 text-left text-muted-foreground"
        aria-label="Workspace attribution unavailable"
      >
        <Boxes className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-sans text-[15px] font-semibold text-foreground">
            Workspace attribution
          </span>
          <span className="mt-0.5 block truncate text-[13px]">
            Not configured
          </span>
        </span>
      </div>
    );
  }
  const summary = assignmentSummary(attribution);
  const available = attribution.status === 'available';
  const observed = observedLabel(attribution.observedAt);
  const provider = attributionProviderLabel(attribution.provider);
  const groups = groupedAssignments(attribution);
  const statusSummary = (
    <>
      <Boxes className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-sans text-[15px] font-semibold text-foreground">
          {provider}
        </span>
        <span className="mt-0.5 block truncate text-[13px] text-muted-foreground">
          {attribution.status === 'unavailable'
            ? 'Attribution unavailable'
            : `${summary.workloads} ${summary.workloads === 1 ? 'workspace' : 'workspaces'} · ${summary.resources} ${summary.resources === 1 ? 'device' : 'devices'}${attribution.status === 'stale' ? ' · stale' : ''}`}
        </span>
      </span>
    </>
  );
  const accessibleSummary = `${provider} attribution: ${summary.workloads} ${summary.workloads === 1 ? 'workspace' : 'workspaces'}, ${summary.resources} ${summary.resources === 1 ? 'device' : 'devices'}, ${attribution.status}`;
  if (attribution.status === 'unavailable' || groups.length === 0) {
    return (
      <div
        className={`attribution-summary mt-2 inline-flex max-w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left ${
          available
            ? 'border-primary/20 bg-primary/[0.055] text-primary'
            : 'border-amber-500/30 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300'
        }`}
        aria-label={accessibleSummary}
        title={observed ? `Observed ${observed}` : undefined}
      >
        {statusSummary}
      </div>
    );
  }
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        className={`attribution-summary flowing-surface group mt-2 flex max-w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          available
            ? 'border-primary/20 bg-primary/[0.055] text-primary'
            : 'border-amber-500/30 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300'
        }`}
        aria-label={accessibleSummary}
        title={observed ? `Observed ${observed}` : undefined}
      >
        <PerimeterLight />
        {statusSummary}
        <ChevronDown
          className="motion-chevron size-3.5 shrink-0 group-data-[popup-open]:rotate-180"
          aria-hidden="true"
        />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          side="bottom"
          align="start"
          sideOffset={7}
          className="z-40"
        >
          <PopoverPrimitive.Popup className="motion-popover w-[min(30rem,calc(100vw-2rem))] origin-[var(--transform-origin)] rounded-md border border-border bg-popover text-popover-foreground shadow-xl outline-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            <PopoverPrimitive.Title className="sr-only">
              Workspace assignments
            </PopoverPrimitive.Title>
            <ul className="max-h-64 divide-y divide-border/70 overflow-y-auto">
              {groups.map(({ workload, assignments }) => (
                <li key={workload.ref} className="p-3">
                  <p className="truncate text-sm font-semibold">
                    {workloadLabel(workload)}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {assignments.map((assignment) => (
                      <Badge
                        key={`${assignment.entityType}:${assignment.entityUuid}`}
                        variant="outline"
                        className="rounded border-border bg-muted/45 font-mono text-[13px] text-muted-foreground"
                        title={`Scheduler state: ${assignment.state}`}
                      >
                        {assignmentLabel(assignment, snapshot)}
                      </Badge>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export const AttributionSummary = memo(AttributionSummaryComponent);

export function AttributionDetails({
  attribution,
  targets,
}: {
  attribution?: Attribution;
  targets: readonly AttributionTarget[];
}) {
  if (!attribution || attribution.status !== 'available') return null;
  const attributed = attributedWorkloads(attribution, targets);
  const observed = observedLabel(attribution.observedAt);
  const provider = attributionProviderLabel(attribution.provider);
  return (
    <section aria-labelledby="workspace-attribution-title">
      <h3
        id="workspace-attribution-title"
        className="mb-2 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
      >
        <UserRound className="size-3.5" /> Workspace attribution
      </h3>
      <div className="border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2 font-mono text-[13px] text-muted-foreground">
          <span>
            <span className="block">{provider}</span>
            {observed ? (
              <time
                className="mt-0.5 block text-[13px]"
                dateTime={attribution.observedAt}
              >
                Observed {observed}
              </time>
            ) : null}
          </span>
          <span>scheduler assignments</span>
        </div>
        {attributed.length === 0 ? (
          <p className="p-3 text-[13px] text-muted-foreground">
            No workspace assignment reported for this resource.
          </p>
        ) : (
          <ul className="divide-y divide-border/70">
            {attributed.map(({ workload, state }) => (
              <li
                key={workload.ref}
                className="flex items-start justify-between gap-3 p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {workloadLabel(workload)}
                  </p>
                  <p className="mt-0.5 font-mono text-[13px] text-muted-foreground">
                    {workload.platform} · {workload.kind}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className="shrink-0 rounded border-border bg-muted/45 font-mono text-[13px] text-muted-foreground"
                >
                  {state}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
