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
import { buildTrendRows, trendTimeDomain } from '../chart-trend';
import { formatBytesPerSecond, formatRoundedPercent } from '../lib';
import type { ChartRow, LoadAlignedHistory } from '../overview-history';
import { useChartTooltips } from '../use-chart-tooltips';
import {
  rawHistoryWindowMilliseconds,
  useHistoryRefreshGeneration,
} from '../use-history-refresh';
import { useTrendCeiling } from '../use-trend-ceiling';
import {
  currentWorkloadRow,
  loadWorkloadHistory,
  mergeWorkloadRows,
  workloadHistoryKeys,
  type WorkloadHistoryEntity,
  type WorkloadHistoryKeys,
  type WorkloadTelemetryEntity,
} from '../workload-history';
import {
  ChartTooltipPortal,
  chartTooltipPortalWrapperStyle,
} from './chart-tooltip-portal';
import { ChartWindowControl } from './chart-window-control';
import { MetricIcon, type MetricVisualKey } from './metric-icon';

type TelemetryMetric = Exclude<keyof WorkloadHistoryKeys, 'descriptor'>;
type TelemetryUnit = 'percent' | 'bytes_per_second';

type TelemetryDefinition = {
  metric: TelemetryMetric;
  title: string;
  icon: MetricVisualKey;
  unit: TelemetryUnit;
};

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
const telemetryDefinitions: readonly TelemetryDefinition[] = [
  {
    metric: 'activity',
    title: 'Activity',
    icon: 'gpu_activity',
    unit: 'percent',
  },
  {
    metric: 'memory',
    title: 'Memory usage',
    icon: 'memory',
    unit: 'percent',
  },
  {
    metric: 'memoryActivity',
    title: 'Memory activity',
    icon: 'memory_activity',
    unit: 'percent',
  },
  {
    metric: 'pcieTotal',
    title: 'PCIe transfer',
    icon: 'pcie_total_bytes_per_second',
    unit: 'bytes_per_second',
  },
];
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

function valueFormatter(unit: TelemetryUnit, value: number): string {
  return unit === 'bytes_per_second'
    ? formatBytesPerSecond(value)
    : formatRoundedPercent(value);
}

