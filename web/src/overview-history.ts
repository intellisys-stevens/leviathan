import { useEffect, useState, useSyncExternalStore } from 'react';
import { defaultHistoryWindowMs, durationQuery } from './chart-window';
import type { HistorySeries, Snapshot } from './types';

export const chartAverageWindowMilliseconds = 5 * 1000;

export type OverviewEntity = {
  key: string;
  uuid: string;
  label: string;
  scope: 'physical_gpu' | 'gpu_instance';
  gpuUUID: string;
  giUUID?: string;
  colorIndex: number;
};

export type OverviewPoint = {
  sampledAt: string;
  values: Record<string, number>;
};

export type OverviewHistoryState = {
  entities: OverviewEntity[];
  points: Record<string, OverviewPoint[]>;
  loading: boolean;
  failedEntities: string[];
};

type LoadHistory = (
  entity: string,
  metrics: string[],
  window?: string,
) => Promise<HistorySeries>;

const gpuMetrics = [
  'temperature',
  'gpu_activity',
  'memory_activity',
  'memory_used_bytes',
  'memory_total_bytes',
];
const giMetrics = [
  'sm_activity',
  'dram_activity',
  'memory_used_bytes',
  'memory_total_bytes',
];

export function overviewTopologyKey(snapshot: Snapshot): string {
  return snapshot.gpus
    .map(
      (gpu) =>
        `${gpu.uuid}:${gpu.gpuInstances
          .map((gi) => gi.generation || gi.uuid)
          .join(',')}`,
    )
    .join('|');
}

export function buildOverviewEntities(snapshot: Snapshot): OverviewEntity[] {
  const entities: OverviewEntity[] = [];
  let giColor = 0;
  for (const gpu of snapshot.gpus) {
    entities.push({
      key: `gpu:${gpu.uuid}`,
      uuid: gpu.uuid,
      label: `GPU ${gpu.index}`,
      scope: 'physical_gpu',
      gpuUUID: gpu.uuid,
      colorIndex: gpu.index,
    });
    for (const gi of gpu.gpuInstances) {
      entities.push({
        key: `gi:${gi.generation || gi.uuid}`,
        uuid: gi.uuid,
        label: `GPU ${gpu.index} · GI ${gi.id}`,
        scope: 'gpu_instance',
        gpuUUID: gpu.uuid,
        giUUID: gi.uuid,
        colorIndex: giColor,
      });
      giColor += 1;
    }
  }
  return entities;
}

function metricsFor(entity: OverviewEntity): string[] {
  return entity.scope === 'physical_gpu' ? gpuMetrics : giMetrics;
}

export function pointFromSnapshot(
  snapshot: Snapshot,
  entity: OverviewEntity,
): OverviewPoint | null {
  const gpu = snapshot.gpus.find(
    (candidate) => candidate.uuid === entity.gpuUUID,
  );
  if (!gpu) return null;
  const source = entity.giUUID
    ? gpu.gpuInstances.find((candidate) => candidate.uuid === entity.giUUID)
    : gpu;
  if (!source) return null;
  const values: Record<string, number> = {};
  for (const name of [
    'temperature',
    'gpu_activity',
    'sm_activity',
    'memory_activity',
    'dram_activity',
  ]) {
    const metric = source.metrics[name];
    if (metric?.status === 'available' && metric.value != null)
      values[name] = metric.value;
  }
  if (
    source.memory.status === 'available' &&
    source.memory.usedBytes != null &&
    source.memory.totalBytes != null
  ) {
    values.memory_used_bytes = source.memory.usedBytes;
    values.memory_total_bytes = source.memory.totalBytes;
  }
  return { sampledAt: snapshot.sampledAt, values };
}

export function mergeOverviewPoints(
  existing: OverviewPoint[],
  incoming: OverviewPoint[],
  now: string,
  retentionMilliseconds = defaultHistoryWindowMs,
): OverviewPoint[] {
  const cutoff = new Date(now).getTime() - retentionMilliseconds;
  const byTimestamp = new Map<string, OverviewPoint>();
  for (const point of [...existing, ...incoming]) {
    if (new Date(point.sampledAt).getTime() >= cutoff)
      byTimestamp.set(point.sampledAt, point);
  }
  return [...byTimestamp.values()].sort(
    (left, right) =>
      new Date(left.sampledAt).getTime() - new Date(right.sampledAt).getTime(),
  );
}

type HistoryLoadResult = {
  entity: OverviewEntity;
  series?: HistorySeries;
  failed: boolean;
};

type InternalHistoryState = OverviewHistoryState & {
  topologyKey: string;
  latestSampledAt: string;
};

function initialHistoryState(snapshot: Snapshot): InternalHistoryState {
  const entities = buildOverviewEntities(snapshot);
  const points: Record<string, OverviewPoint[]> = {};
  for (const entity of entities) {
    const point = pointFromSnapshot(snapshot, entity);
    if (point) points[entity.key] = [point];
  }
  return {
    topologyKey: overviewTopologyKey(snapshot),
    latestSampledAt: snapshot.sampledAt,
    entities,
    points,
    loading: true,
    failedEntities: [],
  };
}

class OverviewHistoryStore {
  private state: InternalHistoryState;
  private listeners = new Set<() => void>();
  private requestedTopology = '';
  private loadedWindowMilliseconds = 0;
  private requestToken = 0;

  constructor(snapshot: Snapshot) {
    this.state = initialHistoryState(snapshot);
  }

