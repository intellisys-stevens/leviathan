import { lazy, memo, Suspense, useEffect, useMemo } from 'react';
import { Boxes, ChevronRight, Cpu, Gauge, UserRound } from 'lucide-react';
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
import type { LoadAlignedHistory } from '../overview-history';
import type { Selection, Snapshot } from '../types';
import { buildWorkloadTelemetryEntities } from '../workload-history';
import { MetricIcon } from './metric-icon';
import { PerimeterLight } from './perimeter-light';

const WorkloadTelemetryChart = lazy(() => import('./workload-telemetry-chart'));

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
    <li className="mobile-workload-resource interactive-resource flowing-surface group relative grid min-w-0 gap-3 rounded-lg px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.8fr)]">
      <PerimeterLight />
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
              <MetricIcon metric="memory" className="size-3" />
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
              <MetricIcon
                metric={physical ? 'gpu_activity' : 'sm_activity'}
                className="size-3"
              />
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

export type PeopleViewProps = {
  snapshot: Snapshot;
  onSelect: (selection: Selection) => void;
  selectedPersonKey: string | null;
  onSelectedPersonChange: (personKey: string) => void;
  loadHistory: LoadAlignedHistory;
  chartWindowMs: number;
  retentionMs: number;
  onChartWindowChange: (milliseconds: number) => void;
};

