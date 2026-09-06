import { memo, useId, useRef, useState, type CSSProperties } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  formatBytes,
  formatMetric,
  formatPercent,
  memoryPercent,
  metricValue,
  powerLevel,
  temperatureLevel,
} from '../lib';
import { attributedWorkloads, workloadLabel } from '../attribution';
import type { Attribution, GPU, Selection } from '../types';
import { MetricIcon } from './metric-icon';
import { GPUBrandIcon } from './gpu-brand-icon';
import { SnowCap } from './snow-cap';
import type { GPUAllocationState } from '../gpu-allocation';
import {
  gpuChipActivity,
  gpuChipRegions,
  gpuTopologyKey,
  type GPUChipRegion,
} from './gpu-chip';
import { GPU_CHIP_COLORS } from './gpu-chip-appearance';
import { GPUBoardFallback } from './gpu-board-fallback';
import { GPUBoardView } from './gpu-board-view';
import './gpu-card.css';

type Props = {
  gpu: GPU;
  hostKey?: string;
  theme?: 'dark' | 'light';
  live?: boolean;
  attribution?: Attribution;
  onSelect: (selection: Selection) => void;
  allocationStates?: ReadonlyMap<string, GPUAllocationState>;
};

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
      <MetricIcon metric="temperature" className="size-3.5" /> {formatted}
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
      <MetricIcon metric="power" className="size-3.5" /> {formatted}
      <span className="sr-only">, Physical GPU power, {context}</span>
    </span>
  );
}

function assignmentLabel(state: GPUAllocationState): string {
  return state === 'unknown'
    ? 'Assignment unknown'
    : state.charAt(0).toUpperCase() + state.slice(1);
}

function AllocationBadge({ state }: { state: GPUAllocationState }) {
  return (
    <span className="gpu-allocation-label" data-allocation-state={state}>
      {state === 'unknown' ? 'Unknown' : assignmentLabel(state)}
    </span>
  );
}

function ownersFor(region: GPUChipRegion, attribution?: Attribution): string {
  if (attribution?.status !== 'available') return '';
  const selection = region.selection;
  return attributedWorkloads(
    attribution,
    selection.kind === 'physical_gpu'
      ? [{ entityType: 'physical_gpu', entityUuid: selection.gpu.uuid }]
      : [
          { entityType: 'compute_instance', entityUuid: selection.ci.uuid },
          { entityType: 'physical_gpu', entityUuid: selection.gpu.uuid },
        ],
  )
    .map(
      ({ workload, state }) =>
        `${workloadLabel(workload)}${state === 'reserved' ? ' (reserved)' : ''}`,
    )
    .join('; ');
}

function ChipSummary({
  region,
  state,
  attribution,
  live,
}: {
  region: GPUChipRegion;
  state: GPUAllocationState;
  attribution?: Attribution;
  live: boolean;
}) {
  const selection = region.selection;
  const device =
    selection.kind === 'compute_instance' ? selection.gi : selection.gpu;
  const shared = selection.kind === 'compute_instance';
  const memory = memoryPercent(device.memory);
  const sm = gpuChipActivity(region, live);
  const smMetric = device.metrics.sm_activity;
  const owners = live ? ownersFor(region, attribution) : '';
  const delayed = !live || smMetric?.status === 'stale';
  const estimated = smMetric?.status === 'estimated';
  const estimate =
    smMetric?.unit === 'percent' &&
    smMetric.scope === (shared ? 'gpu_instance' : 'physical_gpu') &&
    smMetric.value != null &&
    Number.isFinite(smMetric.value) &&
    smMetric.value >= 0 &&
    smMetric.value <= 100
      ? smMetric.value
      : null;
  const smLabel = delayed
    ? 'Delayed'
    : sm != null
      ? formatPercent(sm)
      : estimated
        ? estimate == null
          ? 'Estimated'
          : `Estimated ${formatPercent(estimate)}`
        : 'Unavailable';
  const statuses = [device.memory.status, smMetric?.status];
  const notice = statuses.includes('error')
    ? 'Telemetry error'
    : !live || statuses.includes('stale')
      ? 'Telemetry delayed'
      : statuses.includes('permission_denied')
        ? 'Limited telemetry'
        : null;
  return (
    <output
      className="gpu-chip-summary"
      aria-live="off"
      data-region-id={region.id}
    >
      <div className="gpu-chip-summary-heading">
        <strong>{region.label}</strong>
        <AllocationBadge state={state} />
      </div>
      {shared ? (
        <p>{selection.ci.profile || selection.gi.profile}</p>
      ) : (
        <p>Physical GPU</p>
      )}
      {owners ? <p className="gpu-chip-owners">{owners}</p> : null}
      <dl>
        <div>
          <dt>{shared ? `Shared GI ${selection.gi.id} memory` : 'Memory'}</dt>
          <dd>
            {memory == null
              ? 'Unavailable'
              : `${formatBytes(device.memory.usedBytes)} / ${formatBytes(device.memory.totalBytes)}`}
          </dd>
        </div>
        <div>
          <dt>
            {shared
              ? `Shared GI ${selection.gi.id} SM activity`
              : 'SM activity'}
          </dt>
          <dd>{smLabel}</dd>
        </div>
      </dl>
      {notice ? <p className="gpu-chip-notice">{notice}</p> : null}
    </output>
  );
}

