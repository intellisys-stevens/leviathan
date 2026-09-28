import type { components } from './api.gen';

export type GPUCapacity = components['schemas']['GPUCapacity'];
export type GPUCapacityRow = components['schemas']['GPUCapacityRow'];

export const gpuCapacityRefreshMs = 5_000;
export const gpuCapacityStaleMs = 15_000;

const statuses = new Set([
  'available',
  'partial',
  'stale',
  'unavailable',
  'unsupported',
]);
const rowStatuses = new Set(['available', 'unavailable', 'unsupported']);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalText = (value: unknown) =>
  value === undefined || typeof value === 'string';
const nonnegativeInteger = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A malformed response must never turn into a believable free-device count. */
export function parseGPUCapacity(value: unknown): GPUCapacity {
  if (
    !record(value) ||
    !statuses.has(String(value.status)) ||
    !nonnegativeInteger(value.revision) ||
    !optionalText(value.message) ||
    (value.observedAt !== undefined &&
      (typeof value.observedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.observedAt)))) ||
    !Array.isArray(value.rows)
  )
    throw new Error('Capacity response is invalid.');

  const ids = new Set<string>();
  for (const row of value.rows) {
    if (
      !record(row) ||
      typeof row.id !== 'string' ||
      !row.id ||
      ids.has(row.id) ||
      (row.mode !== 'native' && row.mode !== 'mig') ||
      typeof row.model !== 'string' ||
      !optionalText(row.profile) ||
      !optionalText(row.message) ||
      !rowStatuses.has(String(row.status)) ||
      (row.memoryBytes !== null && !nonnegativeInteger(row.memoryBytes)) ||
      (row.available !== null && !nonnegativeInteger(row.available)) ||
      (row.status === 'available' && row.available === null)
    )
      throw new Error('Capacity response is invalid.');
    ids.add(row.id);
  }
  if (
    (value.status === 'available' || value.status === 'partial') &&
    !value.observedAt
  )
    throw new Error('Capacity observation time is missing.');
  return value as GPUCapacity;
}

export function orderedCapacityRows(rows: readonly GPUCapacityRow[]) {
  return [...rows].sort(
    (a, b) =>
      Number(a.mode === 'mig') - Number(b.mode === 'mig') ||
      (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0) ||
      a.model.localeCompare(b.model) ||
      (a.profile ?? '').localeCompare(b.profile ?? '') ||
      a.id.localeCompare(b.id),
  );
}
