import { memo } from 'react';
import {
  Activity,
  ArrowLeftRight,
  Box,
  ChevronRight,
  Cpu,
  Gauge,
  HardDrive,
  Thermometer,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  formatBytes,
  formatBytesPerSecond,
  formatMetric,
  formatPercent,
  memoryPercent,
  metricValue,
  powerLevel,
  temperatureLevel,
} from '../lib';
import { gpuAttributionTargets } from '../attribution';
import type { Attribution, GPU, GpuInstance, Selection } from '../types';
import { WorkspaceBadges } from './workspace-attribution';

type Props = {
  gpu: GPU;
  attribution?: Attribution;
  onSelect: (selection: Selection) => void;
};

const snowCapVariants = ['left', 'right', 'split', 'center', 'corner'] as const;

function snowCapVariant(key: string): (typeof snowCapVariants)[number] {
  let hash = 2_166_136_261;
  for (const character of key) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return snowCapVariants[(hash >>> 0) % snowCapVariants.length];
}

const temperatureTone = {
  unavailable: 'border-border bg-muted/40 text-muted-foreground',
  cool: 'border-sky-500/25 bg-sky-500/[0.08] text-sky-700 dark:text-sky-300',
  normal: 'border-primary/25 bg-primary/[0.08] text-primary',
  warm: 'border-amber-500/30 bg-amber-500/[0.09] text-amber-700 dark:text-amber-300',
  hot: 'border-destructive/35 bg-destructive/[0.09] text-destructive',
} as const;

const powerTone = {
  unavailable: 'border-border bg-muted/40 text-muted-foreground',
  unknown: 'border-border bg-muted/40 text-muted-foreground',
  low: 'border-sky-500/25 bg-sky-500/[0.08] text-sky-700 dark:text-sky-300',
  normal: 'border-primary/25 bg-primary/[0.08] text-primary',
  high: 'border-amber-500/25 bg-amber-500/[0.07] text-amber-700 dark:text-amber-300',
  near_limit:
    'border-orange-500/40 bg-orange-500/[0.12] text-orange-700 dark:text-orange-200',
} as const;

const powerLevelLabel = {
  unavailable: 'unavailable',
  unknown: 'limit unavailable',
  low: 'low',
  normal: 'normal',
  high: 'high',
  near_limit: 'near limit',
} as const;

function TemperatureChip({ gpu }: { gpu: GPU }) {
  const metric = gpu.metrics.temperature;
  const level = temperatureLevel(metric);
  const formatted = formatMetric(metric);
  return (
    <span
      className={`flex min-w-[4.7rem] items-center justify-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[13px] tabular-nums ${temperatureTone[level]}`}
      title={`Physical GPU temperature · ${level}`}
    >
      <Thermometer className="size-3.5" aria-hidden="true" /> {formatted}
      <span className="sr-only">, Physical GPU temperature, {level}</span>
    </span>
  );
}

function PowerChip({ gpu }: { gpu: GPU }) {
  const metric = gpu.metrics.power;
  const limit = gpu.metrics.power_limit;
  const level = powerLevel(metric, limit);
  const formatted = formatMetric(metric);
  const value = metricValue(metric);
  const limitValue = metricValue(limit);
  const ratio =
    value != null && limitValue != null && limitValue > 0
      ? Math.round((value / limitValue) * 100)
      : null;
  const context =
    ratio == null
      ? powerLevelLabel[level]
      : `${ratio}% of power limit, ${powerLevelLabel[level]}`;
  return (
    <span
      className={`flex min-w-[4.7rem] items-center justify-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[13px] tabular-nums ${powerTone[level]}`}
      title={`Physical GPU power · ${context}`}
    >
      <Zap className="size-3.5" aria-hidden="true" /> {formatted}
      <span className="sr-only">, Physical GPU power, {context}</span>
    </span>
  );
}

function instanceStatus(gi: GpuInstance): 'normal' | 'warning' | 'error' {
  const metrics = Object.values(gi.metrics);
  if (metrics.some((metric) => metric.status === 'error')) return 'error';
  const memory = memoryPercent(gi.memory);
  if (memory != null && memory >= 85) return 'warning';
  if (
    metrics.some(
      (metric) =>
        metric.status === 'stale' || metric.status === 'permission_denied',
    )
  )
    return 'warning';
  return 'normal';
}

