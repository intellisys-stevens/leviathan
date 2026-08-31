import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  Activity,
  AlertTriangle,
  Cpu,
  Database,
  Layers3,
  Server,
  type LucideIcon,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { DiagnosticsPanel } from './components/diagnostics-panel';
import { GPUCard } from './components/gpu-card';
import { PeopleView } from './components/people-view';
import { ProcessTable } from './components/process-table';
import { StatusHeader } from './components/status-header';
import { AttributionSummary } from './components/workspace-attribution';
import { readBrowserSetting, writeBrowserSetting } from './browser-storage';
import {
  chartWindowStorageKey,
  defaultHistoryWindowMs,
  detailChartWindowStorageKey,
  effectiveChartWindow,
  storedChartWindow,
  storedDetailChartWindow,
} from './chart-window';
import type { BuildInfo, Selection, SelectionKey, Snapshot } from './types';
import { useLeviathan } from './use-leviathan';

const DetailSheet = lazy(() => import('./components/detail-sheet'));
const OverviewCharts = lazy(() => import('./components/overview-charts'));
const themeKey = 'leviathan.theme.v1';
const dashboardViewKey = 'leviathan.dashboardView.v1';
type DashboardView = 'gpus' | 'people';

function storedDashboardView(): DashboardView {
  return readBrowserSetting(dashboardViewKey) === 'people' ? 'people' : 'gpus';
}

export function formatBuildVersion(
  buildInfo: BuildInfo | null | undefined,
): string {
  if (buildInfo === undefined) return '…';
  if (buildInfo === null) return 'unavailable';
  const version = buildInfo.version.trim();
  if (!version) return 'unavailable';
  if (version.toLowerCase() === 'dev') return 'dev';
  return version.startsWith('v') || version.startsWith('V')
    ? version
    : `v${version}`;
}

function selectedEntity(
  snapshot: Snapshot,
  key: SelectionKey | null,
): Selection | null {
  if (!key) return null;
  if (key.kind === 'physical_gpu') {
    const gpu = snapshot.gpus.find((candidate) => candidate.uuid === key.uuid);
    return gpu ? { kind: 'physical_gpu', gpu } : null;
  }
  for (const gpu of snapshot.gpus) {
    for (const gi of gpu.gpuInstances) {
      for (const ci of gi.computeInstances) {
        if (ci.uuid === key.uuid)
          return { kind: 'compute_instance', gpu, gi, ci };
      }
    }
  }
  return null;
}

function LoadingView({ error }: { error: string | null }) {
  return (
    <main className="mx-auto max-w-[1680px] px-4 py-6 sm:px-6">
      {error ? (
        <div className="mb-4 flex items-center gap-2 border border-amber-500/30 bg-amber-500/[0.06] p-3 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="size-4" /> {error}. Retrying the local SSE
          endpoint…
        </div>
      ) : null}
      <section className="space-y-4" aria-label="Loading GPU topology">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </section>
    </main>
  );
}