function PeopleViewComponent({
  snapshot,
  onSelect,
  selectedPersonKey,
  onSelectedPersonChange,
  loadHistory,
  chartWindowMs,
  retentionMs,
  onChartWindowChange,
}: PeopleViewProps) {
  const attribution = snapshot.attribution;
  const view = useMemo(() => buildPeopleAttributionView(snapshot), [snapshot]);
  const selectedPersonIndex = view.people.findIndex(
    ({ key }) => key === selectedPersonKey,
  );
  const effectivePersonIndex =
    selectedPersonIndex >= 0
      ? selectedPersonIndex
      : view.people.length
        ? 0
        : -1;
  const selectedPerson =
    effectivePersonIndex >= 0 ? view.people[effectivePersonIndex] : null;
  const telemetryEntities = useMemo(
    () =>
      selectedPerson
        ? buildWorkloadTelemetryEntities(view.people, selectedPerson.key)
        : [],
    [selectedPerson, view.people],
  );

  useEffect(() => {
    if (!selectedPerson || selectedPerson.key === selectedPersonKey) return;
    onSelectedPersonChange(selectedPerson.key);
  }, [onSelectedPersonChange, selectedPerson, selectedPersonKey]);

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

  if (!selectedPerson) return null;
  const selectAndFocusPerson = (index: number) => {
    const person = view.people[index];
    if (!person) return;
    onSelectedPersonChange(person.key);
    document.getElementById(`workload-owner-tab-${index}`)?.focus();
  };

  return (
    <div className="space-y-4" data-testid="people-view">
      {view.unresolvedAssignments > 0 ? (
        <p className="border border-amber-500/25 bg-amber-500/[0.05] px-3 py-2 text-[13px] text-amber-700 dark:text-amber-300">
          {countLabel(view.unresolvedAssignments, 'assignment')} could not be
          resolved against the current GPU topology.
        </p>
      ) : null}

      <div
        className="workloads-master-detail grid min-w-0 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]"
        data-testid="people-grid"
      >
        <aside className="workload-owner-picker min-w-0" aria-label="Users">
          <label className="sr-only" htmlFor="workload-owner-select">
            Select user
          </label>
          <select
            id="workload-owner-select"
            className="workload-owner-select h-11 w-full rounded-lg border border-input bg-card px-3 text-[15px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
            value={String(effectivePersonIndex)}
            onChange={(event) => {
              const person = view.people[Number(event.currentTarget.value)];
              if (person) onSelectedPersonChange(person.key);
            }}
          >
            {view.people.map((person, index) => (
              <option key={person.key} value={index}>
                {person.ownerName}
              </option>
            ))}
          </select>

          <div
            className="workload-owner-tabs hidden flex-col gap-1 lg:flex"
            role="tablist"
            aria-label="Users"
            aria-orientation="vertical"
          >
            {view.people.map((person, index) => {
              const selected = index === effectivePersonIndex;
              return (
                <button
                  key={person.key}
                  id={`workload-owner-tab-${index}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls="workload-owner-panel"
                  tabIndex={selected ? 0 : -1}
                  className={`workload-owner-tab flowing-surface rounded-lg border px-3 py-3 text-left outline-none transition-[color,background-color,border-color] duration-[var(--duration-feedback)] focus-visible:ring-2 focus-visible:ring-ring ${
                    selected
                      ? 'border-primary/35 bg-primary/10 text-foreground'
                      : 'border-transparent text-muted-foreground hover:border-border hover:bg-card/70 hover:text-foreground'
                  }`}
                  onClick={() => onSelectedPersonChange(person.key)}
                  onKeyDown={(event) => {
                    let nextIndex: number | null = null;
                    if (event.key === 'ArrowDown')
                      nextIndex = (index + 1) % view.people.length;
                    else if (event.key === 'ArrowUp')
                      nextIndex =
                        (index - 1 + view.people.length) % view.people.length;
                    else if (event.key === 'Home') nextIndex = 0;
                    else if (event.key === 'End')
                      nextIndex = view.people.length - 1;
                    if (nextIndex == null) return;
                    event.preventDefault();
                    selectAndFocusPerson(nextIndex);
                  }}
                >
                  <PerimeterLight />
                  <span className="block truncate text-[15px] font-semibold">
                    {person.ownerName}
                  </span>
                  <span className="mt-0.5 block font-mono text-[13px]">
                    {countLabel(person.workspaces.length, 'workspace')} ·{' '}
                    {countLabel(person.resourceCount, 'device')}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <section
          id="workload-owner-panel"
          role="tabpanel"
          aria-labelledby="workload-owner-heading"
          className="workload-person-detail mobile-person-card frost-panel snow-capped min-w-0 border border-border/75 bg-card/90"
          data-testid="person-card"
          data-snow-cap={snowCapVariant(selectedPerson.key)}
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                <UserRound className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h3
                  id="workload-owner-heading"
                  className="truncate text-[17px] font-semibold"
                >
                  {selectedPerson.ownerName}
                </h3>
                <p className="font-mono text-[13px] uppercase tracking-[0.1em] text-muted-foreground">
                  {selectedPerson.platform}
                </p>
              </div>
            </div>
            <p className="flex items-center gap-1.5 font-mono text-[13px] text-muted-foreground">
              <Boxes className="size-3" aria-hidden="true" />
              {countLabel(selectedPerson.workspaces.length, 'workspace')} ·{' '}
              {countLabel(selectedPerson.resourceCount, 'device')}
            </p>
          </div>

          <div className="p-3 pb-0">
            <Suspense
              fallback={
                <div
                  className="workload-telemetry grid h-48 place-items-center border border-dashed border-border/80 bg-background/45 text-[13px] text-muted-foreground"
                  aria-label="Loading assigned telemetry"
                >
                  Preparing assigned telemetry…
                </div>
              }
            >
              <WorkloadTelemetryChart
                ownerKey={selectedPerson.key}
                ownerName={selectedPerson.ownerName}
                sampledAt={snapshot.sampledAt}
                entities={telemetryEntities}
                loadHistory={loadHistory}
                chartWindowMs={chartWindowMs}
                retentionMs={retentionMs}
                onChartWindowChange={onChartWindowChange}
              />
            </Suspense>
          </div>

          <div
            className="mobile-workspace-grid grid gap-3 p-3"
            data-testid="workspace-grid"
          >
            {selectedPerson.workspaces.map((workspace) => (
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
      </div>
    </div>
  );
}

export const PeopleView = memo(PeopleViewComponent);
