import type { GPUAllocationState } from '../gpu-allocation';

/** Presentation only; activity is fresh measured SM activity, or unavailable. */
export type GPUChipAppearance = {
  id: string;
  state: GPUAllocationState;
  activity: number | null;
};

export const GPU_CHIP_COLORS = {
  dark: {
    assigned: '#76B900',
    unassigned: '#9AA5AD',
    reserved: '#D9AA50',
    unknown: '#9AA5AD',
  },
  light: {
    assigned: '#426800',
    unassigned: '#58646E',
    reserved: '#805600',
    unknown: '#58646E',
  },
} as const satisfies Record<
  'dark' | 'light',
  Record<GPUAllocationState, string>
>;
