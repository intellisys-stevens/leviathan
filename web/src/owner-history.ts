import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  buildTrendRows,
  trendBucketMilliseconds,
  trendTimeDomain,
} from './chart-trend';
import { durationQuery } from './chart-window';
import type { ChartRow, LoadAlignedHistory } from './overview-history';
import type { AlignedHistory, WorkloadOwnerTelemetry } from './types';
import {
  rawHistoryWindowMilliseconds,
  useHistoryRefreshGeneration,
} from './use-history-refresh';

export const ownerMetricKeys = [
  'cpu_cores',
  'memory_used_bytes',
  'storage_read_bps',
  'storage_write_bps',
] as const;
export type OwnerMetricKey = (typeof ownerMetricKeys)[number];
const maxLiveRows = 2048;

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function currentOwnerRow(
  owner: WorkloadOwnerTelemetry,
): ChartRow | null {
  const time = Date.parse(owner.sampledAt);
  if (!Number.isFinite(time)) return null;
  return Object.fromEntries([
    ['time', time],
    ...ownerMetricKeys.map((key) => {
      const metric = owner.metrics[key];
      return [
        key,
        metric?.status === 'available' &&
        owner.status !== 'stale' &&
        owner.status !== 'unavailable'
          ? finite(metric.value)
          : null,
      ];
    }),
  ]) as ChartRow;
}

export function parseOwnerHistory(response: AlignedHistory): ChartRow[] {
  return response.points.flatMap((point) => {
    const time = Date.parse(point.sampledAt);
    if (!Number.isFinite(time)) return [];
    return [
      Object.fromEntries([
        ['time', time],
        ...ownerMetricKeys.map((key) => [
          key,
          finite(point.values.owner?.[key]),
        ]),
      ]) as ChartRow,
    ];
  });
}

export function mergeOwnerRows(
  previous: readonly ChartRow[],
  incoming: readonly ChartRow[],
  windowMs: number,
): ChartRow[] {
  const byTime = new Map(previous.map((row) => [row.time, row]));
  for (const row of incoming) byTime.set(row.time, row);
  const rows = [...byTime.values()].sort((a, b) => a.time - b.time);
  const cutoff = (rows.at(-1)?.time ?? 0) - windowMs;
  return rows.filter((row) => row.time >= cutoff).slice(-maxLiveRows);
}

export function ownerChartRows(
  source: readonly ChartRow[],
  keys: readonly OwnerMetricKey[],
  windowMs: number,
) {
  const ordered = source.toSorted((a, b) => a.time - b.time);
  const rows: ChartRow[] = [];
  const gapLimit = Math.max(6000, trendBucketMilliseconds(windowMs) * 3);
  for (const row of ordered) {
    const previous = rows.at(-1);
    if (previous && row.time - previous.time > gapLimit) {
      rows.push(
        Object.fromEntries([
          ['time', previous.time + gapLimit / 2],
          ...keys.map((key) => [key, null]),
        ]) as ChartRow,
      );
    }
    rows.push(row);
  }
  return {
    rows: buildTrendRows(rows, keys, windowMs),
    domain: trendTimeDomain(ordered.at(-1)?.time ?? 0, windowMs),
  };
}

type State = {
  rows: ChartRow[];
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
  ref: string,
  windowMs: number,
  generation: string,
) {
  let requests = inFlight.get(load);
  if (!requests) {
    requests = new Map();
    inFlight.set(load, requests);
  }
  const key = `${ref}:${windowMs}:${generation}`;
  const existing = requests.get(key);
  if (existing) return existing;
  const request = load({
    window: durationQuery(windowMs),
    maxPoints: 720,
    series: [
      { key: 'owner', entity: `owner:${ref}`, metrics: [...ownerMetricKeys] },
    ],
  });
  requests.set(key, request);
  while (requests.size > 32) requests.delete(requests.keys().next().value!);
  const clear = () => {
    if (requests.get(key) === request) requests.delete(key);
  };
  void request.then(clear, clear);
  return request;
}

class OwnerHistoryStore {
  private state: State;
  private latest: WorkloadOwnerTelemetry | undefined;
  private requestedKey = '';
  private loader: LoadAlignedHistory | null = null;
  private token = 0;
  private listeners = new Set<() => void>();
  constructor(private ref: string | undefined) {
    this.state = {
      rows: [],
      loading: Boolean(ref),
      error: null,
      loadedWindowMs: null,
    };
  }

  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  merge(owner: WorkloadOwnerTelemetry | undefined, windowMs: number) {
    if (owner === this.latest || owner?.ref !== this.ref) return;
    this.latest = owner;
    const row = owner && currentOwnerRow(owner);
    if (
      !row ||
      windowMs > rawHistoryWindowMilliseconds ||
      (this.state.loadedWindowMs ?? windowMs) > rawHistoryWindowMilliseconds
    )
      return;
    this.publish({
      ...this.state,
      rows: mergeOwnerRows(
        this.state.rows,
        [row],
        this.state.loadedWindowMs ?? windowMs,
      ),
    });
  }
  load(load: LoadAlignedHistory, windowMs: number, generation: string) {
    const ref = this.ref;
    if (!ref) return;
    const key = `${ref}:${windowMs}:${generation}`;
    if (key === this.requestedKey && this.loader === load) return;
    this.requestedKey = key;
    this.loader = load;
    const token = ++this.token;
    const startedAt = Date.parse(this.latest!.sampledAt);
    this.publish({ ...this.state, loading: true, error: null });
    void requestHistory(load, ref, windowMs, generation)
      .then((response) => {
        if (token !== this.token) return;
        const historical = parseOwnerHistory(response);
        const current = this.latest && currentOwnerRow(this.latest);
        const live = this.state.rows.filter((row) => row.time >= startedAt);
        if (current) live.push(current);
        this.publish({
          rows:
            windowMs <= rawHistoryWindowMilliseconds
              ? mergeOwnerRows(historical, live, windowMs)
              : historical,
          loading: false,
          error: null,
          loadedWindowMs: windowMs,
        });
      })
      .catch(() => {
        if (token === this.token)
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

export function useOwnerHistory(
  owner: WorkloadOwnerTelemetry | undefined,
  loadHistory: LoadAlignedHistory,
  windowMs: number,
  retentionMs: number,
) {
  // Separate stores prevent a slow prior owner's request from replacing the selected owner.
  const ref = owner?.ref;
  const store = useMemo(() => new OwnerHistoryStore(ref), [ref]);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const refresh = useHistoryRefreshGeneration(windowMs);
  const requestedWindow = Math.min(windowMs, retentionMs);
  useEffect(
    () => store.merge(owner, requestedWindow),
    [owner, requestedWindow, store],
  );
  useEffect(
    () =>
      store.load(loadHistory, requestedWindow, `${retryGeneration}:${refresh}`),
    [loadHistory, requestedWindow, retryGeneration, refresh, store],
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
