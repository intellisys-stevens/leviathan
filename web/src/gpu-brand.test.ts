import { describe, expect, it } from 'vitest';
import { resolveGPUBrand, resolveGPUCollectionBrand } from './gpu-brand';

describe('GPU brand identity', () => {
  it.each([
    ['NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition', 'nvidia'],
    ['NVIDIA A100-SXM4-80GB', 'nvidia'],
    ['GeForce RTX 4090', 'nvidia'],
    ['Quadro P6000', 'nvidia'],
    ['Tesla V100-SXM2-16GB', 'nvidia'],
    ['AMD Instinct MI300X', 'amd'],
    ['Advanced Micro Devices, Inc. [AMD/ATI] Navi 31', 'amd'],
    ['Radeon PRO W7900', 'amd'],
    ['Intel(R) Arc(TM) A770 Graphics', 'intel'],
    ['Iris Xe Graphics', 'intel'],
    ['Arc Pro B60', 'intel'],
    ['Synthetic GPU', 'unknown'],
    ['GPU-0000-0000', 'unknown'],
    ['MIG-GPU-0/GI-0/CI-0', 'unknown'],
    ['0000:10de:00.0', 'unknown'],
    ['A100', 'unknown'],
    ['NVIDIA Radeon compatibility adapter', 'unknown'],
    ['ARC virtual adapter', 'unknown'],
    ['Teslatera T100', 'unknown'],
    ['', 'unknown'],
  ])('resolves %s conservatively as %s', (name, expected) => {
    expect(resolveGPUBrand({ name })).toBe(expected);
  });

  it('keeps mixed, partly unidentified, and empty summaries generic', () => {
    const nvidia = { name: 'NVIDIA RTX PRO 6000' };
    const amd = { name: 'AMD Instinct MI300X' };
    expect(resolveGPUCollectionBrand([nvidia, nvidia])).toBe('nvidia');
    expect(resolveGPUCollectionBrand([amd, amd])).toBe('amd');
    expect(resolveGPUCollectionBrand([nvidia, amd])).toBe('unknown');
    expect(resolveGPUCollectionBrand([amd, nvidia])).toBe('unknown');
    expect(resolveGPUCollectionBrand([nvidia, { name: 'Unknown GPU' }])).toBe(
      'unknown',
    );
    expect(resolveGPUCollectionBrand([])).toBe('unknown');
    expect(resolveGPUBrand()).toBe('unknown');
  });
});
