import type { AttributedPerson } from './attribution';
import { durationQuery } from './chart-window';
import { clampRenderedPercent } from './lib';
import type { ChartRow, LoadAlignedHistory } from './overview-history';
import type {
  AlignedHistory,
  AlignedHistorySeriesDescriptor,
  GPU,
  GpuInstance,
} from './types';

const historyBatchSeriesLimit = 256;
const historyBatchMetricLimit = 1_024;

export type WorkloadTelemetryEntity = {
  key: string;
  entity: string;
  label: string;
  accessibleLabel: string;
  activityMetric: 'gpu_activity' | 'sm_activity';
  memoryActivityMetric: 'memory_activity' | 'dram_activity';
  source: GPU | GpuInstance;
  sharedAcrossOwners: boolean;
};

export type WorkloadHistoryEntity = Pick<
  WorkloadTelemetryEntity,
  'activityMetric' | 'entity' | 'key' | 'memoryActivityMetric'
>;

export type WorkloadHistoryKeys = {
  descriptor: string;
  activity: string;
  memory: string;
  memoryActivity: string;
  pcieTotal: string;
};

function resourceScopeKey(
  resource: AttributedPerson['workspaces'][number]['resources'][number],
): string {
  const { selection } = resource;
  return selection.kind === 'physical_gpu'
    ? `gpu:${selection.gpu.uuid}`
    : `gi:${selection.gi.generation || selection.gi.uuid}`;
}

function allocatedScopeOwners(
  people: readonly AttributedPerson[],
): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const person of people) {
    for (const workspace of person.workspaces) {
      for (const resource of workspace.resources) {
        if (resource.state !== 'allocated') continue;
        const key = resourceScopeKey(resource);
        const scopeOwners = owners.get(key) ?? new Set<string>();
        scopeOwners.add(person.key);
        owners.set(key, scopeOwners);
      }
    }
  }
  return owners;
}

export function buildWorkloadTelemetryEntities(
  people: readonly AttributedPerson[],
  selectedPersonKey: string,
): WorkloadTelemetryEntity[] {
  const person = people.find(({ key }) => key === selectedPersonKey);
  if (!person) return [];
  const owners = allocatedScopeOwners(people);
  const entities = new Map<string, WorkloadTelemetryEntity>();

  for (const workspace of person.workspaces) {
    for (const resource of workspace.resources) {
      if (resource.state !== 'allocated') continue;
      const { selection } = resource;
      const key = resourceScopeKey(resource);
      if (entities.has(key)) continue;
      const sharedAcrossOwners = (owners.get(key)?.size ?? 0) > 1;
      if (selection.kind === 'physical_gpu') {
        const label = `GPU ${selection.gpu.index}`;
        entities.set(key, {
          key,
          entity: selection.gpu.uuid,
          label: sharedAcrossOwners ? `${label} · shared` : label,
          accessibleLabel: sharedAcrossOwners
            ? `${label}, shared assigned physical GPU telemetry`
            : `${label}, assigned physical GPU telemetry`,
          activityMetric: 'gpu_activity',
          memoryActivityMetric: 'memory_activity',
          source: selection.gpu,
          sharedAcrossOwners,
        });
        continue;
      }
      const label = `GPU ${selection.gpu.index} · GI ${selection.gi.id}`;
      entities.set(key, {
        key,
        entity: selection.gi.uuid,
        label: sharedAcrossOwners ? `${label} · shared` : label,
        accessibleLabel: sharedAcrossOwners
          ? `${label}, shared parent GI telemetry across assigned users`
          : `${label}, assigned parent GI telemetry`,
        activityMetric: 'sm_activity',
        memoryActivityMetric: 'dram_activity',
        source: selection.gi,
        sharedAcrossOwners,
      });
    }
  }

  return [...entities.values()].sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { numeric: true }),
  );
}

