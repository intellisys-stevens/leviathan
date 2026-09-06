export type GPUBrand = 'nvidia' | 'amd' | 'intel' | 'unknown';
export type GPUIdentity = Readonly<{ name: string }>;
export type GPUBrandSource = {
  gpu?: GPUIdentity;
  gpus?: readonly GPUIdentity[];
};

const brandNames: ReadonlyArray<
  readonly [Exclude<GPUBrand, 'unknown'>, RegExp]
> = [
  ['nvidia', /\b(?:nvidia|geforce|quadro)\b|\btesla\s+[a-z]\d{2,3}\b/iu],
  ['amd', /\b(?:amd|advanced micro devices|radeon|instinct)\b/iu],
  [
    'intel',
    /\bintel\b|\biris\s+(?:xe|plus|pro)\b|\barc\s+(?:pro\s+)?[ab]\d{2,3}\b/iu,
  ],
];

/** Only names identifying a vendor or an established GPU product family count.
 * A PCI bus address, device UUID, driver availability, or MIG mode is not a vendor.
 */
export function resolveGPUBrand(gpu?: GPUIdentity): GPUBrand {
  if (!gpu) return 'unknown';
  const brands = brandNames.filter(([, pattern]) => pattern.test(gpu.name));
  return brands.length === 1 ? brands[0][0] : 'unknown';
}

/** Unknown members keep an aggregate unknown; do not guess from the first GPU. */
export function resolveGPUCollectionBrand(
  gpus: readonly GPUIdentity[],
): GPUBrand {
  if (gpus.length === 0) return 'unknown';
  const brands = new Set(gpus.map(resolveGPUBrand));
  return brands.size === 1 ? resolveGPUBrand(gpus[0]) : 'unknown';
}