function GPUCardComponent({
  gpu,
  hostKey = '',
  theme = 'dark',
  live = true,
  attribution,
  onSelect,
  allocationStates,
}: Props) {
  const headingID = useId();
  const descriptionID = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [highlight, setHighlight] = useState<{
    id: string | null;
    topology: string;
  }>({ id: null, topology: '' });
  const regions = gpuChipRegions(gpu);
  const topologyKey = gpuTopologyKey(gpu);
  const highlighted =
    highlight.topology === topologyKey
      ? regions.find((region) => region.id === highlight.id)
      : undefined;
  const stateFor = (id: string): GPUAllocationState =>
    !live || (attribution && attribution.status !== 'available')
      ? 'unknown'
      : (allocationStates?.get(id) ?? 'unknown');
  const appearances = regions.map((region) => ({
    id: region.id,
    state: stateFor(region.id),
    activity: gpuChipActivity(region, live),
  }));
  const colors = GPU_CHIP_COLORS[theme];
  const highlightRegion = (id: string | null) =>
    setHighlight((previous) =>
      previous.id === id && previous.topology === topologyKey
        ? previous
        : { id, topology: topologyKey },
    );
  const selectRegion = (id: string) => {
    const region = regions.find((candidate) => candidate.id === id);
    if (!region) return;
    buttons.current.get(id)?.focus({ preventScroll: true });
    onSelect(region.selection);
  };
  const fallback = (
    <GPUBoardFallback
      regions={regions}
      appearances={appearances}
      theme={theme}
      highlightedId={highlighted?.id ?? null}
    />
  );
  return (
    <article
      className="gpu-card accelerator-card gpu-3d-card snow-capped"
      aria-labelledby={headingID}
      data-gpu-index={gpu.index}
      data-gpu-uuid={gpu.uuid}
      data-snow-cap="generated"
      style={
        {
          '--gpu-chip-assigned': colors.assigned,
          '--gpu-chip-unassigned': colors.unassigned,
          '--gpu-chip-reserved': colors.reserved,
          '--gpu-chip-unknown': colors.unknown,
        } as CSSProperties
      }
    >
      <SnowCap surfaceKey={`gpu:${gpu.uuid}`} />
      <header className="gpu-hardware-header">
        <div className="gpu-hardware-heading">
          <GPUBrandIcon gpu={gpu} className="gpu-identity-icon size-4" />
          <h3 id={headingID}>GPU {gpu.index}</h3>
          <span className="gpu-mode-label">
            {gpu.migEnabled ? 'MIG' : 'Full GPU'}
          </span>
          <button
            type="button"
            className="accelerator-detail-button"
            aria-label={`Open GPU ${gpu.index} physical GPU details`}
            onClick={() => onSelect({ kind: 'physical_gpu', gpu })}
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </button>
        </div>
        <p className="gpu-model-name">{gpu.name}</p>
        <div className="gpu-hardware-status">
          <TemperatureChip gpu={gpu} />
          <PowerChip gpu={gpu} />
        </div>
      </header>
      <div className="gpu-scene-area">
        <GPUBoardView
          gpuKey={`${hostKey}/${gpu.uuid}`}
          topologyKey={topologyKey}
          regions={regions}
          appearances={appearances}
          theme={theme}
          highlightedId={highlighted?.id ?? null}
          onHighlight={highlightRegion}
          onSelect={selectRegion}
          label={`GPU ${gpu.index} interactive board`}
          fallback={fallback}
        />
        {highlighted ? (
          <ChipSummary
            region={highlighted}
            attribution={attribution}
            live={live}
            state={stateFor(highlighted.id)}
          />
        ) : null}
      </div>
      <div
        className="gpu-instance-controls"
        aria-label={`GPU ${gpu.index} chip regions`}
        onMouseLeave={() => {
          if (
            !buttons.current.has(highlight.id ?? '') ||
            ![...buttons.current.values()].includes(
              document.activeElement as HTMLButtonElement,
            )
          )
            highlightRegion(null);
        }}
      >
        {regions.map((region) => {
          const selection = region.selection;
          const compute = selection.kind === 'compute_instance';
          const state = stateFor(region.id);
          const description = [
            compute ? selection.ci.profile : 'Physical GPU',
            assignmentLabel(state),
            live ? ownersFor(region, attribution) : '',
          ]
            .filter(Boolean)
            .join('. ');
          return (
            <button
              type="button"
              key={region.identity}
              ref={(element) => {
                if (element) buttons.current.set(region.id, element);
                else buttons.current.delete(region.id);
              }}
              className={compute ? 'gpu-ci-button' : 'gpu-full-chip-button'}
              data-ci-uuid={compute ? selection.ci.uuid : undefined}
              data-region-id={region.id}
              data-chip-key={region.id}
              data-allocation-state={state}
              data-highlighted={highlighted?.id === region.id || undefined}
              aria-label={
                compute
                  ? `Open GPU ${gpu.index} · GI ${selection.gi.id} · CI ${selection.ci.id} details`
                  : `Open GPU ${gpu.index} full GPU details`
              }
              aria-describedby={`${descriptionID}-${region.id}`}
              onFocus={() => highlightRegion(region.id)}
              onBlur={() => highlightRegion(null)}
              onMouseEnter={() => highlightRegion(region.id)}
              onClick={() => selectRegion(region.id)}
            >
              <span id={`${descriptionID}-${region.id}`} className="sr-only">
                {description}
              </span>
              <span className="gpu-ci-identity">
                {compute ? region.label : 'Inspect chip'}
              </span>
              <AllocationBadge state={state} />
            </button>
          );
        })}
        {regions.length === 0 ? (
          <p className="accelerator-empty">No observed MIG instances.</p>
        ) : null}
      </div>
    </article>
  );
}

export const GPUCard = memo(GPUCardComponent);
