import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Boxes,
  ChevronRight,
  Database,
  Gauge,
  Server,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { readBrowserSetting, writeBrowserSetting } from '../browser-storage';
import { GPUCard } from '../components/gpu-card';
import type { Attribution, Selection, SelectionKey } from '../types';
import {
  InstanceTable,
  observationSourceLabel,
  telemetryLabel,
  telemetryState,
} from './instance-table';
import {
  gpuConnectedUsersLabel,
  hasCurrentCompleteProcessCoverage,
  processCountLabel,
  processInspectionState,
  processInspectionSummary,
} from './process-inspection';
import type { InstanceObservation, PlatformObservation } from './types';
import {
  hostUsageUnavailableLabel,
  staticCapacityLabel,
} from './instance-capacity';

const DetailSheet = lazy(() => import('../components/detail-sheet'));
const dashboardViewKey = 'leviathan.jetstreamDashboardView.v1';
type DashboardView = 'gpus' | 'people';

type JetstreamSelectionKey = {
  instanceUUID: string;
  entity: SelectionKey;
};

type JetstreamSelection = {
  selection: Selection;
  attribution?: Attribution;
};

function selectedJetstreamEntity(
  instances: InstanceObservation[],
  key: JetstreamSelectionKey | null,
): JetstreamSelection | null {
  if (!key) return null;
  const snapshot = instances.find(
    ({ instance }) => instance.uuid === key.instanceUUID,
  )?.agent.snapshot;
  if (!snapshot) return null;
  if (key.entity.kind === 'physical_gpu') {
    const gpu = snapshot.gpus.find(
      (candidate) => candidate.uuid === key.entity.uuid,
    );
    return gpu
      ? {
          selection: { kind: 'physical_gpu', gpu },
          attribution: snapshot.attribution,
        }
      : null;
  }
  for (const gpu of snapshot.gpus) {
    for (const gi of gpu.gpuInstances) {
      const ci = gi.computeInstances.find(
        (candidate) => candidate.uuid === key.entity.uuid,
      );
      if (ci) {
        return {
          selection: { kind: 'compute_instance', gpu, gi, ci },
          attribution: snapshot.attribution,
        };
      }
    }
  }
  return null;
}

const cloudLabels: Record<string, string> = {
  active: 'Running',
  shelved: 'Shelved',
  shelved_offloaded: 'Shelved offloaded',
  shutoff: 'Shut off',
  building: 'Building',
  paused: 'Paused',
  suspended: 'Suspended',
  error: 'Error',
  unknown: 'Unknown',
};

function storedDashboardView(): DashboardView {
  return readBrowserSetting(dashboardViewKey) === 'people' ? 'people' : 'gpus';
}

function statusClasses(status: string): string {
  if (status === 'available' || status === 'active')
    return 'border-primary/30 bg-primary/10 text-primary';
  if (status === 'degraded' || status === 'stale')
    return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  if (
    status === 'error' ||
    status === 'unreachable' ||
    status === 'incompatible'
  )
    return 'border-destructive/30 bg-destructive/10 text-destructive';
  return 'border-border bg-muted/45 text-muted-foreground';
}

function StatusChip({ status, label }: { status: string; label: string }) {
  return (
    <span
      className={`inline-flex h-5 items-center rounded-full border px-2 font-mono text-[9px] font-medium ${statusClasses(status)}`}
    >
      {label}
    </span>
  );
}

function snapshotInstances(instances: InstanceObservation[]) {
  return instances.filter(
    ({ instance, agent }) =>
      instance.cloudState === 'active' && agent.snapshot != null,
  );
}

function currentMonitoredInstances(instances: InstanceObservation[]) {
  return snapshotInstances(instances).filter(
    ({ agent }) => agent.status === 'available',
  );
}

function hasCurrentGPUCoverage(observation: InstanceObservation): boolean {
  const snapshot = observation.agent.snapshot;
  return Boolean(
    observation.agent.status === 'available' &&
    observation.agent.source !== 'exosphere_console' &&
    snapshot?.capabilities.nvml.available &&
    snapshot.capabilities.nvml.status === 'available',
  );
}

function gpuCount(observations: InstanceObservation[]): number {
  return observations.reduce(
    (total, { agent }) => total + (agent.snapshot?.gpus.length ?? 0),
    0,
  );
}

