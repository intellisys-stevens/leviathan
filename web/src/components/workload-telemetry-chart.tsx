import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import {
  buildTrendRows,
  trendBucketMilliseconds,
  trendTimeDomain,
  trendValueSummary,
} from '../chart-trend';
import { formatPercent, formatRoundedPercent } from '../lib';
import type { ChartRow, LoadAlignedHistory } from '../overview-history';
import {
  currentWorkloadRow,
  loadWorkloadHistory,
  mergeWorkloadRows,
  workloadHistoryKeys,
  type WorkloadHistoryEntity,
  type WorkloadTelemetryEntity,
} from '../workload-history';
import {
  ChartTooltipPortal,
  chartTooltipPortalWrapperStyle,
} from './chart-tooltip-portal';
import { ChartWindowControl } from './chart-window-control';
import { MetricIcon } from './metric-icon';
import { SegmentedControl } from './segmented-control';

type TelemetryMetric = 'activity' | 'memory';

type Props = {
  ownerKey: string;
  ownerName: string;
  sampledAt: string;
  entities: readonly WorkloadTelemetryEntity[];
  loadHistory: LoadAlignedHistory;
  chartWindowMs: number;
  retentionMs: number;
  onChartWindowChange: (milliseconds: number) => void;
};

type HistoryState = {
  requestGeneration: number;
  scopeSignature: string;
  queryKey: string;
  rows: ChartRow[];
  loading: boolean;
  error: string | null;
};

type TooltipDatum = {
  color?: string;
  dataKey?: string | number | ((object: unknown) => unknown);
  name?: string | number;
  value?: number | string | readonly (number | string)[];
  payload?: ChartRow;
};

const colors = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
];
const dashPatterns = ['', '7 3', '2 3', '10 3 2 3', '5 3 1 3', '1 3'];
const completedHistoryCache = new Map<string, ChartRow[]>();
const completedHistoryCacheLimit = 32;
const pendingHistoryRequests = new Map<string, Promise<ChartRow[]>>();
const pendingHistoryRequestLimit = 32;

function cacheCompletedHistory(key: string, rows: ChartRow[]) {
  completedHistoryCache.delete(key);
  completedHistoryCache.set(key, rows);
  while (completedHistoryCache.size > completedHistoryCacheLimit) {
    const oldest = completedHistoryCache.keys().next().value;
    if (oldest == null) break;
    completedHistoryCache.delete(oldest);
  }
}

export function clearWorkloadHistoryCache() {
  completedHistoryCache.clear();
  pendingHistoryRequests.clear();
}

function sharedHistoryRequest(
  queryKey: string,
  loadHistory: LoadAlignedHistory,
  entities: readonly WorkloadHistoryEntity[],
  chartWindowMs: number,
): Promise<ChartRow[]> {
  const pending = pendingHistoryRequests.get(queryKey);
  if (pending) return pending;

  const request = loadWorkloadHistory(loadHistory, entities, chartWindowMs);
  pendingHistoryRequests.set(queryKey, request);
  while (pendingHistoryRequests.size > pendingHistoryRequestLimit) {
    const oldest = pendingHistoryRequests.keys().next().value;
    if (oldest == null) break;
    pendingHistoryRequests.delete(oldest);
  }
  void request.then(
    (rows) => {
      if (pendingHistoryRequests.get(queryKey) === request) {
        cacheCompletedHistory(queryKey, rows);
        pendingHistoryRequests.delete(queryKey);
      }
    },
    () => {
      if (pendingHistoryRequests.get(queryKey) === request)
        pendingHistoryRequests.delete(queryKey);
    },
  );
  return request;
}

