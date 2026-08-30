import { useMemo, useState } from 'react';
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
import { formatDuration } from '../chart-window';
import {
  downsampleChartRows,
  movingAverageChartRows,
  type ChartRow,
  type OverviewEntity,
  type OverviewPoint,
  useOverviewHistory,
} from '../overview-history';
import type { HistorySeries, Snapshot } from '../types';
import type { ConnectionState } from '../use-miglens';
import { ChartWindowControl } from './chart-window-control';

const colors = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
];
export { movingAverageChartRows } from '../overview-history';

type ChartMetric =
  | 'temperature'
  | 'utilization'
  | 'memory_percent'
  | 'memory_activity';

type PanelDefinition = {
  id: string;
  title: string;
  metric: ChartMetric;
  description: string;
  unit: '°C' | '%';
  entities: OverviewEntity[];
};

type Props = {
  snapshot: Snapshot;
  connection: ConnectionState;
  chartWindowMs: number;
  retentionMs: number;
  onChartWindowChange: (milliseconds: number) => void;
  loadHistory: (
    entity: string,
    metrics: string[],
    window?: string,
  ) => Promise<HistorySeries>;
};

type SeriesDescriptor = {
  entity: OverviewEntity;
  valueKey: string;
};

type TooltipDatum = {
  color?: string;
  dataKey?: string | number;
  name?: string | number;
  value?: number | string | readonly (number | string)[];
};

