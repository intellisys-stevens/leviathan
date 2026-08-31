import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MetricIcon, metricIcons, type MetricVisualKey } from './metric-icon';

describe('MetricIcon', () => {
  it('defines one canonical decorative icon for every displayed metric family', () => {
    const expectedIconClass: Record<MetricVisualKey, string> = {
      clocks: 'lucide-clock',
      dram_activity: 'lucide-activity',
      gpu_activity: 'lucide-gauge',
      memory: 'lucide-hard-drive',
      memory_activity: 'lucide-activity',
      memory_clock: 'lucide-clock',
      memory_used_bytes: 'lucide-hard-drive',
      pcie_rx_bytes_per_second: 'lucide-arrow-left-right',
      pcie_total_bytes_per_second: 'lucide-arrow-left-right',
      pcie_tx_bytes_per_second: 'lucide-arrow-left-right',
      power: 'lucide-zap',
      power_limit: 'lucide-zap',
      sm_activity: 'lucide-cpu',
      sm_clock: 'lucide-clock',
      sm_occupancy: 'lucide-cpu',
      temperature: 'lucide-thermometer',
      tensor_activity: 'lucide-boxes',
    };
    const metrics = Object.keys(metricIcons) as MetricVisualKey[];
    const view = render(
      <div>
        {metrics.map((metric) => (
          <MetricIcon key={metric} metric={metric} />
        ))}
      </div>,
    );

    expect(metrics).toHaveLength(17);
    for (const metric of metrics) {
      const icon = view.container.querySelector(
        `[data-metric-icon="${metric}"]`,
      );
      expect(icon).toBeInTheDocument();
      expect(icon).toHaveAttribute('aria-hidden', 'true');
      expect(icon).not.toHaveAttribute('aria-label');
      expect(icon).toHaveClass(expectedIconClass[metric]);
    }
  });
});