export function AssignedTelemetryTooltip({
  active,
  anchorRef,
  coordinate,
  label,
  payload,
  bucketMilliseconds,
}: {
  active?: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  coordinate?: { x: number; y: number };
  label?: string | number;
  payload?: readonly TooltipDatum[];
  bucketMilliseconds: number;
}) {
  const visible = payload?.filter(
    ({ value }) => typeof value === 'number' && Number.isFinite(value),
  );
  return (
    <ChartTooltipPortal
      active={active && Boolean(visible?.length)}
      anchorRef={anchorRef}
      coordinate={coordinate}
      testId="assigned-telemetry-tooltip"
    >
      <div className="rounded-lg border border-border bg-popover px-3 py-2 text-[13px] shadow-xl">
        <p className="mb-1 font-mono text-muted-foreground">
          {new Date(Number(label)).toLocaleTimeString()}
        </p>
        <div className="space-y-1">
          {visible?.map((item) => {
            const dataKey = String(item.dataKey);
            const summary = trendValueSummary(item.payload, dataKey);
            return (
              <div
                key={dataKey}
                className="min-w-52 border-t border-border/60 py-1.5 first:border-0 first:pt-0 last:pb-0"
              >
                <div className="flex items-center justify-between gap-4">
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
                    <span
                      aria-hidden="true"
                      className="h-0.5 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: item.color }}
                    />
                    <span className="truncate">{item.name}</span>
                  </span>
                  <span className="font-mono font-medium text-foreground">
                    Trend {formatRoundedPercent(Number(item.value))}
                  </span>
                </div>
                <p className="mt-1 font-mono text-[12px] text-muted-foreground">
                  Source latest{' '}
                  {summary.latest == null
                    ? '—'
                    : formatRoundedPercent(summary.latest)}{' '}
                  · min{' '}
                  {summary.minimum == null
                    ? '—'
                    : formatRoundedPercent(summary.minimum)}{' '}
                  · max{' '}
                  {summary.maximum == null
                    ? '—'
                    : formatRoundedPercent(summary.maximum)}{' '}
                  · {summary.count} {summary.count === 1 ? 'sample' : 'samples'}
                  {summary.partial ? ' · live bucket' : ''}
                </p>
              </div>
            );
          })}
        </div>
        <p className="mt-1 border-t border-border/60 pt-1 font-mono text-[12px] text-muted-foreground">
          {bucketMilliseconds / 1000}s bucket trend
        </p>
      </div>
    </ChartTooltipPortal>
  );
}

