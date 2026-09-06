import { SampledLine } from './sampled-line';
import {
  ChartRenderBoundary,
  useChartVisibility,
} from './chart-render-boundary';
import { memo, useMemo, useRef, useState } from 'react';
import { Cpu, Database, MemoryStick } from 'lucide-react';
import {
  CartesianGrid,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { niceTrendCeiling } from '../chart-trend';
import {
  currentOwnerRow,
  ownerChartRows,
  type OwnerMetricKey,
  type useOwnerHistory,
} from '../owner-history';
import type { WorkloadOwnerTelemetry } from '../types';
import type { ConnectionState } from '../use-leviathan';
import {
  useChartAxisGeometry,
  formatAxisTime,
  formatAxisByteRate,
} from '../use-chart-axis-geometry';
import { useChartTooltips } from '../use-chart-tooltips';
import {
  ChartSelectionReadout,
  compactChartValue,
  useChartSelection,
} from './chart-interaction';
import { TimeAxisTick, StackedRateAxisTick } from './chart-axis-ticks';
import { useChartLegendStrip } from './chart-legend-strip';
import {
  ChartTooltipPortal,
  chartTooltipPortalWrapperStyle,
} from './chart-tooltip-portal';

const definitions = {
  cpu: {
    title: 'CPU used',
    icon: Cpu,
    keys: ['cpu_cores'],
    context: 'Cores are logical-CPU equivalents.',
  },
  ram: {
    title: 'RAM used',
    icon: MemoryStick,
    keys: ['memory_used_bytes'],
    context: 'Cgroup memory charged, including cache.',
  },
  io: {
    title: 'Storage I/O',
    icon: Database,
    keys: ['storage_read_bps', 'storage_write_bps'],
    context: 'Kernel-accounted physical backing-device read and write rates.',
  },
} as const;
const labels: Record<OwnerMetricKey, string> = {
  cpu_cores: 'Used',
  memory_used_bytes: 'Used',
  storage_read_bps: 'Read',
  storage_write_bps: 'Write',
};
const colors = ['var(--chart-1)', 'var(--chart-2)'];

export function formatOwnerValue(
  key: OwnerMetricKey,
  value: number | null | undefined,
  precise = false,
): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (precise)
    return `${value} ${key === 'cpu_cores' ? 'logical-CPU equivalents' : key === 'memory_used_bytes' ? 'bytes' : 'B/s'}`;
  if (key === 'storage_read_bps' || key === 'storage_write_bps')
    return compactChartValue(value, 'bytes_per_second');
  const scaled = key === 'memory_used_bytes' ? value / 2 ** 30 : value;
  const number =
    scaled > 0 && scaled < 0.001
      ? '<0.001'
      : String(Number(scaled.toPrecision(3)));
  return `${number} ${key === 'memory_used_bytes' ? 'GiB' : 'cores'}`;
}

export function ownerMetricState(
  owner: WorkloadOwnerTelemetry | undefined,
  key: OwnerMetricKey,
  connection: ConnectionState,
): string | null {
  if (connection !== 'live') return 'Paused';
  if (!owner) return 'No data';
  if (owner.status === 'stale') return 'Stale';
  if (owner.status === 'unavailable') return 'No data';
  const metric = owner.metrics[key];
  if (metric?.status === 'available' && metric.value != null) return null;
  if (metric?.status === 'estimated') return 'Estimated';
  if (metric?.status === 'stale') return 'Stale';
  if (
    metric?.status === 'unsupported' ||
    metric?.status === 'permission_denied'
  )
    return 'No data';
  if (metric?.message?.startsWith('Partial') || owner.status === 'partial')
    return 'Partial';
  return 'No data';
}

