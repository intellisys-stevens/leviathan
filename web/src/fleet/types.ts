import type { BuildInfo, Snapshot as AgentSnapshot } from '../types';

export type FleetConnectionState =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'disconnected';

export type PlatformKind = 'host' | 'openstack';
export type InventoryStatus = 'available' | 'stale' | 'unavailable';
export type AgentStatus =
  | 'not_managed'
  | 'available'
  | 'unreachable'
  | 'stale'
  | 'incompatible';
export type PolicyReason =
  | 'allowed'
  | 'not_allowlisted'
  | 'creator_mismatch'
  | 'cloud_not_active';
export type CloudState =
  | 'active'
  | 'shelved'
  | 'shelved_offloaded'
  | 'shutoff'
  | 'building'
  | 'paused'
  | 'suspended'
  | 'error'
  | 'unknown';

export type Platform = {
  id: string;
  displayName: string;
  kind: PlatformKind;
  dashboardUrl?: string;
};

export type InventoryHealth = {
  status: InventoryStatus;
  observedAt?: string;
  lastAttemptAt: string;
  lastSuccessAt?: string;
  message?: string;
};

export type FleetInstance = {
  uuid: string;
  name: string;
  creatorUsername: string;
  cloudState: CloudState;
  rawCloudState?: string;
  flavor?: string;
};

export type AgentObservation = {
  status: AgentStatus;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  observedAt?: string;
  buildInfo?: BuildInfo;
  snapshot?: AgentSnapshot;
  message?: string;
};

export type InstanceObservation = {
  instance: FleetInstance;
  managed: boolean;
  agentProbeEligible: boolean;
  policyReason: PolicyReason;
  agent: AgentObservation;
};

export type PlatformObservation = {
  platform: Platform;
  inventory: InventoryHealth;
  instances: InstanceObservation[];
};

export type FleetSnapshot = {
  schemaVersion: 'fleet-v1';
  sequence: number;
  observedAt: string;
  platforms: PlatformObservation[];
};

export type TelemetryState = 'healthy' | 'degraded' | 'error' | 'unavailable';
