import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
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
import { DiagnosticsPanel } from './components/diagnostics-panel';
import { GPUCard } from './components/gpu-card';
import { ProcessTable } from './components/process-table';
import { StatusHeader } from './components/status-header';
import {
  chartWindowStorageKey,
  defaultHistoryWindowMs,
  effectiveChartWindow,
  storedChartWindow,
} from './chart-window';
import type { BuildInfo, Selection, Snapshot } from './types';
import { useMIGLens } from './use-miglens';

const DetailSheet = lazy(() => import('./components/detail-sheet'));
const OverviewCharts = lazy(() => import('./components/overview-charts'));
const themeKey = 'miglens.theme.v1';

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
  uuid: string | null,
): Selection | null {
  if (!uuid) return null;
  for (const gpu of snapshot.gpus) {
    for (const gi of gpu.gpuInstances) {
      for (const ci of gi.computeInstances) {
        if (ci.uuid === uuid) return { gpu, gi, ci };
      }
    }
  }
  return null;
}

function LoadingView({ error }: { error: string | null }) {
  return (
    <main className="mx-auto max-w-[1680px] px-4 py-6 sm:px-6">
      {error ? (
        <div className="mb-4 flex items-center gap-2 border border-amber-500/30 bg-amber-500/[0.06] p-3 text-sm text-amber-600 dark:text-amber-300">
          <AlertTriangle className="size-4" /> {error}. Retrying the local SSE
          endpoint…
        </div>
      ) : null}
      <div className="space-y-4" aria-label="Loading GPU topology">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </main>
  );
}

export function App() {
  const {
    snapshot,
    connection,
    error,
    history,
    settings,
    buildInfo,
    updateSamplingInterval,
  } = useMIGLens();
  const [selectedUUID, setSelectedUUID] = useState<string | null>(null);
  const [requestedChartWindowMs, setRequestedChartWindowMs] =
    useState(storedChartWindow);
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    localStorage.getItem(themeKey) === 'light' ? 'light' : 'dark',
  );

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem(themeKey, theme);
  }, [theme]);

  const retentionMs = Math.max(
    1,
    settings?.historyWindowMs ?? defaultHistoryWindowMs,
  );
  const chartWindowMs = effectiveChartWindow(
    requestedChartWindowMs,
    retentionMs,
  );

  function selectChartWindow(milliseconds: number) {
    setRequestedChartWindowMs(milliseconds);
    localStorage.setItem(chartWindowStorageKey, String(milliseconds));
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
  const selection = selectedEntity(snapshot, selectedUUID);
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

  return (
    <div className="min-h-screen bg-background text-foreground">
      <StatusHeader
        hostname={snapshot.host.hostname}
        sampledAt={snapshot.sampledAt}
        capabilities={snapshot.capabilities}
        connection={connection}
        degraded={degraded}
        settings={settings}
        theme={theme}
        onSamplingIntervalChange={updateSamplingInterval}
        onToggleTheme={() =>
          setTheme((value) => (value === 'dark' ? 'light' : 'dark'))
        }
      />
      <main className="mx-auto max-w-[1680px] px-4 py-6 sm:px-6">
        {connection !== 'live' ? (
          <div className="mb-4 flex items-center gap-2 border border-amber-500/30 bg-amber-500/[0.06] p-3 text-sm text-amber-600 dark:text-amber-300">
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
              GPU partition overview
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Live GPU, MIG, and CUDA process telemetry.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-px border border-border bg-border text-center sm:grid-cols-4">
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

        <section aria-label="GPU topology" className="space-y-4">
          {snapshot.gpus.length === 0 ? (
            <div className="border border-dashed border-border bg-card p-10 text-center">
              <p className="text-sm font-medium">No NVIDIA GPUs detected</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Run <span className="font-mono">miglens doctor</span> to inspect
                driver and library visibility.
              </p>
            </div>
          ) : (
            snapshot.gpus.map((gpu) => (
              <GPUCard
                key={gpu.uuid}
                gpu={gpu}
                onSelect={(next) => setSelectedUUID(next.ci.uuid)}
              />
            ))
          )}
        </section>

        <Suspense
          fallback={
            <div
              className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2"
              aria-label="Loading GPU history charts"
            >
              {['temperature', 'utilization', 'memory', 'sm-active'].map(
                (name) => (
                  <Skeleton key={name} className="h-[302px] w-full" />
                ),
              )}
            </div>
          }
        >
          <OverviewCharts
            snapshot={snapshot}
            connection={connection}
            loadHistory={history}
            chartWindowMs={chartWindowMs}
            retentionMs={retentionMs}
            onChartWindowChange={selectChartWindow}
          />
        </Suspense>

        <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(330px,1fr)]">
          <ProcessTable snapshot={snapshot} />
          <DiagnosticsPanel diagnostics={snapshot.diagnostics} />
        </div>

        <footer className="mt-6 border-t border-border/70 pt-4 pb-1 text-center text-[11px] text-muted-foreground">
          <p className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5">
            <span>
              Built with <span aria-label="crossed swords">⚔️</span> by{' '}
              <strong className="font-semibold text-foreground">
                Intellisys Dragoons
              </strong>{' '}
              and Codex
            </span>{' '}
            <span className="whitespace-nowrap font-mono text-[10px]">
              · MIGLens {formatBuildVersion(buildInfo)}
            </span>
          </p>
        </footer>
      </main>

      {selection ? (
        <Suspense fallback={null}>
          <DetailSheet
            selection={selection}
            open
            onOpenChange={(open) => {
              if (!open) setSelectedUUID(null);
            }}
            loadHistory={history}
            chartWindowMs={chartWindowMs}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
