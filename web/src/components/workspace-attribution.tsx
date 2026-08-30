import { memo } from 'react';
import { Boxes, UserRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  assignmentSummary,
  attributionProviderLabel,
  attributedWorkloads,
  workloadLabel,
  type AttributionTarget,
} from '../attribution';
import { shortUUID } from '../lib';
import type { Attribution } from '../types';

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
        className="rounded border-border font-mono text-[9px] text-muted-foreground"
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
          className="max-w-52 rounded border-border bg-muted/45 font-mono text-[9px] text-foreground"
        >
          <span className="truncate">{workloadLabel(workload)}</span>
        </Badge>
      ))}
      {attributed.length > visible.length ? (
        <Badge
          variant="outline"
          className="rounded border-border font-mono text-[9px] text-muted-foreground"
        >
          +{attributed.length - visible.length}
        </Badge>
      ) : null}
    </span>
  );
}

function assignmentLabel(
  assignment: Attribution['assignments'][number],
): string {
  return assignment.entityType === 'physical_gpu'
    ? `GPU ${shortUUID(assignment.entityUuid)}`
    : `MIG ${shortUUID(assignment.entityUuid)}`;
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
}: {
  attribution?: Attribution;
}) {
  if (!attribution) return null;
  const summary = assignmentSummary(attribution);
  const available = attribution.status === 'available';
  const observed = observedLabel(attribution.observedAt);
  const provider = attributionProviderLabel(attribution.provider);
  const groups = groupedAssignments(attribution);
  const statusSummary = (
    <>
      <Boxes className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{provider}</span>
      <span aria-hidden="true">·</span>
      {attribution.status === 'unavailable' ? (
        <span>unavailable</span>
      ) : (
        <>
          <span>
            {summary.workloads}{' '}
            {summary.workloads === 1 ? 'workspace' : 'workspaces'}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {summary.resources} {summary.resources === 1 ? 'device' : 'devices'}
          </span>
          {attribution.status === 'stale' ? (
            <>
              <span aria-hidden="true">·</span>
              <span>stale</span>
            </>
          ) : null}
        </>
      )}
    </>
  );
  if (attribution.status === 'unavailable' || groups.length === 0) {
    return (
      <div
        className={`mt-2 inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px] ${
          available
            ? 'border-primary/20 bg-primary/[0.055] text-primary'
            : 'border-amber-500/30 bg-amber-500/[0.06] text-amber-600 dark:text-amber-300'
        }`}
        aria-label="Workspace attribution summary"
        title={observed ? `Observed ${observed}` : undefined}
      >
        {statusSummary}
      </div>
    );
  }
  return (
    <details
      className={`group relative mt-2 w-fit max-w-full rounded-md border font-mono text-[10px] ${
        available
          ? 'border-primary/20 bg-primary/[0.055] text-primary'
          : 'border-amber-500/30 bg-amber-500/[0.06] text-amber-600 dark:text-amber-300'
      }`}
    >
      <summary
        className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
        aria-label="Workspace attribution summary"
        title={observed ? `Observed ${observed}` : undefined}
      >
        {statusSummary}
      </summary>
      <div className="absolute left-0 top-[calc(100%+0.4rem)] z-20 w-[min(30rem,calc(100vw-2rem))] rounded-md border border-border bg-popover text-popover-foreground shadow-xl">
        <p className="border-b border-border/70 px-3 py-2 text-[9px] text-muted-foreground">
          Scheduler assignments; these do not imply active GPU use.
        </p>
        <ul className="max-h-64 divide-y divide-border/70 overflow-y-auto">
          {groups.map(({ workload, assignments }) => (
            <li key={workload.ref} className="p-3">
              <p className="truncate text-xs font-semibold">
                {workloadLabel(workload)}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {assignments.map((assignment) => (
                  <Badge
                    key={`${assignment.entityType}:${assignment.entityUuid}`}
                    variant="outline"
                    className="rounded border-border bg-muted/45 font-mono text-[9px] text-muted-foreground"
                    title={`Scheduler state: ${assignment.state}`}
                  >
                    {assignmentLabel(assignment)}
                  </Badge>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </details>
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
        className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
      >
        <UserRound className="size-3.5" /> Workspace attribution
      </h3>
      <div className="border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2 font-mono text-[9px] text-muted-foreground">
          <span>
            <span className="block">{provider}</span>
            {observed ? (
              <time
                className="mt-0.5 block text-[8px]"
                dateTime={attribution.observedAt}
              >
                Observed {observed}
              </time>
            ) : null}
          </span>
          <span>scheduler assignments</span>
        </div>
        {attributed.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
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
                  <p className="mt-0.5 font-mono text-[9px] text-muted-foreground">
                    {workload.platform} · {workload.kind}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className="shrink-0 rounded border-border bg-muted/45 font-mono text-[9px] text-muted-foreground"
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
