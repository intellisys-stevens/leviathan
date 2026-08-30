import { memo, useMemo } from 'react';
import { Boxes, Cpu, Gauge, HardDrive, UserRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  buildPeopleAttributionView,
  type AssignedResource,
} from '../attribution';
import { formatBytes, formatMetric, memoryPercent, metricValue } from '../lib';
import type { Selection, Snapshot } from '../types';

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function ResourceRow({
  resource,
  onSelect,
}: {
  resource: AssignedResource;
  onSelect: (selection: Selection) => void;
}) {
  const { selection, state } = resource;
  const physical = selection.kind === 'physical_gpu';
  const memory = physical ? selection.gpu.memory : selection.gi.memory;
  const activityMetric = physical
    ? selection.gpu.metrics.gpu_activity
    : selection.gi.metrics.sm_activity;
  const activity = metricValue(activityMetric);
  const used = memoryPercent(memory);
  const identity = physical
    ? `GPU ${selection.gpu.index} · Full GPU`
    : `GPU ${selection.gpu.index} · GI ${selection.gi.id} · CI ${selection.ci.id}`;
  const profile = physical
    ? selection.gpu.name
    : `${selection.gi.profile} · ${selection.ci.profile}`;
  const metricScope = physical
    ? 'Physical GPU metrics'
    : selection.gi.computeInstances.length > 1
      ? `Parent GI metrics · shared by ${selection.gi.computeInstances.length} CIs`
      : 'Parent GI metrics';

  return (
    <li>
      <button
        type="button"
        className="group grid w-full gap-3 px-3 py-3 text-left outline-none transition-colors hover:bg-accent/55 focus-visible:bg-accent/55 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.8fr)]"
        aria-label={`Open ${identity} details`}
        onClick={() => onSelect(selection)}
      >
        <span className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            {physical ? (
              <Gauge className="size-3.5" aria-hidden="true" />
            ) : (
              <Cpu className="size-3.5" aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-mono text-xs font-semibold text-foreground">
              {identity}
            </span>
            <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
              {profile}
            </span>
            <span className="mt-1 block font-mono text-[8px] uppercase tracking-[0.1em] text-muted-foreground">
              {metricScope}
            </span>
          </span>
        </span>

        <span className="grid min-w-0 grid-cols-2 gap-3">
          <span>
            <span className="flex items-center justify-between gap-2 text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <HardDrive className="size-3" aria-hidden="true" /> Memory
              </span>
              <span className="font-mono text-foreground">
                {used == null ? '—' : `${used.toFixed(1)}%`}
              </span>
            </span>
            <Progress
              value={used ?? 0}
              aria-label="Memory used"
              className={`mt-1.5 h-1 ${
                used != null && used >= 85
                  ? '[&_[data-slot=progress-indicator]]:bg-amber-400'
                  : '[&_[data-slot=progress-indicator]]:bg-cyan-400'
              }`}
            />
            <span className="mt-1 block truncate font-mono text-[8px] text-muted-foreground">
              {formatBytes(memory.usedBytes)} / {formatBytes(memory.totalBytes)}
            </span>
          </span>
          <span>
            <span className="flex items-center justify-between gap-2 text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
              <span>{physical ? 'GPU active' : 'SM active'}</span>
              <span className="font-mono text-foreground">
                {formatMetric(activityMetric)}
              </span>
            </span>
            <Progress value={activity ?? 0} className="mt-1.5 h-1" />
            <Badge
              variant="outline"
              className="mt-1.5 rounded border-border bg-muted/40 font-mono text-[8px] text-muted-foreground"
              title={`Scheduler assignment state: ${state}`}
            >
              {state}
            </Badge>
          </span>
        </span>
      </button>
    </li>
  );
}

function PeopleViewComponent({
  snapshot,
  onSelect,
}: {
  snapshot: Snapshot;
  onSelect: (selection: Selection) => void;
}) {
  const attribution = snapshot.attribution;
  const view = useMemo(() => buildPeopleAttributionView(snapshot), [snapshot]);
  if (!attribution) return null;

  if (attribution.status !== 'available') {
    return (
      <div
        className="border border-dashed border-amber-500/30 bg-amber-500/[0.05] p-6 text-sm text-amber-600 dark:text-amber-300"
        data-testid="people-attribution-state"
      >
        Workspace assignments are {attribution.status}. Host GPU telemetry
        remains available below.
      </div>
    );
  }

  if (view.people.length === 0) {
    return (
      <div
        className="border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground"
        data-testid="people-attribution-empty"
      >
        No workspace GPU assignments reported.
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="people-view">
      {view.unresolvedAssignments > 0 ? (
        <p className="border border-amber-500/25 bg-amber-500/[0.05] px-3 py-2 text-xs text-amber-600 dark:text-amber-300">
          {countLabel(view.unresolvedAssignments, 'assignment')} could not be
          resolved against the current GPU topology.
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2" data-testid="people-grid">
        {view.people.map((person, personIndex) => {
          const headingID = `person-${personIndex}`;
          return (
            <section
              key={person.key}
              className="min-w-0 border border-border/75 bg-card/75"
              aria-labelledby={headingID}
              data-testid="person-card"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                    <UserRound className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <h3
                      id={headingID}
                      className="truncate text-sm font-semibold"
                    >
                      {person.ownerName}
                    </h3>
                    <p className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
                      {person.platform}
                    </p>
                  </div>
                </div>
                <p className="flex items-center gap-1.5 font-mono text-[9px] text-muted-foreground">
                  <Boxes className="size-3" aria-hidden="true" />
                  {countLabel(person.workspaces.length, 'workspace')} ·{' '}
                  {countLabel(person.resourceCount, 'device')}
                </p>
              </div>

              <div className="grid gap-3 p-3" data-testid="workspace-grid">
                {person.workspaces.map((workspace) => (
                  <article
                    key={workspace.workload.ref}
                    className="min-w-0 border border-border/70 bg-background/55"
                  >
                    <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2.5">
                      <div className="min-w-0">
                        <h4 className="truncate text-xs font-semibold">
                          {workspace.workload.name}
                        </h4>
                        <p className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.1em] text-muted-foreground">
                          Scheduler assignment
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className="shrink-0 rounded border-border bg-muted/40 font-mono text-[8px] text-muted-foreground"
                      >
                        {countLabel(workspace.resources.length, 'device')}
                      </Badge>
                    </div>
                    <ul className="divide-y divide-border/70">
                      {workspace.resources.map((resource) => (
                        <ResourceRow
                          key={`${resource.selection.kind}:${
                            resource.selection.kind === 'physical_gpu'
                              ? resource.selection.gpu.uuid
                              : resource.selection.ci.uuid
                          }`}
                          resource={resource}
                          onSelect={onSelect}
                        />
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export const PeopleView = memo(PeopleViewComponent);