  readonly getSnapshot = () => this.state;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  mergeSnapshot(snapshot: Snapshot, retentionMilliseconds: number) {
    const topologyKey = overviewTopologyKey(snapshot);
    if (this.state.topologyKey !== topologyKey) {
      this.requestedTopology = '';
      this.loadedWindowMilliseconds = 0;
      this.requestToken += 1;
      this.publish(initialHistoryState(snapshot));
      return;
    }
    const points = { ...this.state.points };
    for (const entity of this.state.entities) {
      const point = pointFromSnapshot(snapshot, entity);
      if (!point) continue;
      points[entity.key] = mergeOverviewPoints(
        points[entity.key] ?? [],
        [point],
        snapshot.sampledAt,
        retentionMilliseconds,
      );
    }
    this.publish({
      ...this.state,
      points,
      latestSampledAt: snapshot.sampledAt,
    });
  }

  loadHistory(
    snapshot: Snapshot,
    loadHistory: LoadHistory,
    windowMilliseconds: number,
    retentionMilliseconds: number,
  ) {
    const topologyKey = overviewTopologyKey(snapshot);
    if (this.requestedTopology !== topologyKey) {
      this.requestedTopology = topologyKey;
      this.loadedWindowMilliseconds = 0;
    }
    if (this.loadedWindowMilliseconds >= windowMilliseconds) return;
    this.loadedWindowMilliseconds = windowMilliseconds;
    const requestToken = ++this.requestToken;
    const entities = buildOverviewEntities(snapshot);
    this.publish({ ...this.state, loading: true, failedEntities: [] });
    void Promise.all(
      entities.map(async (entity): Promise<HistoryLoadResult> => {
        try {
          return {
            entity,
            series: await loadHistory(
              entity.uuid,
              metricsFor(entity),
              durationQuery(windowMilliseconds),
            ),
            failed: false,
          };
        } catch {
          return { entity, failed: true };
        }
      }),
    ).then((results) => {
      if (
        this.state.topologyKey !== topologyKey ||
        requestToken !== this.requestToken
      )
        return;
      const points = { ...this.state.points };
      const failedEntities: string[] = [];
      for (const result of results) {
        if (result.failed || !result.series) {
          failedEntities.push(result.entity.key);
          continue;
        }
        points[result.entity.key] = mergeOverviewPoints(
          result.series.points,
          points[result.entity.key] ?? [],
          this.state.latestSampledAt,
          retentionMilliseconds,
        );
      }
      this.publish({
        ...this.state,
        points,
        loading: false,
        failedEntities,
      });
    });
  }

  private publish(next: InternalHistoryState) {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

export function useOverviewHistory(
  snapshot: Snapshot,
  loadHistory: LoadHistory,
  windowMilliseconds: number,
  retentionMilliseconds: number,
): OverviewHistoryState {
  const [store] = useState(() => new OverviewHistoryStore(snapshot));

  useEffect(() => {
    store.mergeSnapshot(snapshot, retentionMilliseconds);
  }, [retentionMilliseconds, snapshot, store]);

  useEffect(() => {
    store.loadHistory(
      snapshot,
      loadHistory,
      windowMilliseconds,
      retentionMilliseconds,
    );
  }, [loadHistory, retentionMilliseconds, snapshot, store, windowMilliseconds]);

  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const cutoff = new Date(state.latestSampledAt).getTime() - windowMilliseconds;
  const points: Record<string, OverviewPoint[]> = {};
  for (const [entity, series] of Object.entries(state.points)) {
    points[entity] = series.filter(
      (point) => new Date(point.sampledAt).getTime() >= cutoff,
    );
  }
  return { ...state, points };
}

export type ChartRow = { time: number } & Record<string, number | null>;

// A time-based window keeps the visual smoothing stable when the collector
// changes between 0.5s, 1s, 2s, or a custom startup cadence.
export function movingAverageChartRows(
  rows: ChartRow[],
  valueKeys: string[],
  windowMilliseconds = chartAverageWindowMilliseconds,
): ChartRow[] {
  const windows = new Map<string, Array<{ time: number; value: number }>>(
    valueKeys.map((key) => [key, []]),
  );

  return rows.map((row) => {
    const averaged: ChartRow = { ...row };
    for (const key of valueKeys) {
      const value = row[key];
      const window = windows.get(key) ?? [];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        window.length = 0;
        windows.set(key, window);
        averaged[key] = null;
        continue;
      }
      const cutoff = row.time - windowMilliseconds;
      while (window.length > 0 && window[0].time <= cutoff) window.shift();
      window.push({ time: row.time, value });
      windows.set(key, window);
      averaged[key] =
        window.reduce((total, sample) => total + sample.value, 0) /
        window.length;
    }
    return averaged;
  });
}

export function downsampleChartRows(
  rows: ChartRow[],
  valueKeys: string[],
  bucketCount = 360,
): ChartRow[] {
  if (bucketCount <= 0 || rows.length <= bucketCount) return rows;
  const bucketSize = Math.ceil(rows.length / bucketCount);
  const selected: ChartRow[] = [];
  for (let start = 0; start < rows.length; start += bucketSize) {
    const bucket = rows.slice(start, Math.min(rows.length, start + bucketSize));
    const keep = new Set<ChartRow>([bucket[0], bucket[bucket.length - 1]]);
    for (const key of valueKeys) {
      let minimum: { row: ChartRow; value: number } | null = null;
      let maximum: { row: ChartRow; value: number } | null = null;
      for (const row of bucket) {
        const value = row[key];
        if (typeof value !== 'number') continue;
        if (!minimum || value < minimum.value) minimum = { row, value };
        if (!maximum || value > maximum.value) maximum = { row, value };
      }
      if (minimum) keep.add(minimum.row);
      if (maximum) keep.add(maximum.row);
    }
    selected.push(...[...keep].sort((left, right) => left.time - right.time));
  }
  return selected;
}
