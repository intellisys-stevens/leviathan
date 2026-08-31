import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
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
  clampRenderedPercent,
  formatBytes,
  formatBytesPerSecond,
  formatMetric,
  formatPercent,
  formatRoundedPercent,
  memoryPercent,
  metricValue,
} from '../lib';
import {
  downsampleChartRows,
  mergeOverviewPoints,
  movingAverageChartRows,
  type ChartRow,
} from '../overview-history';
import type {
  Attribution,
  GPU,
  GpuInstance,
  HistorySeries,
  Metric,
  Selection,
} from '../types';
import { ChartWindowControl } from './chart-window-control';
import { AttributionDetails } from './workspace-attribution';

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
  { name: 'pcie_total_bytes_per_second', label: 'PCIe total' },
  { name: 'pcie_rx_bytes_per_second', label: 'Host → GPU' },
  { name: 'pcie_tx_bytes_per_second', label: 'GPU → Host' },
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
  { name: 'pcie_total_bytes_per_second', label: 'PCIe total' },
  { name: 'pcie_rx_bytes_per_second', label: 'PCIe RX' },
  { name: 'pcie_tx_bytes_per_second', label: 'PCIe TX' },
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

const pcieChartMetrics: readonly ChartDescriptor[] = [
  {
    name: 'pcie_rx_bytes_per_second',
    key: 'pcie_rx',
    label: 'Host → GPU',
    color: 'var(--primary)',
    strokeWidth: 2,
  },
  {
    name: 'pcie_tx_bytes_per_second',
    key: 'pcie_tx',
    label: 'GPU → Host',
    color: 'var(--chart-2)',
    strokeWidth: 2,
  },
];

const instanceHistoryMetrics = [
  ...instanceChartMetrics,
  ...pcieChartMetrics,
] as const;
const physicalHistoryMetrics = [
  ...physicalChartMetrics,
  ...pcieChartMetrics,
] as const;