function currentKnownProcessCount(observations: InstanceObservation[]): number {
  return observations.reduce((total, observation) => {
    if (processInspectionState(observation) === 'unavailable') return total;
    return (
      total +
      (observation.agent.snapshot?.processes.filter(
        ({ status }) => status !== 'stale',
      ).length ?? 0)
    );
  }, 0);
}

function incompleteAggregateValue(count: number): string {
  return count > 0 ? `≥${count}` : 'Unknown';
}

function snapshotHealthMessages(observation: InstanceObservation): string[] {
  const snapshot = observation.agent.snapshot;
  if (!snapshot) return [];
  const messages: string[] = [];
  if (observation.agent.status !== 'available') {
    messages.push(
      'Showing the last retained telemetry snapshot; current usage may have changed.',
    );
  }
  const processSummary = processInspectionSummary(observation);
  const activeDiagnostics = snapshot.diagnostics.filter(
    ({ severity }) => severity !== 'info',
  );
  for (const diagnostic of activeDiagnostics.slice(0, 3)) {
    const summary = diagnostic.summary.replace(/[.\s]+$/u, '');
    messages.push(
      diagnostic.summary === processSummary
        ? `${summary}. GPU process usage may be incomplete.`
        : `${summary}.`,
    );
  }
  if (
    processSummary &&
    !activeDiagnostics.some(({ summary }) => summary === processSummary)
  ) {
    messages.push(
      `${processSummary.replace(/[.\s]+$/u, '')}. GPU process usage may be incomplete.`,
    );
  }
  if (activeDiagnostics.length > 3) {
    messages.push(
      `${activeDiagnostics.length - 3} more telemetry diagnostic${activeDiagnostics.length - 3 === 1 ? '' : 's'} reported.`,
    );
  }
  return [...new Set(messages)];
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: number | string;
}) {
  return (
    <div className="min-w-[125px] bg-card px-4 py-2.5 text-center">
      <p className="flex items-center justify-center gap-1.5 font-mono text-base font-semibold text-primary">
        <Icon className="size-3.5" aria-hidden="true" /> {value}
      </p>
      <p className="text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </p>
    </div>
  );
}

function InstanceIdentity({
  observation,
  compact = false,
}: {
  observation: InstanceObservation;
  compact?: boolean;
}) {
  const { instance, agent } = observation;
  const users = gpuConnectedUsersLabel(observation);
  const telemetry = telemetryState(observation);
  const capacity = staticCapacityLabel(instance);
  return (
    <div
      className={`flex min-w-0 flex-wrap items-center justify-between gap-3 ${compact ? '' : 'border border-border/75 bg-card/75 px-4 py-3'}`}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
          <Server className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{instance.name}</p>
          <p className="truncate font-mono text-[9px] text-muted-foreground">
            {instance.creatorUsername || 'Unknown creator'}
            {instance.flavor ? ` · ${instance.flavor}` : ''}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <StatusChip
          status={instance.cloudState}
          label={cloudLabels[instance.cloudState] ?? 'Unknown'}
        />
        <StatusChip
          status={agent.status}
          label={observationSourceLabel(agent)}
        />
        {agent.snapshot ? (
          <StatusChip
            status={telemetry}
            label={`Telemetry ${telemetryLabel(telemetry)}`}
          />
        ) : null}
        {agent.snapshot ? (
          <Badge
            variant="outline"
            className="rounded border-border bg-muted/35 font-mono text-[9px] text-muted-foreground"
          >
            {agent.snapshot.gpus.length} GPU · {processCountLabel(observation)}
          </Badge>
        ) : null}
      </div>
      {!compact ? (
        <p className="w-full text-[10px] text-muted-foreground">
          GPU-connected users:{' '}
          <span className="font-mono text-foreground">{users}</span>
        </p>
      ) : null}
      <p
        className="w-full font-mono text-[9px] text-muted-foreground"
        data-testid="jetstream-static-capacity"
      >
        Static capacity: {capacity ?? 'Unavailable'} ·{' '}
        {hostUsageUnavailableLabel}
      </p>
    </div>
  );
}

function SnapshotHealthNotice({
  observation,
}: {
  observation: InstanceObservation;
}) {
  const messages = snapshotHealthMessages(observation);
  if (messages.length === 0) return null;
  return (
    <div className="flex items-start gap-2 border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[10px] text-amber-700 dark:text-amber-300">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <div className="space-y-0.5">
        {messages.map((message) => (
          <p key={message}>{message}</p>
        ))}
      </div>
    </div>
  );
}

