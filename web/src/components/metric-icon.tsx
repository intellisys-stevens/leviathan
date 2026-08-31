import type { ComponentProps } from 'react';
import {
  Activity,
  ArrowLeftRight,
  Boxes,
  Clock,
  Cpu,
  Gauge,
  HardDrive,
  Thermometer,
  Zap,
  type LucideIcon,
} from 'lucide-react';

export type MetricVisualKey =
  | 'clocks'
  | 'dram_activity'
  | 'gpu_activity'
  | 'memory'
  | 'memory_activity'
  | 'memory_clock'
  | 'memory_used_bytes'
  | 'pcie_rx_bytes_per_second'
  | 'pcie_total_bytes_per_second'
  | 'pcie_tx_bytes_per_second'
  | 'power'
  | 'power_limit'
  | 'sm_activity'
  | 'sm_clock'
  | 'sm_occupancy'
  | 'temperature'
  | 'tensor_activity';

export const metricIcons: Record<MetricVisualKey, LucideIcon> = {
  clocks: Clock,
  dram_activity: Activity,
  gpu_activity: Gauge,
  memory: HardDrive,
  memory_activity: Activity,
  memory_clock: Clock,
  memory_used_bytes: HardDrive,
  pcie_rx_bytes_per_second: ArrowLeftRight,
  pcie_total_bytes_per_second: ArrowLeftRight,
  pcie_tx_bytes_per_second: ArrowLeftRight,
  power: Zap,
  power_limit: Zap,
  sm_activity: Cpu,
  sm_clock: Clock,
  sm_occupancy: Cpu,
  temperature: Thermometer,
  tensor_activity: Boxes,
};

export function MetricIcon({
  metric,
  ...props
}: Omit<ComponentProps<LucideIcon>, 'aria-label'> & {
  metric: MetricVisualKey;
}) {
  const Icon = metricIcons[metric];
  return <Icon aria-hidden="true" data-metric-icon={metric} {...props} />;
}