export function App() {
  const {
    snapshot,
    connection,
    error,
    history,
    alignedHistory,
    settings,
    buildInfo,
    updateSamplingInterval,
  } = useLeviathan();
  const [selectedKey, setSelectedKey] = useState<SelectionKey | null>(null);
  const [requestedChartWindowMs, setRequestedChartWindowMs] =
    useState(storedChartWindow);
  const [requestedDetailChartWindowMs, setRequestedDetailChartWindowMs] =
    useState(storedDetailChartWindow);
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    readBrowserSetting(themeKey) === 'light' ? 'light' : 'dark',
  );
  const [dashboardView, setDashboardView] =
    useState<DashboardView>(storedDashboardView);
  const openSelection = useCallback((next: Selection) => {
    setSelectedKey(
      next.kind === 'physical_gpu'
        ? { kind: next.kind, uuid: next.gpu.uuid }
        : { kind: next.kind, uuid: next.ci.uuid },
    );
  }, []);
  const toggleTheme = useCallback(() => {
    setTheme((value) => (value === 'dark' ? 'light' : 'dark'));
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    writeBrowserSetting(themeKey, theme);
  }, [theme]);

  const retentionMs = Math.max(
    1,
    settings?.historyWindowMs ?? defaultHistoryWindowMs,
  );
  const chartWindowMs = effectiveChartWindow(
    requestedChartWindowMs,
    retentionMs,
  );
  const detailChartWindowMs = effectiveChartWindow(
    requestedDetailChartWindowMs,
    retentionMs,
  );

  function selectChartWindow(milliseconds: number) {
    setRequestedChartWindowMs(milliseconds);
    writeBrowserSetting(chartWindowStorageKey, String(milliseconds));
  }

  function selectDetailChartWindow(milliseconds: number) {
    setRequestedDetailChartWindowMs(milliseconds);
    writeBrowserSetting(detailChartWindowStorageKey, String(milliseconds));
  }

  function selectDashboardView(view: DashboardView) {
    setDashboardView(view);
    setSelectedKey(null);
    writeBrowserSetting(dashboardViewKey, view);
  }

  const summary = useMemo(() => {
    if (!snapshot) return { gpu: 0, gi: 0, ci: 0, processes: 0 };
    let gi = 0;
    let ci = 0;
    for (const gpu of snapshot.gpus) {
      gi += gpu.gpuInstances.length;
      for (const instance of gpu.gpuInstances) {
        ci += instance.computeInstances.length;
      }
    }
    return {
      gpu: snapshot.gpus.length,
      gi,
      ci,
      processes: snapshot.processes.length,
    };
  }, [snapshot]);

  if (!snapshot) return <LoadingView error={error} />;
  const selection = selectedEntity(snapshot, selectedKey);
  const degraded = snapshot.diagnostics.some(
    (diagnostic) => diagnostic.severity !== 'info',
  );
  const summaryItems: Array<{
    value: number;
    label: string;
    icon: LucideIcon;
  }> = [
    { value: summary.gpu, label: 'Physical GPUs', icon: Server },
    { value: summary.gi, label: 'GPU instances', icon: Layers3 },
    { value: summary.ci, label: 'Compute instances', icon: Cpu },
    { value: summary.processes, label: 'GPU processes', icon: Database },
  ];
  const attributionEnabled = snapshot.attribution != null;
  const effectiveDashboardView = attributionEnabled ? dashboardView : 'gpus';

  return (
    <div className="app-shell min-h-screen text-foreground">
      <StatusHeader
        hostname={snapshot.host.hostname}
        connection={connection}
        degraded={degraded}
        settings={settings}
        theme={theme}
        onSamplingIntervalChange={updateSamplingInterval}
        onToggleTheme={toggleTheme}
      />
      <main className="mx-auto max-w-[1680px] px-4 py-6 sm:px-6">
        {connection !== 'live' ? (
          <div className="mb-4 flex items-center gap-2 border border-amber-500/30 bg-amber-500/[0.06] p-3 text-sm text-amber-700 dark:text-amber-300">
            <AlertTriangle className="size-4" /> Live stream {connection}. The
            last complete snapshot remains visible.
          </div>
        ) : null}

        <section
          className="mb-5 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between"
          aria-labelledby="host-overview"
        >
          <div>
            <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.15em] text-primary">
              <Activity className="size-3.5" /> host / {snapshot.host.hostname}
            </div>
            <h1
              id="host-overview"
              className="text-xl font-semibold tracking-[-0.025em] sm:text-2xl"
            >
              Dashboard
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Live GPU, MIG, and CUDA process telemetry.
            </p>
            <AttributionSummary
              attribution={snapshot.attribution}
              snapshot={snapshot}
            />
          </div>
          <div className="frost-panel grid grid-cols-2 gap-px overflow-hidden border border-border bg-border text-center sm:grid-cols-4">
            {summaryItems.map(({ value, label, icon: Icon }) => (
              <div key={label} className="min-w-[125px] bg-card px-4 py-2.5">
                <p className="flex items-center justify-center gap-1.5 font-mono text-base font-semibold text-primary">
                  <Icon className="size-3.5" /> {value}
                </p>
                <p className="text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
                  {label}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="resource-view-heading">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <h2 id="resource-view-heading" className="text-sm font-semibold">
              Resources
            </h2>
            {attributionEnabled ? (
              <fieldset
                className="flex items-center gap-2 border-0 p-0"
                aria-label="Organize resources by"
              >
                <legend className="font-mono text-[8px] uppercase tracking-[0.12em] text-muted-foreground">
                  Organize by
                </legend>
                <div className="flex rounded-md border border-input bg-popover p-0.5 shadow-sm">
                  {(['gpus', 'people'] as const).map((view) => (
                    <button
                      key={view}
                      type="button"
                      className={`h-7 rounded px-3 font-mono text-[10px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                        effectiveDashboardView === view
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                      }`}
                      aria-pressed={effectiveDashboardView === view}
                      onClick={() => selectDashboardView(view)}
                    >
                      {view === 'gpus' ? 'GPUs' : 'People'}
                    </button>
                  ))}
                </div>
              </fieldset>
            ) : null}
          </div>

          {effectiveDashboardView === 'people' ? (
            <PeopleView snapshot={snapshot} onSelect={openSelection} />
          ) : (
            <section
              aria-label="GPU topology"
              className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2"
            >
              {snapshot.gpus.length === 0 ? (
                <div className="frost-panel border border-dashed border-border bg-card p-10 text-center xl:col-span-2">
                  <p className="text-sm font-medium">No NVIDIA GPUs detected</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Run <span className="font-mono">leviathan doctor</span> to
                    inspect driver and library visibility.
                  </p>
                </div>
              ) : (
                snapshot.gpus.map((gpu) => (
                  <GPUCard
                    key={gpu.uuid}
                    gpu={gpu}
                    attribution={snapshot.attribution}
                    onSelect={openSelection}
                  />
                ))
              )}
            </section>
          )}
        </section>

        <section className="mt-5" aria-labelledby="host-telemetry-heading">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="host-telemetry-heading" className="text-sm font-semibold">
              Host-wide telemetry
            </h2>
            <Badge
              variant="outline"
              className="rounded border-border bg-muted/35 font-mono text-[9px] text-muted-foreground"
            >
              All GPUs
            </Badge>
          </div>
          <Suspense
            fallback={
              <section
                className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2"
                aria-label="Loading GPU history charts"
              >
                {[
                  'temperature',
                  'utilization',
                  'memory',
                  'memory-bandwidth',
                  'pcie',
                ].map((name) => (
                  <Skeleton key={name} className="h-[302px] w-full" />
                ))}
              </section>
            }
          >
            <OverviewCharts
              snapshot={snapshot}
              connection={connection}
              loadHistory={alignedHistory}
              chartWindowMs={chartWindowMs}
              retentionMs={retentionMs}
              onChartWindowChange={selectChartWindow}
            />
          </Suspense>
        </section>

        <div className="relative z-0 mt-5 grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(330px,1fr)]">
          <ProcessTable
            processes={snapshot.processes}
            procCapability={snapshot.capabilities.proc}
            attribution={snapshot.attribution}
          />
          <DiagnosticsPanel diagnostics={snapshot.diagnostics} />
        </div>

        <footer className="mt-6 border-t border-border/70 pt-4 pb-1 text-center text-[11px] text-muted-foreground">
          <p className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5">
            <span>
              Built with <span aria-hidden="true">⚔️</span> by{' '}
              <a
                href="https://intellisys.haow.us/team/"
                className="font-semibold text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Intellisys Dragoons
              </a>{' '}
              and Codex
            </span>{' '}
            <span className="whitespace-nowrap font-mono text-[10px]">
              · Leviathan {formatBuildVersion(buildInfo)}
            </span>
          </p>
        </footer>
      </main>

      {selection ? (
        <Suspense fallback={null}>
          <DetailSheet
            selection={selection}
            attribution={snapshot.attribution}
            open
            onOpenChange={(open) => {
              if (!open) setSelectedKey(null);
            }}
            loadHistory={history}
            chartWindowMs={detailChartWindowMs}
            retentionMs={retentionMs}
            onChartWindowChange={selectDetailChartWindow}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
