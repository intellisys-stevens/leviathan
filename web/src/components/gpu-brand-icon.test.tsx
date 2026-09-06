import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import nvidiaSVG from '../assets/gpu-brands/nvidia.svg?raw';
import amdSVG from '../assets/gpu-brands/amd.svg?raw';
import intelSVG from '../assets/gpu-brands/intel.svg?raw';
import { gpuBrandPaths } from '../assets/gpu-brands/paths';
import { GPUBrandIcon } from './gpu-brand-icon';

const originalSVGs = { nvidia: nvidiaSVG, amd: amdSVG, intel: intelSVG };

describe('GPU brand marks', () => {
  it.each(['nvidia', 'amd', 'intel'] as const)(
    'bundles the vetted %s SVG path unchanged',
    (brand) => {
      const original = new DOMParser().parseFromString(
        originalSVGs[brand],
        'image/svg+xml',
      );
      expect(gpuBrandPaths[brand]).toBe(
        original.querySelector('path')?.getAttribute('d'),
      );
      const view = render(
        <GPUBrandIcon gpu={{ name: brand }} className="size-4" />,
      );
      const icon = view.container.querySelector('svg');
      expect(icon).toHaveAttribute('data-gpu-brand', brand);
      expect(icon).toHaveAttribute('aria-hidden', 'true');
      expect(icon).toHaveAttribute('focusable', 'false');
      expect(icon).toHaveAttribute('fill', 'currentColor');
      expect(icon).toHaveClass('gpu-brand-icon', 'size-4');
      expect(icon?.querySelector('path')).toHaveAttribute(
        'd',
        gpuBrandPaths[brand],
      );
      expect(
        view.container.querySelector('image, use, foreignObject, script'),
      ).toBeNull();
    },
  );

  it('uses one generic GPU symbol for mixed inventories and permits explicit accessible labels', () => {
    render(
      <GPUBrandIcon
        gpus={[{ name: 'NVIDIA RTX 6000' }, { name: 'AMD Radeon' }]}
        aria-label="GPU resources"
      />,
    );
    const icon = screen.getByRole('img', { name: 'GPU resources' });
    expect(icon).toHaveClass('lucide-gpu');
    expect(icon).toHaveAttribute('data-gpu-brand', 'unknown');
    expect(icon).not.toHaveAttribute('aria-hidden');
  });
});
