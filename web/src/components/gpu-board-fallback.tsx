import type { CSSProperties } from 'react';
import type { BoardRegion } from './gpu-board-model';
import { GPU_CHIP_COLORS, type GPUChipAppearance } from './gpu-chip-appearance';

/** Static exposed-board equivalent; native controls below remain the inspection surface. */
export function GPUBoardFallback({
  regions,
  highlightedId,
  appearances = [],
  theme = 'dark',
}: {
  regions: readonly BoardRegion[];
  highlightedId: string | null;
  appearances?: readonly GPUChipAppearance[];
  theme?: 'dark' | 'light';
}) {
  const byId = new Map(
    appearances.map((appearance) => [appearance.id, appearance]),
  );
  return (
    <svg
      className="gpu-board-fallback"
      viewBox="0 0 720 350"
      aria-hidden="true"
    >
      <g className="gpu-fallback-board">
        <path d="M76 66H643L662 85V270H455V293H213V273H76Z" />
        <path className="gpu-fallback-metal" d="M50 48H79V288H68V310H51Z" />
        {[93, 139, 185, 231].map((y) => (
          <rect
            key={y}
            className="gpu-fallback-port"
            x="55"
            y={y}
            width="15"
            height="29"
            rx="3"
          />
        ))}
        {Array.from({ length: 34 }, (_, i) => (
          <rect
            key={i}
            className="gpu-fallback-gold"
            x={218 + i * 6.7}
            y="272"
            width="4.5"
            height="19"
          />
        ))}
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <rect
              className="gpu-fallback-memory"
              x={245 + i * 55}
              y="82"
              width="40"
              height="31"
              rx="2"
            />
            <rect
              className="gpu-fallback-memory"
              x={245 + i * 55}
              y="229"
              width="40"
              height="31"
              rx="2"
            />
          </g>
        ))}
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <rect
              className="gpu-fallback-power"
              x="558"
              y={85 + i * 32}
              width="25"
              height="20"
              rx="2"
            />
            <rect
              className="gpu-fallback-memory"
              x="601"
              y={87 + i * 32}
              width="27"
              height="16"
              rx="2"
            />
            <path
              className="gpu-fallback-trace"
              d={`M583 ${95 + i * 32}H598`}
            />
          </g>
        ))}
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <path
            key={i}
            className="gpu-fallback-trace"
            d={`M${125 + i * 14} 110V${145 + i * 10}L${153 + i * 14} ${171 + i * 10}H262`}
          />
        ))}
        {[105, 638].flatMap((x) =>
          [82, 252].map((y) => (
            <circle
              key={`${x}-${y}`}
              className="gpu-fallback-metal"
              cx={x}
              cy={y}
              r="5"
            />
          )),
        )}
        <rect
          className="gpu-fallback-socket"
          x="264"
          y="116"
          width="204"
          height="109"
          rx="5"
        />
        {regions.length ? (
          regions.map((region) => {
            const appearance = byId.get(region.id);
            const state = appearance?.state ?? 'unknown';
            const activity = appearance?.activity;
            const measured =
              activity != null && Number.isFinite(activity)
                ? Math.max(0, Math.min(100, activity))
                : null;
            const intensity =
              state === 'assigned' || state === 'unassigned'
                ? (measured ?? 0) / 100
                : 0;
            return (
              <g
                key={region.id}
                className="gpu-fallback-chip"
                data-highlighted={region.id === highlightedId || undefined}
                data-allocation-state={state}
                data-region-id={region.id}
                data-activity={measured ?? 'unavailable'}
                style={
                  {
                    '--gpu-chip-tone': GPU_CHIP_COLORS[theme][state],
                    '--gpu-chip-fill': `${12 + intensity * 32}%`,
                  } as CSSProperties
                }
              >
                <rect
                  x={274 + region.x * 184 + 1}
                  y={125 + region.y * 91 + 1}
                  width={region.width * 184 - 2}
                  height={region.height * 91 - 2}
                  rx="2"
                />
                <text
                  x={274 + (region.x + region.width / 2) * 184}
                  y={125 + (region.y + region.height / 2) * 91}
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {region.label}
                </text>
              </g>
            );
          })
        ) : (
          <rect
            className="gpu-fallback-inactive"
            x="275"
            y="126"
            width="182"
            height="89"
            rx="2"
          />
        )}
      </g>
    </svg>
  );
}