type Props = {
  selection: Selection;
  attribution?: Attribution;
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

function liveMetric(
  entity: GPU | GpuInstance,
  name: string,
): Metric | undefined {
  if (name !== 'pcie_total_bytes_per_second') return entity.metrics[name];
  const rx = entity.metrics.pcie_rx_bytes_per_second;
  const tx = entity.metrics.pcie_tx_bytes_per_second;
  const rxValue = metricValue(rx);
  const txValue = metricValue(tx);
  if (rxValue == null || txValue == null) {
    const missing = rxValue == null ? rx : tx;
    const basis = missing ?? rx ?? tx;
    return basis
      ? {
          ...basis,
          value: null,
          unit: 'bytes_per_second',
          source: 'synthetic',
          status: missing?.status ?? 'stale',
          message: 'Exact PCIe total requires both RX and TX metrics',
        }
      : undefined;
  }
  return {
    ...rx,
    value: rxValue + txValue,
    unit: 'bytes_per_second',
    source: 'synthetic',
    status: 'available',
    message: 'RX + TX',
  };
}

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

function chartRowsForMetrics(
  series: HistorySeries | null,
  metrics: readonly ChartDescriptor[],
  percentage = false,
): ChartRow[] {
  const keys = metrics.map(({ key }) => key);
  const rows: ChartRow[] =
    series?.points.map((point) => {
      const numericPoint = point as typeof point & { time?: number };
      const row: ChartRow = {
        time: numericPoint.time ?? new Date(numericPoint.sampledAt).getTime(),
      };
      for (const descriptor of metrics) {
        const value = point.values[descriptor.name];
        row[descriptor.key] = Number.isFinite(value) ? value : null;
      }
      return row;
    }) ?? [];
  const averaged = movingAverageChartRows(rows, keys);
  if (percentage) {
    for (const row of averaged) {
      for (const key of keys) {
        const value = row[key];
        if (typeof value === 'number') row[key] = clampRenderedPercent(value);
      }
    }
  }
  return downsampleChartRows(averaged, keys, 720);
}

function hasChartValues(
  rows: readonly ChartRow[],
  metrics: readonly ChartDescriptor[],
): boolean {
  return rows.some((row) =>
    metrics.some(({ key }) => typeof row[key] === 'number'),
  );
}

export function appendHistoryPoint(
  series: HistorySeries,
  point: ReturnType<typeof currentHistoryPoint>,
  windowMilliseconds: number,
): HistorySeries {
  return {
    ...series,
    points: mergeOverviewPoints(
      series.points,
      [point],
      point.sampledAt,
      windowMilliseconds,
    ),
  };
}

type DetailHistoryState = {
  key: string;
  series: HistorySeries | null;
  error: string | null;
};

class DetailHistoryStore {
  private state: DetailHistoryState = {
    key: '',
    series: null,
    error: null,
  };
  private listeners = new Set<() => void>();
  private latestKey = '';
  private latestPoint: ReturnType<typeof currentHistoryPoint> | null = null;

  readonly getSnapshot = () => this.state;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  begin(key: string) {
    this.latestKey = key;
    this.latestPoint = null;
    if (this.state.key !== key || this.state.error)
      this.publish({ key, series: null, error: null });
  }

  mergeLivePoint(
    key: string,
    point: ReturnType<typeof currentHistoryPoint>,
    windowMilliseconds: number,
  ) {
    if (this.latestKey !== key) return;
    this.latestPoint = point;
    if (this.state.key !== key || !this.state.series) return;
    this.publish({
      ...this.state,
      series: appendHistoryPoint(this.state.series, point, windowMilliseconds),
    });
  }

  resolve(key: string, series: HistorySeries, windowMilliseconds: number) {
    if (this.latestKey !== key) return;
    this.publish({
      key,
      series: this.latestPoint
        ? appendHistoryPoint(series, this.latestPoint, windowMilliseconds)
        : series,
      error: null,
    });
  }

  reject(key: string, error: string) {
    if (this.latestKey !== key) return;
    this.publish({ key, series: null, error });
  }

  private publish(next: DetailHistoryState) {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

export default function DetailSheet({
  selection,
  attribution,
  open,
  onOpenChange,
  loadHistory,
  chartWindowMs,
  retentionMs,
  onChartWindowChange,
}: Props) {
  const [historyStore] = useState(() => new DetailHistoryStore());
  const physical = selection.kind === 'physical_gpu';
  const gpu = selection.gpu;
  const source = physical ? gpu : selection.gi;
  const historyEntity = physical ? gpu.uuid : selection.gi.uuid;
  const liveMetrics = physical ? physicalLiveMetrics : instanceLiveMetrics;
  const chartMetrics = physical ? physicalChartMetrics : instanceChartMetrics;
  const historyMetrics = physical
    ? physicalHistoryMetrics
    : instanceHistoryMetrics;
  const historyKey = `${historyEntity}:${chartWindowMs}`;
  const currentPoint = useMemo(
    () => currentHistoryPoint(source, historyMetrics),
    [historyMetrics, source],
  );
  const historyState = useSyncExternalStore(
    historyStore.subscribe,
    historyStore.getSnapshot,
    historyStore.getSnapshot,
  );
  const attributionTargets = [
    selection.kind === 'physical_gpu'
      ? { entityType: 'physical_gpu' as const, entityUuid: gpu.uuid }
      : {
          entityType: 'compute_instance' as const,
          entityUuid: selection.ci.uuid,
        },
  ];

  useEffect(() => {
    let active = true;
    historyStore.begin(historyKey);
    loadHistory(
      historyEntity,
      historyMetrics.map(({ name }) => name),
      durationQuery(chartWindowMs),
    )
      .then((data) => {
        if (active) historyStore.resolve(historyKey, data, chartWindowMs);
      })
      .catch((reason: unknown) => {
        if (active)
          historyStore.reject(
            historyKey,
            reason instanceof Error ? reason.message : 'History unavailable',
          );
      });
    return () => {
      active = false;
    };
  }, [
    chartWindowMs,
    historyEntity,
    historyMetrics,
    historyKey,
    historyStore,
    loadHistory,
  ]);

  useEffect(() => {
    historyStore.mergeLivePoint(historyKey, currentPoint, chartWindowMs);
  }, [chartWindowMs, currentPoint, historyKey, historyStore]);

  const retainedSeries =
    historyState.key === historyKey ? historyState.series : null;
  const series = retainedSeries;
  const historyError =
    historyState.key === historyKey ? historyState.error : null;
  const chartData = useMemo(() => {
    return chartRowsForMetrics(series, chartMetrics, true);
  }, [chartMetrics, series]);
  const pcieChartData = useMemo(
    () => chartRowsForMetrics(series, pcieChartMetrics),
    [series],
  );
  const pcieAvailable = hasChartValues(pcieChartData, pcieChartMetrics);
  const memory = memoryPercent(source.memory);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="frost-sheet w-full overflow-y-auto border-input bg-popover"
        style={{ width: 'min(640px, 100vw)', maxWidth: '640px' }}
        data-testid="detail-sheet"
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
                GPU {gpu.index} · {gpu.pciBusId || 'PCI bus unavailable'}
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
                GPU {gpu.index} · GI {selection.gi.id} · CI {selection.ci.id}
              </SheetDescription>
            </>
          )}
        </SheetHeader>

        <div className="space-y-5 px-5 pb-8">
          {selection.kind === 'compute_instance' &&
          selection.gi.computeInstances.length > 1 ? (
            <div className="border border-amber-500/30 bg-amber-500/[0.06] p-3 text-xs text-amber-700 dark:text-amber-300">
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
                const metric = liveMetric(source, name);
                return (
                  <div key={name} className="bg-card p-3">
                    <p className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                      {label}
                    </p>
                    <p className="mt-1 font-mono text-lg font-semibold text-primary">
                      {formatMetric(metric)}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>

          <AttributionDetails
            attribution={attribution}
            targets={attributionTargets}
          />

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
            <div
              className="h-44 border border-border bg-card p-2"
              data-testid="detail-history-chart"
            >
              {historyError ? (
                <div className="grid h-full place-items-center text-xs text-amber-700 dark:text-amber-300">
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
                  initialDimension={{ width: 590, height: 176 }}
                >
                  <LineChart
                    data={chartData}
                    margin={{ top: 14, right: 8, left: 0, bottom: 2 }}
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
                      allowDataOverflow
                      interval={0}
                      tickFormatter={(value: number) =>
                        formatRoundedPercent(value)
                      }
                      tick={{ fontSize: 9, fill: 'var(--muted-foreground)' }}
                      axisLine={false}
                      tickLine={false}
                      ticks={[0, 25, 50, 75, 100]}
                      tickMargin={4}
                      padding={{ top: 6, bottom: 4 }}
                      width={44}
                    />
                    <Tooltip
                      isAnimationActive={false}
                      wrapperStyle={{ zIndex: 50, pointerEvents: 'none' }}
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

          <section aria-labelledby="pcie-history-title">
            <div className="mb-2">
              <h3
                id="pcie-history-title"
                className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
              >
                {formatDuration(chartWindowMs)} PCIe transfer
              </h3>
            </div>
            <div
              className="h-44 border border-border bg-card p-2"
              data-testid="detail-pcie-chart"
            >
              {historyError ? (
                <div className="grid h-full place-items-center text-xs text-amber-700 dark:text-amber-300">
                  {historyError}
                </div>
              ) : pcieChartData.length < 2 ? (
                <div className="grid h-full place-items-center text-xs text-muted-foreground">
                  Collecting history…
                </div>
              ) : !pcieAvailable ? (
                <div className="grid h-full place-items-center text-xs text-muted-foreground">
                  PCIe transfer metrics unavailable.
                </div>
              ) : (
                <ResponsiveContainer
                  width="100%"
                  height="100%"
                  minWidth={0}
                  initialDimension={{ width: 590, height: 176 }}
                >
                  <LineChart
                    data={pcieChartData}
                    margin={{ top: 14, right: 8, left: 0, bottom: 2 }}
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
                      domain={[
                        0,
                        (maximum: number) =>
                          maximum > 0 ? Math.ceil(maximum * 1.08) : 1,
                      ]}
                      tickFormatter={(value: number) =>
                        formatBytesPerSecond(value)
                      }
                      tick={{ fontSize: 9, fill: 'var(--muted-foreground)' }}
                      axisLine={false}
                      tickLine={false}
                      tickMargin={4}
                      width={72}
                    />
                    <Tooltip
                      isAnimationActive={false}
                      wrapperStyle={{ zIndex: 50, pointerEvents: 'none' }}
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
                        formatBytesPerSecond(Number(value)),
                        String(name),
                      ]}
                    />
                    {pcieChartMetrics.map((descriptor) => (
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
                  {memory == null ? '—' : formatPercent(memory)}
                </p>
              </div>
              <Progress
                value={memory ?? 0}
                aria-label={
                  physical ? 'Full GPU memory used' : 'GPU instance memory used'
                }
                className={`mt-2 ${memory != null && memory >= 85 ? '[&_[data-slot=progress-indicator]]:bg-amber-400' : '[&_[data-slot=progress-indicator]]:bg-primary'}`}
              />
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
        </div>
      </SheetContent>
    </Sheet>
  );
}
