import { useEffect, useMemo, useState } from 'react';
import { Cpu, Database, MemoryStick } from 'lucide-react';
import { durationQuery } from '../chart-window';
import { formatBytes, formatBytesPerSecond, formatPercent } from '../lib';
import type { HistorySeries, Snapshot } from '../types';

type HostPoint = {
  sampledAt: string;
  cpu?: number;
  memory?: number;
  storage?: number;
};

function usable(status: string): boolean {
  return status === 'available' || status === 'estimated';
}

function ratio(
  used: number | null | undefined,
  total: number | null | undefined,
) {
  if (used == null || total == null || total <= 0) return undefined;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

function MiniTrend({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) {
    return (
      <div className="mt-3 h-9 rounded bg-muted/25 px-2 py-2 text-center text-[11px] text-muted-foreground">
        Collecting trend…
      </div>
    );
  }
  const bounded = values.slice(-80);
  const minimum = Math.min(...bounded);
  const maximum = Math.max(...bounded);
  const span = Math.max(1, maximum - minimum);
  const points = bounded
    .map((value, index) => {
      const x = (index / Math.max(1, bounded.length - 1)) * 100;
      const y = 30 - ((value - minimum) / span) * 26;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  return (
    <figure
      className="mt-3"
      aria-label={`${label} recent trend from ${minimum.toFixed(1)} to ${maximum.toFixed(1)} percent`}
    >
      <svg
        viewBox="0 0 100 32"
        preserveAspectRatio="none"
        className="h-9 w-full overflow-visible text-primary"
        aria-hidden="true"
      >
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </figure>
  );
}

export function SystemOverview({
  snapshot,
  chartWindowMs,
}: {
  snapshot: Snapshot;
  chartWindowMs: number;
}) {
  const system = snapshot.system;
  const cpuValue = usable(system.cpu.utilization.status)
    ? system.cpu.utilization.value
    : null;
  const memoryValue = usable(system.memory.utilization.status)
    ? (system.memory.utilization.value ?? undefined)
    : undefined;
  const storageValue = ratio(
    system.storage.usedBytes,
    system.storage.totalBytes,
  );
  const [points, setPoints] = useState<HostPoint[]>([]);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const query = new URLSearchParams({
        entity: '@host',
        metrics:
          'cpu_utilization,memory_utilization,storage_used_bytes,storage_total_bytes',
        window: durationQuery(chartWindowMs),
        maxPoints: '720',
      });
      try {
        const response = await fetch(`/api/v1/history?${query}`, {
          cache: 'no-store',
        });
        if (!response.ok) return;
        const series = (await response.json()) as HistorySeries;
        if (!active) return;
        setPoints(
          series.points.map((point) => ({
            sampledAt: point.sampledAt,
            cpu: point.values.cpu_utilization,
            memory: point.values.memory_utilization,
            storage: ratio(
              point.values.storage_used_bytes,
              point.values.storage_total_bytes,
            ),
          })),
        );
      } catch {
        // Current values remain available when retained history cannot load.
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [chartWindowMs]);
  const visiblePoints = useMemo(() => {
    const current: HostPoint = {
      sampledAt: snapshot.sampledAt,
      cpu: cpuValue ?? undefined,
      memory: memoryValue,
      storage: storageValue,
    };
    return [
      ...points.filter(({ sampledAt }) => sampledAt !== current.sampledAt),
      current,
    ];
  }, [cpuValue, memoryValue, points, snapshot.sampledAt, storageValue]);

  const cards = [
    {
      key: 'cpu' as const,
      label: 'CPU',
      icon: Cpu,
      value: cpuValue == null ? '—' : formatPercent(cpuValue),
      detail: `${system.cpu.logicalProcessors || '—'} logical · load ${system.cpu.load1.value?.toFixed(2) ?? '—'} / ${system.cpu.load5.value?.toFixed(2) ?? '—'} / ${system.cpu.load15.value?.toFixed(2) ?? '—'}`,
    },
    {
      key: 'memory' as const,
      label: 'RAM',
      icon: MemoryStick,
      value:
        system.memory.usedBytes == null
          ? '—'
          : `${formatBytes(system.memory.usedBytes)} / ${formatBytes(system.memory.totalBytes)}`,
      detail: `${memoryValue == null ? '—' : formatPercent(memoryValue)} used${system.memory.status === 'estimated' ? ' · available memory estimated' : ''}`,
    },
    {
      key: 'storage' as const,
      label: 'Storage',
      icon: Database,
      value:
        system.storage.usedBytes == null
          ? '—'
          : `${formatBytes(system.storage.usedBytes)} / ${formatBytes(system.storage.totalBytes)}`,
      detail: `R ${formatBytesPerSecond(system.storage.readBytesPerSecond.value)} · W ${formatBytesPerSecond(system.storage.writeBytesPerSecond.value)}`,
    },
  ];

  return (
    <section aria-labelledby="machine-telemetry-heading">
      <div className="section-heading-row">
        <div>
          <h2 id="machine-telemetry-heading" className="section-title">
            Machine
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {system.cpu.model || `${snapshot.host.os} / ${snapshot.host.arch}`}
          </p>
        </div>
        <span className="font-mono text-xs text-muted-foreground">
          {system.status}
        </span>
      </div>
      <div className="mt-3 grid gap-4 md:grid-cols-3">
        {cards.map(({ key, label, icon: Icon, value, detail }) => (
          <article key={key} className="frost-panel p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="inline-flex items-center gap-2 text-sm font-semibold">
                <Icon className="size-4 text-primary" aria-hidden="true" />
                {label}
              </h3>
              <span className="font-mono text-lg font-semibold text-primary">
                {value}
              </span>
            </div>
            <p
              className="mt-2 truncate text-xs text-muted-foreground"
              title={detail}
            >
              {detail}
            </p>
            <MiniTrend
              values={visiblePoints.flatMap((point) =>
                point[key] == null ? [] : [point[key] as number],
              )}
              label={label}
            />
          </article>
        ))}
      </div>
    </section>
  );
}

/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- The horizontally scrollable table must accept keyboard focus. */
export function FilesystemTable({ snapshot }: { snapshot: Snapshot }) {
  const filesystems = snapshot.system.storage.filesystems;
  return (
    <section aria-labelledby="filesystem-heading">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 id="filesystem-heading" className="section-title">
            Filesystems
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Persistent local filesystems in Leviathan&apos;s mount namespace
          </p>
        </div>
        <span className="font-mono text-xs text-muted-foreground">
          {filesystems.length} mounted
        </span>
      </div>
      <section
        className="frost-panel overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Filesystem capacity table"
        tabIndex={0}
      >
        {filesystems.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            No persistent local filesystem capacity is available.
          </p>
        ) : (
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-border/80 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Mount</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Used</th>
                <th className="px-4 py-3 font-medium">Available</th>
                <th className="px-4 py-3 font-medium">Utilization</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {filesystems.map((filesystem) => {
                const percent = ratio(
                  filesystem.usedBytes,
                  filesystem.totalBytes,
                );
                return (
                  <tr key={filesystem.id}>
                    <td
                      className="max-w-64 truncate px-4 py-3 font-mono"
                      title={filesystem.mountPoint}
                    >
                      {filesystem.mountPoint}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {filesystem.fsType}
                    </td>
                    <td className="px-4 py-3 font-mono">
                      {formatBytes(filesystem.usedBytes)}
                    </td>
                    <td className="px-4 py-3 font-mono">
                      {formatBytes(filesystem.availableBytes)}
                    </td>
                    <td className="px-4 py-3 font-mono">
                      {percent == null ? '—' : formatPercent(percent)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {filesystem.status}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}
/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */
