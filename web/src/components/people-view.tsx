import { memo, useMemo } from 'react';
import {
  Activity,
  Boxes,
  ChevronRight,
  Cpu,
  Gauge,
  HardDrive,
  UserRound,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  buildPeopleAttributionView,
  type AssignedResource,
} from '../attribution';
import {
  formatBytes,
  formatMetric,
  formatPercent,
  memoryPercent,
  metricValue,
} from '../lib';
import type { Selection, Snapshot } from '../types';

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

const snowCapVariants = ['left', 'right', 'split', 'center', 'corner'] as const;

function snowCapVariant(key: string): (typeof snowCapVariants)[number] {
  let hash = 2_166_136_261;
  for (const character of key) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return snowCapVariants[(hash >>> 0) % snowCapVariants.length];
}

function ResourceRow({
  resource,
  onSelect,
}: {
  resource: AssignedResource;
  onSelect: (selection: Selection) => void;
}) {
  const { selection } = resource;
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
  const hardwareName = physical ? selection.gpu.name : null;
  const parentGIScope = physical
    ? null
    : `GPU ${selection.gpu.index} GI ${selection.gi.id} parent GI`;
  const sharedCISuffix = physical
    ? ''
    : `, shared by ${countLabel(selection.gi.computeInstances.length, 'CI')}`;

  return (
    <li className="mobile-workload-resource interactive-resource group relative grid min-w-0 gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.8fr)]">
      <button
        type="button"
        className="interactive-resource-button absolute inset-0 z-10 text-left outline-none"
        aria-label={`Open ${identity} details`}
        onClick={() => onSelect(selection)}
      />
      <div className="pointer-events-none relative z-0 flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
          {physical ? (
            <Gauge className="size-3.5" aria-hidden="true" />
          ) : (
            <Cpu className="size-3.5" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[15px] font-semibold text-foreground">
            {identity}
          </span>
          {hardwareName ? (
            <span className="mt-0.5 block truncate text-[13px] text-muted-foreground">
              {hardwareName}
            </span>
          ) : null}
        </span>
        <ChevronRight
          className="resource-chevron mt-1 size-4 shrink-0 text-primary"
          aria-hidden="true"
        />
      </div>

      <div className="mobile-workload-metrics pointer-events-none relative z-0 grid min-w-0 grid-cols-2 gap-3">
        <div>
          <span className="flex items-center justify-between gap-2 text-[13px] uppercase tracking-[0.1em] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <HardDrive className="size-3" aria-hidden="true" />
              <span className="mobile-only-label">Mem</span>
              <span className="desktop-only-label">Memory</span>
            </span>
            <span className="font-mono text-foreground">
              {used == null ? '—' : formatPercent(used)}
            </span>
          </span>
          <Progress
            value={used}
            aria-label={
              physical
                ? `${identity} memory used`
                : `${parentGIScope} memory used${sharedCISuffix}`
            }
            className={`mt-1.5 h-1 ${
              used != null && used >= 85
                ? '[&_[data-slot=progress-indicator]]:bg-amber-400'
                : '[&_[data-slot=progress-indicator]]:bg-primary'
            }`}
          />
          <span className="mt-1 block truncate font-mono text-[13px] text-muted-foreground">
            {formatBytes(memory.usedBytes)} / {formatBytes(memory.totalBytes)}
          </span>
        </div>
        <div>
          <span className="flex items-center justify-between gap-2 text-[13px] uppercase tracking-[0.1em] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Activity className="size-3" aria-hidden="true" />
              <span className="mobile-only-label">
                {physical ? 'GPU' : 'SM'}
              </span>
              <span className="desktop-only-label">
                {physical ? 'GPU active' : 'SM active'}
              </span>
            </span>
            <span className="font-mono text-foreground">
              {formatMetric(activityMetric)}
            </span>
          </span>
          <Progress
            value={activity}
            aria-label={
              physical
                ? `${identity} GPU activity`
                : `${parentGIScope} SM activity${sharedCISuffix}`
            }
            className="mt-1.5 h-1"
          />
        </div>
      </div>
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
  if (!attribution) {
    return (
      <section
        className="frost-panel border border-dashed border-border bg-card p-8 text-center"
        data-testid="people-attribution-unconfigured"
        aria-labelledby="workload-attribution-unconfigured"
      >
        <UserRound
          className="mx-auto size-6 text-muted-foreground"
          aria-hidden="true"
        />
        <h3
          id="workload-attribution-unconfigured"
          className="mt-3 text-[17px] font-semibold"
        >
          Workspace attribution is not configured
        </h3>
        <p className="mx-auto mt-1 max-w-lg text-[15px] text-muted-foreground">
          This host is reporting GPU telemetry without a workspace assignment
          provider. Resources and processes remain available in their views.
        </p>
      </section>
    );
  }

  if (attribution.status !== 'available') {
    return (
      <div
        className="border border-dashed border-amber-500/30 bg-amber-500/[0.05] p-6 text-[15px] text-amber-700 dark:text-amber-300"
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
        className="border border-dashed border-border bg-card p-8 text-center text-[15px] text-muted-foreground"
        data-testid="people-attribution-empty"
      >
        No workspace GPU assignments reported.
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="people-view">
      {view.unresolvedAssignments > 0 ? (
        <p className="border border-amber-500/25 bg-amber-500/[0.05] px-3 py-2 text-[13px] text-amber-700 dark:text-amber-300">
          {countLabel(view.unresolvedAssignments, 'assignment')} could not be
          resolved against the current GPU topology.
        </p>
      ) : null}

      <div
        className="grid gap-4 min-[1400px]:grid-cols-2"
        data-testid="people-grid"
      >
        {view.people.map((person, personIndex) => {
          const headingID = `person-${personIndex}`;
          return (
            <section
              key={person.key}
              className="mobile-person-card frost-panel snow-capped min-w-0 border border-border/75 bg-card/90"
              aria-labelledby={headingID}
              data-testid="person-card"
              data-snow-cap={snowCapVariant(person.key)}
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                    <UserRound className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <h3
                      id={headingID}
                      className="truncate text-[17px] font-semibold"
                    >
                      {person.ownerName}
                    </h3>
                    <p className="font-mono text-[13px] uppercase tracking-[0.1em] text-muted-foreground">
                      {person.platform}
                    </p>
                  </div>
                </div>
                <p className="flex items-center gap-1.5 font-mono text-[13px] text-muted-foreground">
                  <Boxes className="size-3" aria-hidden="true" />
                  {countLabel(person.workspaces.length, 'workspace')} ·{' '}
                  {countLabel(person.resourceCount, 'device')}
                </p>
              </div>

              <div
                className="mobile-workspace-grid grid gap-3 p-3"
                data-testid="workspace-grid"
              >
                {person.workspaces.map((workspace) => (
                  <article
                    key={workspace.workload.ref}
                    className="mobile-workspace-card min-w-0 border border-border/70 bg-background/55"
                  >
                    <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2.5">
                      <div className="min-w-0">
                        <h4 className="truncate text-[15px] font-semibold">
                          {workspace.workload.name}
                        </h4>
                        <p className="mobile-workspace-provenance mt-0.5 font-mono text-[13px] uppercase tracking-[0.1em] text-muted-foreground">
                          Scheduler assignment
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className="shrink-0 rounded border-border bg-muted/40 font-mono text-[13px] text-muted-foreground"
                      >
                        {countLabel(workspace.resources.length, 'device')}
                      </Badge>
                    </div>
                    <ul className="mobile-workload-list divide-y divide-border/70">
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
