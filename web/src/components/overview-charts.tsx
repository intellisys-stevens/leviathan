import { memo, useMemo, useRef, useState } from 'react';
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
import {
  buildTrendRows,
  trendTimeDomain,
  trendValueSummary,
} from '../chart-trend';
import { formatDuration } from '../chart-window';
import {
  clampRenderedPercent,
  formatBytesPerSecond,
  formatPercent,
  formatRoundedPercent,
} from '../lib';
import {
  buildOverviewEntities,
  type AlignedHistorySeriesDescriptor,
  type ChartRow,
  type LoadAlignedHistory,
  type OverviewEntity,
  type OverviewPoint,
  useOverviewHistory,
} from '../overview-history';
import type { Snapshot } from '../types';
import type { ConnectionState } from '../use-leviathan';
import { useChartTooltips } from '../use-chart-tooltips';
import { useTrendCeiling } from '../use-trend-ceiling';
import {
  ChartTooltipPortal,
  chartTooltipPortalWrapperStyle,
} from './chart-tooltip-portal';
import { MetricIcon, type MetricVisualKey } from './metric-icon';

const colors = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
];
const dashPatterns = ['', '7 3', '2 3', '10 3 2 3', '5 3 1 3', '1 3'];
const percentageTicks = [0, 25, 50, 75, 100];
type ChartMetric =
  | 'temperature'
  | 'utilization'
  | 'memory_percent'
  | 'memory_activity'
  | 'pcie_total';

type ChartUnit = '°C' | '%' | 'bytes_per_second';

type PanelDefinition = {
  id: string;
  title: string;
  icon: MetricVisualKey;
  metric: ChartMetric;
  description: string;
  unit: ChartUnit;
  entities: OverviewEntity[];
  fullWidth?: boolean;
};

type Props = {
  snapshot: Snapshot;
  connection: ConnectionState;
  chartWindowMs: number;
  retentionMs: number;
  loadHistory: LoadAlignedHistory;
};

type SeriesDescriptor = {
  entity: OverviewEntity;
  valueKey: string;
};

type TooltipDatum = {
  color?: string;
  dataKey?: string | number | ((object: unknown) => unknown);
  name?: string | number;
  value?: number | string | readonly (number | string)[];
  payload?: ChartRow;
};

function seriesDashPattern(colorIndex: number): string {
  const paletteCycle = Math.floor(colorIndex / colors.length);
  return dashPatterns[(colorIndex + paletteCycle) % dashPatterns.length];
}

function historyMetrics(
  metric: ChartMetric,
  scope: OverviewEntity['scope'],
): string[] {
  switch (metric) {
    case 'temperature':
      return ['temperature'];
    case 'utilization':
      return [scope === 'gpu_instance' ? 'sm_activity' : 'gpu_activity'];
    case 'memory_percent':
      return ['memory_used_bytes', 'memory_total_bytes'];
    case 'memory_activity':
      return [scope === 'gpu_instance' ? 'dram_activity' : 'memory_activity'];
    case 'pcie_total':
      return ['pcie_rx_bytes_per_second', 'pcie_tx_bytes_per_second'];
  }
}

function chartValueLabel(value: number, unit: ChartUnit): string {
  if (unit === 'bytes_per_second') return formatBytesPerSecond(value);
  if (unit === '%') return formatPercent(value);
  return `${value.toFixed(0)}${unit}`;
}

