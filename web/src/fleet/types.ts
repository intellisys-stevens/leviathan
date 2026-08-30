import type { components } from '../fleet-api.gen';

export type FleetConnectionState =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'disconnected';

export type FleetSnapshot = components['schemas']['FleetSnapshot'];
export type PlatformObservation = components['schemas']['PlatformObservation'];
export type Platform = components['schemas']['Platform'];
export type PlatformKind = Platform['kind'];
export type InventoryHealth = components['schemas']['InventoryHealth'];
export type InventoryStatus = InventoryHealth['status'];
export type FleetInstance = components['schemas']['Instance'];
export type CloudState = FleetInstance['cloudState'];
export type AgentObservation = components['schemas']['AgentObservation'];
export type AgentStatus = AgentObservation['status'];
export type InstanceObservation = components['schemas']['InstanceObservation'];
export type PolicyReason = InstanceObservation['policyReason'];

export type TelemetryState = 'healthy' | 'degraded' | 'error' | 'unavailable';
