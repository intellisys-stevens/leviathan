import { describe, expect, it } from 'vitest';
import { systemFixture } from '../test/system-fixture';
import type { Snapshot } from '../types';
import {
  buildMotherboardAppearance,
  motherboardGlowIntensity,
} from './motherboard-appearance';

const snapshot = () =>
  ({ system: systemFixture('2026-09-05T20:00:00Z') }) as Snapshot;

describe('motherboard measured utilization', () => {
  it('keeps valid CPU utilization when only load-average collection fails', () => {
    const value = snapshot();
    value.system.cpu.status = 'stale';
    value.system.cpu.load1.status = 'error';
    value.system.cpu.load5.status = 'error';
    value.system.cpu.load15.status = 'error';
    expect(buildMotherboardAppearance(value, true).cpu).toBe(37);
    value.system.cpu.utilization.status = 'stale';
    expect(buildMotherboardAppearance(value, true).cpu).toBeNull();
    expect(buildMotherboardAppearance(value, false).cpu).toBeNull();
  });

  it('uses independent host utilization rather than GPU or capacity estimates', () => {
    const value = snapshot();
    expect(buildMotherboardAppearance(value, true)).toEqual({
      cpu: 37,
      memory: 40.625,
    });
    value.system!.cpu!.status = 'error';
    expect(buildMotherboardAppearance(value, true)).toEqual({
      cpu: null,
      memory: 40.625,
    });
  });

  it.each(['stale', 'estimated', 'error', 'unsupported'] as const)(
    'keeps %s measurements neutral',
    (status) => {
      const value = snapshot();
      value.system!.cpu!.utilization.status = status;
      value.system!.memory!.status = status;
      expect(buildMotherboardAppearance(value, true)).toEqual({
        cpu: null,
        memory: null,
      });
    },
  );

  it('distinguishes measured zero from absent data and a disconnected retained snapshot', () => {
    const value = snapshot();
    value.system!.cpu!.utilization.value = 0;
    value.system!.memory!.utilization.value = null;
    expect(buildMotherboardAppearance(value, true)).toEqual({
      cpu: 0,
      memory: null,
    });
    expect(buildMotherboardAppearance(value, false)).toEqual({
      cpu: null,
      memory: null,
    });
    expect(buildMotherboardAppearance(null, true)).toEqual({
      cpu: null,
      memory: null,
    });
  });

  it('rejects non-finite, wrong-unit and non-host values', () => {
    const value = snapshot();
    value.system!.cpu!.utilization.value = Number.NaN;
    value.system!.memory!.utilization.unit = 'bytes';
    expect(buildMotherboardAppearance(value, true)).toEqual({
      cpu: null,
      memory: null,
    });
    value.system!.cpu!.utilization.value = 25;
    value.system!.cpu!.utilization.scope = 'physical_gpu';
    value.system!.memory!.utilization.unit = 'percent';
    value.system!.memory!.utilization.value = Number.POSITIVE_INFINITY;
    expect(buildMotherboardAppearance(value, true)).toEqual({
      cpu: null,
      memory: null,
    });
  });

  it('bounds the specified glow formula while missing data has no activity glow', () => {
    expect(motherboardGlowIntensity(0)).toBe(0.15);
    expect(motherboardGlowIntensity(50)).toBe(0.475);
    expect(motherboardGlowIntensity(100)).toBe(0.8);
    expect(motherboardGlowIntensity(-10)).toBe(0.15);
    expect(motherboardGlowIntensity(150)).toBe(0.8);
    expect(motherboardGlowIntensity(null)).toBe(0);
    expect(motherboardGlowIntensity(Number.NaN)).toBe(0);
  });

  it('rejects impossible measured percentages instead of reporting believable endpoints', () => {
    const value = snapshot();
    value.system!.cpu!.utilization.value = -1;
    value.system!.memory!.utilization.value = 101;
    expect(buildMotherboardAppearance(value, true)).toEqual({
      cpu: null,
      memory: null,
    });
  });
});
