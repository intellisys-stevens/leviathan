import { useEffect, useMemo, useState } from 'react';
import { Activity, Cpu, Database, Gauge, Layers3 } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { durationQuery, formatDuration } from '../chart-window';
import {
  formatBytes,
  formatMetric,
  formatRoundedPercent,
  memoryPercent,
  shortUUID,
} from '../lib';
import {
  downsampleChartRows,
  movingAverageChartRows,
  type ChartRow,
} from '../overview-history';
import type { GPU, GpuInstance, HistorySeries, Selection } from '../types';
import { ChartWindowControl } from './chart-window-control';

type MetricDescriptor = {
  name: string;
  label: string;
};

type ChartDescriptor = MetricDescriptor & {
  key: string;
  color: string;
  strokeWidth: number;
};

const instanceLiveMetrics: readonly MetricDescriptor[] = [
  { name: 'sm_activity', label: 'SM activity' },
  { name: 'sm_occupancy', label: 'SM occupancy' },
  { name: 'tensor_activity', label: 'Tensor' },
  { name: 'dram_activity', label: 'DRAM' },
];

const instanceChartMetrics: readonly ChartDescriptor[] = [
  {
    name: 'sm_activity',
    key: 'sm',
    label: 'SM activity',
    color: 'var(--primary)',
    strokeWidth: 2,
  },
  {
    name: 'tensor_activity',
    key: 'tensor',
    label: 'Tensor',
    color: 'var(--chart-2)',
    strokeWidth: 1.5,
  },
  {
    name: 'dram_activity',
    key: 'dram',
    label: 'DRAM',
    color: 'var(--chart-3)',
    strokeWidth: 1.5,
  },
];

const physicalLiveMetrics: readonly MetricDescriptor[] = [
  { name: 'gpu_activity', label: 'GPU activity' },
  { name: 'sm_activity', label: 'SM activity' },
  { name: 'memory_activity', label: 'Memory activity' },
  { name: 'temperature', label: 'Temperature' },
  { name: 'power', label: 'Power' },
  { name: 'sm_clock', label: 'SM clock' },
  { name: 'memory_clock', label: 'Memory clock' },
];

const physicalChartMetrics: readonly ChartDescriptor[] = [
  {
    name: 'gpu_activity',
    key: 'gpu',
    label: 'GPU activity',
    color: 'var(--primary)',
    strokeWidth: 2,
  },
  {
    name: 'sm_activity',
    key: 'sm',
    label: 'SM activity',
    color: 'var(--chart-2)',
    strokeWidth: 1.5,
  },
  {
    name: 'memory_activity',
    key: 'memory',
    label: 'Memory activity',
    color: 'var(--chart-3)',
    strokeWidth: 1.5,
  },
];

type Props = {
  selection: Selection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loadHistory: (
    entity: string,
    metrics: string[],
    window?: string,
  ) => Promise<HistorySeries>;
  chartWindowMs: number;
  retentionMs: number;
  onChartWindowChange: (milliseconds: number) => void;
};

function currentHistoryPoint(
  entity: GPU | GpuInstance,
  metrics: readonly ChartDescriptor[],
) {
  const values: Record<string, number> = {};
  for (const { name } of metrics) {
    const metric = entity.metrics[name];
    if (metric?.status === 'available' && metric.value != null)
      values[name] = metric.value;
  }
  return { sampledAt: entity.memory.sampledAt, values };
}

function appendHistoryPoint(
  series: HistorySeries,
  point: ReturnType<typeof currentHistoryPoint>,
  windowMilliseconds: number,
): HistorySeries {
  const latest = new Date(point.sampledAt).getTime();
  const cutoff = latest - windowMilliseconds;
  const points = new Map(
    series.points
      .filter((candidate) => new Date(candidate.sampledAt).getTime() >= cutoff)
      .map((candidate) => [candidate.sampledAt, candidate]),
  );
  points.set(point.sampledAt, point);
  return {
    ...series,
    points: [...points.values()].sort(
      (left, right) =>
        new Date(left.sampledAt).getTime() -
        new Date(right.sampledAt).getTime(),
    ),
  };
}

