import type { GPU, Selection } from '../types';
import type { BoardRegion } from './gpu-board-model';

export type GPUChipRegion = BoardRegion & {
  selection: Selection;
  identity: string;
};

/** CIs share their GI's measured SM activity; allocation and memory are unrelated. */
export function gpuChipActivity(
  region: GPUChipRegion,
  live = true,
): number | null {
  const selection = region.selection;
  const compute = selection.kind === 'compute_instance';
  const metric = (compute ? selection.gi : selection.gpu).metrics.sm_activity;
  return live &&
    metric?.status === 'available' &&
    metric.unit === 'percent' &&
    metric.scope === (compute ? 'gpu_instance' : 'physical_gpu') &&
    metric.value != null &&
    Number.isFinite(metric.value) &&
    metric.value >= 0 &&
    metric.value <= 100
    ? metric.value
    : null;
}

/** Every cell has area 1/count; short rows grow taller, never inventing slots. */
export function chipLayout(
  count: number,
): Pick<BoardRegion, 'x' | 'y' | 'width' | 'height'>[] {
  if (!Number.isSafeInteger(count) || count <= 0) return [];
  const rowCount = Math.max(1, Math.round(Math.sqrt(count)));
  const minimum = Math.floor(count / rowCount);
  const extra = count % rowCount;
  let y = 0;
  return Array.from({ length: rowCount }, (_, row) => {
    const columns = minimum + (row < extra ? 1 : 0);
    const height = columns / count;
    const cells = Array.from({ length: columns }, (_, column) => ({
      x: column / columns,
      y,
      width: 1 / columns,
      height,
    }));
    y += height;
    return cells;
  }).flat();
}

export function gpuChipRegions(gpu: GPU): GPUChipRegion[] {
  if (!gpu.migEnabled)
    return [
      {
        id: gpu.uuid,
        identity: gpu.uuid,
        label: 'GPU',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        selection: { kind: 'physical_gpu', gpu },
      },
    ];
  const observed = new Map<
    string,
    {
      selection: Extract<Selection, { kind: 'compute_instance' }>;
      identity: string;
    }
  >();
  for (const gi of [...gpu.gpuInstances].sort((a, b) => a.id - b.id)) {
    for (const ci of [...gi.computeInstances].sort((a, b) => a.id - b.id)) {
      if (!observed.has(ci.uuid))
        observed.set(ci.uuid, {
          selection: { kind: 'compute_instance', gpu, gi, ci },
          identity: `${gi.generation || gi.uuid}/${ci.generation || ci.uuid}`,
        });
    }
  }
  const layout = chipLayout(observed.size);
  return [...observed.values()].map(({ selection, identity }, index) => ({
    ...layout[index],
    id: selection.ci.uuid,
    identity,
    label: `GI ${selection.gi.id} · CI ${selection.ci.id}`,
    selection,
  }));
}

export function gpuTopologyKey(gpu: GPU): string {
  return JSON.stringify([
    gpu.uuid,
    gpu.migEnabled,
    gpu.gpuInstances
      .map((gi) => [
        gi.uuid,
        gi.generation,
        gi.id,
        gi.profile,
        gi.computeInstances
          .map((ci) => [ci.uuid, ci.generation, ci.id, ci.profile])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]);
}
