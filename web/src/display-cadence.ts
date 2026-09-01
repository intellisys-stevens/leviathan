import { readBrowserSetting } from './browser-storage';

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