function pcieThroughput(gpu: GPU): {
  value: string;
  detail: string;
  accessibleDetail: string;
} {
  const rx = metricValue(gpu.metrics.pcie_rx_bytes_per_second);
  const tx = metricValue(gpu.metrics.pcie_tx_bytes_per_second);
  if (rx != null && tx != null) {
    const formattedRX = formatBytesPerSecond(rx);
    const formattedTX = formatBytesPerSecond(tx);
    return {
      value: formatBytesPerSecond(rx + tx),
      detail: `RX ${formattedRX} · TX ${formattedTX}`,
      accessibleDetail: `Host to GPU ${formattedRX}; GPU to host ${formattedTX}`,
    };
  }
  if (rx != null) {
    const formatted = formatBytesPerSecond(rx);
    return {
      value: formatted,
      detail: 'RX · Host → GPU',
      accessibleDetail: `Host to GPU ${formatted}`,
    };
  }
  if (tx != null) {
    const formatted = formatBytesPerSecond(tx);
    return {
      value: formatted,
      detail: 'TX · GPU → Host',
      accessibleDetail: `GPU to host ${formatted}`,
    };
  }
  return {
    value: '—',
    detail: 'Unavailable',
    accessibleDetail: 'PCIe throughput unavailable',
  };
}

function FullGPUResource({
  gpu,
  onSelect,
}: {
  gpu: GPU;
  onSelect: Props['onSelect'];
}) {
  const memory = memoryPercent(gpu.memory);
  const sm = metricValue(gpu.metrics.sm_activity);
  const pcie = pcieThroughput(gpu);
  const memoryDetail =
    memory == null
      ? 'Unavailable'
      : `${formatBytes(gpu.memory.usedBytes)} / ${formatBytes(gpu.memory.totalBytes)}`;

  return (
    <section
      className="full-gpu-resource mobile-resource-surface interactive-resource relative flex min-h-[9rem] flex-1 flex-col border border-border/80 bg-instance p-3"
      aria-label={`GPU ${gpu.index} live telemetry`}
    >
      <button
        type="button"
        className="interactive-resource-button absolute inset-0 z-10 rounded-[inherit] text-left outline-none"
        aria-label={`Open GPU ${gpu.index} full GPU details`}
        onClick={() => onSelect({ kind: 'physical_gpu', gpu })}
      />
      <div className="pointer-events-none relative z-0 flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <Activity className="size-3.5" aria-hidden="true" /> Live telemetry
        </span>
        <span className="flex shrink-0 items-center gap-1 font-mono text-[13px] uppercase tracking-[0.1em] text-primary">
          Details
          <ChevronRight
            className="resource-chevron size-4"
            aria-hidden="true"
          />
        </span>
      </div>

      <div className="mobile-resource-metrics pointer-events-none relative z-0 mt-4 grid flex-1 grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="min-w-0">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[13px] uppercase tracking-[0.11em] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <HardDrive className="size-3" aria-hidden="true" />
              <span className="mobile-only-label">Mem</span>
              <span className="desktop-only-label">Memory</span>
            </span>
            <span className="font-mono text-foreground">
              {memory == null ? '—' : formatPercent(memory)}
            </span>
          </div>
          <Progress
            value={memory}
            aria-label={`GPU ${gpu.index} memory used`}
            className={
              memory != null && memory >= 85
                ? '[&_[data-slot=progress-indicator]]:bg-amber-400'
                : '[&_[data-slot=progress-indicator]]:bg-primary'
            }
          />
          <p className="mt-1.5 truncate font-mono text-[13px] text-muted-foreground">
            {memoryDetail}
          </p>
        </div>

        <div className="min-w-0">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[13px] uppercase tracking-[0.11em] text-muted-foreground">
            <span className="mobile-only-label">SM</span>
            <span className="desktop-only-label">SM active</span>
            <span className="font-mono text-foreground">
              {sm == null ? '—' : formatPercent(sm)}
            </span>
          </div>
          <Progress value={sm} aria-label={`GPU ${gpu.index} SM activity`} />
          {sm == null ? (
            <p className="mt-1.5 font-mono text-[13px] text-muted-foreground">
              Unavailable
            </p>
          ) : null}
        </div>

        <div className="min-w-0">
          <div className="mb-1.5 flex items-center gap-1.5 text-[13px] uppercase tracking-[0.11em] text-muted-foreground">
            <ArrowLeftRight className="size-3" aria-hidden="true" /> PCIe
          </div>
          <p className="font-mono text-[15px] font-semibold tabular-nums text-foreground">
            {pcie.value}
          </p>
          <p
            className="mt-1.5 truncate font-mono text-[13px] text-muted-foreground"
            aria-label={pcie.accessibleDetail}
            title={pcie.accessibleDetail}
          >
            {pcie.detail}
          </p>
        </div>
      </div>
    </section>
  );
}