export const OwnerTelemetryPanel = memo(function OwnerTelemetryPanel({
  kind,
  owner,
  ownerName,
  history,
  connection,
}: {
  kind: keyof typeof definitions;
  owner: WorkloadOwnerTelemetry | undefined;
  ownerName: string;
  history: ReturnType<typeof useOwnerHistory>;
  connection: ConnectionState;
}) {
  const definition = definitions[kind];
  const { rows, domain } = useMemo(
    () => ownerChartRows(history.rows, definition.keys, history.windowMs),
    [definition.keys, history.rows, history.windowMs],
  );
  const selection = useChartSelection(
    rows,
    domain,
    `owner:${owner?.ref ?? ownerName}:${kind}`,
  );
  const anchor = useRef<HTMLElement>(null);
  const axis = useChartAxisGeometry(anchor);
  const plotActive = useChartVisibility(anchor);
  const tooltips = useChartTooltips();
  const legend = useChartLegendStrip(
    `${ownerName} ${definition.title}`,
    kind === 'io' ? definition.keys.join(':') : '',
  );
  const [highlighted, setHighlighted] = useState<OwnerMetricKey | null>(null);
  const current = owner && currentOwnerRow(owner);
  const active = selection.selectedRow ?? current;
  const values = rows.flatMap((row) =>
    definition.keys.map((key) => row[key] ?? 0),
  );
  const ceiling = niceTrendCeiling(Math.max(0, ...values));
  const hasValues = rows.some((row) =>
    definition.keys.some((key) => row[key] != null),
  );
  const state = [
    ...new Set(
      definition.keys
        .map((key) => ownerMetricState(owner, key, connection))
        .filter(Boolean),
    ),
  ].join(' · ');
  const Icon = definition.icon;
  return (
    <section
      className={`workload-telemetry-panel compact-chart-panel min-w-0 border border-border/70 bg-card/55 ${kind === 'io' ? 'lg:col-span-2' : ''}`}
      data-owner-metric={kind}
      aria-labelledby={`owner-${kind}-heading`}
    >
      <div className="host-chart-heading">
        <h5
          id={`owner-${kind}-heading`}
          className="flex items-center gap-2 text-[15px] font-semibold"
        >
          <Icon className="size-4 text-primary" aria-hidden="true" />
          {definition.title}
        </h5>
        <div className="chart-heading-actions">
          <span className="host-chart-state">{state}</span>
          {kind === 'io' ? legend.controls : null}
        </div>
      </div>
      <p id={`owner-${kind}-meaning`} className="sr-only">
        {definition.context}
      </p>
      <figure
        {...selection.plotProps}
        ref={anchor}
        className="workload-telemetry-chart chart-plot-frame compact-chart-plot"
        aria-label={`${ownerName} ${definition.title.toLowerCase()} history. ${definition.context}`}
        aria-busy={history.loading}
      >
        {!hasValues ? (
          <div className="host-chart-empty">
            {history.error ??
              (history.loading
                ? 'Loading history…'
                : owner
                  ? 'No measured samples.'
                  : 'Owner telemetry is not configured.')}
          </div>
        ) : (
          <ChartRenderBoundary active={plotActive} layout={axis}>
            <ResponsiveContainer
              width="100%"
              height="100%"
              minWidth={0}
              initialDimension={{ width: 600, height: 160 }}
            >
              <LineChart
                accessibilityLayer={false}
                data={rows}
                margin={{
                  top:
                    kind === 'io' && axis.compactRates
                      ? axis.rateTop
                      : axis.top,
                  right: 8,
                  left: 0,
                  bottom: 4,
                }}
              >
                <CartesianGrid stroke="var(--border)" vertical={false} />
                {selection.selectedTime != null ? (
                  <ReferenceLine
                    x={selection.selectedTime}
                    stroke="var(--primary)"
                    strokeDasharray="3 3"
                  />
                ) : null}
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={[domain[0], domain[1]]}
                  allowDataOverflow
                  tickCount={axis.xTickCount}
                  ticks={axis.singleTimeTick ? [domain[1]] : undefined}
                  interval="preserveStartEnd"
                  minTickGap={axis.minTickGap}
                  height="auto"
                  tickFormatter={formatAxisTime}
                  tick={<TimeAxisTick fontSize={axis.tick.fontSize} />}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  domain={[0, ceiling]}
                  tickCount={3}
                  allowDataOverflow
                  ticks={axis.compactRates ? [0, ceiling] : undefined}
                  tickFormatter={(value: number) =>
                    kind === 'io'
                      ? formatAxisByteRate(value)
                      : formatOwnerValue(definition.keys[0], value)
                  }
                  tick={
                    kind === 'io' && axis.compactRates ? (
                      <StackedRateAxisTick fontSize={axis.tick.fontSize} />
                    ) : (
                      axis.tick
                    )
                  }
                  fontSize={axis.tick.fontSize}
                  padding={
                    kind === 'io' && axis.compactRates
                      ? { bottom: axis.rateBottom }
                      : undefined
                  }
                  axisLine={false}
                  tickLine={false}
                  tickMargin={4}
                  width="auto"
                />
                {plotActive && tooltips && !selection.selectedRow ? (
                  <Tooltip
                    isAnimationActive={false}
                    portal={
                      typeof document === 'undefined'
                        ? undefined
                        : document.body
                    }
                    wrapperStyle={chartTooltipPortalWrapperStyle}
                    content={(tooltip) => (
                      <ChartTooltipPortal
                        active={
                          tooltip.active && Boolean(tooltip.payload?.length)
                        }
                        anchorRef={anchor}
                        coordinate={tooltip.coordinate}
                        testId={`owner-${kind}-tooltip`}
                      >
                        <div className="rounded-lg border border-border bg-popover px-3 py-2 text-[13px] shadow-xl">
                          <p className="font-mono text-muted-foreground">
                            {new Date(
                              Number(tooltip.label),
                            ).toLocaleTimeString()}
                          </p>
                          {tooltip.payload?.map((item) => (
                            <p
                              key={String(item.dataKey)}
                              className="flex justify-between gap-4"
                            >
                              <span>{item.name}</span>
                              <span className="font-mono">
                                {formatOwnerValue(
                                  item.dataKey as OwnerMetricKey,
                                  Number(item.value),
                                )}
                              </span>
                            </p>
                          ))}
                        </div>
                      </ChartTooltipPortal>
                    )}
                  />
                ) : null}
                {definition.keys.map((key, index) => (
                  <SampledLine
                    key={key}
                    type="linear"
                    dataKey={key}
                    name={labels[key]}
                    stroke={colors[index]}
                    strokeWidth={2}
                    strokeOpacity={highlighted && highlighted !== key ? 0.2 : 1}
                    strokeDasharray={index ? '6 3' : undefined}
                    dot={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </ChartRenderBoundary>
        )}
      </figure>
      <div
        {...(kind === 'io' ? legend.props : {})}
        className={`compact-chart-legend ${kind === 'io' ? 'chart-legend-strip' : 'host-chart-legend'}`}
        data-legend-unit={kind === 'io' ? 'bytes_per_second' : undefined}
        aria-label={`${ownerName} ${definition.title.toLowerCase()} series`}
      >
        {definition.keys.map((key, index) => {
          const metricState = ownerMetricState(owner, key, connection);
          const value = selection.selectedRow
            ? active?.[key]
            : metricState
              ? null
              : active?.[key];
          return (
            <button
              key={key}
              type="button"
              onMouseEnter={() => setHighlighted(key)}
              onMouseLeave={() => setHighlighted(null)}
              onFocus={() => setHighlighted(key)}
              onBlur={() => setHighlighted(null)}
              onClick={() => setHighlighted(highlighted === key ? null : key)}
              aria-label={`${labels[key]} ${selection.selectedRow ? 'selected' : 'current'} ${formatOwnerValue(key, value, true)}. ${selection.selectedRow ? '' : (metricState ?? '')} ${definition.context}`}
            >
              <svg aria-hidden="true" width="18" height="5" viewBox="0 0 18 5">
                <line
                  x1="0"
                  y1="2.5"
                  x2="18"
                  y2="2.5"
                  stroke={colors[index]}
                  strokeWidth="2"
                  strokeDasharray={index ? '6 3' : undefined}
                />
              </svg>
              <span data-legend-label>{labels[key]}</span>
              <span data-legend-value>{formatOwnerValue(key, value)}</span>
            </button>
          );
        })}
      </div>
      <ChartSelectionReadout
        selection={selection}
        label={`${ownerName} ${definition.title}`}
        summary={definition.keys
          .map(
            (key) =>
              `${labels[key]}: ${formatOwnerValue(key, selection.selectedRow?.[key], true)}`,
          )
          .join(', ')}
      />
      {history.error ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{history.error} Last complete data retained.</span>
          <Button size="sm" variant="outline" onClick={history.retry}>
            Retry history
          </Button>
        </div>
      ) : null}
    </section>
  );
});