export function workloadHistoryKeys(index: number): WorkloadHistoryKeys {
  const descriptor = `assigned_${index}`;
  return {
    descriptor,
    activity: `${descriptor}_activity`,
    memory: `${descriptor}_memory`,
    memoryActivity: `${descriptor}_memory_activity`,
    pcieTotal: `${descriptor}_pcie_total`,
  };
}

export function workloadHistoryDescriptors(
  entities: readonly WorkloadHistoryEntity[],
): AlignedHistorySeriesDescriptor[] {
  return entities.map((entity, index) => ({
    key: workloadHistoryKeys(index).descriptor,
    entity: entity.entity,
    metrics: [
      entity.activityMetric,
      entity.memoryActivityMetric,
      'memory_used_bytes',
      'memory_total_bytes',
      'pcie_rx_bytes_per_second',
      'pcie_tx_bytes_per_second',
    ],
  }));
}

export function workloadHistoryBatches(
  descriptors: readonly AlignedHistorySeriesDescriptor[],
): AlignedHistorySeriesDescriptor[][] {
  const batches: AlignedHistorySeriesDescriptor[][] = [];
  let batch: AlignedHistorySeriesDescriptor[] = [];
  let metricCount = 0;
  for (const descriptor of descriptors) {
    const requestedMetrics = descriptor.metrics.length;
    if (
      batch.length > 0 &&
      (batch.length === historyBatchSeriesLimit ||
        metricCount + requestedMetrics > historyBatchMetricLimit)
    ) {
      batches.push(batch);
      batch = [];
      metricCount = 0;
    }
    batch.push(descriptor);
    metricCount += requestedMetrics;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function memoryPercentage(values: Record<string, number>): number | null {
  const used = values.memory_used_bytes;
  const total = values.memory_total_bytes;
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0)
    return null;
  return clampRenderedPercent((used / total) * 100);
}

function percentageMetric(
  values: Record<string, number>,
  metric: string,
): number | null {
  const value = values[metric];
  return Number.isFinite(value) ? clampRenderedPercent(value) : null;
}

function pcieTotal(values: Record<string, number>): number | null {
  const rx = values.pcie_rx_bytes_per_second;
  const tx = values.pcie_tx_bytes_per_second;
  if (!Number.isFinite(rx) || !Number.isFinite(tx)) return null;
  return Math.max(0, rx) + Math.max(0, tx);
}

export function workloadRowsFromHistory(
  responses: readonly AlignedHistory[],
  entities: readonly WorkloadHistoryEntity[],
): ChartRow[] {
  const rows = new Map<number, ChartRow>();
  for (const response of responses) {
    for (const point of response.points) {
      const time = Date.parse(point.sampledAt);
      if (!Number.isFinite(time)) continue;
      const row: ChartRow = rows.get(time) ?? { time };
      for (const [index, entity] of entities.entries()) {
        const keys = workloadHistoryKeys(index);
        const values = point.values[keys.descriptor];
        if (!values) continue;
        row[keys.activity] = percentageMetric(values, entity.activityMetric);
        row[keys.memory] = memoryPercentage(values);
        row[keys.memoryActivity] = percentageMetric(
          values,
          entity.memoryActivityMetric,
        );
        row[keys.pcieTotal] = pcieTotal(values);
      }
      rows.set(time, row);
    }
  }
  return [...rows.values()].sort((left, right) => left.time - right.time);
}

export function currentWorkloadRow(
  sampledAt: string,
  entities: readonly WorkloadTelemetryEntity[],
): ChartRow | null {
  const publicationTime = Date.parse(sampledAt);
  if (!Number.isFinite(publicationTime) || entities.length === 0) return null;
  const row: ChartRow = { time: publicationTime };
  const observedTimes: number[] = [];
  const setObserved = (
    key: string,
    value: number | null,
    observedAt?: string,
  ) => {
    const time = Date.parse(observedAt ?? '');
    row[key] = value != null && Number.isFinite(time) ? value : null;
    if (row[key] != null) observedTimes.push(time);
  };
  for (const [index, entity] of entities.entries()) {
    const keys = workloadHistoryKeys(index);
    const activity = entity.source.metrics[entity.activityMetric];
    setObserved(
      keys.activity,
      activity?.status === 'available' &&
        activity.value != null &&
        Number.isFinite(activity.value)
        ? clampRenderedPercent(activity.value)
        : null,
      activity?.sampledAt,
    );
    const memory = entity.source.memory;
    setObserved(
      keys.memory,
      memory.status === 'available' &&
        memory.usedBytes != null &&
        Number.isFinite(memory.usedBytes) &&
        memory.totalBytes != null &&
        Number.isFinite(memory.totalBytes) &&
        memory.totalBytes > 0
        ? clampRenderedPercent(
            (Number(memory.usedBytes) / Number(memory.totalBytes)) * 100,
          )
        : null,
      memory.sampledAt,
    );
    const memoryActivity = entity.source.metrics[entity.memoryActivityMetric];
    setObserved(
      keys.memoryActivity,
      memoryActivity?.status === 'available' &&
        memoryActivity.value != null &&
        Number.isFinite(memoryActivity.value)
        ? clampRenderedPercent(memoryActivity.value)
        : null,
      memoryActivity?.sampledAt,
    );
    const rx = entity.source.metrics.pcie_rx_bytes_per_second;
    const tx = entity.source.metrics.pcie_tx_bytes_per_second;
    setObserved(
      keys.pcieTotal,
      rx?.status === 'available' &&
        rx.value != null &&
        Number.isFinite(rx.value) &&
        tx?.status === 'available' &&
        tx.value != null &&
        Number.isFinite(tx.value) &&
        Date.parse(rx.sampledAt) === Date.parse(tx.sampledAt)
        ? Math.max(0, rx.value) + Math.max(0, tx.value)
        : null,
      rx?.sampledAt,
    );
  }
  // A host or cgroup publication can retain every GPU sample unchanged.
  // Anchor this aligned row to actual GPU/GI provenance, preserving available
  // values for independently sampled entities rather than creating null gaps
  // just because another entity has a newer timestamp. Only an entirely
  // unavailable observation uses publication time, so it cannot overwrite the
  // last measured point at the stale source timestamp.
  if (observedTimes.length > 0) row.time = Math.max(...observedTimes);
  return row;
}

export function mergeWorkloadRows(
  existing: ChartRow[],
  incoming: ChartRow,
  windowMilliseconds: number,
): ChartRow[] {
  const cutoff =
    Math.max(incoming.time, existing.at(-1)?.time ?? incoming.time) -
    windowMilliseconds;
  const filtered = existing.filter(({ time }) => time >= cutoff);
  const retained = filtered.length === existing.length ? existing : filtered;
  if (incoming.time < cutoff) return retained;
  const last = retained.at(-1);
  if (!last || last.time < incoming.time) return [...retained, incoming];
  if (last.time === incoming.time) {
    const keys = Object.keys(incoming);
    if (
      keys.length === Object.keys(last).length &&
      keys.every((key) => Object.is(last[key], incoming[key]))
    )
      return retained;
    return [...retained.slice(0, -1), incoming];
  }
  const rows = new Map(retained.map((row) => [row.time, row]));
  rows.set(incoming.time, incoming);
  return [...rows.values()].sort((left, right) => left.time - right.time);
}

export async function loadWorkloadHistory(
  loadHistory: LoadAlignedHistory,
  entities: readonly WorkloadHistoryEntity[],
  windowMilliseconds: number,
): Promise<ChartRow[]> {
  const descriptors = workloadHistoryDescriptors(entities);
  const batches = workloadHistoryBatches(descriptors);
  if (batches.length === 0) return [];
  const responses = await Promise.all(
    batches.map((series) =>
      loadHistory({
        window: durationQuery(windowMilliseconds),
        maxPoints: 720,
        series,
      }),
    ),
  );
  return workloadRowsFromHistory(responses, entities);
}
