import { memo, useMemo } from 'react';
import './snow-cap.css';

export type SnowDrift = Readonly<{
  start: number;
  width: number;
  height: number;
  crest: number;
}>;

function createPageSeed(): number {
  if (import.meta.env.DEV) {
    const override = (
      globalThis as typeof globalThis & {
        __LEVIATHAN_TEST_SNOW_SEED__?: unknown;
      }
    ).__LEVIATHAN_TEST_SNOW_SEED__;
    if (
      typeof override === 'number' &&
      Number.isInteger(override) &&
      override >= 0 &&
      override <= 0xffff_ffff
    ) {
      return override;
    }
  }
  return globalThis.crypto?.getRandomValues
    ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0]
    : Math.floor(Math.random() * 0x1_0000_0000);
}

// Module lifetime is the document lifetime. React remounts and polling never
// consume more randomness or change an existing surface's arrangement.
const pageSeed = createPageSeed();

function surfaceRandom(surfaceKey: string, seed: number): () => number {
  let state = (2_166_136_261 ^ seed) >>> 0;
  for (const character of surfaceKey) {
    state ^= character.codePointAt(0) ?? 0;
    state = Math.imul(state, 16_777_619) >>> 0;
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

/** Normalized edge geometry, independent of viewport and render order. */
export function generateSnowProfile(
  surfaceKey: string,
  seed: number,
): readonly SnowDrift[] {
  const random = surfaceRandom(surfaceKey, seed);
  const count = random() < 0.5 ? 1 : 2;
  const widths = Array.from({ length: count }, () =>
    count === 1 ? 250 + random() * 300 : 150 + random() * 130,
  );
  const gap = count === 2 ? 80 + random() * 160 : 0;
  const span = widths.reduce((sum, width) => sum + width, 0) + gap;
  // The widest two piles plus their largest gap fit inside these end margins.
  // Position, gap, widths and heights each use their own random draw.
  let start = 40 + random() * (920 - span);
  return widths.map((width) => {
    const drift = {
      start,
      width,
      height: 3 + random() * 11,
      crest: 0.44 + random() * 0.12,
    };
    start += width + gap;
    return drift;
  });
}

function driftPaths({ start, width, height, crest }: SnowDrift) {
  const x = (ratio: number) => +(start + width * ratio).toFixed(2);
  const y = (ratio: number) => +(15 - height * ratio).toFixed(2);
  return {
    body: `M${x(0)} 15 C${x(0.07)} 15 ${x(0.12)} ${y(0.4)} ${x(0.23)} ${y(0.38)} C${x(crest - 0.14)} ${y(0.32)} ${x(crest - 0.13)} ${y(0.96)} ${x(crest)} ${y(0.83)} C${x(crest + 0.11)} ${y(1)} ${x(0.72)} ${y(0.48)} ${x(0.8)} ${y(0.5)} C${x(0.89)} ${y(0.6)} ${x(0.95)} 15 ${x(1)} 15 C${x(0.76)} 17 ${x(0.65)} 15 ${x(0.48)} 16 C${x(0.29)} 17 ${x(0.14)} 15 ${x(0)} 15 Z`,
    highlight: `M${x(0.15)} ${y(0.28)} C${x(0.29)} ${y(0.3)} ${x(crest - 0.13)} ${y(0.83)} ${x(crest)} ${y(0.7)} C${x(crest + 0.11)} ${y(0.95)} ${x(0.68)} ${y(0.43)} ${x(0.78)} ${y(0.39)}`,
  };
}

export const SnowCap = memo(function SnowCap({
  surfaceKey,
}: {
  surfaceKey: string;
}) {
  const profile = useMemo(
    () => generateSnowProfile(surfaceKey, pageSeed).map(driftPaths),
    [surfaceKey],
  );
  return (
    <span
      className="snow-cap"
      data-slot="snow-cap"
      data-snow-profile="generated"
      data-snow-surface={surfaceKey}
      data-snow-piles={profile.length}
      aria-hidden="true"
    >
      <svg
        className="snow-cap-art"
        viewBox="0 0 1000 24"
        preserveAspectRatio="none"
        focusable="false"
      >
        <g
          className="snow-cap-shadow"
          data-slot="snow-cap-shadow"
          transform="translate(0 1)"
        >
          {profile.map(({ body }) => (
            <path key={body} d={body} />
          ))}
        </g>
        <g className="snow-cap-body" data-slot="snow-cap-body">
          {profile.map(({ body }) => (
            <path key={body} d={body} />
          ))}
        </g>
        <g className="snow-cap-highlight" data-slot="snow-cap-highlight">
          {profile.map(({ highlight }) => (
            <path key={highlight} d={highlight} />
          ))}
        </g>
      </svg>
    </span>
  );
});
