import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { defaultHistoryWindowMs, durationQuery } from './chart-window';
import type {
  AlignedHistory,
  AlignedHistoryRequest,
  AlignedHistorySeriesDescriptor,
  Snapshot,
} from './types';

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
  time?: number;
  values: Record<string, number>;
};

export type OverviewHistoryState = {
  entities: OverviewEntity[];
  points: Record<string, OverviewPoint[]>;
  loading: boolean;
  failedEntities: string[];
};

export type { AlignedHistorySeriesDescriptor } from './types';

export type LoadAlignedHistory = (
  request: AlignedHistoryRequest,
) => Promise<AlignedHistory>;

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
    'pcie_rx_bytes_per_second',
    'pcie_tx_bytes_per_second',
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
  return {
    sampledAt: snapshot.sampledAt,
    time: new Date(snapshot.sampledAt).getTime(),
    values,
  };
}

function pointTime(point: OverviewPoint): number {
  return point.time ?? new Date(point.sampledAt).getTime();
}

function normalizedPoint(point: OverviewPoint): OverviewPoint {
  return point.time == null ? { ...point, time: pointTime(point) } : point;
}

function firstPointAtOrAfter(
  points: readonly OverviewPoint[],
  cutoff: number,
): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (pointTime(points[middle]) < cutoff) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function mergeOverviewPoints(
  existing: OverviewPoint[],
  incoming: OverviewPoint[],
  now: string,
  retentionMilliseconds = defaultHistoryWindowMs,
): OverviewPoint[] {
  const cutoff = new Date(now).getTime() - retentionMilliseconds;
  const existingStart = firstPointAtOrAfter(existing, cutoff);
  const retainedSlice = existing.slice(existingStart);
  // History responses arrive as ISO strings. Normalize them once; subsequent
  // live appends can compare numeric timestamps without repeatedly parsing the
  // whole retained window.
  const retained =
    retainedSlice[0]?.time == null
      ? retainedSlice.map(normalizedPoint)
      : retainedSlice;
  if (incoming.length === 1) {
    const candidate = normalizedPoint(incoming[0]);
    if (pointTime(candidate) < cutoff) return retained;
    const last = retained.at(-1);
    if (!last || pointTime(candidate) > pointTime(last))
      return [...retained, candidate];
    if (pointTime(candidate) === pointTime(last))
      return [...retained.slice(0, -1), candidate];
  }

  let right = incoming
    .map(normalizedPoint)
    .filter((point) => pointTime(point) >= cutoff);
  if (
    right.some(
      (point, index) =>
        index > 0 && pointTime(point) < pointTime(right[index - 1]),
    )
  )
    right = right.toSorted(
      (left, candidate) => pointTime(left) - pointTime(candidate),
    );

  const merged: OverviewPoint[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < retained.length || rightIndex < right.length) {
    const left = retained[leftIndex];
    const candidate = right[rightIndex];
    if (left && (!candidate || pointTime(left) < pointTime(candidate))) {
      merged.push(normalizedPoint(left));
      leftIndex += 1;
    } else if (!left || pointTime(candidate) < pointTime(left)) {
      merged.push(candidate);
      rightIndex += 1;
    } else {
      // A freshly loaded or sampled point wins when timestamps collide.
      merged.push(candidate);
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return merged;
}

type InternalHistoryState = OverviewHistoryState & {
  topologyKey: string;
  latestSampledAt: string;
};

function initialHistoryState(
  snapshot: Snapshot,
  entities: OverviewEntity[],
): InternalHistoryState {
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
  private requestedKey = '';
  private requestToken = 0;

  constructor(snapshot: Snapshot, entities: OverviewEntity[]) {
    this.state = initialHistoryState(snapshot, entities);
  }

  readonly getSnapshot = () => this.state;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  mergeSnapshot(
    snapshot: Snapshot,
    entities: OverviewEntity[],
    retentionMilliseconds: number,
  ) {
    const topologyKey = overviewTopologyKey(snapshot);
    if (this.state.topologyKey !== topologyKey) {
      this.requestedKey = '';
      this.requestToken += 1;
      this.publish(initialHistoryState(snapshot, entities));
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
    panelID: string,
    entities: OverviewEntity[],
    descriptors: AlignedHistorySeriesDescriptor[],
    loadHistory: LoadAlignedHistory,
    windowMilliseconds: number,
    retentionMilliseconds: number,
  ) {
    const topologyKey = overviewTopologyKey(snapshot);
    const requestWindow = durationQuery(windowMilliseconds);
    const descriptorKey = descriptors
      .map(
        ({ key, entity, metrics }) =>
          `${key}\u0001${entity}\u0001${metrics.join('\u0002')}`,
      )
      .join('\u0003');
    const requestKey = `${topologyKey}\u0000${panelID}\u0000${requestWindow}\u0000${descriptorKey}`;
    if (this.requestedKey === requestKey) return;
    this.requestedKey = requestKey;
    if (descriptors.length === 0) {
      this.publish({
        ...this.state,
        entities,
        points: {},
        loading: false,
        failedEntities: [],
      });
      return;
    }
    const requestToken = ++this.requestToken;
    const requestStartedAt = new Date(this.state.latestSampledAt).getTime();
    this.publish({ ...this.state, loading: true, failedEntities: [] });
    void loadHistory({
      window: requestWindow,
      maxPoints: 720,
      series: descriptors,
    })
      .then((response) => {
        if (
          this.state.topologyKey !== topologyKey ||
          requestToken !== this.requestToken
        )
          return;

        const historical: Record<string, OverviewPoint[]> = Object.fromEntries(
          entities.map((entity) => [entity.key, []]),
        );
        for (const point of response.points) {
          const time = new Date(point.sampledAt).getTime();
          if (!Number.isFinite(time)) continue;
          for (const descriptor of descriptors) {
            historical[descriptor.key]?.push({
              sampledAt: point.sampledAt,
              time,
              values: point.values[descriptor.key] ?? {},
            });
          }
        }

        const points: Record<string, OverviewPoint[]> = {};
        for (const entity of entities) {
          const live = (this.state.points[entity.key] ?? []).filter(
            (point) => pointTime(point) >= requestStartedAt,
          );
          points[entity.key] = mergeOverviewPoints(
            historical[entity.key] ?? [],
            live,
            this.state.latestSampledAt,
            retentionMilliseconds,
          );
        }
        this.publish({
          ...this.state,
          entities,
          points,
          loading: false,
          failedEntities: [],
        });
      })
      .catch(() => {
        if (
          this.state.topologyKey !== topologyKey ||
          requestToken !== this.requestToken
        )
          return;
        this.publish({
          ...this.state,
          loading: false,
          failedEntities: entities.map((entity) => entity.key),
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
  panelID: string,
  entities: OverviewEntity[],
  descriptors: AlignedHistorySeriesDescriptor[],
  loadHistory: LoadAlignedHistory,
  windowMilliseconds: number,
  retentionMilliseconds: number,
): OverviewHistoryState {
  const [store] = useState(() => new OverviewHistoryStore(snapshot, entities));

  useEffect(() => {
    store.mergeSnapshot(snapshot, entities, retentionMilliseconds);
  }, [entities, retentionMilliseconds, snapshot, store]);

  useEffect(() => {
    store.loadHistory(
      snapshot,
      panelID,
      entities,
      descriptors,
      loadHistory,
      windowMilliseconds,
      retentionMilliseconds,
    );
  }, [
    descriptors,
    entities,
    loadHistory,
    panelID,
    retentionMilliseconds,
    snapshot,
    store,
    windowMilliseconds,
  ]);

  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const points = useMemo(() => {
    const cutoff =
      new Date(state.latestSampledAt).getTime() - windowMilliseconds;
    const visible: Record<string, OverviewPoint[]> = {};
    for (const [entity, series] of Object.entries(state.points)) {
      const start = firstPointAtOrAfter(series, cutoff);
      visible[entity] = start === 0 ? series : series.slice(start);
    }
    return visible;
  }, [state.latestSampledAt, state.points, windowMilliseconds]);
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
  const windows = new Map<
    string,
    {
      samples: Array<{ time: number; value: number }>;
      head: number;
      sum: number;
    }
  >(valueKeys.map((key) => [key, { samples: [], head: 0, sum: 0 }]));

  return rows.map((row) => {
    const averaged: ChartRow = { ...row };
    for (const key of valueKeys) {
      const value = row[key];
      const window = windows.get(key) ?? { samples: [], head: 0, sum: 0 };
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        window.samples = [];
        window.head = 0;
        window.sum = 0;
        windows.set(key, window);
        averaged[key] = null;
        continue;
      }
      const cutoff = row.time - windowMilliseconds;
      let evicted = false;
      while (
        window.head < window.samples.length &&
        window.samples[window.head].time <= cutoff
      ) {
        window.head += 1;
        evicted = true;
      }
      if (evicted) {
        // Recompute the active sum after eviction. Repeated subtraction leaves
        // tiny negative floating-point residue, which can leak into chart
        // domains and labels as values such as -0 or 89.99999999999996.
        window.sum = 0;
        for (let index = window.head; index < window.samples.length; index += 1)
          window.sum += window.samples[index].value;
      }
      window.samples.push({ time: row.time, value });
      window.sum += value;
      if (window.head > 128 && window.head * 2 > window.samples.length) {
        window.samples = window.samples.slice(window.head);
        window.head = 0;
      }
      windows.set(key, window);
      averaged[key] = window.sum / (window.samples.length - window.head);
    }
    return averaged;
  });
}

export function downsampleChartRows(
  rows: ChartRow[],
  valueKeys: string[],
  maxRows = 720,
): ChartRow[] {
  if (maxRows <= 0) return [];
  if (rows.length <= maxRows) return rows;
  if (maxRows < 3 || valueKeys.length === 0) {
    if (maxRows <= 1) return rows.slice(0, Math.max(0, maxRows));
    return Array.from(
      { length: maxRows },
      (_, index) =>
        rows[Math.round((index * (rows.length - 1)) / (maxRows - 1))],
    );
  }
  const bucketCount = Math.floor(
    (maxRows - 2) / Math.max(1, valueKeys.length * 2),
  );
  if (bucketCount < 1) {
    return Array.from(
      { length: maxRows },
      (_, index) =>
        rows[Math.round((index * (rows.length - 1)) / (maxRows - 1))],
    );
  }
  const interior = rows.slice(1, -1);
  const bucketSize = Math.ceil(interior.length / bucketCount);
  const keep = new Set<ChartRow>([rows[0], rows[rows.length - 1]]);
  for (let start = 0; start < interior.length; start += bucketSize) {
    const bucket = interior.slice(
      start,
      Math.min(interior.length, start + bucketSize),
    );
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
  }
  return [...keep]
    .sort((left, right) => left.time - right.time)
    .slice(0, maxRows);
}
