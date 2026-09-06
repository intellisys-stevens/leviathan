import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { buildTrendRows, trendTimeDomain } from './chart-trend';
import { durationQuery } from './chart-window';
import {
  mergeOverviewPoints,
  type ChartRow,
  type LoadAlignedHistory,
  type OverviewPoint,
} from './overview-history';
import type {
  AlignedHistory,
  AlignedHistorySeriesDescriptor,
  Metric,
  Snapshot,
} from './types';
import {
  rawHistoryWindowMilliseconds,
  useHistoryRefreshGeneration,
} from './use-history-refresh';

export const hostSeriesKeys = [
  'cpu',
  'memory',
  'storage',
  'read',
  'write',
] as const;
export type HostSeriesKey = (typeof hostSeriesKeys)[number];
export type HostPoints = Record<HostSeriesKey, OverviewPoint[]>;
export const hostHistoryDescriptors: AlignedHistorySeriesDescriptor[] = [
  { key: 'cpu', entity: '@host', metrics: ['cpu_utilization'] },
  { key: 'memory', entity: '@host', metrics: ['memory_utilization'] },
  {
    key: 'storage',
    entity: '@host',
    metrics: ['storage_used_bytes', 'storage_total_bytes'],
  },
  { key: 'read', entity: '@host', metrics: ['disk_read_bytes_per_second'] },
  { key: 'write', entity: '@host', metrics: ['disk_write_bytes_per_second'] },
];

