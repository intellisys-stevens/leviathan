import { readBrowserSetting } from './browser-storage';

// This preference only controls rendering in this browser, never collection.
export const displayCadenceStorageKey = 'leviathan.displayCadence.v1';
export const defaultDisplayCadenceMs = 500;
export const displayCadencePresets = [
  { label: '0.5s', value: 500 },
  { label: '1s', value: 1000 },
  { label: '2s', value: 2000 },
] as const;

export function storedDisplayCadence(): number {
  const value = Number(readBrowserSetting(displayCadenceStorageKey));
  return displayCadencePresets.some((preset) => preset.value === value)
    ? value
    : defaultDisplayCadenceMs;
}
