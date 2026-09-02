import { memo } from 'react';

export const snowCapVariants = [
  'left',
  'right',
  'split',
  'center',
  'corner',
] as const;

export type SnowCapVariant = (typeof snowCapVariants)[number];

type SnowProfile = {
  body: readonly string[];
  highlight: readonly string[];
};

const snowProfiles: Readonly<Record<SnowCapVariant, SnowProfile>> = {
  left: {
    body: [
      'M0 15 C8 15 12 10 21 9 C31 7 34 4 44 5 C55 2 66 4 75 7 C88 3 103 4 115 8 C131 6 149 7 162 10 C176 9 190 12 200 15 C189 16 179 15 166 18 C151 20 137 17 122 19 C105 21 89 18 72 20 C56 22 42 18 28 19 C15 18 7 16 0 15 Z',
    ],
    highlight: [
      'M10 11 C18 9 25 8 33 6 C44 3 56 5 65 7 C78 4 92 5 106 8 C124 7 143 8 158 10',
    ],
  },
  right: {
    body: [
      'M0 15 C10 14 18 11 30 11 C43 10 53 10 65 8 C78 9 88 5 101 7 C114 3 129 5 140 7 C153 3 169 5 180 9 C188 10 195 13 200 15 C191 17 181 16 169 19 C154 17 142 21 127 18 C111 20 97 17 83 19 C67 16 53 20 38 17 C24 18 11 16 0 15 Z',
    ],
    highlight: [
      'M12 12 C23 10 30 11 40 9 C54 10 66 7 78 8 C92 5 105 7 117 8 C131 4 143 5 154 7 C167 5 178 8 188 11',
    ],
  },
  split: {
    body: [
      'M0 15 C8 14 12 9 22 8 C33 7 38 4 48 5 C59 3 70 5 78 8 C86 9 91 12 96 15 C87 17 78 15 68 18 C56 20 45 17 34 19 C21 18 9 16 0 15 Z',
      'M104 15 C111 13 115 8 125 8 C136 7 141 4 151 5 C162 3 173 5 181 8 C189 9 195 12 200 15 C191 17 182 16 173 19 C161 20 151 17 140 19 C127 17 115 18 104 15 Z',
    ],
    highlight: [
      'M10 12 C18 9 25 9 33 7 C44 4 56 6 65 8 C75 7 83 10 88 12',
      'M115 12 C123 9 132 9 140 7 C151 4 162 6 170 8 C180 7 188 10 193 12',
    ],
  },
  center: {
    body: [
      'M0 15 C9 14 18 11 30 10 C42 10 51 6 63 7 C75 3 88 5 99 6 C112 3 127 5 138 8 C151 6 166 8 178 10 C188 11 195 13 200 15 C187 17 174 16 161 19 C146 21 132 17 118 19 C102 22 86 18 72 20 C57 18 44 20 31 17 C18 18 8 16 0 15 Z',
    ],
    highlight: [
      'M12 12 C23 10 31 10 40 8 C52 6 62 8 72 7 C84 3 98 5 108 7 C121 5 133 7 144 9 C158 8 171 10 188 12',
    ],
  },
  corner: {
    body: [
      'M0 15 C9 14 18 11 30 11 C43 10 54 10 66 8 C79 9 90 5 102 7 C114 3 128 4 139 7 C151 3 165 5 176 8 C187 9 195 12 200 15 C192 18 184 17 175 20 C163 18 152 21 141 18 C128 20 116 17 104 19 C91 17 79 20 66 17 C52 19 40 16 28 18 C16 17 7 16 0 15 Z',
    ],
    highlight: [
      'M12 12 C23 10 31 11 42 9 C55 10 66 7 77 8 C90 5 102 6 113 8 C126 4 139 6 149 7 C162 6 174 8 188 11',
    ],
  },
};

export function snowCapVariant(key: string): SnowCapVariant {
  let hash = 2_166_136_261;
  for (const character of key) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return snowCapVariants[(hash >>> 0) % snowCapVariants.length];
}

export const SnowCap = memo(function SnowCap({
  variant,
}: {
  variant: SnowCapVariant;
}) {
  const profile = snowProfiles[variant];
  return (
    <span
      className="snow-cap"
      data-slot="snow-cap"
      data-snow-profile={variant}
      aria-hidden="true"
    >
      <svg
        className="snow-cap-art"
        viewBox="0 0 200 24"
        preserveAspectRatio="none"
        focusable="false"
      >
        <g
          className="snow-cap-shadow"
          data-slot="snow-cap-shadow"
          transform="translate(0 2)"
        >
          {profile.body.map((path) => (
            <path key={path} d={path} />
          ))}
        </g>
        <g className="snow-cap-body" data-slot="snow-cap-body">
          {profile.body.map((path) => (
            <path key={path} d={path} />
          ))}
        </g>
        <g className="snow-cap-highlight" data-slot="snow-cap-highlight">
          {profile.highlight.map((path) => (
            <path key={path} d={path} />
          ))}
        </g>
      </svg>
    </span>
  );
});
