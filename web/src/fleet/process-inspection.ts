import type { InstanceObservation } from './types';

export type ProcessInspectionState = 'complete' | 'incomplete' | 'unavailable';

const incompleteInspectionCodes = new Set([
  'gpu_process_fds',
  'gpu_process_fields',
]);
const unavailableInspectionCodes = new Set([
  'gpu_process_detection',
  'gpu_processes',
]);

export function processInspectionState(
  observation: InstanceObservation,
): ProcessInspectionState {
  const snapshot = observation.agent.snapshot;
  if (!snapshot) return 'unavailable';
  const capability = snapshot.capabilities.proc;
  if (!capability.available || capability.status !== 'available') {
    return 'unavailable';
  }
  if (
    snapshot.diagnostics.some(
      ({ code, severity }) =>
        unavailableInspectionCodes.has(code) && severity !== 'info',
    )
  ) {
    return 'unavailable';
  }
  if (
    snapshot.diagnostics.some(
      ({ code, severity }) =>
        incompleteInspectionCodes.has(code) && severity !== 'info',
    )
  ) {
    return 'incomplete';
  }
  return 'complete';
}

export function processInspectionSummary(
  observation: InstanceObservation,
): string | null {
  const snapshot = observation.agent.snapshot;
  if (!snapshot) return null;
  const diagnostic = snapshot.diagnostics.find(
    ({ code, severity }) =>
      (unavailableInspectionCodes.has(code) ||
        incompleteInspectionCodes.has(code)) &&
      severity !== 'info',
  );
  if (diagnostic) return diagnostic.summary;
  const capability = snapshot.capabilities.proc;
  if (!capability.available || capability.status !== 'available') {
    return (
      capability.message || 'GPU-connected process inspection is unavailable.'
    );
  }
  return null;
}

export function gpuConnectedUsers(observation: InstanceObservation): string[] {
  const users = observation.agent.snapshot?.processes
    .map(({ user }) => user?.trim() ?? '')
    .filter(Boolean);
  return [...new Set(users ?? [])].sort((left, right) =>
    left.localeCompare(right),
  );
}

function lastKnownSuffix(observation: InstanceObservation): string {
  return observation.agent.snapshot && observation.agent.status !== 'available'
    ? ' · last known'
    : '';
}

export function processCountLabel(observation: InstanceObservation): string {
  const snapshot = observation.agent.snapshot;
  if (!snapshot) return 'Telemetry unavailable';
  const state = processInspectionState(observation);
  const count = snapshot.processes.length;
  const suffix = lastKnownSuffix(observation);
  if (state === 'unavailable') return `Processes unavailable${suffix}`;
  if (state === 'incomplete') {
    return count > 0
      ? `≥${count} process${count === 1 ? '' : 'es'}${suffix}`
      : `Processes unknown${suffix}`;
  }
  return `${count} process${count === 1 ? '' : 'es'}${suffix}`;
}

export function gpuConnectedUsersLabel(
  observation: InstanceObservation,
): string {
  const snapshot = observation.agent.snapshot;
  if (!snapshot) return 'Unavailable';
  const users = gpuConnectedUsers(observation);
  const suffix = lastKnownSuffix(observation);
  switch (processInspectionState(observation)) {
    case 'unavailable':
      return `Unavailable${suffix}`;
    case 'incomplete':
      return users.length > 0
        ? `${users.join(', ')} · others may be hidden${suffix}`
        : `Unknown · inspection incomplete${suffix}`;
    default:
      return users.length > 0
        ? `${users.join(', ')}${suffix}`
        : observation.agent.status === 'available'
          ? 'None observed'
          : 'None in last snapshot';
  }
}

export function hasCurrentCompleteProcessCoverage(
  observation: InstanceObservation,
): boolean {
  return (
    observation.agent.status === 'available' &&
    processInspectionState(observation) === 'complete'
  );
}