function MigBlock({
  gpu,
  gi,
  attribution,
  onSelect,
}: {
  gpu: GPU;
  gi: GpuInstance;
  attribution?: Attribution;
  onSelect: Props['onSelect'];
}) {
  const memory = memoryPercent(gi.memory);
  const sm = metricValue(gi.metrics.sm_activity);
  const status = instanceStatus(gi);
  const single = gi.computeInstances.length === 1;
  const singleCI = single ? gi.computeInstances[0] : undefined;
  const identity = (
    <div
      className={`flex items-start justify-between gap-2 ${single ? 'pointer-events-none relative z-0' : ''}`}
    >
      <span className="flex items-center gap-2">
        <span className="grid size-6 place-items-center rounded bg-primary/10 text-primary">
          <Cpu className="size-3.5" aria-hidden="true" />
        </span>
        <span className="block font-mono text-[15px] font-semibold">
          {singleCI ? (
            <>
              <span className="mobile-only-label">GI {gi.id}</span>
              <span className="desktop-only-label">
                GI {gi.id} / CI {singleCI.id}
              </span>
            </>
          ) : (
            <>GI {gi.id}</>
          )}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <Badge
          variant="outline"
          className="rounded border-primary/15 bg-primary/5 font-mono text-[13px] text-primary"
        >
          {gi.profile}
        </Badge>
        {single ? (
          <ChevronRight
            className="resource-chevron size-4 text-primary"
            aria-hidden="true"
          />
        ) : null}
      </span>
    </div>
  );
  const content = (
    <>
      {singleCI ? (
        <button
          type="button"
          className="interactive-resource-button absolute inset-0 z-10 rounded-[inherit] text-left outline-none"
          aria-label={`Open GPU ${gpu.index} · GI ${gi.id} / CI ${singleCI.id} details`}
          onClick={() =>
            onSelect({
              kind: 'compute_instance',
              gpu,
              gi,
              ci: singleCI,
            })
          }
        />
      ) : null}
      {identity}

      <div className="pointer-events-none relative z-0 mt-4 grid grid-cols-2 gap-3">
        <div>
          <div className="mb-1.5 flex justify-between text-[13px] uppercase tracking-[0.11em] text-muted-foreground">
            <span className="mobile-only-label">Mem</span>
            <span className="desktop-only-label">Memory</span>
            <span className="font-mono text-foreground">
              {memory == null ? '—' : formatPercent(memory)}
            </span>
          </div>
          <Progress
            value={memory}
            aria-label={`GPU ${gpu.index} GI ${gi.id} memory used`}
            className={
              memory != null && memory >= 85
                ? '[&_[data-slot=progress-indicator]]:bg-amber-400'
                : '[&_[data-slot=progress-indicator]]:bg-primary'
            }
          />
        </div>
        <div>
          <div className="mb-1.5 flex justify-between text-[13px] uppercase tracking-[0.11em] text-muted-foreground">
            <span className="mobile-only-label">SM</span>
            <span className="desktop-only-label">SM active</span>
            <span className="font-mono text-foreground">
              {sm == null ? '—' : formatPercent(sm)}
            </span>
          </div>
          <Progress
            value={sm}
            aria-label={`GPU ${gpu.index} GI ${gi.id} SM activity`}
          />
        </div>
      </div>

      {attribution?.status === 'available' ? (
        <div
          className={
            single
              ? 'pointer-events-none relative z-20 mt-3 [&_button]:pointer-events-auto'
              : 'mt-3'
          }
        >
          <WorkspaceBadges
            attribution={attribution}
            targets={gi.computeInstances.map((ci) => ({
              entityType: 'compute_instance',
              entityUuid: ci.uuid,
            }))}
            limit={3}
            showUnassigned
          />
        </div>
      ) : null}

      {!singleCI ? (
        <div className="mobile-ci-list mt-4 space-y-1.5 border-t border-border/70 pt-3">
          <p className="font-mono text-[13px] uppercase tracking-[0.12em] text-muted-foreground">
            {gi.computeInstances.length} CIs · shared GI metrics
          </p>
          {gi.computeInstances.map((ci) => (
            <div
              key={ci.uuid}
              className="mobile-ci-card interactive-resource relative flex w-full items-center justify-between gap-3 rounded border border-transparent px-2 py-2 text-left"
            >
              <button
                type="button"
                className="interactive-resource-button absolute inset-0 z-10 rounded-[inherit] text-left outline-none"
                aria-label={`Open GPU ${gpu.index} · GI ${gi.id} · CI ${ci.id} details`}
                onClick={() =>
                  onSelect({ kind: 'compute_instance', gpu, gi, ci })
                }
              />
              <span className="pointer-events-none relative z-0 font-mono text-[15px] text-primary">
                CI {ci.id}
              </span>
              <span className="pointer-events-none relative z-0 flex min-w-0 flex-1 items-center justify-end gap-2">
                <span className="truncate font-mono text-[13px] text-muted-foreground">
                  {ci.profile}
                </span>
              </span>
              <span className="pointer-events-none relative z-20 [&_button]:pointer-events-auto">
                <WorkspaceBadges
                  attribution={attribution}
                  targets={[
                    {
                      entityType: 'compute_instance',
                      entityUuid: ci.uuid,
                    },
                  ]}
                  limit={1}
                  showUnassigned
                />
              </span>
              <ChevronRight
                className="resource-chevron pointer-events-none relative z-0 size-4 shrink-0 text-primary"
                aria-hidden="true"
              />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );

  const className = `min-w-0 border p-3 text-left ${single ? 'interactive-resource relative' : ''} ${status === 'error' ? 'border-destructive/60 bg-destructive/5' : status === 'warning' ? 'border-amber-500/35 bg-amber-500/[0.035]' : 'border-border/80 bg-instance'}`;
  return (
    <div className="mobile-mig-block min-w-0">
      <div className={`${className} h-full`}>{content}</div>
    </div>
  );
}

function GPUCardComponent({ gpu, attribution, onSelect }: Props) {
  return (
    <Card
      className="frost-panel snow-capped gpu-card mobile-resource-card h-full border-border/75 bg-card/90 py-0 shadow-[0_14px_35px_rgb(0_0_0/13%)] ring-0"
      data-snow-cap={snowCapVariant(gpu.uuid)}
    >
      <CardHeader className="border-b border-border/70 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md border border-primary/20 bg-primary/10 text-primary">
            <Gauge className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2 text-[17px]">
              GPU {gpu.index}
              <Badge className="rounded bg-primary/12 text-primary hover:bg-primary/12">
                {gpu.migEnabled ? 'MIG enabled' : 'Full GPU'}
              </Badge>
            </CardTitle>
            <CardDescription className="truncate font-mono text-[13px]">
              {gpu.name}
            </CardDescription>
          </div>
        </div>
        <CardAction className="col-span-full col-start-1 row-span-1 row-start-2 mt-2 flex flex-wrap justify-end gap-2 text-[13px] text-muted-foreground sm:col-span-1 sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:mt-0 sm:flex-nowrap">
          {gpu.migEnabled ? (
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1 rounded-md border border-primary/20 bg-primary/5 px-2.5 font-mono text-[13px] uppercase tracking-[0.08em] text-primary transition-colors hover:border-primary/40 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Open GPU ${gpu.index} physical GPU details`}
              onClick={() => onSelect({ kind: 'physical_gpu', gpu })}
            >
              Physical details
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
          <TemperatureChip gpu={gpu} />
          <PowerChip gpu={gpu} />
        </CardAction>
        <div className="col-span-full mt-1 min-w-0">
          <WorkspaceBadges
            attribution={attribution}
            targets={gpuAttributionTargets(gpu)}
            limit={3}
          />
        </div>
      </CardHeader>
      <CardContent className="gpu-resource-body mobile-resource-body flex min-h-[13rem] flex-1 flex-col py-4">
        {gpu.migEnabled ? (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <Box className="size-3" aria-hidden="true" /> MIG instances
              </div>
              <span className="font-mono text-[13px] text-muted-foreground">
                {gpu.gpuInstances.length} GI ·{' '}
                {gpu.gpuInstances.reduce(
                  (sum, gi) => sum + gi.computeInstances.length,
                  0,
                )}{' '}
                CI
              </span>
            </div>
            {gpu.gpuInstances.length === 0 ? (
              <div className="flex flex-1 items-center border border-dashed border-border p-5 text-[15px] text-muted-foreground">
                No active MIG instances.
              </div>
            ) : (
              <div
                className={`mig-resource-grid grid flex-1 grid-cols-1 gap-2 ${gpu.gpuInstances.length > 1 ? 'sm:grid-cols-2' : ''}`}
              >
                {gpu.gpuInstances.map((gi) => (
                  <MigBlock
                    key={gi.uuid}
                    gpu={gpu}
                    gi={gi}
                    attribution={attribution}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            )}
          </>
        ) : (
          <FullGPUResource gpu={gpu} onSelect={onSelect} />
        )}
      </CardContent>
    </Card>
  );
}

export const GPUCard = memo(GPUCardComponent);