export default function DetailSheet({
  selection,
  open,
  onOpenChange,
  loadHistory,
  chartWindowMs,
  retentionMs,
  onChartWindowChange,
}: Props) {
  const [historyState, setHistoryState] = useState<{
    key: string;
    series: HistorySeries | null;
    error: string | null;
  }>({ key: '', series: null, error: null });
  const physical = selection.kind === 'physical_gpu';
  const gpu = selection.gpu;
  const source = physical ? gpu : selection.gi;
  const historyEntity = physical ? gpu.uuid : selection.gi.uuid;
  const liveMetrics = physical ? physicalLiveMetrics : instanceLiveMetrics;
  const chartMetrics = physical ? physicalChartMetrics : instanceChartMetrics;
  const historyKey = `${historyEntity}:${chartWindowMs}`;

  useEffect(() => {
    let active = true;
    loadHistory(
      historyEntity,
      chartMetrics.map(({ name }) => name),
      durationQuery(chartWindowMs),
    )
      .then((data) => {
        if (active)
          setHistoryState({
            key: historyKey,
            series: data,
            error: null,
          });
      })
      .catch((reason: unknown) => {
        if (active)
          setHistoryState({
            key: historyKey,
            series: null,
            error:
              reason instanceof Error ? reason.message : 'History unavailable',
          });
      });
    return () => {
      active = false;
    };
  }, [chartMetrics, chartWindowMs, historyEntity, historyKey, loadHistory]);

  const retainedSeries =
    historyState.key === historyKey ? historyState.series : null;
  const series = useMemo(
    () =>
      retainedSeries
        ? appendHistoryPoint(
            retainedSeries,
            currentHistoryPoint(source, chartMetrics),
            chartWindowMs,
          )
        : null,
    [chartMetrics, chartWindowMs, retainedSeries, source],
  );
  const historyError =
    historyState.key === historyKey ? historyState.error : null;
  const chartData = useMemo(() => {
    const keys = chartMetrics.map(({ key }) => key);
    const rows: ChartRow[] =
      series?.points.map((point) => {
        const row: ChartRow = {
          time: new Date(point.sampledAt).getTime(),
        };
        for (const descriptor of chartMetrics) {
          const value = point.values[descriptor.name];
          row[descriptor.key] = Number.isFinite(value) ? value : null;
        }
        return row;
      }) ?? [];
    return downsampleChartRows(movingAverageChartRows(rows, keys), keys, 360);
  }, [chartMetrics, series]);
  const memory = memoryPercent(source.memory);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full overflow-y-auto border-border bg-popover"
        style={{ width: 'min(640px, 100vw)', maxWidth: '640px' }}
      >
        <SheetHeader className="border-b border-border px-5 py-5">
          {selection.kind === 'physical_gpu' ? (
            <>
              <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.13em] text-primary">
                <Gauge className="size-3.5" /> GPU {gpu.index} · Full GPU
              </div>
              <SheetTitle className="flex items-center gap-2 text-lg">
                <Gauge className="size-4 text-primary" /> {gpu.name}
                <Badge
                  variant="outline"
                  className="rounded font-mono text-[10px]"
                >
                  Full GPU
                </Badge>
              </SheetTitle>
              <SheetDescription className="font-mono text-[10px]">
                {gpu.uuid}
              </SheetDescription>
            </>
          ) : (
            <>
              <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.13em] text-primary">
                <Layers3 className="size-3.5" /> GPU {gpu.index} · GI{' '}
                {selection.gi.id} · CI {selection.ci.id}
              </div>
              <SheetTitle className="flex items-center gap-2 text-lg">
                <Cpu className="size-4 text-primary" /> {selection.gi.profile}
                <Badge
                  variant="outline"
                  className="rounded font-mono text-[10px]"
                >
                  {selection.ci.profile}
                </Badge>
              </SheetTitle>
              <SheetDescription className="font-mono text-[10px]">
                {selection.ci.uuid}
              </SheetDescription>
            </>
          )}
        </SheetHeader>

        <div className="space-y-5 px-5 pb-8">
          {selection.kind === 'compute_instance' &&
          selection.gi.computeInstances.length > 1 ? (
            <div className="border border-amber-500/30 bg-amber-500/[0.06] p-3 text-xs text-amber-600 dark:text-amber-300">
              GI metrics are shared by {selection.gi.computeInstances.length}{' '}
              CIs.
            </div>
          ) : null}

          <section aria-labelledby="metrics-title">
            <h3
              id="metrics-title"
              className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
            >
              <Activity className="size-3.5" /> Live metrics
            </h3>
            <div className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4">
              {liveMetrics.map(({ name, label }) => {
                const metric = source.metrics[name];
                return (
                  <div key={name} className="bg-card p-3">
                    <p className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                      {label}
                    </p>
                    <p className="mt-1 font-mono text-lg font-semibold text-primary">
                      {formatMetric(metric)}
                    </p>
                    <p
                      className="mt-1 truncate font-mono text-[9px] text-muted-foreground"
                      title={metric?.message}
                    >
                      {metric?.source || '—'} · {metric?.scope || '—'} ·{' '}
                      {metric?.status || '—'}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>

          <section aria-labelledby="history-title">
            <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h3
                id="history-title"
                className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
              >
                {formatDuration(chartWindowMs)} activity
              </h3>
              <ChartWindowControl
                chartWindowMs={chartWindowMs}
                retentionMs={retentionMs}
                onChartWindowChange={onChartWindowChange}
                ariaLabel="Detail chart window"
                className="shrink-0"
              />
            </div>
            <div className="h-44 border border-border bg-card p-2">
              {historyError ? (
                <div className="grid h-full place-items-center text-xs text-amber-500">
                  {historyError}
                </div>
              ) : chartData.length < 2 ? (
                <div className="grid h-full place-items-center text-xs text-muted-foreground">
                  Collecting history…
                </div>
              ) : (
                <ResponsiveContainer
                  width="100%"
                  height="100%"
                  minWidth={0}
                  initialDimension={{ width: 1, height: 1 }}
                >
                  <LineChart
                    data={chartData}
                    margin={{ top: 8, right: 8, left: -14, bottom: 0 }}
                  >
                    <CartesianGrid stroke="var(--border)" vertical={false} />
                    <XAxis
                      dataKey="time"
                      type="number"
                      domain={['dataMin', 'dataMax']}
                      tickFormatter={(value) =>
                        new Date(value).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      }
                      tick={{ fontSize: 9, fill: 'var(--muted-foreground)' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      domain={[0, 100]}
                      tickFormatter={(value: number) =>
                        formatRoundedPercent(value)
                      }
                      tick={{ fontSize: 9, fill: 'var(--muted-foreground)' }}
                      axisLine={false}
                      tickLine={false}
                      width={42}
                    />
                    <Tooltip
                      isAnimationActive={false}
                      contentStyle={{
                        background: 'var(--popover)',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        fontSize: 11,
                      }}
                      labelFormatter={(value) =>
                        new Date(Number(value)).toLocaleTimeString()
                      }
                      formatter={(value, name) => [
                        formatRoundedPercent(Number(value)),
                        String(name),
                      ]}
                    />
                    {chartMetrics.map((descriptor) => (
                      <Line
                        key={descriptor.key}
                        type="monotoneX"
                        dataKey={descriptor.key}
                        name={descriptor.label}
                        stroke={descriptor.color}
                        strokeWidth={descriptor.strokeWidth}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        dot={false}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </section>

          <section
            className="grid gap-3 sm:grid-cols-2"
            aria-label={physical ? 'GPU facts' : 'Instance facts'}
          >
            <div className="border border-border bg-card p-3">
              <p className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                <Database className="size-3" />{' '}
                {physical ? 'Full GPU memory' : 'GI memory'}
              </p>
              <div className="flex items-end justify-between gap-2">
                <p className="font-mono text-sm font-semibold">
                  {formatBytes(source.memory.usedBytes)} /{' '}
                  {formatBytes(source.memory.totalBytes)}
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  {memory == null ? '—' : `${memory.toFixed(1)}%`}
                </p>
              </div>
              <Progress
                value={memory ?? 0}
                className={`mt-2 ${memory != null && memory >= 85 ? '[&_[data-slot=progress-indicator]]:bg-amber-400' : '[&_[data-slot=progress-indicator]]:bg-cyan-400'}`}
              />
              <p className="mt-2 font-mono text-[9px] text-muted-foreground">
                {source.memory.source} · {source.memory.scope} ·{' '}
                {source.memory.status}
              </p>
            </div>
            <div className="border border-border bg-card p-3">
              {selection.kind === 'physical_gpu' ? (
                <>
                  <p className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                    <Gauge className="size-3" /> Identity
                  </p>
                  <p className="font-mono text-sm font-semibold">
                    GPU {gpu.index} · {gpu.pciBusId || 'PCI bus unavailable'}
                  </p>
                  <p className="mt-2 font-mono text-[9px] text-muted-foreground">
                    {shortUUID(gpu.uuid)} · Full GPU
                  </p>
                </>
              ) : (
                <>
                  <p className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                    <Layers3 className="size-3" /> Hierarchy
                  </p>
                  <p className="font-mono text-sm font-semibold">
                    GI {selection.gi.id} / CI {selection.ci.id}
                  </p>
                  <p className="mt-2 font-mono text-[9px] text-muted-foreground">
                    {selection.gi.profile} · {selection.ci.profile}
                  </p>
                </>
              )}
            </div>
          </section>

          <p className="font-mono text-[9px] text-muted-foreground">
            {selection.kind === 'physical_gpu' ? (
              <>{shortUUID(gpu.uuid)} · Physical GPU</>
            ) : (
              <>
                Generation {selection.ci.generation} · {shortUUID(gpu.uuid)} /
                GI {selection.gi.id} / CI {selection.ci.id}
              </>
            )}
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
