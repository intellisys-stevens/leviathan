import { useId } from 'react';
import { ArrowUpRight, Cpu, Database, Gauge, MemoryStick } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { PerimeterLight } from './perimeter-light';
import { formatBytes, formatPercent } from '../lib';
import {
  buildGPUAllocationView,
  type GPUAllocationView,
} from '../gpu-allocation';
import type { Filesystem, Metric, Snapshot } from '../types';
import './host-overview.css';

export type ResourceCategory = 'cpu' | 'memory' | 'storage' | 'gpu';

export function usable(status: string): boolean {
  return status === 'available' || status === 'estimated';
}

export function combinedStatus(...statuses: string[]): string {
  return (
    statuses.find((status) => !usable(status)) ??
    (statuses.includes('estimated') ? 'estimated' : 'available')
  );
}

export function hostMetricValue(metric: Metric): number | null {
  return usable(metric.status) &&
    metric.value != null &&
    Number.isFinite(metric.value)
    ? metric.value
    : null;
}

export function capacityPercent(
  used: number | null,
  total: number | null,
): number | null {
  if (
    used == null ||
    total == null ||
    !Number.isFinite(used) ||
    !Number.isFinite(total) ||
    used < 0 ||
    total <= 0
  )
    return null;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

export function busiestFilesystem(
  filesystems: Filesystem[],
): Filesystem | null {
  return (
    filesystems
      .filter(
        (filesystem) =>
          usable(filesystem.status) &&
          capacityPercent(filesystem.usedBytes, filesystem.totalBytes) != null,
      )
      .toSorted(
        (left, right) =>
          (capacityPercent(right.usedBytes, right.totalBytes) ?? 0) -
          (capacityPercent(left.usedBytes, left.totalBytes) ?? 0),
      )[0] ?? null
  );
}

export function gpuCapacity(snapshot: Snapshot) {
  const provider = snapshot.capabilities.nvml;
  const providerAvailable = provider.available && usable(provider.status);
  const physical = [
    ...new Map(snapshot.gpus.map((gpu) => [gpu.uuid, gpu])).values(),
  ];
  const readable = physical.filter(
    (gpu) =>
      providerAvailable &&
      usable(gpu.memory.status) &&
      gpu.memory.totalBytes != null &&
      gpu.memory.usedBytes != null,
  );
  const complete = providerAvailable && readable.length === physical.length;
  const memoryStatus = combinedStatus(
    provider.status,
    ...physical.map((gpu) => gpu.memory.status),
  );
  const status = !providerAvailable
    ? usable(provider.status)
      ? 'unavailable'
      : provider.status
    : complete
      ? memoryStatus
      : readable.length > 0
        ? 'partial'
        : usable(memoryStatus)
          ? 'unavailable'
          : memoryStatus;
  return {
    count: physical.length,
    complete,
    reported: readable.length,
    status,
    used: readable.length
      ? readable.reduce((sum, gpu) => sum + gpu.memory.usedBytes!, 0)
      : null,
    total: readable.length
      ? readable.reduce((sum, gpu) => sum + gpu.memory.totalBytes!, 0)
      : null,
  };
}

export function statusLabel(status: string) {
  if (status === 'available') return null;
  if (status === 'estimated') return 'Estimated';
  if (status === 'stale') return 'Stale';
  if (status === 'unsupported') return 'No data';
  if (status === 'partial') return 'Partial';
  return 'Unavailable';
}

export function CapacityOverview({
  snapshot,
  onNavigate,
  stale = false,
}: {
  snapshot: Snapshot;
  onNavigate: (resource: ResourceCategory) => void;
  stale?: boolean;
}) {
  const allocationDescriptionId = useId();
  const { cpu, memory, storage } = snapshot.system;
  const cpuStatus = cpu.utilization.status;
  const ramStatus = combinedStatus(memory.status, memory.utilization.status);
  const cpuValue = hostMetricValue(cpu.utilization);
  const ramPercent = usable(memory.status)
    ? hostMetricValue(memory.utilization)
    : null;
  const storageComplete =
    usable(storage.status) &&
    storage.filesystems.every((filesystem) => usable(filesystem.status));
  const storagePercent = storageComplete
    ? capacityPercent(storage.usedBytes, storage.totalBytes)
    : null;
  const busiest = busiestFilesystem(storage.filesystems);
  const allocation = buildGPUAllocationView(snapshot, { stale });
  const fullCount = allocation.units.filter(
    ({ entityType }) => entityType === 'physical_gpu',
  ).length;
  const migCount = allocation.total - fullCount;
  const allocationDescription =
    allocation.status === 'available'
      ? `Observed workspace assignments: ${allocation.assigned} assigned, ${allocation.reserved} reserved, ${allocation.unassigned} unassigned. ${allocation.total} allocation units: ${fullCount} full GPUs and ${migCount} MIG compute instances.`
      : allocation.reason;
  const cards = [
    {
      key: 'cpu' as const,
      label: 'CPU',
      icon: Cpu,
      value: cpu.logicalProcessors > 0 ? String(cpu.logicalProcessors) : '—',
      unit: 'logical processors',
      detail:
        cpuValue == null
          ? 'Utilization unavailable'
          : `${formatPercent(cpuValue)} utilized`,
      percent: cpuValue,
      state: statusLabel(cpuStatus),
    },
    {
      key: 'memory' as const,
      label: 'RAM',
      icon: MemoryStick,
      value: formatBytes(memory.totalBytes),
      unit: 'total memory',
      detail: usable(memory.status)
        ? `${formatBytes(memory.usedBytes)} used`
        : 'Usage unavailable',
      percent: ramPercent,
      state: statusLabel(ramStatus),
    },
    {
      key: 'gpu' as const,
      label: 'GPU',
      icon: Gauge,
      value:
        allocation.unassigned == null ? '—' : String(allocation.unassigned),
      unit: 'unassigned resources',
      detail:
        allocation.status !== 'available'
          ? allocation.reason
          : allocation.total === 0
            ? 'No configured resources'
            : `${allocation.assigned + allocation.reserved} of ${allocation.total} in use${allocation.reserved > 0 ? ` · ${allocation.reserved} reserved` : ''}`,
      percent: null,
      state:
        allocation.status === 'available'
          ? null
          : allocation.status === 'incomplete'
            ? 'Incomplete'
            : 'Unknown',
    },
    {
      key: 'storage' as const,
      label: 'Storage',
      icon: Database,
      value: formatBytes(storage.totalBytes),
      unit: storageComplete ? 'mounted capacity' : 'reported capacity',
      detail:
        usable(storage.status) && storage.usedBytes != null
          ? `${formatBytes(storage.usedBytes)} used${!storageComplete ? ' · partial' : ''}`
          : 'Usage unavailable',
      percent: storagePercent,
      state: !usable(storage.status)
        ? statusLabel(storage.status)
        : !storageComplete && storage.totalBytes != null
          ? 'Partial'
          : statusLabel(
              combinedStatus(
                storage.status,
                ...storage.filesystems.map((filesystem) => filesystem.status),
              ),
            ),
    },
  ];
  return (
    <section className="host-capacity-grid" aria-label="Host capacity">
      {cards.map(
        ({ key, label, icon: Icon, value, unit, detail, percent, state }) => (
          <button
            key={key}
            type="button"
            className="host-capacity-card frost-panel flowing-surface"
            onClick={() => onNavigate(key)}
            aria-label={`Inspect ${label} resources`}
            aria-describedby={
              key === 'gpu' ? allocationDescriptionId : undefined
            }
          >
            <PerimeterLight />
            <span className="host-capacity-label">
              <span>
                <Icon aria-hidden="true" />
                {label}
              </span>
              <ArrowUpRight aria-hidden="true" />
            </span>
            <span className="host-capacity-value">{value}</span>
            <span className="host-capacity-unit">
              {unit}
              {state ? <span className="host-data-state">{state}</span> : null}
            </span>
            <span
              className="host-capacity-detail"
              id={
                key === 'gpu' && allocation.status !== 'available'
                  ? allocationDescriptionId
                  : undefined
              }
            >
              {detail}
              {key === 'storage' && busiest ? (
                <span className="host-capacity-highest">
                  Highest: {busiest.mountPoint} ·{' '}
                  {formatPercent(
                    capacityPercent(busiest.usedBytes, busiest.totalBytes)!,
                    0,
                  )}
                </span>
              ) : null}
            </span>
            {key === 'gpu' ? (
              <GPUAllocationBar view={allocation} />
            ) : (
              <Progress value={percent} aria-label={`${label} utilization`} />
            )}
            {key === 'gpu' && allocation.status === 'available' ? (
              <span id={allocationDescriptionId} className="sr-only">
                {allocationDescription}
              </span>
            ) : null}
          </button>
        ),
      )}
    </section>
  );
}

function GPUAllocationBar({ view }: { view: GPUAllocationView }) {
  const known = view.status === 'available';
  const categories = [
    { key: 'assigned', label: 'Assigned', count: view.assigned },
    { key: 'reserved', label: 'Reserved', count: view.reserved },
    { key: 'unassigned', label: 'Unassigned', count: view.unassigned ?? 0 },
  ];
  return (
    <span className="gpu-allocation-capacity">
      {known ? (
        <meter
          className="sr-only"
          min={0}
          max={Math.max(1, view.total)}
          value={view.assigned + view.reserved}
          aria-label="GPU assignments"
          aria-valuetext={
            view.total === 0
              ? 'No configured resources'
              : categories
                  .map(({ label, count }) => `${count} ${label.toLowerCase()}`)
                  .join(', ')
          }
        />
      ) : (
        <span className="sr-only">
          GPU assignments:{' '}
          {view.status === 'incomplete' ? 'Incomplete' : 'Unknown'}
        </span>
      )}
      <span
        aria-hidden="true"
        className="gpu-allocation-bar"
        data-known={known}
      >
        {known && view.total > 0 ? (
          <span
            data-state="occupied"
            style={{
              width: `${((view.assigned + view.reserved) / view.total) * 100}%`,
            }}
          />
        ) : null}
      </span>
    </span>
  );
}