function AssignedTelemetryPlot({
  rows,
  entities,
  metric,
  chartWindowMs,
}: {
  rows: ChartRow[];
  entities: readonly WorkloadTelemetryEntity[];
  metric: TelemetryMetric;
  chartWindowMs: number;
}) {
  const tooltipAnchorRef = useRef<HTMLDivElement>(null);
  const latestTime = rows.at(-1)?.time ?? 0;
  const domain = trendTimeDomain(latestTime, chartWindowMs);
  const bucketMilliseconds = trendBucketMilliseconds(chartWindowMs);
  return (
    <div ref={tooltipAnchorRef} className="h-full w-full">
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        initialDimension={{ width: 600, height: 192 }}
      >
        <LineChart
          data={rows}
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        >
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="time"
            type="number"
            domain={[domain[0], domain[1]]}
            tickCount={4}
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
            ticks={[0, 25, 50, 75, 100]}
            tickFormatter={(value: number) => formatRoundedPercent(value)}
            tick={{ fontSize: 13, fill: 'var(--muted-foreground)' }}
            axisLine={false}
            tickLine={false}
            tickMargin={4}
            width={44}
          />
          <Tooltip
            isAnimationActive={false}
            portal={typeof document === 'undefined' ? undefined : document.body}
            wrapperStyle={chartTooltipPortalWrapperStyle}
            content={(tooltip) => (
              <AssignedTelemetryTooltip
                active={tooltip.active}
                anchorRef={tooltipAnchorRef}
                coordinate={tooltip.coordinate}
                label={tooltip.label}
                payload={tooltip.payload}
                bucketMilliseconds={bucketMilliseconds}
              />
            )}
          />
          {entities.map((entity, index) => {
            const keys = workloadHistoryKeys(index);
            return (
              <Line
                key={entity.key}
                type="linear"
                dataKey={keys[metric]}
                name={entity.label}
                stroke={colors[index % colors.length]}
                strokeWidth={2}
                strokeDasharray={dashPatterns[index % dashPatterns.length]}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function WorkloadTelemetryChart({
  ownerKey,
  ownerName,
  sampledAt,
  entities,
  loadHistory,
  chartWindowMs,
  retentionMs,
  onChartWindowChange,
}: Props) {
  const [metric, setMetric] = useState<TelemetryMetric>('activity');
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [history, setHistory] = useState<HistoryState>({
    requestGeneration: -1,
    scopeSignature: '',
    queryKey: '',
    rows: [],
    loading: false,
    error: null,
  });
  const signature = useMemo(
    () =>
      JSON.stringify(
        entities.map(({ key, entity, activityMetric }) => ({
          key,
          entity,
          activityMetric,
        })),
      ),
    [entities],
  );
  const historyEntities = useMemo(
    () => JSON.parse(signature) as WorkloadHistoryEntity[],
    [signature],
  );
  const queryKey = `${ownerKey}\u0000${signature}\u0000${chartWindowMs}`;

  useEffect(() => {
    if (historyEntities.length === 0) return;
    const cached = completedHistoryCache.get(queryKey);
    if (cached) return;
    let active = true;
    void sharedHistoryRequest(
      queryKey,
      loadHistory,
      historyEntities,
      chartWindowMs,
    )
      .then((rows) => {
        if (!active) return;
        setHistory({
          requestGeneration: retryGeneration,
          scopeSignature: signature,
          queryKey,
          rows,
          loading: false,
          error: null,
        });
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setHistory((current) => ({
          requestGeneration: retryGeneration,
          scopeSignature: signature,
          queryKey,
          rows: current.scopeSignature === signature ? current.rows : [],
          loading: false,
          error:
            reason instanceof Error
              ? reason.message
              : 'Assigned telemetry history unavailable',
        }));
      });
    return () => {
      active = false;
    };
  }, [
    chartWindowMs,
    historyEntities,
    loadHistory,
    queryKey,
    retryGeneration,
    signature,
  ]);

  const currentRow = useMemo(
    () => currentWorkloadRow(sampledAt, entities),
    [entities, sampledAt],
  );
  const cachedRows = completedHistoryCache.get(queryKey);
  const historyMatches =
    history.queryKey === queryKey &&
    history.requestGeneration === retryGeneration;
  const retainedRows = history.scopeSignature === signature ? history.rows : [];
  const baseRows = cachedRows ?? (historyMatches ? history.rows : retainedRows);
  const historyLoading = cachedRows
    ? false
    : historyMatches
      ? history.loading
      : true;
  const historyError = cachedRows || !historyMatches ? null : history.error;
  const visibleRows = useMemo(
    () =>
      currentRow
        ? mergeWorkloadRows(baseRows, currentRow, chartWindowMs)
        : baseRows,
    [baseRows, chartWindowMs, currentRow],
  );
  useEffect(() => {
    if (!currentRow) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setHistory((current) => {
        const cached = completedHistoryCache.get(queryKey);
        if (cached) {
          const rows = mergeWorkloadRows(cached, currentRow, chartWindowMs);
          cacheCompletedHistory(queryKey, rows);
          return current.queryKey === queryKey ? { ...current, rows } : current;
        }
        if (current.scopeSignature !== signature) return current;
        const rows = mergeWorkloadRows(current.rows, currentRow, chartWindowMs);
        if (current.queryKey === queryKey && !current.loading && !current.error)
          cacheCompletedHistory(queryKey, rows);
        return { ...current, rows };
      });
    });
    return () => {
      active = false;
    };
  }, [chartWindowMs, currentRow, queryKey, signature]);

  const valueKeys = useMemo(
    () => entities.map((_, index) => workloadHistoryKeys(index)[metric]),
    [entities, metric],
  );
  const trendRows = useMemo(
    () => buildTrendRows(visibleRows, valueKeys, chartWindowMs),
    [chartWindowMs, valueKeys, visibleRows],
  );
  const hasValues = trendRows.some((row) =>
    valueKeys.some((key) => typeof row[key] === 'number'),
  );
  const latest = visibleRows.at(-1);

  if (entities.length === 0) {
    return (
      <section
        className="workload-telemetry border border-dashed border-border/80 bg-background/45 px-4 py-5 text-center text-[13px] text-muted-foreground"
        aria-label="Assigned telemetry"
      >
        No allocated GPU telemetry.
      </section>
    );
  }

  return (
    <section
      className="workload-telemetry min-w-0 border border-border/70 bg-background/45 p-3"
      aria-labelledby="workload-telemetry-heading"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h4
            id="workload-telemetry-heading"
            className="text-[15px] font-semibold"
          >
            Assigned telemetry
          </h4>
          <p className="text-[13px] text-muted-foreground">
            Device-scoped signals, not user usage.
          </p>
        </div>
        <div className="workload-telemetry-controls flex min-w-0 flex-wrap items-center gap-2">
          <SegmentedControl
            ariaLabel="Assigned telemetry metric"
            options={
              [
                {
                  value: 'activity',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <MetricIcon metric="gpu_activity" className="size-3.5" />
                      Activity
                    </span>
                  ),
                },
                {
                  value: 'memory',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <MetricIcon metric="memory" className="size-3.5" />
                      Memory
                    </span>
                  ),
                },
              ] as const
            }
            value={metric}
            onValueChange={setMetric}
            itemClassName="px-2.5"
          />
          <ChartWindowControl
            chartWindowMs={chartWindowMs}
            retentionMs={retentionMs}
            onChartWindowChange={onChartWindowChange}
            ariaLabel="Assigned telemetry window"
          />
        </div>
      </div>

      <ul
        className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1"
        aria-label={`${ownerName} assigned telemetry series`}
      >
        {entities.map((entity, index) => {
          const value = latest?.[workloadHistoryKeys(index)[metric]];
          return (
            <li
              key={entity.key}
              aria-label={entity.accessibleLabel}
              className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[13px] text-muted-foreground"
            >
              <svg aria-hidden="true" width="18" height="5" viewBox="0 0 18 5">
                <line
                  x1="0"
                  y1="2.5"
                  x2="18"
                  y2="2.5"
                  stroke={colors[index % colors.length]}
                  strokeWidth="2"
                  strokeDasharray={dashPatterns[index % dashPatterns.length]}
                  strokeLinecap="round"
                />
              </svg>
              <span className="truncate">{entity.label}</span>
              <span className="text-foreground">
                {typeof value === 'number' ? formatPercent(value) : '—'}
              </span>
            </li>
          );
        })}
      </ul>

      <figure
        className="workload-telemetry-chart chart-plot-frame mt-2 h-48 min-w-0"
        aria-label={`${ownerName} assigned resource ${metric} trend`}
        aria-busy={historyLoading}
      >
        {!hasValues ? (
          <div className="grid h-full place-items-center px-4 text-center text-[13px] text-muted-foreground">
            <span>
              {historyError ??
                (historyLoading
                  ? 'Loading assigned telemetry…'
                  : 'Collecting assigned telemetry…')}
              {historyError ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mx-auto mt-3 flex"
                  onClick={() => setRetryGeneration((value) => value + 1)}
                >
                  Retry history
                </Button>
              ) : null}
            </span>
          </div>
        ) : (
          <AssignedTelemetryPlot
            rows={trendRows}
            entities={entities}
            metric={metric}
            chartWindowMs={chartWindowMs}
          />
        )}
      </figure>
      {historyError && hasValues ? (
        <output className="mt-2 flex items-center justify-between gap-3 border border-amber-500/25 bg-amber-500/[0.05] px-3 py-2 text-[13px] text-amber-700 dark:text-amber-300">
          <span>History unavailable. Last complete data retained.</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setRetryGeneration((value) => value + 1)}
          >
            Retry
          </Button>
        </output>
      ) : null}
    </section>
  );
}
