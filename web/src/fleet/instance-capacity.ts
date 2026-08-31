import type { FleetInstance } from './types';

export const hostUsageUnavailableLabel = 'CPU and system RAM usage unavailable';

function validInteger(value: number, minimum: number): boolean {
  return (
    Number.isSafeInteger(value) && value >= minimum && value <= 2_147_483_647
  );
}

function formatRAM(ramMiB: number): string {
  if (ramMiB % 1024 === 0) return `${ramMiB / 1024} GiB RAM`;
  return `${ramMiB} MiB RAM`;
}

export function staticCapacityLabel(instance: FleetInstance): string | null {
  const capacity = instance.capacity;
  if (
    !capacity ||
    !validInteger(capacity.vcpus, 1) ||
    !validInteger(capacity.ramMiB, 1) ||
    !validInteger(capacity.rootDiskGiB, 0)
  ) {
    return null;
  }
  return `${capacity.vcpus} vCPU · ${formatRAM(capacity.ramMiB)} · ${capacity.rootDiskGiB} GiB root disk`;
}
