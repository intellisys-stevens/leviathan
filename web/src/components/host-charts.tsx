import {
  ChartRenderBoundary,
  useChartVisibility,
} from './chart-render-boundary';
import { TimeAxisTick, StackedRateAxisTick } from './chart-axis-ticks';
import {
  memo,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { Cpu, Database, MemoryStick, type LucideIcon } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { formatDuration } from '../chart-window';
import {
  formatBytesPerSecond,
  formatPercent,
  formatRoundedPercent,
} from '../lib';
import {
  currentHostPoints,
  hostChartRows,
  useHostHistory,
  type HostPoints,
  type HostSeriesKey,
} from '../host-history';
import type { ChartRow, LoadAlignedHistory } from '../overview-history';
import type { Snapshot } from '../types';
import type { ConnectionState } from '../use-leviathan';
import { useChartTooltips } from '../use-chart-tooltips';
import { useTrendCeiling } from '../use-trend-ceiling';
import {
  formatAxisByteRate,
  formatAxisTime,
  useChartAxisGeometry,
} from '../use-chart-axis-geometry';
import {
  ChartTooltipPortal,
  chartTooltipPortalWrapperStyle,
} from './chart-tooltip-portal';
import { SegmentedControl } from './segmented-control';
import { SeriesTooltip } from './overview-charts';
import {
  ChartSelectionReadout,
  compactChartValue,
  useChartSelection,
} from './chart-interaction';
import { combinedStatus, statusLabel, usable } from './system-overview';
import './host-overview.css';

const names: Record<HostSeriesKey, string> = {
  cpu: 'Utilization',
  memory: 'Used',
  storage: 'Space used',
  read: 'Read',
  write: 'Write',
};
const colors: Record<HostSeriesKey, string> = {
  cpu: 'var(--chart-1)',
  memory: 'var(--chart-2)',
  storage: 'var(--chart-3)',
  read: 'var(--chart-1)',
  write: 'var(--chart-2)',
};

const HostHistoryPlot = memo(function HostHistoryPlot({
  rows,
  domain,
  keys,
  bytes,
  ceiling,
  axis,
  selectedTime,
  interactive,
  activeKey,
  anchor,
  id,
  plotActive,
}: {
  rows: ChartRow[];
  domain: readonly [number, number];
  keys: HostSeriesKey[];
  bytes: boolean;
  ceiling: number;
  axis: ReturnType<typeof useChartAxisGeometry>;
  selectedTime: number | null;
  interactive: boolean;
  activeKey: HostSeriesKey | null;
  anchor: RefObject<HTMLDivElement | null>;
  id: string;
  plotActive: boolean;
}) {
  return (
    <ChartRenderBoundary active={plotActive} layout={axis}>
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        initialDimension={{ width: 600, height: 224 }}
      >
        <LineChart
          accessibilityLayer={false}
          data={rows}
          margin={{
            top: bytes && axis.compactRates ? axis.rateTop : axis.top,
            right: 8,
            left: 0,
            bottom: 4,
          }}
        >
          <CartesianGrid stroke="var(--border)" vertical={false} />
          {selectedTime != null ? (
            <ReferenceLine
              x={selectedTime}
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
            fontSize={axis.tick.fontSize}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            domain={[0, bytes ? ceiling : 100]}
            ticks={
              bytes
                ? axis.compactRates
                  ? [0, ceiling]
                  : undefined
                : [0, 25, 50, 75, 100]
            }
            interval={bytes ? undefined : 0}
            allowDataOverflow
            tickFormatter={(value: number) =>
              bytes ? formatAxisByteRate(value) : formatRoundedPercent(value)
            }
            tick={
              bytes && axis.compactRates ? (
                <StackedRateAxisTick fontSize={axis.tick.fontSize} />
              ) : (
                axis.tick
              )
            }
            fontSize={axis.tick.fontSize}
            tickMargin={4}
            axisLine={false}
            tickLine={false}
            padding={{
              top: 6,
              bottom: bytes && axis.compactRates ? axis.rateBottom : 4,
            }}
            width="auto"
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
                  anchorRef={anchor}
                  coordinate={tooltip.coordinate}
                >
                  <SeriesTooltip
                    active={tooltip.active}
                    payload={tooltip.payload}
                    label={tooltip.label}
                    activeDataKey={activeKey}
                    unit={bytes ? 'bytes_per_second' : '%'}
                    testId={`${id}-tooltip`}
                  />
                </ChartTooltipPortal>
              )}
            />
          ) : null}
          {keys.map((key, index) => (
            <Line
              key={key}
              type="linear"
              dataKey={key}
              name={names[key]}
              stroke={colors[key]}
              strokeWidth={2}
              strokeOpacity={activeKey && activeKey !== key ? 0.2 : 1}
              strokeDasharray={index ? '6 3' : undefined}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartRenderBoundary>
  );
});

function HostChartPanel({
  title,
  icon: Icon,
  keys,
  points,
  current,
  currentStates,
  windowMs,
  requestedWindowMs,
  loading,
  error,
  retry,
  connection,
  children,
}: {
  title: string;
  icon: LucideIcon;
  keys: HostSeriesKey[];
  points: HostPoints;
  current: HostPoints;
  currentStates: Record<HostSeriesKey, string>;
  windowMs: number;
  requestedWindowMs: number;
  loading: boolean;
  error: string | null;
  retry: () => void;
  connection: ConnectionState;
  children?: React.ReactNode;
}) {
  const { rows, domain } = useMemo(
    () => hostChartRows(points, keys, windowMs),
    [keys, points, windowMs],
  );
  const selection = useChartSelection(
    rows,
    domain,
    `${title}:${keys.join(',')}`,
  );
  const bytes = keys.includes('read');
  const format = bytes ? formatBytesPerSecond : formatPercent;
  const maximum = Math.max(
    0,
    ...rows.flatMap((row) => keys.map((key) => row[key] ?? 0)),
  );
  const ceiling = useTrendCeiling(bytes ? maximum : 0);
  const anchor = useRef<HTMLDivElement>(null);
  const axis = useChartAxisGeometry(anchor);
  const plotActive = useChartVisibility(anchor);
  const interactive = useChartTooltips();
  const [focused, setFocused] = useState<HostSeriesKey | null>(null);
  const activeKey = focused && keys.includes(focused) ? focused : null;
  const availableRows = rows.filter((row) =>
    keys.some((key) => row[key] != null),
  ).length;
  const hasCurrent = keys.some(
    (key) =>
      usable(currentStates[key]) && current[key][0]?.values.value != null,
  );
  const id = `host-${title.toLowerCase()}-chart`;
  return (
    <section
      className="frost-panel host-chart-panel compact-chart-panel"
      aria-labelledby={`${id}-title`}
      data-testid={id}
    >
      <div className="host-chart-heading">
        <h3 id={`${id}-title`}>
          <Icon aria-hidden="true" />
          {title}
        </h3>
        {children ?? (
          <span className="host-chart-state">
            {connection !== 'live'
              ? 'Paused'
              : !hasCurrent
                ? 'Unavailable'
                : null}
          </span>
        )}
      </div>
      <figure
        ref={anchor}
        {...selection.plotProps}
        className="host-chart-plot chart-plot-frame compact-chart-plot"
        aria-label={`${formatDuration(windowMs)} ${title.toLowerCase()} history`}
        aria-busy={loading}
      >
        {availableRows < 2 ? (
          <div className="host-chart-empty">
            {error
              ? 'History unavailable.'
              : loading
                ? 'Loading history…'
                : availableRows === 1
                  ? 'Collecting history…'
                  : 'Metric unavailable.'}
          </div>
        ) : (
          <HostHistoryPlot
            rows={rows}
            domain={domain}
            keys={keys}
            bytes={bytes}
            ceiling={ceiling}
            axis={axis}
            selectedTime={selection.selectedTime}
            interactive={plotActive && interactive && !selection.selectedRow}
            activeKey={activeKey}
            anchor={anchor}
            id={id}
            plotActive={plotActive}
          />
        )}
      </figure>
      <div
        className="host-chart-legend compact-chart-legend"
        aria-label={`${title} current values`}
      >
        {keys.map((key, index) => {
          const selectedValue = selection.selectedRow?.[key];
          const value = selection.selectedRow
            ? typeof selectedValue === 'number'
              ? selectedValue
              : null
            : usable(currentStates[key])
              ? current[key][0]?.values.value
              : null;
          const state = selection.selectedRow
            ? null
            : statusLabel(currentStates[key]);
          return (
            <button
              key={key}
              type="button"
              aria-pressed={activeKey === key}
              aria-label={`${names[key]}: ${value == null ? (state ?? 'Unavailable') : `${format(value)}${state ? ` · ${state}` : ''}`}`}
              onClick={() =>
                setFocused((previous) => (previous === key ? null : key))
              }
            >
              <svg width="18" height="5" aria-hidden="true">
                <line
                  x1="0"
                  y1="2.5"
                  x2="18"
                  y2="2.5"
                  stroke={colors[key]}
                  strokeWidth="2"
                  strokeDasharray={index ? '6 3' : undefined}
                />
              </svg>
              <span data-legend-label>{names[key]}</span>
              <strong data-legend-value>
                {compactChartValue(value, bytes ? 'bytes_per_second' : '%')}
              </strong>
              {state ? <span className="host-data-state">{state}</span> : null}
            </button>
          );
        })}
      </div>
      <ChartSelectionReadout
        selection={selection}
        label={title}
        summary={keys
          .map(
            (key) =>
              `${names[key]}: ${selection.selectedRow?.[key] == null ? 'Unavailable' : format(Number(selection.selectedRow[key]))}`,
          )
          .join(', ')}
      />
      {error ? (
        <output className="host-chart-feedback">
          <span>
            {availableRows >= 2
              ? 'Last complete history retained.'
              : 'History unavailable.'}
          </span>
          <Button variant="ghost" size="sm" onClick={retry}>
            Retry history
          </Button>
        </output>
      ) : loading && windowMs !== requestedWindowMs ? (
        <p className="host-chart-feedback">
          Showing {formatDuration(windowMs)} while{' '}
          {formatDuration(requestedWindowMs)} loads.
        </p>
      ) : null}
    </section>
  );
}

const cpuKeys: HostSeriesKey[] = ['cpu'];
const memoryKeys: HostSeriesKey[] = ['memory'];
const storageKeys: HostSeriesKey[] = ['storage'];
const ioKeys: HostSeriesKey[] = ['read', 'write'];

export function HostCharts({
  snapshot,
  connection,
  chartWindowMs,
  retentionMs,
  loadHistory,
  children,
}: {
  snapshot: Snapshot;
  connection: ConnectionState;
  chartWindowMs: number;
  retentionMs: number;
  loadHistory: LoadAlignedHistory;
  children?: ReactNode;
}) {
  const [storageMode, setStorageMode] = useState<'io' | 'space'>('io');
  const history = useHostHistory(
    snapshot,
    loadHistory,
    chartWindowMs,
    retentionMs,
  );
  const current = useMemo(() => currentHostPoints(snapshot), [snapshot]);
  const { cpu, memory, storage } = snapshot.system;
  const props = {
    points: history.points,
    current,
    currentStates: {
      cpu: cpu.utilization.status,
      memory: combinedStatus(memory.status, memory.utilization.status),
      storage: storage.status,
      read: storage.readBytesPerSecond.status,
      write: storage.writeBytesPerSecond.status,
    },
    windowMs: history.windowMs,
    requestedWindowMs: chartWindowMs,
    loading: history.loading,
    error: history.error,
    retry: history.retry,
    connection,
  };
  return (
    <>
      <HostChartPanel title="CPU" icon={Cpu} keys={cpuKeys} {...props} />
      <HostChartPanel
        title="RAM"
        icon={MemoryStick}
        keys={memoryKeys}
        {...props}
      />
      {children}
      <HostChartPanel
        title="Storage"
        icon={Database}
        keys={storageMode === 'io' ? ioKeys : storageKeys}
        {...props}
      >
        <SegmentedControl
          ariaLabel="Storage chart metric"
          value={storageMode}
          onValueChange={setStorageMode}
          options={[
            { label: 'I/O', value: 'io' },
            { label: 'Space', value: 'space' },
          ]}
        />
      </HostChartPanel>
    </>
  );
}
