import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Activity, Database, Gauge, Layers3 } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
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
const detailDashPatterns = ['', '7 3', '2 3'];

const instanceHistoryMetrics = [
  ...instanceChartMetrics,
  ...pcieChartMetrics,
] as const;
const physicalHistoryMetrics = [
  ...physicalChartMetrics,
  ...pcieChartMetrics,
] as const;

function MetricLegend({
  label,
  metrics,
}: {
  label: string;
  metrics: readonly ChartDescriptor[];
}) {
  return (
    <ul className="mb-2 flex flex-wrap gap-x-3 gap-y-1" aria-label={label}>
      {metrics.map((metric, index) => (
        <li
          key={metric.key}
          className="inline-flex items-center gap-1.5 font-mono text-[13px] text-muted-foreground"
        >
          <svg aria-hidden="true" width="18" height="5" viewBox="0 0 18 5">
            <line
              x1="0"
              y1="2.5"
              x2="18"
              y2="2.5"
              stroke={metric.color}
              strokeWidth="2"
              strokeDasharray={detailDashPatterns[index]}
              strokeLinecap="round"
            />
          </svg>
          {metric.label}
        </li>
      ))}
    </ul>
  );
}

function MetricDataSummary({
  title,
  rows,
  metrics,
  format,
}: {
  title: string;
  rows: ChartRow[];
  metrics: readonly ChartDescriptor[];
  format: (value: number) => string;
}) {
  return (
    <details className="mt-2 border border-border/70 bg-card/55 px-3 py-2">
      <summary className="cursor-pointer font-mono text-[13px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Current / minimum / maximum data
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[25rem] text-left font-mono text-[13px]">
          <caption className="sr-only">{title} data summary</caption>
          <thead className="uppercase tracking-[0.06em] text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">Metric</th>
              <th className="px-3 py-1 font-medium">Current</th>
              <th className="px-3 py-1 font-medium">Minimum</th>
              <th className="pl-3 py-1 font-medium">Maximum</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {metrics.map((metric) => {
              const values = rows.flatMap((row) => {
                const value = row[metric.key];
                return typeof value === 'number' && Number.isFinite(value)
                  ? [value]
                  : [];
              });
              const printable = (value: number | undefined) =>
                value == null ? 'Unavailable' : format(value);
              return (
                <tr key={metric.key}>
                  <th className="py-1.5 pr-3 font-medium">{metric.label}</th>
                  <td className="px-3 py-1.5">{printable(values.at(-1))}</td>
                  <td className="px-3 py-1.5">
                    {printable(values.length ? Math.min(...values) : undefined)}
                  </td>
                  <td className="pl-3 py-1.5">
                    {printable(values.length ? Math.max(...values) : undefined)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

type DetailSheetBaseProps = {
  selection: Selection;
  attribution?: Attribution;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete?: (open: boolean) => void;
};

type DetailSheetHistoryProps = {
  historyMode?: 'full';
  loadHistory: (
    entity: string,
    metrics: string[],
    window?: string,
  ) => Promise<HistorySeries>;
  chartWindowMs: number;
  retentionMs: number;
  onChartWindowChange: (milliseconds: number) => void;
};

type DetailSheetLiveOnlyProps = {
  historyMode: 'live-only';
  loadHistory?: never;
  chartWindowMs?: never;
  retentionMs?: never;
  onChartWindowChange?: never;
};

type Props = DetailSheetBaseProps &
  (DetailSheetHistoryProps | DetailSheetLiveOnlyProps);

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

function ActivityHistoryPlot({
  data,
  metrics,
  interactive = true,
}: {
  data: ChartRow[];
  metrics: readonly ChartDescriptor[];
  interactive?: boolean;
}) {
  return (
    <ResponsiveContainer
      width="100%"
      height="100%"
      minWidth={0}
      initialDimension={{ width: 590, height: 176 }}
    >
      <LineChart data={data} margin={{ top: 14, right: 8, left: 0, bottom: 2 }}>
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
          tick={{ fontSize: 13, fill: 'var(--muted-foreground)' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          domain={[0, 100]}
          allowDataOverflow
          interval={0}
          tickFormatter={(value: number) => formatRoundedPercent(value)}
          tick={{ fontSize: 13, fill: 'var(--muted-foreground)' }}
          axisLine={false}
          tickLine={false}
          ticks={[0, 25, 50, 75, 100]}
          tickMargin={4}
          padding={{ top: 6, bottom: 4 }}
          width={44}
        />
        {interactive ? (
          <Tooltip
            isAnimationActive={false}
            wrapperStyle={{ zIndex: 50, pointerEvents: 'none' }}
            contentStyle={{
              background: 'var(--popover)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 13,
            }}
            labelFormatter={(value) =>
              new Date(Number(value)).toLocaleTimeString()
            }
            formatter={(value, name) => [
              formatRoundedPercent(Number(value)),
              String(name),
            ]}
          />
        ) : null}
        {metrics.map((descriptor, index) => (
          <Line
            key={descriptor.key}
            type="monotoneX"
            dataKey={descriptor.key}
            name={descriptor.label}
            stroke={descriptor.color}
            strokeWidth={descriptor.strokeWidth}
            strokeDasharray={detailDashPatterns[index]}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function PCIeHistoryPlot({
  data,
  interactive = true,
}: {
  data: ChartRow[];
  interactive?: boolean;
}) {
  return (
    <ResponsiveContainer
      width="100%"
      height="100%"
      minWidth={0}
      initialDimension={{ width: 590, height: 176 }}
    >
      <LineChart data={data} margin={{ top: 14, right: 8, left: 0, bottom: 2 }}>
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
          tick={{ fontSize: 13, fill: 'var(--muted-foreground)' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          domain={[
            0,
            (maximum: number) => (maximum > 0 ? Math.ceil(maximum * 1.08) : 1),
          ]}
          tickFormatter={(value: number) => formatBytesPerSecond(value)}
          tick={{ fontSize: 13, fill: 'var(--muted-foreground)' }}
          axisLine={false}
          tickLine={false}
          tickMargin={4}
          width={72}
        />
        {interactive ? (
          <Tooltip
            isAnimationActive={false}
            wrapperStyle={{ zIndex: 50, pointerEvents: 'none' }}
            contentStyle={{
              background: 'var(--popover)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 13,
            }}
            labelFormatter={(value) =>
              new Date(Number(value)).toLocaleTimeString()
            }
            formatter={(value, name) => [
              formatBytesPerSecond(Number(value)),
              String(name),
            ]}
          />
        ) : null}
        {pcieChartMetrics.map((descriptor, index) => (
          <Line
            key={descriptor.key}
            type="monotoneX"
            dataKey={descriptor.key}
            name={descriptor.label}
            stroke={descriptor.color}
            strokeWidth={descriptor.strokeWidth}
            strokeDasharray={detailDashPatterns[index]}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
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
  entity: string;
  loadedKey: string;
  loadedWindowMilliseconds: number | null;
  series: HistorySeries | null;
  outgoingSeries: HistorySeries | null;
  error: string | null;
  loading: boolean;
};

class DetailHistoryStore {
  private state: DetailHistoryState = {
    key: '',
    entity: '',
    loadedKey: '',
    loadedWindowMilliseconds: null,
    series: null,
    outgoingSeries: null,
    error: null,
    loading: false,
  };
  private listeners = new Set<() => void>();
  private latestKey = '';
  private latestPoint: ReturnType<typeof currentHistoryPoint> | null = null;
  private transitionTimer: ReturnType<typeof setTimeout> | null = null;

  readonly getSnapshot = () => this.state;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  begin(key: string, entity: string) {
    this.latestKey = key;
    this.latestPoint = null;
    if (this.state.key !== key || this.state.error) {
      this.clearTransition();
      this.publish({
        ...this.state,
        key,
        entity,
        series: this.state.entity === entity ? this.state.series : null,
        outgoingSeries: null,
        error: null,
        loading: true,
      });
    }
  }

  mergeLivePoint(
    key: string,
    point: ReturnType<typeof currentHistoryPoint>,
    windowMilliseconds: number,
  ) {
    if (this.latestKey !== key) return;
    this.latestPoint = point;
    if (this.state.key !== key || !this.state.series || this.state.loading)
      return;
    this.publish({
      ...this.state,
      series: appendHistoryPoint(this.state.series, point, windowMilliseconds),
    });
  }

  resolve(key: string, series: HistorySeries, windowMilliseconds: number) {
    if (this.latestKey !== key) return;
    const outgoingSeries =
      this.state.loadedWindowMilliseconds != null &&
      this.state.loadedWindowMilliseconds !== windowMilliseconds &&
      this.state.series
        ? this.state.series
        : null;
    this.publish({
      key,
      entity: this.state.entity,
      loadedKey: key,
      loadedWindowMilliseconds: windowMilliseconds,
      series: this.latestPoint
        ? appendHistoryPoint(series, this.latestPoint, windowMilliseconds)
        : series,
      outgoingSeries,
      error: null,
      loading: false,
    });
    if (outgoingSeries) {
      this.transitionTimer = setTimeout(() => {
        this.transitionTimer = null;
        if (this.state.outgoingSeries !== outgoingSeries) return;
        this.publish({ ...this.state, outgoingSeries: null });
      }, 140);
    }
  }

  reject(key: string, error: string) {
    if (this.latestKey !== key) return;
    this.publish({ ...this.state, key, error, loading: false });
  }

  private publish(next: DetailHistoryState) {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private clearTransition() {
    if (this.transitionTimer == null) return;
    clearTimeout(this.transitionTimer);
    this.transitionTimer = null;
  }
}

export default function DetailSheet(props: Props) {
  const { selection, attribution, open, onOpenChange, onOpenChangeComplete } =
    props;
  const liveOnly = props.historyMode === 'live-only';
  const historyProps = liveOnly ? null : props;
  const loadHistory = historyProps?.loadHistory ?? null;
  const chartWindowMs = historyProps?.chartWindowMs ?? 0;
  const retentionMs = historyProps?.retentionMs ?? 0;
  const onChartWindowChange =
    historyProps?.onChartWindowChange ?? (() => undefined);
  const [historyStore] = useState(() => new DetailHistoryStore());
  const [historyRetry, setHistoryRetry] = useState(0);
  const physical = selection.kind === 'physical_gpu';
  const gpu = selection.gpu;
  const physicalLabel = gpu.migEnabled ? 'Physical GPU' : 'Full GPU';
  const source = physical ? gpu : selection.gi;
  const historyEntity = physical ? gpu.uuid : selection.gi.uuid;
  const liveMetrics = physical ? physicalLiveMetrics : instanceLiveMetrics;
  const chartMetrics = physical ? physicalChartMetrics : instanceChartMetrics;
  const historyMetrics = physical
    ? physicalHistoryMetrics
    : instanceHistoryMetrics;
  const historyKey = `${historyEntity}:${chartWindowMs}:${historyRetry}`;
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
    if (!loadHistory) return;
    let active = true;
    historyStore.begin(historyKey, historyEntity);
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
    if (liveOnly) return;
    historyStore.mergeLivePoint(historyKey, currentPoint, chartWindowMs);
  }, [chartWindowMs, currentPoint, historyKey, historyStore, liveOnly]);

  const series =
    historyState.entity === historyEntity ? historyState.series : null;
  const outgoingSeries =
    historyState.entity === historyEntity ? historyState.outgoingSeries : null;
  const historyError =
    historyState.key === historyKey ? historyState.error : null;
  const chartData = useMemo(() => {
    return chartRowsForMetrics(series, chartMetrics, true);
  }, [chartMetrics, series]);
  const pcieChartData = useMemo(
    () => chartRowsForMetrics(series, pcieChartMetrics),
    [series],
  );
  const outgoingChartData = useMemo(
    () =>
      outgoingSeries
        ? chartRowsForMetrics(outgoingSeries, chartMetrics, true)
        : null,
    [chartMetrics, outgoingSeries],
  );
  const outgoingPCIeChartData = useMemo(
    () =>
      outgoingSeries
        ? chartRowsForMetrics(outgoingSeries, pcieChartMetrics)
        : null,
    [outgoingSeries],
  );
  const pcieAvailable = hasChartValues(pcieChartData, pcieChartMetrics);
  const memory = memoryPercent(source.memory);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <SheetContent
        className="mobile-detail-sheet frost-sheet w-full max-w-none overflow-y-auto border-input bg-popover md:max-w-[640px]"
        data-testid="detail-sheet"
      >
        <SheetHeader className="mobile-detail-sheet-header border-b border-border px-5 py-5 pr-14">
          <div className="flex min-w-0 items-start gap-3">
            <span
              className="grid size-9 shrink-0 place-items-center rounded-lg border border-primary/15 bg-primary/10 text-primary"
              aria-hidden="true"
            >
              {physical ? (
                <Gauge className="size-4.5" />
              ) : (
                <Layers3 className="size-4.5" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <SheetTitle
                className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xl font-semibold tracking-[-0.025em]"
                aria-label={
                  physical ? `GPU ${gpu.index} · ${physicalLabel}` : undefined
                }
              >
                <span>
                  {physical
                    ? `GPU ${gpu.index}`
                    : `GPU ${gpu.index} · GI ${selection.gi.id} · CI ${selection.ci.id}`}
                </span>
                {physical ? (
                  <Badge
                    variant="outline"
                    className="rounded font-mono text-[13px] tracking-normal"
                  >
                    {physicalLabel}
                  </Badge>
                ) : null}
              </SheetTitle>
              {selection.kind === 'physical_gpu' ? (
                <SheetDescription className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                  <span className="font-medium text-foreground/80">
                    {gpu.name}
                  </span>
                  <span aria-hidden="true" className="text-border">
                    ·
                  </span>
                  <span className="font-mono">
                    {gpu.pciBusId || 'PCI bus unavailable'}
                  </span>
                </SheetDescription>
              ) : (
                <SheetDescription className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      GI
                    </span>
                    <span className="font-mono text-foreground/80">
                      {selection.gi.profile}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      CI
                    </span>
                    <span className="font-mono text-foreground/80">
                      {selection.ci.profile}
                    </span>
                  </span>
                </SheetDescription>
              )}
            </div>
          </div>
        </SheetHeader>

        <div className="space-y-5 px-5 pb-8">
          {selection.kind === 'compute_instance' &&
          selection.gi.computeInstances.length > 1 ? (
            <div className="border border-amber-500/30 bg-amber-500/[0.06] p-3 text-[13px] text-amber-700 dark:text-amber-300">
              GI metrics are shared by {selection.gi.computeInstances.length}{' '}
              CIs.
            </div>
          ) : null}

          <section aria-labelledby="metrics-title">
            <h3
              id="metrics-title"
              className="mb-2 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
            >
              <Activity className="size-3.5" /> Live metrics
            </h3>
            <div className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4">
              {liveMetrics.map(({ name, label }) => {
                const metric = liveMetric(source, name);
                return (
                  <div key={name} className="bg-card p-3">
                    <p className="text-[13px] uppercase tracking-[0.08em] text-muted-foreground">
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

          {liveOnly ? (
            <section
              aria-labelledby="live-snapshot-title"
              className="border border-primary/20 bg-primary/[0.05] p-3"
              data-testid="detail-live-snapshot-note"
            >
              <h3
                id="live-snapshot-title"
                className="text-[13px] font-semibold uppercase tracking-[0.1em] text-primary"
              >
                Live snapshot only
              </h3>
              <p className="mt-1 text-[13px] text-muted-foreground">
                This view shows the latest telemetry snapshot. Historical
                activity and PCIe series are not retained for this source.
              </p>
            </section>
          ) : (
            <>
              <section aria-labelledby="history-title">
                <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <h3
                    id="history-title"
                    className="text-[13px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
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
                <MetricLegend
                  label="Activity chart series"
                  metrics={chartMetrics}
                />
                <div
                  className="chart-plot-frame h-44 p-2"
                  data-testid="detail-history-chart"
                  aria-busy={historyState.loading}
                >
                  {chartData.length < 2 ? (
                    <div className="grid h-full place-items-center text-center text-[13px] text-amber-700 dark:text-amber-300">
                      <span>
                        {historyError ?? 'Collecting history…'}
                        {historyError ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="mx-auto mt-3 flex"
                            onClick={() =>
                              setHistoryRetry((value) => value + 1)
                            }
                          >
                            Retry history
                          </Button>
                        ) : null}
                      </span>
                    </div>
                  ) : (
                    <div className="relative h-full">
                      <div
                        className={`chart-plot-layer ${outgoingChartData ? 'chart-plot-incoming' : ''}`}
                      >
                        <ActivityHistoryPlot
                          data={chartData}
                          metrics={chartMetrics}
                        />
                      </div>
                      {outgoingChartData ? (
                        <div
                          className="chart-plot-layer chart-plot-outgoing"
                          aria-hidden="true"
                        >
                          <ActivityHistoryPlot
                            data={outgoingChartData}
                            metrics={chartMetrics}
                            interactive={false}
                          />
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
                {historyError && chartData.length >= 2 ? (
                  <output className="mt-2 flex items-center justify-between gap-3 border border-amber-500/25 bg-amber-500/[0.05] px-3 py-2 text-[13px] text-amber-700 dark:text-amber-300">
                    <span>{historyError}. Last complete history retained.</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setHistoryRetry((value) => value + 1)}
                    >
                      Retry
                    </Button>
                  </output>
                ) : null}
                <MetricDataSummary
                  title="Activity history"
                  rows={chartData}
                  metrics={chartMetrics}
                  format={formatRoundedPercent}
                />
              </section>

              <section aria-labelledby="pcie-history-title">
                <div className="mb-2">
                  <h3
                    id="pcie-history-title"
                    className="text-[13px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
                  >
                    {formatDuration(chartWindowMs)} PCIe transfer
                  </h3>
                </div>
                <MetricLegend
                  label="PCIe transfer chart series"
                  metrics={pcieChartMetrics}
                />
                <div
                  className="chart-plot-frame h-44 p-2"
                  data-testid="detail-pcie-chart"
                  aria-busy={historyState.loading}
                >
                  {pcieChartData.length < 2 ? (
                    <div className="grid h-full place-items-center text-sm text-muted-foreground">
                      {historyError ?? 'Collecting history…'}
                    </div>
                  ) : !pcieAvailable ? (
                    <div className="grid h-full place-items-center text-[13px] text-muted-foreground">
                      PCIe transfer metrics unavailable.
                    </div>
                  ) : (
                    <div className="relative h-full">
                      <div
                        className={`chart-plot-layer ${outgoingPCIeChartData ? 'chart-plot-incoming' : ''}`}
                      >
                        <PCIeHistoryPlot data={pcieChartData} />
                      </div>
                      {outgoingPCIeChartData ? (
                        <div
                          className="chart-plot-layer chart-plot-outgoing"
                          aria-hidden="true"
                        >
                          <PCIeHistoryPlot
                            data={outgoingPCIeChartData}
                            interactive={false}
                          />
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
                <MetricDataSummary
                  title="PCIe transfer history"
                  rows={pcieChartData}
                  metrics={pcieChartMetrics}
                  format={formatBytesPerSecond}
                />
              </section>
            </>
          )}

          <section aria-label={physical ? 'GPU memory' : 'Instance memory'}>
            <div className="border border-border bg-card p-3">
              <p className="mb-2 flex items-center gap-2 text-[13px] uppercase tracking-[0.08em] text-muted-foreground">
                <Database className="size-3" />{' '}
                {physical ? `${physicalLabel} memory` : 'GI memory'}
              </p>
              <div className="flex items-end justify-between gap-2">
                <p className="font-mono text-sm font-semibold">
                  {formatBytes(source.memory.usedBytes)} /{' '}
                  {formatBytes(source.memory.totalBytes)}
                </p>
                <p className="font-mono text-[13px] text-muted-foreground">
                  {memory == null ? '—' : formatPercent(memory)}
                </p>
              </div>
              <Progress
                value={memory}
                aria-label={
                  physical
                    ? `${physicalLabel} memory used`
                    : 'GPU instance memory used'
                }
                className={`mt-2 ${memory != null && memory >= 85 ? '[&_[data-slot=progress-indicator]]:bg-amber-400' : '[&_[data-slot=progress-indicator]]:bg-primary'}`}
              />
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
