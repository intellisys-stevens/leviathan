import { memo } from 'react';
import { Box, ChevronRight, Cpu, Gauge, Thermometer, Zap } from 'lucide-react';
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
  formatMetric,
  memoryPercent,
  metricValue,
  shortUUID,
} from '../lib';
import type { GPU, GpuInstance, Selection } from '../types';

type Props = {
  gpu: GPU;
  onSelect: (selection: Selection) => void;
};

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

function MigBlock({
  gpu,
  gi,
  onSelect,
}: {
  gpu: GPU;
  gi: GpuInstance;
  onSelect: Props['onSelect'];
}) {
  const memory = memoryPercent(gi.memory);
  const sm = metricValue(gi.metrics.sm_activity);
  const status = instanceStatus(gi);
  const single = gi.computeInstances.length === 1;
  const content = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="flex items-center gap-2">
          <span className="grid size-6 place-items-center rounded bg-primary/10 text-primary">
            <Cpu className="size-3.5" />
          </span>
          <span>
            <span className="block font-mono text-xs font-semibold">
              GI {gi.id}
              {single ? ` / CI ${gi.computeInstances[0].id}` : ''}
            </span>
            <span className="block font-mono text-[9px] text-muted-foreground">
              {shortUUID(single ? gi.computeInstances[0].uuid : gi.uuid)}
            </span>
          </span>
        </span>
        <Badge
          variant="outline"
          className="rounded border-primary/15 bg-primary/5 font-mono text-[10px] text-primary"
        >
          {gi.profile}
        </Badge>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <div className="mb-1.5 flex justify-between text-[9px] uppercase tracking-[0.11em] text-muted-foreground">
            <span>Memory</span>
            <span className="font-mono text-foreground">
              {memory == null ? '—' : `${memory.toFixed(1)}%`}
            </span>
          </div>
          <Progress
            value={memory ?? 0}
            aria-label="Memory used"
            className={
              memory != null && memory >= 85
                ? '[&_[data-slot=progress-indicator]]:bg-amber-400'
                : '[&_[data-slot=progress-indicator]]:bg-cyan-400'
            }
          />
        </div>
        <div>
          <div className="mb-1.5 flex justify-between text-[9px] uppercase tracking-[0.11em] text-muted-foreground">
            <span>SM active</span>
            <span className="font-mono text-foreground">
              {sm == null ? '—' : `${sm.toFixed(1)}%`}
            </span>
          </div>
          <Progress value={sm ?? 0} aria-label="SM activity" />
        </div>
      </div>

      {single ? (
        <div className="mt-4 border-t border-border/70 pt-3">
          <p className="font-mono text-[10px] text-muted-foreground">
            CI {gi.computeInstances[0].id} · {gi.computeInstances[0].profile}
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-1.5 border-t border-border/70 pt-3">
          <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
            {gi.computeInstances.length} CIs · shared GI metrics
          </p>
          {gi.computeInstances.map((ci) => (
            <button
              key={ci.uuid}
              type="button"
              onClick={() =>
                onSelect({ kind: 'compute_instance', gpu, gi, ci })
              }
              className="flex w-full items-center justify-between gap-3 rounded border border-transparent px-1.5 py-1.5 text-left hover:border-primary/30 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="font-mono text-[10px] text-primary">
                CI {ci.id}
              </span>
              <span className="truncate font-mono text-[10px] text-muted-foreground">
                {ci.profile}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );

  const className = `min-w-[210px] flex-1 border p-3 text-left transition-[border-color,background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${status === 'error' ? 'border-destructive/60 bg-destructive/5' : status === 'warning' ? 'border-amber-500/35 bg-amber-500/[0.035]' : 'border-border/80 bg-instance hover:border-primary/45 hover:bg-instance-hover'}`;
  return (
    <div className="min-w-[210px] flex-1 basis-0">
      {single ? (
        <button
          type="button"
          className={`${className} h-full w-full`}
          onClick={() =>
            onSelect({
              kind: 'compute_instance',
              gpu,
              gi,
              ci: gi.computeInstances[0],
            })
          }
        >
          {content}
        </button>
      ) : (
        <div className={`${className} h-full`}>{content}</div>
      )}
    </div>
  );
}

function GPUCardComponent({ gpu, onSelect }: Props) {
  return (
    <Card className="gpu-card border-border/75 bg-card/90 py-0 shadow-[0_14px_35px_rgb(0_0_0/13%)] ring-0">
      <CardHeader className="border-b border-border/70 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md border border-primary/20 bg-primary/10 text-primary">
            <Gauge className="size-4" />
          </span>
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2">
              GPU {gpu.index}
              <Badge className="rounded bg-primary/12 text-primary hover:bg-primary/12">
                {gpu.migEnabled ? 'MIG enabled' : 'Full GPU'}
              </Badge>
            </CardTitle>
            <CardDescription className="truncate font-mono text-xs">
              {gpu.name} · {shortUUID(gpu.uuid)}
            </CardDescription>
          </div>
        </div>
        <CardAction className="flex gap-4 text-xs text-muted-foreground">
          <span
            className="flex items-center gap-1.5"
            title="Physical GPU temperature"
          >
            <Thermometer className="size-3.5" />{' '}
            {formatMetric(gpu.metrics.temperature)}
          </span>
          <span
            className="flex items-center gap-1.5"
            title="Physical GPU power"
          >
            <Zap className="size-3.5" /> {formatMetric(gpu.metrics.power)}
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="py-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            <Box className="size-3" /> MIG instances
          </div>
          <span className="font-mono text-[10px] text-muted-foreground">
            {gpu.gpuInstances.length} GI ·{' '}
            {gpu.gpuInstances.reduce(
              (sum, gi) => sum + gi.computeInstances.length,
              0,
            )}{' '}
            CI
          </span>
        </div>
        {gpu.gpuInstances.length === 0 ? (
          gpu.migEnabled ? (
            <div className="border border-dashed border-border p-5 text-sm text-muted-foreground">
              No active MIG instances.
            </div>
          ) : (
            <button
              type="button"
              className="flex w-full items-center justify-between gap-4 border border-dashed border-border p-5 text-left text-sm text-muted-foreground transition-[border-color,background-color,color] hover:border-primary/45 hover:bg-primary/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Open GPU ${gpu.index} full GPU details`}
              onClick={() => onSelect({ kind: 'physical_gpu', gpu })}
            >
              <span>
                Full GPU memory: {formatBytes(gpu.memory.usedBytes)} /{' '}
                {formatBytes(gpu.memory.totalBytes)}
              </span>
              <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-[0.1em] text-primary">
                Details <ChevronRight className="size-3.5" />
              </span>
            </button>
          )
        ) : (
          <div className="flex flex-wrap gap-2">
            {gpu.gpuInstances.map((gi) => (
              <MigBlock key={gi.uuid} gpu={gpu} gi={gi} onSelect={onSelect} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export const GPUCard = memo(GPUCardComponent);
