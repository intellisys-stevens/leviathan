import type { ComponentProps } from 'react';
import { Gpu, type LucideIcon } from 'lucide-react';
import { gpuBrandPaths } from '../assets/gpu-brands/paths';
import {
  resolveGPUBrand,
  resolveGPUCollectionBrand,
  type GPUBrandSource,
} from '../gpu-brand';
import './gpu-brand-icon.css';

export function GPUBrandIcon({
  gpu,
  gpus,
  className = '',
  size = 24,
  absoluteStrokeWidth,
  ...props
}: Omit<ComponentProps<LucideIcon>, 'children'> & GPUBrandSource) {
  const brand = gpus ? resolveGPUCollectionBrand(gpus) : resolveGPUBrand(gpu);
  const accessibility = props['aria-label']
    ? { role: 'img' as const }
    : { 'aria-hidden': true as const };
  const iconClass = `gpu-brand-icon ${className}`.trim();
  if (brand === 'unknown') {
    return (
      <Gpu
        {...accessibility}
        {...props}
        size={size}
        absoluteStrokeWidth={absoluteStrokeWidth}
        className={iconClass}
        data-gpu-brand={brand}
        focusable="false"
      />
    );
  }
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      {...accessibility}
      {...props}
      className={iconClass}
      data-gpu-brand={brand}
      fill="currentColor"
      stroke="none"
      focusable="false"
    >
      <path d={gpuBrandPaths[brand]} />
    </svg>
  );
}
