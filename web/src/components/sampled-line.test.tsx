import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import type { ChartRow } from '../overview-history';
import { SampledLine } from './sampled-line';

function chart(rows: ChartRow[], tooltipIndex?: number) {
  return render(
    <LineChart width={600} height={200} data={rows}>
      <XAxis dataKey="time" type="number" domain={[0, 6000]} />
      <YAxis domain={[0, 100]} />
      <SampledLine
        dataKey="fast"
        className="fast"
        dot={false}
        isAnimationActive={false}
      />
      <SampledLine
        dataKey="slow"
        className="slow"
        dot={false}
        isAnimationActive={false}
      />
      {tooltipIndex != null ? (
        <Tooltip
          active
          defaultIndex={tooltipIndex}
          isAnimationActive={false}
          content={({ label, payload }) => (
            <output data-testid="sample-tooltip">
              {JSON.stringify({
                time: label,
                values: payload?.map(({ dataKey, value }) => ({
                  dataKey,
                  value,
                })),
              })}
            </output>
          )}
        />
      ) : null}
    </LineChart>,
  );
}

const rows: ChartRow[] = [
  { time: 1000, fast: 10, slow: 0 },
  { time: 2000, fast: 20 },
  { time: 3000, fast: 30, slow: 20 },
  { time: 4000, fast: 40 },
  { time: 5000, fast: 50, slow: 40 },
  { time: 6000, fast: 60 },
];

describe('independently sampled chart lines', () => {
  it('connects only measured points and does not extend a slower series to the newest timestamp', () => {
    const { container } = chart(rows);
    const paths = ['fast', 'slow'].map((key) =>
      container
        .querySelector(`.${key} .recharts-line-curve`)!
        .getAttribute('d')!,
    );
    expect(paths[0].match(/M/g)).toHaveLength(1);
    expect(paths[1].match(/M/g)).toHaveLength(1);
    expect(paths[0].match(/L/g)).toHaveLength(5);
    expect(paths[1].match(/L/g)).toHaveLength(2);
  });

  it('still splits a line at an explicit unavailable observation', () => {
    const { container } = chart(
      rows.map((row) => (row.time === 4000 ? { ...row, slow: null } : row)),
    );
    const fast = container
      .querySelector('.fast .recharts-line-curve')!
      .getAttribute('d')!;
    const slow = container
      .querySelector('.slow .recharts-line-curve')!
      .getAttribute('d')!;
    expect(fast.match(/M/g)).toHaveLength(1);
    expect(slow.match(/M/g)).toHaveLength(2);
  });

  it.each([
    [1, { time: 2000, values: [{ dataKey: 'fast', value: 20 }] }],
    [
      2,
      {
        time: 3000,
        values: [
          { dataKey: 'fast', value: 30 },
          { dataKey: 'slow', value: 20 },
        ],
      },
    ],
  ])(
    'keeps tooltip values at the shared timestamp index %i',
    (index, expected) => {
      chart(rows, index);
      expect(
        JSON.parse(screen.getByTestId('sample-tooltip').textContent!),
      ).toEqual(expected);
    },
  );
});
