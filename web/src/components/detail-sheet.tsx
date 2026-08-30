import { useEffect, useMemo, useState } from 'react';
import { Activity, Cpu, Database, Layers3 } from 'lucide-react';
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
import { formatBytes, formatMetric, memoryPercent, shortUUID } from '../lib';
import { durationQuery, formatDuration } from '../chart-window';
import {
  downsampleChartRows,
  movingAverageChartRows,
  type ChartRow,
} from '../overview-history';
import type { GpuInstance, HistorySeries, Selection } from '../types';

const metricNames = [
  ['sm_activity', 'SM activity'],
  ['sm_occupancy', 'SM occupancy'],
  ['tensor_activity', 'Tensor'],
  ['dram_activity', 'DRAM'],
] as const;

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
};

function currentHistoryPoint(gi: GpuInstance) {
  const values: Record<string, number> = {};
  for (const [name] of metricNames) {
    const metric = gi.metrics[name];
    if (metric?.status === 'available' && metric.value != null)
      values[name] = metric.value;
  }
  return { sampledAt: gi.memory.sampledAt, values };
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
}: Props) {
  const [historyState, setHistoryState] = useState<{
    key: string;
    series: HistorySeries | null;
    error: string | null;
  }>({ key: '', series: null, error: null });
  const { gpu, gi, ci } = selection;
  const historyKey = `${gi.uuid}:${chartWindowMs}`;

  useEffect(() => {
    let active = true;
    loadHistory(
      gi.uuid,
      metricNames.map(([name]) => name),
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
  }, [chartWindowMs, gi.uuid, historyKey, loadHistory]);

  const retainedSeries =
    historyState.key === historyKey ? historyState.series : null;
  const series = useMemo(
    () =>
      retainedSeries
        ? appendHistoryPoint(
            retainedSeries,
            currentHistoryPoint(gi),
            chartWindowMs,
          )
        : null,
    [chartWindowMs, gi, retainedSeries],
  );
  const historyError =
    historyState.key === historyKey ? historyState.error : null;
  const chartData = useMemo(() => {
    const keys = ['sm', 'tensor', 'dram'];
    const rows: ChartRow[] =
      series?.points.map((point) => ({
        time: new Date(point.sampledAt).getTime(),
        sm: Number.isFinite(point.values.sm_activity)
          ? point.values.sm_activity
          : null,
        tensor: Number.isFinite(point.values.tensor_activity)
          ? point.values.tensor_activity
          : null,
        dram: Number.isFinite(point.values.dram_activity)
          ? point.values.dram_activity
          : null,
      })) ?? [];
    return downsampleChartRows(movingAverageChartRows(rows, keys), keys, 360);
  }, [series]);
  const memory = memoryPercent(gi.memory);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full overflow-y-auto border-border bg-popover"
        style={{ width: 'min(640px, 100vw)', maxWidth: '640px' }}
      >
        <SheetHeader className="border-b border-border px-5 py-5">
          <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.13em] text-primary">
            <Layers3 className="size-3.5" /> GPU {gpu.index} · GI {gi.id} · CI{' '}
            {ci.id}
          </div>
          <SheetTitle className="flex items-center gap-2 text-lg">
            <Cpu className="size-4 text-primary" /> {gi.profile}
            <Badge variant="outline" className="rounded font-mono text-[10px]">
              {ci.profile}
            </Badge>
          </SheetTitle>
          <SheetDescription className="font-mono text-[10px]">
            {ci.uuid}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-5 pb-8">
          {gi.computeInstances.length > 1 ? (
            <div className="border border-amber-500/30 bg-amber-500/[0.06] p-3 text-xs text-amber-600 dark:text-amber-300">
              GI metrics are shared by {gi.computeInstances.length} CIs.
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
              {metricNames.map(([name, label]) => {
                const metric = gi.metrics[name];
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
            <div className="mb-2 flex items-center justify-between">
              <h3
                id="history-title"
                className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
              >
                {formatDuration(chartWindowMs)} activity
              </h3>
              <span className="font-mono text-[9px] text-muted-foreground">
                in-memory
              </span>
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
                    margin={{ top: 8, right: 8, left: -24, bottom: 0 }}
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
                      tick={{ fontSize: 9, fill: 'var(--muted-foreground)' }}
                      axisLine={false}
                      tickLine={false}
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
                    />
                    <Line
                      type="monotoneX"
                      dataKey="sm"
                      name="SM activity"
                      stroke="var(--primary)"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      dot={false}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                    <Line
                      type="monotoneX"
                      dataKey="tensor"
                      name="Tensor"
                      stroke="var(--chart-2)"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      dot={false}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                    <Line
                      type="monotoneX"
                      dataKey="dram"
                      name="DRAM"
                      stroke="var(--chart-3)"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      dot={false}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </section>

          <section
            className="grid gap-3 sm:grid-cols-2"
            aria-label="Instance facts"
          >
            <div className="border border-border bg-card p-3">
              <p className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                <Database className="size-3" /> GI memory
              </p>
              <div className="flex items-end justify-between gap-2">
                <p className="font-mono text-sm font-semibold">
                  {formatBytes(gi.memory.usedBytes)} /{' '}
                  {formatBytes(gi.memory.totalBytes)}
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
                {gi.memory.source} · {gi.memory.scope} · {gi.memory.status}
              </p>
            </div>
            <div className="border border-border bg-card p-3">
              <p className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                <Layers3 className="size-3" /> Hierarchy
              </p>
              <p className="font-mono text-sm font-semibold">
                GI {gi.id} / CI {ci.id}
              </p>
              <p className="mt-2 font-mono text-[9px] text-muted-foreground">
                {gi.profile} · {ci.profile}
              </p>
            </div>
          </section>

          <p className="font-mono text-[9px] text-muted-foreground">
            Generation {ci.generation} · {shortUUID(gpu.uuid)} / GI {gi.id} / CI{' '}
            {ci.id}
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