export function AssignedTelemetryTooltip({
  active,
  anchorRef,
  coordinate,
  label,
  payload,
  unit = 'percent',
  testId = 'assigned-telemetry-tooltip',
}: {
  active?: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  coordinate?: { x: number; y: number };
  label?: string | number;
  payload?: readonly TooltipDatum[];
  unit?: TelemetryUnit;
  testId?: string;
}) {
  const visible = payload?.filter(
    ({ value }) => typeof value === 'number' && Number.isFinite(value),
  );
  return (
    <ChartTooltipPortal
      active={active && Boolean(visible?.length)}
      anchorRef={anchorRef}
      coordinate={coordinate}
      testId={testId}
    >
      <div className="rounded-lg border border-border bg-popover px-3 py-2 text-[13px] shadow-xl">
        <p className="mb-1 font-mono text-muted-foreground">
          {new Date(Number(label)).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
        </p>
        <div className="space-y-1">
          {visible?.map((item) => {
            const dataKey = String(item.dataKey);
            return (
              <div
                key={dataKey}
                className="flex min-w-40 items-center justify-between gap-4"
              >
                <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <span
                    aria-hidden="true"
                    className="h-0.5 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="truncate">{item.name}</span>
                </span>
                <span className="whitespace-nowrap font-mono font-medium text-foreground">
                  {valueFormatter(unit, Number(item.value))}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </ChartTooltipPortal>
  );
}

function AssignedTelemetryPlot({
  rows,
  entities,
  metric,
  unit,
  chartWindowMs,
  interactive,
}: {
  rows: ChartRow[];
  entities: readonly WorkloadTelemetryEntity[];
  metric: TelemetryMetric;
  unit: TelemetryUnit;
  chartWindowMs: number;
  interactive: boolean;
}) {
  const tooltipAnchorRef = useRef<HTMLDivElement>(null);
  const latestTime = rows.at(-1)?.time ?? 0;
  const domain = trendTimeDomain(latestTime, chartWindowMs);
  const maximum = Math.max(
    0,
    ...rows.flatMap((row) =>
      entities.flatMap((_, index) => {
        const value = row[workloadHistoryKeys(index)[metric]];
        return typeof value === 'number' && Number.isFinite(value)
          ? [value]
          : [];
      }),
    ),
  );
  const throughputCeiling = useTrendCeiling(maximum);
  const throughput = unit === 'bytes_per_second';
  return (
    <div
      ref={tooltipAnchorRef}
      className="h-full w-full"
      data-chart-curve="linear"
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        initialDimension={{ width: 600, height: 216 }}
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
            allowDataOverflow
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
            domain={throughput ? [0, throughputCeiling] : [0, 100]}
            allowDataOverflow
            interval={throughput ? undefined : 0}
            ticks={throughput ? undefined : [0, 25, 50, 75, 100]}
            tickFormatter={(value: number) =>
              valueFormatter(unit, Number(value))
            }
            tick={{ fontSize: 13, fill: 'var(--muted-foreground)' }}
            axisLine={false}
            tickLine={false}
            tickMargin={4}
            width={throughput ? 72 : 44}
          />
          {interactive ? (
            <Tooltip
              isAnimationActive={false}
              portal={
                typeof document === 'undefined' ? undefined : document.body
              }
              wrapperStyle={chartTooltipPortalWrapperStyle}
              content={(tooltip) => (
                <AssignedTelemetryTooltip
                  active={tooltip.active}
                  anchorRef={tooltipAnchorRef}
                  coordinate={tooltip.coordinate}
                  label={tooltip.label}
                  payload={tooltip.payload}
                  unit={unit}
                  testId={`assigned-${metric}-tooltip`}
                />
              )}
            />
          ) : null}
          {entities.map((entity, index) => (
            <Line
              key={entity.key}
              type="linear"
              dataKey={workloadHistoryKeys(index)[metric]}
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
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function TelemetryLegend({
  ownerName,
  title,
  entities,
  metric,
  unit,
  rows,
}: {
  ownerName: string;
  title: string;
  entities: readonly WorkloadTelemetryEntity[];
  metric: TelemetryMetric;
  unit: TelemetryUnit;
  rows: readonly ChartRow[];
}) {
  const latest = rows.at(-1);
  return (
    <ul
      className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1"
      aria-label={`${ownerName} ${title.toLowerCase()} assigned telemetry series`}
    >
      {entities.map((entity, index) => {
        const value = latest?.[workloadHistoryKeys(index)[metric]];
        const available = typeof value === 'number' && Number.isFinite(value);
        const formatted = available ? valueFormatter(unit, value) : '—';
        return (
          <li
            key={entity.key}
            aria-label={`${entity.accessibleLabel}. ${title} current ${available ? formatted : 'Unavailable'}`}
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
            <span className="chart-legend-value text-foreground">
              {formatted}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function TelemetryPanel({
  definition,
  ownerName,
  entities,
  sourceRows,
  chartWindowMs,
  loading,
  error,
  retry,
  tooltipsEnabled,
}: {
  definition: TelemetryDefinition;
  ownerName: string;
  entities: readonly WorkloadTelemetryEntity[];
  sourceRows: ChartRow[];
  chartWindowMs: number;
  loading: boolean;
  error: string | null;
  retry: () => void;
  tooltipsEnabled: boolean;
}) {
  const valueKeys = useMemo(
    () =>
      entities.map((_, index) => workloadHistoryKeys(index)[definition.metric]),
    [definition.metric, entities],
  );
  const trendRows = useMemo(
    () => buildTrendRows(sourceRows, valueKeys, chartWindowMs),
    [chartWindowMs, sourceRows, valueKeys],
  );
  const hasValues = trendRows.some((row) =>
    valueKeys.some((key) => typeof row[key] === 'number'),
  );

  return (
    <section
      className="workload-telemetry-panel min-w-0 border border-border/70 bg-card/55 p-3"
      aria-labelledby={`workload-${definition.metric}-heading`}
      data-workload-metric={definition.metric}
    >
      <h5
        id={`workload-${definition.metric}-heading`}
        className="flex items-center gap-2 text-[15px] font-semibold"
      >
        <MetricIcon metric={definition.icon} className="size-4 text-primary" />
        {definition.title}
      </h5>
      <TelemetryLegend
        ownerName={ownerName}
        title={definition.title}
        entities={entities}
        metric={definition.metric}
        unit={definition.unit}
        rows={sourceRows}
      />
      <figure
        className="workload-telemetry-chart chart-plot-frame mt-2 h-[200px] min-w-0 lg:h-[216px]"
        aria-label={`${ownerName} assigned resource ${definition.title.toLowerCase()} trend`}
        aria-busy={loading}
      >
        {!hasValues ? (
          <div className="grid h-full place-items-center px-4 text-center text-[13px] text-muted-foreground">
            <span>
              {loading
                ? 'Loading assigned telemetry…'
                : `${definition.title} unavailable.`}
              {error ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mx-auto mt-3 flex"
                  onClick={retry}
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
            metric={definition.metric}
            unit={definition.unit}
            chartWindowMs={chartWindowMs}
            interactive={tooltipsEnabled}
          />
        )}
      </figure>
    </section>
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
  const [retryGeneration, setRetryGeneration] = useState(0);
  const historyRefresh = useHistoryRefreshGeneration(chartWindowMs);
  const includeLiveSamples = chartWindowMs <= rawHistoryWindowMilliseconds;
  const [history, setHistory] = useState<HistoryState>({
    requestGeneration: -1,
    scopeSignature: '',
    queryKey: '',
    rows: [],
    loading: false,
    error: null,
  });
  const tooltipsEnabled = useChartTooltips();
  const signature = useMemo(
    () =>
      JSON.stringify(
        entities.map(
          ({ key, entity, activityMetric, memoryActivityMetric }) => ({
            key,
            entity,
            activityMetric,
            memoryActivityMetric,
          }),
        ),
      ),
    [entities],
  );
  const historyEntities = useMemo(
    () => JSON.parse(signature) as WorkloadHistoryEntity[],
    [signature],
  );
  const queryKey = `${ownerKey}\u0000${signature}\u0000${chartWindowMs}\u0000${historyRefresh}`;

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
      includeLiveSamples && currentRow
        ? mergeWorkloadRows(baseRows, currentRow, chartWindowMs)
        : baseRows,
    [baseRows, chartWindowMs, currentRow, includeLiveSamples],
  );

  useEffect(() => {
    if (!includeLiveSamples || !currentRow) return;
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
  }, [chartWindowMs, currentRow, includeLiveSamples, queryKey, signature]);

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
        <div className="workload-telemetry-controls min-w-0 shrink-0">
          <ChartWindowControl
            chartWindowMs={chartWindowMs}
            retentionMs={retentionMs}
            onChartWindowChange={onChartWindowChange}
            ariaLabel="Assigned telemetry window"
          />
        </div>
      </div>

      <div className="workload-telemetry-grid mt-3 grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
        {telemetryDefinitions.map((definition) => (
          <TelemetryPanel
            key={definition.metric}
            definition={definition}
            ownerName={ownerName}
            entities={entities}
            sourceRows={visibleRows}
            chartWindowMs={chartWindowMs}
            loading={historyLoading}
            error={historyError}
            retry={() => setRetryGeneration((value) => value + 1)}
            tooltipsEnabled={tooltipsEnabled}
          />
        ))}
      </div>

      {historyError && visibleRows.length > 0 ? (
        <output className="mt-3 flex items-center justify-between gap-3 border border-amber-500/25 bg-amber-500/[0.05] px-3 py-2 text-[13px] text-amber-700 dark:text-amber-300">
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
