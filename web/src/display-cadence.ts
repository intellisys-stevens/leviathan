import { readBrowserSetting } from './browser-storage';
import { formatSamplingInterval } from './chart-window';

export const displayCadenceStorageKey = 'leviathan.displayCadence.v1';
export const defaultDisplayCadenceMs = 1000;
export const displayCadenceOptions = [0, 1000, 2000] as const;

export function normalizeDisplayCadence(value: unknown): number {
  if (value == null || value === '') return defaultDisplayCadenceMs;
  const parsed = Number(value);
  return displayCadenceOptions.includes(
    parsed as (typeof displayCadenceOptions)[number],
  )
    ? parsed
    : defaultDisplayCadenceMs;
}

export function storedDisplayCadence(): number {
  return normalizeDisplayCadence(readBrowserSetting(displayCadenceStorageKey));
}

export function displayCadenceLabel(milliseconds: number): string {
  if (milliseconds === 0) return 'Every sample';
  return `${milliseconds / 1000}s`;
}

function validHostSamplingInterval(
  milliseconds: number | null | undefined,
): milliseconds is number {
  return (
    typeof milliseconds === 'number' &&
    Number.isFinite(milliseconds) &&
    milliseconds > 0
  );
}

export function visibleDisplayCadenceLabel(
  milliseconds: number,
  hostSamplingIntervalMs: number | null | undefined,
): string {
  if (milliseconds !== 0) return displayCadenceLabel(milliseconds);
  return validHostSamplingInterval(hostSamplingIntervalMs)
    ? formatSamplingInterval(hostSamplingIntervalMs)
    : 'Auto';
}

export function accessibleDisplayCadenceLabel(
  milliseconds: number,
  hostSamplingIntervalMs: number | null | undefined,
): string {
  const visible = visibleDisplayCadenceLabel(
    milliseconds,
    hostSamplingIntervalMs,
  );
  return milliseconds === 0 ? `${visible}, every host sample` : visible;
}

export function availableDisplayCadenceOptions(
  hostSamplingIntervalMs: number | null | undefined,
): readonly number[] {
  if (!validHostSamplingInterval(hostSamplingIntervalMs))
    return displayCadenceOptions;
  return displayCadenceOptions.filter(
    (milliseconds) =>
      milliseconds === 0 || milliseconds > hostSamplingIntervalMs,
  );
}

export function effectiveDisplayCadenceOption(
  milliseconds: number,
  hostSamplingIntervalMs: number | null | undefined,
): number {
  if (
    milliseconds !== 0 &&
    validHostSamplingInterval(hostSamplingIntervalMs) &&
    milliseconds <= hostSamplingIntervalMs
  )
    return 0;
  return milliseconds;
}
