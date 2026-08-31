import { describe, expect, it } from 'vitest';
import { placeChartTooltip } from './chart-tooltip-portal';

const viewport = { left: 0, top: 0, width: 1000, height: 800 };

describe('chart tooltip viewport placement', () => {
  it('opens beside the hovered point when there is room', () => {
    expect(
      placeChartTooltip(
        { left: 100, top: 80 },
        { x: 200, y: 120 },
        { width: 180, height: 80 },
        viewport,
      ),
    ).toEqual({ left: 312, top: 160, sourceX: 200, sourceY: 120 });
  });

  it('flips before the point and clamps vertically at viewport edges', () => {
    expect(
      placeChartTooltip(
        { left: 700, top: 650 },
        { x: 240, y: 140 },
        { width: 220, height: 120 },
        viewport,
      ),
    ).toEqual({ left: 708, top: 672, sourceX: 240, sourceY: 140 });
  });

  it('keeps an oversized tooltip pinned to the safe viewport inset', () => {
    expect(
      placeChartTooltip(
        { left: -40, top: -30 },
        { x: 0, y: 0 },
        { width: 1200, height: 900 },
        viewport,
      ),
    ).toEqual({ left: 8, top: 8, sourceX: 0, sourceY: 0 });
  });
});
