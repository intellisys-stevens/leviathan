import { beforeEach, describe, expect, it } from 'vitest';
import {
  accessibleDisplayCadenceLabel,
  availableDisplayCadenceOptions,
  defaultDisplayCadenceMs,
  displayCadenceLabel,
  displayCadenceStorageKey,
  effectiveDisplayCadenceOption,
  normalizeDisplayCadence,
  storedDisplayCadence,
  visibleDisplayCadenceLabel,
} from './display-cadence';

describe('browser-local display cadence', () => {
  beforeEach(() => localStorage.clear());

  it('defaults invalid or missing values to one second', () => {
    expect(normalizeDisplayCadence(undefined)).toBe(defaultDisplayCadenceMs);
    expect(normalizeDisplayCadence('500')).toBe(defaultDisplayCadenceMs);
    expect(storedDisplayCadence()).toBe(defaultDisplayCadenceMs);
  });

  it('restores every-sample, one-second, and two-second choices', () => {
    for (const value of [0, 1000, 2000]) {
      localStorage.setItem(displayCadenceStorageKey, String(value));
      expect(storedDisplayCadence()).toBe(value);
    }
    expect(displayCadenceLabel(0)).toBe('Every sample');
    expect(displayCadenceLabel(2000)).toBe('2s');
  });

  it('presents every-sample cadence using the current host interval', () => {
    expect(visibleDisplayCadenceLabel(0, 500)).toBe('0.5s');
    expect(accessibleDisplayCadenceLabel(0, 500)).toBe(
      '0.5s, every host sample',
    );
    expect(visibleDisplayCadenceLabel(0, 250)).toBe('0.25s');
    expect(visibleDisplayCadenceLabel(0, null)).toBe('Auto');
    expect(accessibleDisplayCadenceLabel(0, null)).toBe(
      'Auto, every host sample',
    );
    expect(visibleDisplayCadenceLabel(1000, 500)).toBe('1s');
  });

  it('hides rates that cannot differ from a slower host without rewriting the preference', () => {
    expect(availableDisplayCadenceOptions(500)).toEqual([0, 1000, 2000]);
    expect(availableDisplayCadenceOptions(1000)).toEqual([0, 2000]);
    expect(availableDisplayCadenceOptions(2000)).toEqual([0]);
    expect(availableDisplayCadenceOptions(undefined)).toEqual([0, 1000, 2000]);

    expect(effectiveDisplayCadenceOption(1000, 1000)).toBe(0);
    expect(effectiveDisplayCadenceOption(1000, 500)).toBe(1000);
    expect(effectiveDisplayCadenceOption(2000, 1000)).toBe(2000);

    localStorage.setItem(displayCadenceStorageKey, '1000');
    expect(storedDisplayCadence()).toBe(1000);
  });
});
