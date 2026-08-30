import type { components } from './api.gen';

export type Snapshot = components['schemas']['Snapshot'];
export type GPU = components['schemas']['GPU'];
export type GpuInstance = components['schemas']['GpuInstance'];
export type ComputeInstance = components['schemas']['ComputeInstance'];
export type Metric = components['schemas']['Metric'];
export type Memory = components['schemas']['Memory'];
export type Process = components['schemas']['Process'];
export type Diagnostic = components['schemas']['Diagnostic'];
export type Capabilities = components['schemas']['Capabilities'];
export type HistorySeries = components['schemas']['HistorySeries'];
export type RuntimeSettings = components['schemas']['RuntimeSettings'];
export type BuildInfo = components['schemas']['BuildInfo'];

export type Selection =
  | {
      kind: 'physical_gpu';
      gpu: GPU;
    }
  | {
      kind: 'compute_instance';
      gpu: GPU;
      gi: GpuInstance;
      ci: ComputeInstance;
    };

export type SelectionKey =
  | { kind: 'physical_gpu'; uuid: string }
  | { kind: 'compute_instance'; uuid: string };
