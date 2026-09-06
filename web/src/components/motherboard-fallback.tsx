import {
  MOTHERBOARD_COLORS,
  motherboardGlowIntensity,
  type MotherboardAppearance,
  type MotherboardCategoryId,
} from './motherboard-appearance';

/** Decorative equivalent of the 3D board; sibling native controls own interaction. */
export function MotherboardFallback({
  appearance,
  selectedId = null,
  highlightedId = null,
  theme = 'dark',
}: {
  appearance: MotherboardAppearance;
  selectedId?: MotherboardCategoryId | null;
  highlightedId?: MotherboardCategoryId | null;
  theme?: 'dark' | 'light';
}) {
  const colors = MOTHERBOARD_COLORS[theme];
  const outline = (id: MotherboardCategoryId) => ({
    stroke: colors.outline,
    strokeWidth: selectedId === id ? 3 : 2,
    strokeOpacity: selectedId === id ? 1 : highlightedId === id ? 0.7 : 0,
  });
  return (
    <svg
      className="motherboard-fallback"
      viewBox="0 0 600 640"
      aria-hidden="true"
      focusable="false"
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    >
      <path d="M80 66H493L517 90V549L493 573H104L80 549Z" fill="#253c43" />
      <path
        d="M80 60H493L517 84V543L493 567H104L80 543Z"
        fill={colors.pcb}
        stroke="#517b82"
        strokeWidth="2"
      />
      <g fill="none" stroke="#537f84" strokeWidth="1" opacity=".6">
        {Array.from({ length: 11 }, (_, i) => (
          <g key={i}>
            <path
              d={`M${205 + i * 4} 304V${323 + i * 4}L${153 + i * 4} ${375 + i * 4}V455H260`}
            />
            <path d={`M330 ${205 + i * 4}H${340 + i * 2}L363 ${228 + i * 4}`} />
            <path
              d={`M150 ${485 + i * 3}H${205 + i * 4}L${231 + i * 4} 535H365`}
            />
          </g>
        ))}
      </g>
      <g fill="#a8b6bc" stroke="#34494f" strokeWidth="2">
        {[116, 176, 236, 296].map((y) => (
          <g key={y}>
            <rect x="68" y={y} width="50" height="45" rx="3" />
            <rect x="69" y={y + 11} width="12" height="23" fill="#152027" />
          </g>
        ))}
      </g>
      <g fill="#3f5059" stroke="#74858a" strokeWidth="1">
        {[156, 190, 224, 258, 292, 326].map((x) => (
          <g key={x}>
            <rect x={x} y="109" width="23" height="24" rx="2" />
            <rect x={x + 2} y="90" width="19" height="12" fill="#172126" />
            <circle cx={x + 11} cy="149" r="7" fill="#a8b6bc" />
            <path d={`M${x + 7} 149h8`} />
          </g>
        ))}
      </g>
      <g
        data-region-id="cpu"
        data-utilization={appearance.cpu ?? 'unavailable'}
      >
        <rect
          x="184"
          y="171"
          width="151"
          height="153"
          rx="4"
          fill="#141d22"
          stroke="#566971"
          strokeWidth="4"
        />
        <rect
          x="195"
          y="182"
          width="129"
          height="131"
          rx="3"
          fill="#607c80"
          stroke="#afbac0"
          strokeWidth="5"
        />
        <rect x="207" y="194" width="105" height="107" rx="4" fill="#788a92" />
        <rect
          x="207"
          y="194"
          width="105"
          height="107"
          rx="4"
          fill={colors.accent}
          opacity={motherboardGlowIntensity(appearance.cpu) * 0.68}
        />
        <path
          d="M344 186V306l-12 7"
          fill="none"
          stroke="#b3bec2"
          strokeWidth="4"
        />
        <text
          x="259"
          y="254"
          textAnchor="middle"
          fill="#edf7fa"
          fontSize="21"
          fontWeight="600"
        >
          CPU
        </text>
        <rect
          x="176"
          y="163"
          width="173"
          height="169"
          rx="5"
          fill="none"
          {...outline('cpu')}
        />
      </g>
      <g
        data-region-id="memory"
        data-utilization={appearance.memory ?? 'unavailable'}
      >
        {[372, 398, 424, 450].map((x) => (
          <g key={x}>
            <rect
              x={x - 3}
              y="129"
              width="21"
              height="212"
              rx="2"
              fill="#111c22"
            />
            <rect x={x + 1} y="137" width="13" height="196" fill="#305559" />
            {[149, 194, 239, 284].map((y) => (
              <g key={y}>
                <rect
                  x={x - 1}
                  y={y}
                  width="17"
                  height="33"
                  rx="1"
                  fill="#34494e"
                />
                <rect
                  x={x - 1}
                  y={y}
                  width="17"
                  height="33"
                  rx="1"
                  fill={colors.accent}
                  opacity={motherboardGlowIntensity(appearance.memory) * 0.75}
                />
              </g>
            ))}
            <path
              d={`M${x - 4} 132h23m-23 205h23`}
              stroke="#adbdc1"
              strokeWidth="7"
            />
          </g>
        ))}
        <text
          x="417"
          y="367"
          textAnchor="middle"
          fill="#d7e9ee"
          fontSize="18"
          fontWeight="600"
        >
          RAM
        </text>
        <rect
          x="360"
          y="120"
          width="117"
          height="228"
          rx="4"
          fill="none"
          {...outline('memory')}
        />
      </g>
      <g fill="#101c22" stroke="#536c70" strokeWidth="1">
        {[361, 484].map((y) => (
          <g key={y}>
            <rect x="132" y={y} width="216" height="15" rx="2" />
            <path d={`M138 ${y + 7}h189`} stroke="#84a39e" strokeWidth="2" />
            <rect x="337" y={y - 3} width="10" height="21" fill="#b2bfc1" />
          </g>
        ))}
      </g>
      <g data-region-id="storage">
        <rect
          x="256"
          y="411"
          width="170"
          height="52"
          rx="2"
          fill="#24494b"
          stroke="#627d78"
        />
        <rect x="246" y="410" width="12" height="54" fill="#17232a" />
        {[265, 305, 350].map((x) => (
          <rect
            key={x}
            x={x}
            y="422"
            width="32"
            height="30"
            fill="#303a40"
            stroke="#59666a"
          />
        ))}
        <circle cx="414" cy="437" r="5" fill="#b7c1c2" />
        <path d="M411 437h6" stroke="#354b52" strokeWidth="2" />
        <text
          x="337"
          y="401"
          textAnchor="middle"
          fill="#d7e9ee"
          fontSize="17"
          fontWeight="600"
        >
          STORAGE
        </text>
        <rect
          x="241"
          y="405"
          width="191"
          height="65"
          rx="4"
          fill="none"
          {...outline('storage')}
        />
      </g>
      <g fill="#1c2a30" stroke="#64777d">
        <rect x="475" y="197" width="25" height="108" rx="2" />
        {Array.from({ length: 12 }, (_, i) => (
          <path
            key={i}
            d={`M480 ${203 + i * 8}h15`}
            stroke="#b69a5d"
            strokeWidth="2"
          />
        ))}
        <rect x="390" y="83" width="65" height="24" rx="2" />
        <rect x="427" y="485" width="58" height="57" rx="3" fill="#455761" />
        {Array.from({ length: 7 }, (_, i) => (
          <path
            key={i}
            d={`M${435 + i * 7} 490v47`}
            stroke="#a5b4bc"
            strokeWidth="3"
          />
        ))}
      </g>
      {[111, 299, 490].flatMap((x) =>
        [80, 548].map((y) => (
          <g key={`${x}-${y}`}>
            <circle cx={x} cy={y} r="7" fill="#a9b9bf" />
            <circle cx={x} cy={y} r="3" fill="#17292e" />
          </g>
        )),
      )}
      <text x="176" y="83" fill="#b2cbd0" fontSize="12" letterSpacing="2">
        LEVIATHAN
      </text>
    </svg>
  );
}