export function SeriesTooltip({
  active,
  payload,
  label,
  activeDataKey,
  unit,
}: {
  active?: boolean;
  payload?: readonly TooltipDatum[];
  label?: string | number;
  activeDataKey: string | null;
  unit: '°C' | '%';
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
      className="rounded border border-border bg-popover px-3 py-2 text-[11px] shadow-lg"
      data-testid="overview-tooltip"
    >
      <p className="mb-1 font-mono text-[9px] text-muted-foreground">
        {new Date(Number(label)).toLocaleString()}
      </p>
      <div className="space-y-1">
        {visible.map((item) => (
          <div
            key={String(item.dataKey)}
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
            <span className="font-mono font-medium text-foreground">
              {Number(item.value).toFixed(unit === '°C' ? 0 : 1)}
              {unit}
            </span>
          </div>
        ))}
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
): { rows: ChartRow[]; valueKeys: string[]; availableSeries: number } {
  const valueKeys = entities.map((_, index) => `series_${index}`);
  const rowsByTime = new Map<number, ChartRow>();
  const seriesWithValues = new Set<number>();

  entities.forEach((entity, index) => {
    for (const point of points[entity.key] ?? []) {
      const time = new Date(point.sampledAt).getTime();
      if (!Number.isFinite(time)) continue;
      let row = rowsByTime.get(time);
      if (!row) {
        row = { time };
        for (const key of valueKeys) row[key] = null;
        rowsByTime.set(time, row);
      }
      const value = overviewMetricValue(point, metric, entity.scope);
      row[valueKeys[index]] = value;
      if (value != null) seriesWithValues.add(index);
    }
  });

  const rows = [...rowsByTime.values()].sort(
    (left, right) => left.time - right.time,
  );
  const averagedRows = movingAverageChartRows(rows, valueKeys);
  return {
    rows: downsampleChartRows(averagedRows, valueKeys, 360),
    valueKeys,
    availableSeries: seriesWithValues.size,
  };
}

function ChartLegend({
  entities,
  valueKeys,
  activeKey,
  pinnedKey,
  onEnter,
  onLeave,
  onToggle,
}: {
  entities: OverviewEntity[];
  valueKeys: string[];
  activeKey: string | null;
  pinnedKey: string | null;
  onEnter: (key: string) => void;
  onLeave: () => void;
  onToggle: (key: string) => void;
}) {
  return (
    <div className="flex min-h-5 flex-wrap gap-x-3 gap-y-1">
      {entities.map((entity, index) => (
        <button
          type="button"
          key={entity.key}
          className={`inline-flex items-center gap-1.5 rounded-sm px-1.5 py-1 font-mono text-[9px] outline-none transition-[color,background-color,opacity] duration-150 focus-visible:ring-1 focus-visible:ring-ring ${
            activeKey === entity.key
              ? 'bg-accent text-foreground'
              : activeKey
                ? 'text-muted-foreground opacity-40'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
          }`}
          data-series={valueKeys[index]}
          aria-label={`Focus ${entity.label}`}
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
              strokeLinecap="round"
            />
          </svg>
          {entity.label}
        </button>
      ))}
    </div>
  );
}

function ChartPanel({
  definition,
  points,
  loading,
  failedEntities,
  connection,
  rangeLabel,
}: {
  definition: PanelDefinition;
  points: Record<string, OverviewPoint[]>;
  loading: boolean;
  failedEntities: string[];
  connection: ConnectionState;
  rangeLabel: string;
}) {
  const { entities, metric, title, description, unit } = definition;
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const { rows, valueKeys, availableSeries } = useMemo(
    () => chartRows(entities, points, metric),
    [entities, metric, points],
  );
  const timestampsWithValues = rows.filter((row) =>
    valueKeys.some((key) => typeof row[key] === 'number'),
  ).length;
  const failedCount = entities.filter((entity) =>
    failedEntities.includes(entity.key),
  ).length;
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
  const percent = unit === '%';

  return (
    <section
      className="min-w-0 border border-border/75 bg-card/90 p-4"
      aria-labelledby={`${definition.id}-heading`}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 id={`${definition.id}-heading`} className="text-sm font-semibold">
            {title}
          </h2>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {description}
          </p>
        </div>
        <Badge
          variant="outline"
          className={`shrink-0 rounded font-mono text-[8px] uppercase ${
            stateLabel === 'live'
              ? 'text-primary'
              : stateLabel === 'unavailable'
                ? 'text-muted-foreground'
                : 'text-amber-500'
          }`}
        >
          {stateLabel}
        </Badge>
      </div>

      <ChartLegend
        entities={entities}
        valueKeys={valueKeys}
        activeKey={activeKey}
        pinnedKey={currentPinnedKey}
        onEnter={setHoveredKey}
        onLeave={() => setHoveredKey(null)}
        onToggle={(key) =>
          setPinnedKey((current) => (current === key ? null : key))
        }
      />

      <figure
        className="mt-2 h-56 min-w-0"
        aria-label={`${title} over ${rangeLabel}`}
      >
        {emptyMessage ? (
          <div className="grid h-full place-items-center border border-dashed border-border/80 text-xs text-muted-foreground">
            {emptyMessage}
          </div>
        ) : (
          <ResponsiveContainer
            width="100%"
            height="100%"
            minWidth={0}
            initialDimension={{ width: 600, height: 224 }}
          >
            <LineChart
              data={rows}
              margin={{ top: 8, right: 8, left: -18, bottom: 0 }}
            >
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="time"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickCount={4}
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
                domain={
                  percent
                    ? [0, 100]
                    : [
                        (minimum: number) =>
                          Math.max(0, Math.floor(minimum - 5)),
                        (maximum: number) => Math.ceil(maximum + 5),
                      ]
                }
                tickFormatter={(value) => `${value}${unit}`}
                tick={{ fontSize: 9, fill: 'var(--muted-foreground)' }}
                axisLine={false}
                tickLine={false}
                width={52}
              />
              <Tooltip
                isAnimationActive={false}
                content={
                  <SeriesTooltip activeDataKey={activeDataKey} unit={unit} />
                }
              />
              {orderedSeries.map(({ entity, valueKey }) => {
                const focused = activeKey === entity.key;
                const muted = activeKey !== null && !focused;
                return (
                  <Line
                    key={`${focused ? 'focused' : muted ? 'muted' : 'default'}:${entity.key}`}
                    className={`overview-series ${
                      focused
                        ? 'overview-series-focused'
                        : muted
                          ? 'overview-series-muted'
                          : 'overview-series-default'
                    }`}
                    type="monotoneX"
                    dataKey={valueKey}
                    name={entity.label}
                    stroke={colors[entity.colorIndex % colors.length]}
                    strokeWidth={focused ? 3 : muted ? 1.5 : 2.25}
                    strokeOpacity={muted ? 0.18 : focused ? 1 : 0.9}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                    unit={unit}
                    style={{
                      transition:
                        'stroke-opacity 160ms ease, stroke-width 160ms ease',
                    }}
                  />
                );
              })}
            </LineChart>
          </ResponsiveContainer>
        )}
      </figure>
    </section>
  );
}

export function OverviewCharts({
  snapshot,
  connection,
  chartWindowMs,
  retentionMs,
  onChartWindowChange,
  loadHistory,
}: Props) {
  const { entities, points, loading, failedEntities } = useOverviewHistory(
    snapshot,
    loadHistory,
    chartWindowMs,
    retentionMs,
  );
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
        id: 'temperature-chart',
        title: 'Temperature',
        metric: 'temperature',
        description: `${rangeLabel} · Physical GPUs`,
        unit: '°C',
        entities: physicalEntities,
      },
      {
        id: 'utilization-chart',
        title: 'Utilization',
        metric: 'utilization',
        description: `${rangeLabel} · SM activity by GI · GPU activity for full GPUs`,
        unit: '%',
        entities: activityEntities,
      },
      {
        id: 'memory-chart',
        title: 'Memory',
        metric: 'memory_percent',
        description: `${rangeLabel} · Instance memory used`,
        unit: '%',
        entities: activityEntities,
      },
      {
        id: 'memory-activity-chart',
        title: 'Memory Activity',
        metric: 'memory_activity',
        description: `${rangeLabel} · DRAM activity by GI · memory activity for full GPUs`,
        unit: '%',
        entities: activityEntities,
      },
    ],
    [activityEntities, physicalEntities, rangeLabel],
  );

  return (
    <>
      <ChartWindowControl
        chartWindowMs={chartWindowMs}
        retentionMs={retentionMs}
        onChartWindowChange={onChartWindowChange}
        className="mt-4"
      />
      <div
        className="mt-2 grid grid-cols-1 gap-4 md:grid-cols-2"
        aria-label={`${rangeLabel} GPU history`}
      >
        {definitions.map((definition) => (
          <ChartPanel
            key={definition.id}
            definition={definition}
            points={points}
            loading={loading}
            failedEntities={failedEntities}
            connection={connection}
            rangeLabel={rangeLabel}
          />
        ))}
      </div>
    </>
  );
}

export default OverviewCharts;