function finite(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function sample(metric: Metric): OverviewPoint {
  const value =
    metric.status === 'available' || metric.status === 'estimated'
      ? finite(metric.value)
      : null;
  return {
    sampledAt: metric.sampledAt,
    values: value == null ? {} : { value },
  };
}

export function currentHostPoints(snapshot: Snapshot): HostPoints {
  const { cpu, memory, storage } = snapshot.system;
  const percent =
    (storage.status === 'available' || storage.status === 'estimated') &&
    storage.usedBytes != null &&
    storage.totalBytes != null &&
    storage.totalBytes > 0
      ? (storage.usedBytes / storage.totalBytes) * 100
      : null;
  return {
    cpu: [sample(cpu.utilization)],
    memory: [sample(memory.utilization)],
    storage: [
      {
        sampledAt: storage.sampledAt,
        values: percent == null ? {} : { value: percent },
      },
    ],
    read: [sample(storage.readBytesPerSecond)],
    write: [sample(storage.writeBytesPerSecond)],
  };
}

export function parseHostHistory(response: AlignedHistory): HostPoints {
  const output: HostPoints = {
    cpu: [],
    memory: [],
    storage: [],
    read: [],
    write: [],
  };
  for (const point of response.points) {
    if (!Number.isFinite(Date.parse(point.sampledAt))) continue;
    for (const descriptor of hostHistoryDescriptors) {
      const key = descriptor.key as HostSeriesKey;
      const values = point.values[key] ?? {};
      const total = finite(values.storage_total_bytes);
      const used = finite(values.storage_used_bytes);
      const value =
        key === 'storage'
          ? total != null && total > 0 && used != null
            ? (used / total) * 100
            : null
          : finite(values[descriptor.metrics[0]]);
      output[key].push({
        sampledAt: point.sampledAt,
        values: value == null ? {} : { value },
      });
    }
  }
  return output;
}

function latestPointTime(points: HostPoints): string {
  const timestamps = hostSeriesKeys
    .flatMap((key) => points[key].map((point) => Date.parse(point.sampledAt)))
    .filter(Number.isFinite);
  return new Date(
    timestamps.length ? Math.max(...timestamps) : 0,
  ).toISOString();
}

export function mergeHostPoints(
  previous: HostPoints,
  incoming: HostPoints,
  windowMilliseconds: number,
): HostPoints {
  const latest = latestPointTime(incoming);
  return Object.fromEntries(
    hostSeriesKeys.map((key) => [
      key,
      mergeOverviewPoints(
        previous[key],
        incoming[key],
        latest,
        windowMilliseconds,
      ),
    ]),
  ) as HostPoints;
}

export function hostChartRows(
  points: HostPoints,
  keys: readonly HostSeriesKey[],
  windowMilliseconds: number,
) {
  const byTime = new Map<number, ChartRow>();
  for (const key of keys) {
    for (const point of points[key]) {
      const time = Date.parse(point.sampledAt);
      if (!Number.isFinite(time)) continue;
      const row: ChartRow = byTime.get(time) ?? { time };
      const value = finite(point.values.value);
      row[key] =
        value == null
          ? null
          : key === 'read' || key === 'write'
            ? Math.max(0, value)
            : Math.min(100, Math.max(0, value));
      byTime.set(time, row);
    }
  }
  const rows = [...byTime.values()].toSorted(
    (left, right) => left.time - right.time,
  );
  return {
    rows: buildTrendRows(rows, keys, windowMilliseconds),
    domain: trendTimeDomain(rows.at(-1)?.time ?? 0, windowMilliseconds),
  };
}

type State = {
  points: HostPoints;
  loading: boolean;
  error: string | null;
  loadedWindowMs: number | null;
};
const inFlight = new WeakMap<
  LoadAlignedHistory,
  Map<string, Promise<AlignedHistory>>
>();
function requestHistory(
  load: LoadAlignedHistory,
  windowMs: number,
  generation: string,
) {
  let cache = inFlight.get(load);
  if (!cache) {
    cache = new Map();
    inFlight.set(load, cache);
  }
  const key = `${windowMs}:${generation}`;
  let request = cache.get(key);
  if (!request) {
    request = load({
      window: durationQuery(windowMs),
      maxPoints: 720,
      series: hostHistoryDescriptors,
    });
    cache.set(key, request);
    const pending = request;
    void request.then(
      () => {
        if (cache.get(key) === pending) cache.delete(key);
      },
      () => {
        if (cache.get(key) === pending) cache.delete(key);
      },
    );
  }
  return request;
}

class HostHistoryStore {
  private state: State;
  private latest: Snapshot;
  private requestedKey = '';
  private requestedLoader: LoadAlignedHistory | null = null;
  private requestToken = 0;
  private listeners = new Set<() => void>();

  constructor(snapshot: Snapshot) {
    this.latest = snapshot;
    this.state = {
      points: currentHostPoints(snapshot),
      loading: true,
      error: null,
      loadedWindowMs: null,
    };
  }

  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  mergeSnapshot(snapshot: Snapshot, windowMs: number) {
    if (this.latest.system === snapshot.system) return;
    this.latest = snapshot;
    if (
      windowMs > rawHistoryWindowMilliseconds ||
      (this.state.loadedWindowMs ?? windowMs) > rawHistoryWindowMilliseconds
    )
      return;
    this.publish({
      ...this.state,
      points: mergeHostPoints(
        this.state.points,
        currentHostPoints(snapshot),
        this.state.loadedWindowMs ?? windowMs,
      ),
    });
  }

  load(loadHistory: LoadAlignedHistory, windowMs: number, generation: string) {
    const key = `${windowMs}:${generation}`;
    if (this.requestedKey === key && this.requestedLoader === loadHistory)
      return;
    this.requestedKey = key;
    this.requestedLoader = loadHistory;
    const token = ++this.requestToken;
    const requestStart = Date.parse(this.latest.system.sampledAt);
    this.publish({ ...this.state, loading: true, error: null });
    void requestHistory(loadHistory, windowMs, generation)
      .then((response) => {
        if (this.requestToken !== token) return;
        const historical = parseHostHistory(response);
        const live = Object.fromEntries(
          hostSeriesKeys.map((series) => [
            series,
            this.state.points[series].filter(
              (point) => Date.parse(point.sampledAt) >= requestStart,
            ),
          ]),
        ) as HostPoints;
        const points =
          windowMs <= rawHistoryWindowMilliseconds
            ? mergeHostPoints(
                historical,
                mergeHostPoints(live, currentHostPoints(this.latest), windowMs),
                windowMs,
              )
            : historical;
        this.publish({
          points,
          loading: false,
          error: null,
          loadedWindowMs: windowMs,
        });
      })
      .catch(() => {
        if (this.requestToken === token)
          this.publish({
            ...this.state,
            loading: false,
            error: 'History unavailable.',
          });
      });
  }

  private publish(state: State) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

export function useHostHistory(
  snapshot: Snapshot,
  loadHistory: LoadAlignedHistory,
  windowMs: number,
  retentionMs: number,
) {
  const [store] = useState(() => new HostHistoryStore(snapshot));
  const [retryGeneration, setRetryGeneration] = useState(0);
  const refreshGeneration = useHistoryRefreshGeneration(windowMs);
  const requestedWindow = Math.min(windowMs, retentionMs);
  useEffect(
    () => store.mergeSnapshot(snapshot, requestedWindow),
    [requestedWindow, snapshot, store],
  );
  useEffect(
    () =>
      store.load(
        loadHistory,
        requestedWindow,
        `${retryGeneration}:${refreshGeneration}`,
      ),
    [loadHistory, refreshGeneration, requestedWindow, retryGeneration, store],
  );
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const retry = useCallback(() => setRetryGeneration((value) => value + 1), []);
  return useMemo(
    () => ({
      ...state,
      retry,
      windowMs: state.loadedWindowMs ?? requestedWindow,
    }),
    [requestedWindow, retry, state],
  );
}