export function summarizeSeries(
  rows: ChartRow[],
  valueKey: string,
): { current: number | null; minimum: number | null; maximum: number | null } {
  const source = rows
    .map((row) => trendValueSummary(row, valueKey))
    .filter(({ count }) => count > 0);
  if (source.length > 0) {
    const minimum = source.flatMap(({ minimum }) =>
      minimum == null ? [] : [minimum],
    );
    const maximum = source.flatMap(({ maximum }) =>
      maximum == null ? [] : [maximum],
    );
    return {
      current: source.at(-1)?.latest ?? null,
      minimum: minimum.length > 0 ? Math.min(...minimum) : null,
      maximum: maximum.length > 0 ? Math.max(...maximum) : null,
    };
  }
  const values = rows.flatMap((row) => {
    const value = row[valueKey];
    return typeof value === 'number' && Number.isFinite(value) ? [value] : [];
  });
  return {
    current: values.at(-1) ?? null,
    minimum: values.length > 0 ? Math.min(...values) : null,
    maximum: values.length > 0 ? Math.max(...values) : null,
  };
}

export function SeriesTooltip({
  active,
  payload,
  label,
  activeDataKey,
  unit,
  testId = 'overview-tooltip',
}: {
  active?: boolean;
  payload?: readonly TooltipDatum[];
  label?: string | number;
  activeDataKey: string | null;
  unit: ChartUnit;
  testId?: string;
}) {
  if (!active || !payload?.length) return null;

  const visible = payload.filter(
    (item) =>
      typeof item.value === 'number' &&
      (!activeDataKey || String(item.dataKey) === activeDataKey),
  );
  if (visible.length === 0) return null;

  return (
    <div
      className="max-w-[calc(100vw-2rem)] rounded border border-input bg-popover px-3 py-2 text-[13px] shadow-xl"
      data-testid={testId}
    >
      <p className="mb-1 font-mono text-[13px] text-muted-foreground">
        {new Date(Number(label)).toLocaleString()}
      </p>
      <div
        className={
          visible.length > 6
            ? 'grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2'
            : 'space-y-1'
        }
      >
        {visible.map((item) => {
          const dataKey =
            typeof item.dataKey === 'string' || typeof item.dataKey === 'number'
              ? String(item.dataKey)
              : null;
          return (
            <div
              key={dataKey ?? String(item.name)}
              className="flex min-w-36 items-center justify-between gap-4"
            >
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-0.5 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: item.color }}
                />
                <span className="truncate text-muted-foreground">
                  {item.name}
                </span>
              </span>
              <span className="text-right font-mono font-medium text-foreground">
                {chartValueLabel(Number(item.value), unit)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function overviewMetricValue(
  point: OverviewPoint,
  metric: ChartMetric,
  scope: OverviewEntity['scope'],
): number | null {
  if (metric === 'memory_percent') {
    const used = point.values.memory_used_bytes;
    const total = point.values.memory_total_bytes;
    if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0)
      return null;
    return Math.max(0, Math.min(100, (used / total) * 100));
  }
  if (metric === 'pcie_total') {
    const rx = point.values.pcie_rx_bytes_per_second;
    const tx = point.values.pcie_tx_bytes_per_second;
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) return null;
    return Math.max(0, rx) + Math.max(0, tx);
  }
  const sourceMetric =
    metric === 'utilization'
      ? scope === 'gpu_instance'
        ? 'sm_activity'
        : 'gpu_activity'
      : metric === 'memory_activity' && scope === 'gpu_instance'
        ? 'dram_activity'
        : metric;
  const value = point.values[sourceMetric];
  return Number.isFinite(value) ? value : null;
}

export function chartRows(
  entities: OverviewEntity[],
  points: Record<string, OverviewPoint[]>,
  metric: ChartMetric,
  windowMilliseconds = 30 * 60 * 1000,
): {
  rows: ChartRow[];
  valueKeys: string[];
  availableSeries: number;
  xDomain: readonly [number, number];
} {
  const valueKeys = entities.map((_, index) => `series_${index}`);
  const rowsByTime = new Map<number, ChartRow>();
  const seriesWithValues = new Set<number>();

  entities.forEach((entity, index) => {
    for (const point of points[entity.key] ?? []) {
      const time = point.time ?? new Date(point.sampledAt).getTime();
      if (!Number.isFinite(time)) continue;
      let row = rowsByTime.get(time);
      if (!row) {
        row = { time };
        for (const key of valueKeys) row[key] = null;
        rowsByTime.set(time, row);
      }
      const valueKey = valueKeys[index];
      if (metric === 'pcie_total') {
        const rx = point.values.pcie_rx_bytes_per_second;
        const tx = point.values.pcie_tx_bytes_per_second;
        row[`${valueKey}_rx`] = Number.isFinite(rx) ? Math.max(0, rx) : null;
        row[`${valueKey}_tx`] = Number.isFinite(tx) ? Math.max(0, tx) : null;
        row[valueKey] =
          Number.isFinite(rx) && Number.isFinite(tx)
            ? Math.max(0, rx) + Math.max(0, tx)
            : null;
        if (Number.isFinite(rx) && Number.isFinite(tx))
          seriesWithValues.add(index);
      } else {
        const value = overviewMetricValue(point, metric, entity.scope);
        row[valueKey] =
          value != null &&
          (metric === 'utilization' ||
            metric === 'memory_percent' ||
            metric === 'memory_activity')
            ? clampRenderedPercent(value)
            : value;
        if (value != null) seriesWithValues.add(index);
      }
    }
  });

  const rows = [...rowsByTime.values()].sort(
    (left, right) => left.time - right.time,
  );
  const trendKeys =
    metric === 'pcie_total'
      ? valueKeys.flatMap((key) => [key, `${key}_rx`, `${key}_tx`])
      : valueKeys;
  const latestTime = rows.at(-1)?.time ?? 0;
  return {
    rows: buildTrendRows(rows, trendKeys, windowMilliseconds),
    valueKeys,
    availableSeries: seriesWithValues.size,
    xDomain: trendTimeDomain(latestTime, windowMilliseconds),
  };
}

function ChartLegend({
  entities,
  valueKeys,
  rows,
  unit,
  activeKey,
  pinnedKey,
  onEnter,
  onLeave,
  onToggle,
}: {
  entities: OverviewEntity[];
  valueKeys: string[];
  rows: ChartRow[];
  unit: ChartUnit;
  activeKey: string | null;
  pinnedKey: string | null;
  onEnter: (key: string) => void;
  onLeave: () => void;
  onToggle: (key: string) => void;
}) {
  const mobileLabel = (entity: OverviewEntity) =>
    entity.label.replace(/^GPU (\d+) · GI (\d+)$/, 'G$1 · GI$2');

  return (
    <div
      className="mobile-chart-legend flex min-h-5 flex-wrap gap-x-3 gap-y-1"
      data-series-count={entities.length}
    >
      {entities.map((entity, index) => {
        const current = summarizeSeries(rows, valueKeys[index]).current;
        const currentLabel =
          current == null ? '—' : chartValueLabel(current, unit);
        const accessibleCurrent =
          current == null ? 'Unavailable' : currentLabel;
        return (
          <button
            type="button"
            key={entity.key}
            className={`mobile-chart-legend-item inline-flex min-h-8 items-center gap-1.5 rounded-sm px-1.5 py-1 font-mono text-[13px] outline-none transition-[color,background-color,opacity] duration-[var(--duration-feedback)] ease-[var(--ease-out)] focus-visible:ring-2 focus-visible:ring-ring ${
              activeKey === entity.key
                ? 'bg-accent text-foreground'
                : activeKey
                  ? 'text-muted-foreground opacity-40'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
            }`}
            data-series={valueKeys[index]}
            aria-label={`Focus ${entity.label}. Current ${accessibleCurrent}`}
            aria-pressed={pinnedKey === entity.key}
            onMouseEnter={() => onEnter(entity.key)}
            onMouseLeave={onLeave}
            onFocus={() => onEnter(entity.key)}
            onBlur={onLeave}
            onClick={() => onToggle(entity.key)}
          >
            <svg aria-hidden="true" width="18" height="5" viewBox="0 0 18 5">
              <line
                x1="0"
                y1="2.5"
                x2="18"
                y2="2.5"
                stroke={colors[entity.colorIndex % colors.length]}
                strokeWidth="2"
                strokeDasharray={seriesDashPattern(entity.colorIndex)}
                strokeLinecap="round"
              />
            </svg>
            {mobileLabel(entity) === entity.label ? (
              <span className="truncate">{entity.label}</span>
            ) : (
              <>
                <span className="mobile-only-label truncate">
                  {mobileLabel(entity)}
                </span>
                <span className="desktop-only-label truncate">
                  {entity.label}
                </span>
              </>
            )}
            <span className="ml-auto shrink-0 text-foreground">
              {currentLabel}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function HistoryLinePlot({
  rows,
  xDomain,
  orderedSeries,
  activeKey,
  activeDataKey,
  unit,
  definitionID,
  interactive = true,
}: {
  rows: ChartRow[];
  xDomain: readonly [number, number];
  orderedSeries: SeriesDescriptor[];
  activeKey: string | null;
  activeDataKey: string | null;
  unit: ChartUnit;
  definitionID: string;
  interactive?: boolean;
}) {
  const percent = unit === '%';
  const bounded = percent || unit === '°C';
  const throughput = unit === 'bytes_per_second';
  const throughputMaximum = Math.max(
    0,
    ...rows.flatMap((row) =>
      orderedSeries.flatMap(({ valueKey }) => {
        const value = row[valueKey];
        return typeof value === 'number' && Number.isFinite(value)
          ? [value]
          : [];
      }),
    ),
  );
  const throughputCeiling = useTrendCeiling(throughput ? throughputMaximum : 0);
  const tooltipAnchorRef = useRef<HTMLDivElement>(null);
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
        initialDimension={{ width: 600, height: 224 }}
      >
        <LineChart
          data={rows}
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        >
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="time"
            type="number"
            domain={[xDomain[0], xDomain[1]]}
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
            domain={
              bounded
                ? [0, 100]
                : throughput
                  ? [0, throughputCeiling]
                  : [
                      (minimum: number) => Math.max(0, Math.floor(minimum - 5)),
                      (maximum: number) => Math.ceil(maximum + 5),
                    ]
            }
            allowDataOverflow={bounded || throughput}
            interval={bounded ? 0 : undefined}
            ticks={bounded ? percentageTicks : undefined}
            tickFormatter={(value) =>
              throughput
                ? formatBytesPerSecond(Number(value))
                : percent
                  ? formatRoundedPercent(Number(value))
                  : `${Math.round(Number(value))}${unit}`
            }
            tick={{ fontSize: 13, fill: 'var(--muted-foreground)' }}
            axisLine={false}
            tickLine={false}
            tickMargin={4}
            padding={bounded ? { top: 6, bottom: 4 } : undefined}
            width={throughput ? 72 : bounded ? 44 : 52}
          />
          {interactive ? (
            <Tooltip
              isAnimationActive={false}
              portal={
                typeof document === 'undefined' ? undefined : document.body
              }
              wrapperStyle={chartTooltipPortalWrapperStyle}
              content={(tooltip) => (
                <ChartTooltipPortal
                  active={tooltip.active}
                  anchorRef={tooltipAnchorRef}
                  coordinate={tooltip.coordinate}
                >
                  <SeriesTooltip
                    active={tooltip.active}
                    payload={tooltip.payload}
                    label={tooltip.label}
                    activeDataKey={activeDataKey}
                    unit={unit}
                    testId={`${definitionID}-tooltip`}
                  />
                </ChartTooltipPortal>
              )}
            />
          ) : null}
          {orderedSeries.map(({ entity, valueKey }) => {
            const focused = activeKey === entity.key;
            const muted = activeKey !== null && !focused;
            return (
              <Line
                key={entity.key}
                className={`overview-series ${
                  focused
                    ? 'overview-series-focused'
                    : muted
                      ? 'overview-series-muted'
                      : 'overview-series-default'
                }`}
                type="linear"
                dataKey={valueKey}
                name={entity.label}
                stroke={colors[entity.colorIndex % colors.length]}
                strokeWidth={2}
                strokeOpacity={muted ? 0.18 : focused ? 1 : 0.9}
                strokeDasharray={seriesDashPattern(entity.colorIndex)}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
                unit={unit}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ChartPanel({
  definition,
  snapshot,
  loadHistory,
  chartWindowMs,
  retentionMs,
  connection,
  rangeLabel,
  tooltipsEnabled,
}: {
  definition: PanelDefinition;
  snapshot: Snapshot;
  loadHistory: LoadAlignedHistory;
  chartWindowMs: number;
  retentionMs: number;
  connection: ConnectionState;
  rangeLabel: string;
  tooltipsEnabled: boolean;
}) {
  const { entities, metric, title, description, unit } = definition;
  const descriptors = useMemo<AlignedHistorySeriesDescriptor[]>(
    () =>
      entities.map((entity) => ({
        key: entity.key,
        entity: entity.uuid,
        metrics: historyMetrics(metric, entity.scope),
      })),
    [entities, metric],
  );
  const {
    points,
    loading,
    loadedWindowMilliseconds,
    outgoingPoints,
    outgoingWindowMilliseconds,
    failedEntities,
    error,
    retry,
  } = useOverviewHistory(
    snapshot,
    definition.id,
    entities,
    descriptors,
    loadHistory,
    chartWindowMs,
    retentionMs,
  );
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const visibleTrendWindow = loadedWindowMilliseconds ?? chartWindowMs;
  const retainedData = useMemo(
    () => chartRows(entities, points, metric, visibleTrendWindow),
    [entities, metric, points, visibleTrendWindow],
  );
  const outgoingData = useMemo(
    () =>
      outgoingPoints
        ? chartRows(
            entities,
            outgoingPoints,
            metric,
            outgoingWindowMilliseconds ?? visibleTrendWindow,
          )
        : null,
    [
      entities,
      metric,
      outgoingPoints,
      outgoingWindowMilliseconds,
      visibleTrendWindow,
    ],
  );
  const { rows, valueKeys, availableSeries, xDomain } = retainedData;
  const timestampsWithValues = useMemo(() => {
    let count = 0;
    for (const row of rows) {
      if (!valueKeys.some((key) => typeof row[key] === 'number')) continue;
      count += 1;
      if (count === 2) break;
    }
    return count;
  }, [rows, valueKeys]);
  const failedCount = useMemo(() => {
    const failed = new Set(failedEntities);
    return entities.reduce(
      (count, entity) => count + Number(failed.has(entity.key)),
      0,
    );
  }, [entities, failedEntities]);
  const partial =
    availableSeries > 0 &&
    (availableSeries < entities.length || failedCount > 0);
  const stateLabel =
    connection !== 'live'
      ? 'stream paused'
      : partial
        ? `${availableSeries}/${entities.length} series`
        : loading
          ? 'loading history'
          : availableSeries > 0
            ? 'live'
            : 'unavailable';
  const currentKeys = useMemo(
    () => new Set(entities.map((entity) => entity.key)),
    [entities],
  );
  const currentHoveredKey =
    hoveredKey && currentKeys.has(hoveredKey) ? hoveredKey : null;
  const currentPinnedKey =
    pinnedKey && currentKeys.has(pinnedKey) ? pinnedKey : null;
  const activeKey = currentHoveredKey ?? currentPinnedKey;
  const series = useMemo<SeriesDescriptor[]>(
    () =>
      entities.map((entity, index) => ({
        entity,
        valueKey: valueKeys[index],
      })),
    [entities, valueKeys],
  );
  const orderedSeries = useMemo(
    () =>
      activeKey
        ? [
            ...series.filter(({ entity }) => entity.key !== activeKey),
            ...series.filter(({ entity }) => entity.key === activeKey),
          ]
        : series,
    [activeKey, series],
  );
  const activeDataKey =
    series.find(({ entity }) => entity.key === activeKey)?.valueKey ?? null;
  const emptyMessage =
    connection !== 'live' && availableSeries === 0
      ? 'History disconnected.'
      : loading && availableSeries === 0
        ? 'Loading history…'
        : availableSeries === 0
          ? 'Metric unavailable.'
          : timestampsWithValues < 2
            ? 'Collecting history…'
            : null;
  return (
    <section
      className={`frost-panel relative min-w-0 overflow-visible border border-border/75 bg-card/90 p-4 ${definition.fullWidth ? 'md:col-span-2' : ''}`}
      aria-labelledby={`${definition.id}-heading`}
      data-testid={definition.id}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3
            id={`${definition.id}-heading`}
            className="flex items-center gap-2 text-[17px] font-semibold"
          >
            <MetricIcon
              metric={definition.icon}
              className="size-4 text-primary"
            />
            {title}
          </h3>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {description}
          </p>
        </div>
        <Badge
          variant="outline"
          className={`shrink-0 rounded font-mono text-[13px] uppercase ${
            stateLabel === 'live'
              ? 'text-primary'
              : stateLabel === 'unavailable'
                ? 'text-muted-foreground'
                : 'text-amber-700 dark:text-amber-300'
          }`}
        >
          {stateLabel}
        </Badge>
      </div>

      <ChartLegend
        entities={entities}
        valueKeys={valueKeys}
        rows={rows}
        unit={unit}
        activeKey={activeKey}
        pinnedKey={currentPinnedKey}
        onEnter={setHoveredKey}
        onLeave={() => setHoveredKey(null)}
        onToggle={(key) =>
          setPinnedKey((current) => (current === key ? null : key))
        }
      />

      <figure
        className="chart-plot-frame mt-2 h-56 min-w-0"
        aria-label={`${title} over ${rangeLabel}`}
        aria-busy={loading}
      >
        {emptyMessage ? (
          <div className="grid h-full place-items-center border border-dashed border-border/80 px-4 text-center text-[13px] text-muted-foreground">
            <span>
              {error ?? emptyMessage}
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
          <>
            <div
              className={`chart-plot-layer ${outgoingData ? 'chart-plot-incoming' : ''}`}
              data-window={chartWindowMs}
            >
              <HistoryLinePlot
                rows={rows}
                xDomain={xDomain}
                orderedSeries={orderedSeries}
                activeKey={activeKey}
                activeDataKey={activeDataKey}
                unit={unit}
                definitionID={definition.id}
                interactive={tooltipsEnabled}
              />
            </div>
            {outgoingData ? (
              <div
                className="chart-plot-layer chart-plot-outgoing"
                aria-hidden="true"
              >
                <HistoryLinePlot
                  rows={outgoingData.rows}
                  xDomain={outgoingData.xDomain}
                  orderedSeries={orderedSeries}
                  activeKey={null}
                  activeDataKey={null}
                  unit={unit}
                  definitionID={definition.id}
                  interactive={false}
                />
              </div>
            ) : null}
          </>
        )}
      </figure>
      {error && availableSeries > 0 ? (
        <output className="mt-3 flex items-center justify-between gap-3 border border-amber-500/25 bg-amber-500/[0.05] px-3 py-2 text-[13px] text-amber-700 dark:text-amber-300">
          <span>Some retained history could not be loaded.</span>
          <Button type="button" size="sm" variant="outline" onClick={retry}>
            Retry
          </Button>
        </output>
      ) : null}
      <details className="mt-3 border-t border-border/70 pt-2">
        <summary className="cursor-pointer select-none font-mono text-[13px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Current / minimum / maximum data
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[26rem] text-left text-[13px]">
            <caption className="sr-only">
              {title} current, minimum, and maximum values over {rangeLabel}
            </caption>
            <thead className="font-mono uppercase tracking-[0.06em] text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">Series</th>
                <th className="px-3 py-1 font-medium">Current</th>
                <th className="px-3 py-1 font-medium">Minimum</th>
                <th className="pl-3 py-1 font-medium">Maximum</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60 font-mono">
              {series.map(({ entity, valueKey }) => {
                const summary = summarizeSeries(rows, valueKey);
                const label = (value: number | null) =>
                  value == null ? 'Unavailable' : chartValueLabel(value, unit);
                return (
                  <tr key={entity.key}>
                    <th className="py-1.5 pr-3 font-medium text-foreground">
                      {entity.label}
                    </th>
                    <td className="px-3 py-1.5">{label(summary.current)}</td>
                    <td className="px-3 py-1.5">{label(summary.minimum)}</td>
                    <td className="pl-3 py-1.5">{label(summary.maximum)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

const MemoizedChartPanel = memo(ChartPanel);

export function OverviewCharts({
  snapshot,
  connection,
  chartWindowMs,
  retentionMs,
  loadHistory,
}: Props) {
  const entities = useMemo(() => buildOverviewEntities(snapshot), [snapshot]);
  const tooltipsEnabled = useChartTooltips();
  const rangeLabel = formatDuration(chartWindowMs);
  const physicalEntities = useMemo(
    () => entities.filter((entity) => entity.scope === 'physical_gpu'),
    [entities],
  );
  const activityEntities = useMemo(() => {
    const migGPUs = new Set(
      entities
        .filter((entity) => entity.scope === 'gpu_instance')
        .map((entity) => entity.gpuUUID),
    );
    return entities.filter(
      (entity) =>
        entity.scope === 'gpu_instance' ||
        (entity.scope === 'physical_gpu' && !migGPUs.has(entity.gpuUUID)),
    );
  }, [entities]);
  const definitions: PanelDefinition[] = useMemo(
    () => [
      {
        id: 'utilization-chart',
        title: 'Utilization',
        icon: 'gpu_activity',
        metric: 'utilization',
        description: `SM activity · ${rangeLabel}`,
        unit: '%',
        entities: activityEntities,
      },
      {
        id: 'memory-chart',
        title: 'Memory',
        icon: 'memory',
        metric: 'memory_percent',
        description: `Memory used · ${rangeLabel}`,
        unit: '%',
        entities: activityEntities,
      },
      {
        id: 'temperature-chart',
        title: 'Temperature',
        icon: 'temperature',
        metric: 'temperature',
        description: `Physical GPUs · ${rangeLabel}`,
        unit: '°C',
        entities: physicalEntities,
      },
      {
        id: 'memory-activity-chart',
        title: 'Memory Activity',
        icon: 'memory_activity',
        metric: 'memory_activity',
        description: `Memory activity · ${rangeLabel}`,
        unit: '%',
        entities: activityEntities,
      },
      {
        id: 'pcie-throughput-chart',
        title: 'PCIe Transfer',
        icon: 'pcie_total_bytes_per_second',
        metric: 'pcie_total',
        description: `Host ↔ GPU · ${rangeLabel}`,
        unit: 'bytes_per_second',
        entities: activityEntities,
        fullWidth: true,
      },
    ],
    [activityEntities, physicalEntities, rangeLabel],
  );

  return (
    <section
      className="relative z-10 mt-4 grid grid-cols-1 gap-4 md:grid-cols-2"
      aria-label={`${rangeLabel} GPU history`}
    >
      {definitions.map((definition) => (
        <MemoizedChartPanel
          key={definition.id}
          definition={definition}
          snapshot={snapshot}
          loadHistory={loadHistory}
          chartWindowMs={chartWindowMs}
          retentionMs={retentionMs}
          connection={connection}
          rangeLabel={rangeLabel}
          tooltipsEnabled={tooltipsEnabled}
        />
      ))}
    </section>
  );
}

export default OverviewCharts;