function JetstreamGPUView({
  instances,
  onSelect,
}: {
  instances: InstanceObservation[];
  onSelect: (instanceUUID: string, selection: Selection) => void;
}) {
  const observed = snapshotInstances(instances);
  const withoutSnapshot = instances.filter(
    ({ instance, agent }) =>
      instance.cloudState === 'active' && agent.snapshot == null,
  );

  return (
    <div className="space-y-5" data-testid="jetstream-gpu-view">
      {observed.length === 0 ? (
        <div className="border border-dashed border-border bg-card p-10 text-center">
          <p className="text-sm font-medium">No Jetstream GPU snapshots</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Running instances without a current snapshot stay visible below.
          </p>
        </div>
      ) : (
        observed.map((observation) => (
          <section
            key={observation.instance.uuid}
            className="space-y-3"
            aria-label={`${observation.instance.name} GPU resources`}
            data-testid="jetstream-instance-gpus"
          >
            <InstanceIdentity observation={observation} />
            <SnapshotHealthNotice observation={observation} />
            {observation.agent.snapshot!.gpus.length === 0 ? (
              <div className="border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
                No NVIDIA GPUs reported by this instance.
              </div>
            ) : (
              observation.agent.snapshot!.gpus.map((gpu) => (
                <div key={gpu.uuid} className="space-y-2">
                  {gpu.migEnabled ? (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 border border-primary/25 bg-primary/[0.06] px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-primary transition-colors hover:border-primary/45 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`Open GPU ${gpu.index} physical GPU details`}
                        onClick={() =>
                          onSelect(observation.instance.uuid, {
                            kind: 'physical_gpu',
                            gpu,
                          })
                        }
                      >
                        Physical GPU details
                        <ChevronRight className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                  <GPUCard
                    gpu={gpu}
                    attribution={observation.agent.snapshot!.attribution}
                    onSelect={(selection) =>
                      onSelect(observation.instance.uuid, selection)
                    }
                  />
                </div>
              ))
            )}
          </section>
        ))
      )}

      {withoutSnapshot.length > 0 ? (
        <section
          className="border border-dashed border-border bg-card/55 p-4"
          aria-labelledby="without-telemetry-heading"
        >
          <h3 id="without-telemetry-heading" className="text-sm font-medium">
            Running instances without a current snapshot
          </h3>
          <p className="mt-1 text-[10px] text-muted-foreground">
            This includes inventory-only instances that policy deliberately does
            not probe.
          </p>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {withoutSnapshot.map((observation) => (
              <div
                key={observation.instance.uuid}
                className="border border-border/70 bg-background/55 p-3"
              >
                <InstanceIdentity observation={observation} compact />
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

type OwnerGroup = {
  owner: string;
  instances: InstanceObservation[];
};

function groupByOwner(instances: InstanceObservation[]): OwnerGroup[] {
  const groups = new Map<string, InstanceObservation[]>();
  for (const observation of instances) {
    const owner = observation.instance.creatorUsername?.trim() || 'Unknown';
    const group = groups.get(owner);
    if (group) group.push(observation);
    else groups.set(owner, [observation]);
  }
  return [...groups.entries()]
    .map(([owner, observations]) => ({
      owner,
      instances: observations.sort((left, right) => {
        const leftRunning = left.instance.cloudState === 'active' ? 0 : 1;
        const rightRunning = right.instance.cloudState === 'active' ? 0 : 1;
        return (
          leftRunning - rightRunning ||
          left.instance.name.localeCompare(right.instance.name)
        );
      }),
    }))
    .sort((left, right) => {
      const leftLive =
        currentMonitoredInstances(left.instances).length > 0 ? 0 : 1;
      const rightLive =
        currentMonitoredInstances(right.instances).length > 0 ? 0 : 1;
      return leftLive - rightLive || left.owner.localeCompare(right.owner);
    });
}

function JetstreamPeopleView({
  instances,
}: {
  instances: InstanceObservation[];
}) {
  const groups = useMemo(() => groupByOwner(instances), [instances]);
  if (groups.length === 0) {
    return (
      <div className="border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
        No running Jetstream instances reported.
      </div>
    );
  }
  return (
    <div
      className="grid items-start gap-4 xl:grid-cols-2"
      data-testid="jetstream-people-view"
    >
      {groups.map((group, index) => {
        const headingID = `jetstream-owner-${index}`;
        const groupGPUs = gpuCount(group.instances);
        return (
          <section
            key={group.owner}
            className="min-w-0 border border-border/75 bg-card/75"
            aria-labelledby={headingID}
            data-testid="jetstream-person-card"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                  <UserRound className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h3 id={headingID} className="truncate text-sm font-semibold">
                    {group.owner}
                  </h3>
                  <p className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
                    OpenStack creator
                  </p>
                </div>
              </div>
              <p className="flex items-center gap-1.5 font-mono text-[9px] text-muted-foreground">
                <Boxes className="size-3" aria-hidden="true" />
                {group.instances.length} instance
                {group.instances.length === 1 ? '' : 's'} · {groupGPUs} GPU
              </p>
            </div>

            <div className="grid gap-3 p-3">
              {group.instances.map((observation) => {
                const { instance, agent } = observation;
                const users = gpuConnectedUsersLabel(observation);
                const healthMessages = snapshotHealthMessages(observation);
                const telemetry = telemetryState(observation);
                const capacity = staticCapacityLabel(instance);
                return (
                  <article
                    key={instance.uuid}
                    className="min-w-0 border border-border/70 bg-background/55"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-3 py-2.5">
                      <div className="min-w-0">
                        <h4 className="truncate text-xs font-semibold">
                          {instance.name}
                        </h4>
                        <p className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.1em] text-muted-foreground">
                          {instance.flavor || 'Jetstream instance'}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <StatusChip
                          status={instance.cloudState}
                          label={cloudLabels[instance.cloudState] ?? 'Unknown'}
                        />
                        <StatusChip
                          status={agent.status}
                          label={observationSourceLabel(agent)}
                        />
                        {agent.snapshot ? (
                          <StatusChip
                            status={telemetry}
                            label={`Telemetry ${telemetryLabel(telemetry)}`}
                          />
                        ) : null}
                      </div>
                    </div>
                    <div className="grid gap-3 px-3 py-3 sm:grid-cols-2">
                      <div>
                        <p className="font-mono text-[8px] uppercase tracking-[0.1em] text-muted-foreground">
                          Resources
                        </p>
                        <p className="mt-1 flex items-center gap-1.5 text-xs">
                          <Gauge className="size-3.5 text-primary" />
                          {agent.snapshot
                            ? `${agent.snapshot.gpus.length} GPU · ${processCountLabel(observation)}`
                            : 'Telemetry unavailable'}
                        </p>
                        <p
                          className="mt-1 font-mono text-[9px] text-muted-foreground"
                          data-testid="jetstream-static-capacity"
                        >
                          Static capacity: {capacity ?? 'Unavailable'}
                        </p>
                        <p className="mt-0.5 font-mono text-[9px] text-muted-foreground">
                          {hostUsageUnavailableLabel}
                        </p>
                      </div>
                      <div>
                        <p className="font-mono text-[8px] uppercase tracking-[0.1em] text-muted-foreground">
                          GPU-connected users
                        </p>
                        <p className="mt-1 break-all font-mono text-xs">
                          {users}
                        </p>
                      </div>
                    </div>
                    {healthMessages.length > 0 ? (
                      <div className="space-y-0.5 border-t border-amber-500/20 bg-amber-500/[0.04] px-3 py-2 text-[9px] text-amber-700 dark:text-amber-300">
                        {healthMessages.map((message) => (
                          <p key={message}>{message}</p>
                        ))}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function JetstreamDashboard({
  platform,
}: {
  platform: PlatformObservation;
}) {
  const [dashboardView, setDashboardView] =
    useState<DashboardView>(storedDashboardView);
  const [selectedKey, setSelectedKey] = useState<JetstreamSelectionKey | null>(
    null,
  );
  const instances = platform.instances;
  const selected = selectedJetstreamEntity(instances, selectedKey);
  const running = instances.filter(
    ({ instance }) => instance.cloudState === 'active',
  );
  const monitored = currentMonitoredInstances(instances);
  const retained = snapshotInstances(instances);
  const currentGPUCount = gpuCount(monitored);
  const currentProcessCount = currentKnownProcessCount(monitored);
  const completeGPUCoverage = running.every(hasCurrentGPUCoverage);
  const completeProcessCoverage = running.every(
    hasCurrentCompleteProcessCoverage,
  );
  const owners = new Set(
    running
      .map(({ instance }) => instance.creatorUsername?.trim())
      .filter((owner): owner is string => Boolean(owner)),
  ).size;
  const summary = [
    { value: running.length, label: 'Running instances', icon: Server },
    {
      value: completeGPUCoverage
        ? currentGPUCount
        : incompleteAggregateValue(currentGPUCount),
      label: completeGPUCoverage ? 'Physical GPUs' : 'Known GPUs',
      icon: Gauge,
    },
    {
      value: completeProcessCoverage
        ? currentProcessCount
        : incompleteAggregateValue(currentProcessCount),
      label: completeProcessCoverage ? 'GPU processes' : 'Known GPU processes',
      icon: Database,
    },
    { value: owners, label: 'Known owners', icon: UserRound },
  ];

  const openSelection = useCallback(
    (instanceUUID: string, selection: Selection) => {
      setSelectedKey({
        instanceUUID,
        entity:
          selection.kind === 'physical_gpu'
            ? { kind: selection.kind, uuid: selection.gpu.uuid }
            : { kind: selection.kind, uuid: selection.ci.uuid },
      });
    },
    [],
  );

  function selectDashboardView(view: DashboardView) {
    setDashboardView(view);
    setSelectedKey(null);
    writeBrowserSetting(dashboardViewKey, view);
  }

  return (
    <>
      <section
        className="mb-5 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between"
        aria-labelledby="jetstream-overview"
      >
        <div>
          <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.15em] text-primary">
            <Activity className="size-3.5" aria-hidden="true" /> platform /
            jetstream
          </div>
          <h1
            id="jetstream-overview"
            className="text-xl font-semibold tracking-[-0.025em] sm:text-2xl"
          >
            Jetstream Dashboard
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Live GPU, MIG, CUDA process, and OpenStack instance telemetry.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge
              variant={
                platform.inventory.status === 'available'
                  ? 'outline'
                  : 'secondary'
              }
              className="rounded font-mono text-[9px]"
            >
              Inventory {platform.inventory.status}
            </Badge>
            <span className="font-mono text-[9px] text-muted-foreground">
              {monitored.length} monitored of {running.length} running
              {retained.length > monitored.length
                ? ` · ${retained.length - monitored.length} retained snapshot${retained.length - monitored.length === 1 ? '' : 's'}`
                : ''}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4">
          {summary.map((item) => (
            <Metric key={item.label} {...item} />
          ))}
        </div>
      </section>

      <section aria-labelledby="jetstream-resources-heading">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2
              id="jetstream-resources-heading"
              className="text-sm font-semibold"
            >
              Resources
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Creator identity and GPU-connected Unix users remain separate.
            </p>
          </div>
          <fieldset
            className="flex items-center gap-2 border-0 p-0"
            aria-label="Organize resources by"
          >
            <legend className="font-mono text-[8px] uppercase tracking-[0.12em] text-muted-foreground">
              Organize by
            </legend>
            <div className="flex rounded-md border border-border bg-muted/35 p-0.5">
              {(['gpus', 'people'] as const).map((view) => (
                <button
                  key={view}
                  type="button"
                  className={`h-7 rounded px-3 font-mono text-[10px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring ${
                    dashboardView === view
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                  }`}
                  aria-pressed={dashboardView === view}
                  onClick={() => selectDashboardView(view)}
                >
                  {view === 'gpus' ? 'GPUs' : 'People'}
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        {dashboardView === 'people' ? (
          <JetstreamPeopleView instances={running} />
        ) : (
          <JetstreamGPUView instances={instances} onSelect={openSelection} />
        )}
      </section>

      <details className="group mt-6 border border-border/75 bg-card/55">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <span>
            <span className="block text-sm font-semibold">
              Full instance inventory
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Cloud, agent, telemetry, and monitoring-policy details.
            </span>
          </span>
          <Badge variant="outline">
            {instances.length} instance{instances.length === 1 ? '' : 's'}
          </Badge>
        </summary>
        <div className="border-t border-border/70 px-4 pb-4">
          <InstanceTable instances={instances} inventory={platform.inventory} />
        </div>
      </details>

      {selected ? (
        <Suspense fallback={null}>
          <DetailSheet
            selection={selected.selection}
            attribution={selected.attribution}
            open
            onOpenChange={(open) => {
              if (!open) setSelectedKey(null);
            }}
            historyMode="live-only"
          />
        </Suspense>
      ) : null}
    </>
  );
}
