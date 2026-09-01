import { beforeEach, describe, expect, it } from 'vitest';
import {
  defaultDisplayCadenceMs,
  displayCadenceLabel,
  displayCadenceStorageKey,
  normalizeDisplayCadence,
  storedDisplayCadence,
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
});
