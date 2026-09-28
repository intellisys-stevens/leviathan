import { act, fireEvent, render, screen } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChartTooltipPortal,
  placeChartTooltip,
  sameChartTooltipPayload,
} from './chart-tooltip-portal';

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

describe('chart tooltip movement', () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let anchor: HTMLDivElement;
  let anchorBounds: { left: number; top: number };
  let tooltipSize: { width: number; height: number };
  let observerCallback: ResizeObserverCallback;
  let disconnect: ReturnType<typeof vi.fn<() => void>>;
  let readAnchor: ReturnType<typeof vi.fn<() => void>>;
  let readTooltip: ReturnType<typeof vi.fn<() => void>>;
  let visualViewport: EventTarget & {
    offsetLeft: number;
    offsetTop: number;
    width: number;
    height: number;
  };

  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    anchor = document.createElement('div');
    document.body.append(anchor);
    anchorBounds = { left: 100, top: 80 };
    tooltipSize = { width: 180, height: 80 };
    readAnchor = vi.fn();
    readTooltip = vi.fn();
    disconnect = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          observerCallback = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    visualViewport = Object.assign(new EventTarget(), {
      offsetLeft: 0,
      offsetTop: 0,
      width: 1000,
      height: 800,
    });
    vi.stubGlobal('visualViewport', visualViewport);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        if (this === anchor) {
          readAnchor();
          return anchorBounds as DOMRect;
        }
        readTooltip();
        return tooltipSize as DOMRect;
      },
    );
  });

  afterEach(() => {
    anchor.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function flushFrame() {
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(16));
    });
  }

  it('positions the first appearance before paint without a second React commit', () => {
    const onRender = vi.fn();
    render(
      <Profiler id="tooltip" onRender={onRender}>
        <ChartTooltipPortal
          active
          anchorRef={{ current: anchor }}
          coordinate={{ x: 200, y: 120 }}
        >
          42%
        </ChartTooltipPortal>
      </Profiler>,
    );
    expect(screen.getByRole('tooltip')).toHaveStyle({
      transform: 'translate3d(312px, 160px, 0)',
      visibility: 'visible',
    });
    expect(onRender).toHaveBeenCalledTimes(1);
    expect(readAnchor).toHaveBeenCalledTimes(1);
    expect(readTooltip).toHaveBeenCalledTimes(1);
  });

  it('moves immediately and coalesces geometry reads to the newest coordinate', () => {
    const anchorRef = { current: anchor };
    const view = render(
      <ChartTooltipPortal
        active
        anchorRef={anchorRef}
        coordinate={{ x: 200, y: 120 }}
      >
        42%
      </ChartTooltipPortal>,
    );
    view.rerender(
      <ChartTooltipPortal
        active
        anchorRef={anchorRef}
        coordinate={{ x: 250, y: 130 }}
      >
        42%
      </ChartTooltipPortal>,
    );
    view.rerender(
      <ChartTooltipPortal
        active
        anchorRef={anchorRef}
        coordinate={{ x: 300, y: 150 }}
      >
        42%
      </ChartTooltipPortal>,
    );
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveStyle({
      transform: 'translate3d(412px, 190px, 0)',
      visibility: 'visible',
    });
    expect(frames.size).toBe(1);
    flushFrame();
    expect(tooltip).toHaveStyle({
      transform: 'translate3d(412px, 190px, 0)',
      visibility: 'visible',
    });
    expect(readAnchor).toHaveBeenCalledTimes(2);
    expect(readTooltip).toHaveBeenCalledTimes(1);
  });

  it('repositions after content grows without measuring a cached tooltip again', () => {
    const anchorRef = { current: anchor };
    const view = render(
      <ChartTooltipPortal
        active
        anchorRef={anchorRef}
        coordinate={{ x: 700, y: 600 }}
      >
        42%
      </ChartTooltipPortal>,
    );
    const tooltip = screen.getByRole('tooltip');
    view.rerender(
      <ChartTooltipPortal
        active
        anchorRef={anchorRef}
        coordinate={{ x: 700, y: 600 }}
      >
        GPU 0: 42%; GPU 1: 73.5%
      </ChartTooltipPortal>,
    );
    act(() =>
      observerCallback(
        [
          {
            target: tooltip,
            borderBoxSize: [{ inlineSize: 300, blockSize: 240 }],
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      ),
    );
    flushFrame();
    expect(tooltip).toHaveTextContent('73.5%');
    expect(tooltip).toHaveStyle({ transform: 'translate3d(488px, 552px, 0)' });
    expect(readTooltip).toHaveBeenCalledTimes(1);
  });

  it('batches nested scroll, viewport resize and visual viewport changes using fresh anchor coordinates', () => {
    render(
      <ChartTooltipPortal
        active
        anchorRef={{ current: anchor }}
        coordinate={{ x: 200, y: 120 }}
      >
        42%
      </ChartTooltipPortal>,
    );
    anchorBounds = { left: 400, top: 280 };
    visualViewport.offsetLeft = 20;
    visualViewport.offsetTop = 50;
    visualViewport.width = 500;
    visualViewport.height = 350;
    fireEvent.scroll(anchor);
    fireEvent.resize(window);
    visualViewport.dispatchEvent(new Event('scroll'));
    visualViewport.dispatchEvent(new Event('resize'));
    expect(frames.size).toBe(1);
    flushFrame();
    expect(screen.getByRole('tooltip')).toHaveStyle({
      transform: 'translate3d(332px, 312px, 0)',
    });
    expect(readAnchor).toHaveBeenCalledTimes(2);
    expect(readTooltip).toHaveBeenCalledTimes(2);
  });

  it('cancels pending work when hidden or unmounted and measures fresh geometry on re-entry', () => {
    const anchorRef = { current: anchor };
    const view = render(
      <ChartTooltipPortal
        active
        anchorRef={anchorRef}
        coordinate={{ x: 200, y: 120 }}
      >
        42%
      </ChartTooltipPortal>,
    );
    view.rerender(
      <ChartTooltipPortal
        active
        anchorRef={anchorRef}
        coordinate={{ x: 250, y: 120 }}
      >
        42%
      </ChartTooltipPortal>,
    );
    expect(frames.size).toBe(1);
    view.rerender(
      <ChartTooltipPortal
        active={false}
        anchorRef={anchorRef}
        coordinate={{ x: 250, y: 120 }}
      >
        42%
      </ChartTooltipPortal>,
    );
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(frames.size).toBe(0);
    expect(disconnect).toHaveBeenCalledTimes(1);
    anchorBounds = { left: 300, top: 200 };
    view.rerender(
      <ChartTooltipPortal
        active
        anchorRef={anchorRef}
        coordinate={{ x: 250, y: 120 }}
      >
        42%
      </ChartTooltipPortal>,
    );
    expect(screen.getByRole('tooltip')).toHaveStyle({
      transform: 'translate3d(562px, 280px, 0)',
    });
    fireEvent.scroll(window);
    view.unmount();
    expect(frames.size).toBe(0);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('remeasures changed content when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const anchorRef = { current: anchor };
    const view = render(
      <ChartTooltipPortal
        active
        anchorRef={anchorRef}
        coordinate={{ x: 200, y: 120 }}
      >
        42%
      </ChartTooltipPortal>,
    );
    flushFrame();
    tooltipSize = { width: 260, height: 160 };
    view.rerender(
      <ChartTooltipPortal
        active
        anchorRef={anchorRef}
        coordinate={{ x: 200, y: 120 }}
      >
        42%; 73.5%
      </ChartTooltipPortal>,
    );
    flushFrame();
    expect(screen.getByRole('tooltip')).toHaveStyle({
      transform: 'translate3d(312px, 120px, 0)',
    });
  });
});

describe('tooltip content memoization', () => {
  it('keeps identical displayed samples stable and detects corrected values, series and colors', () => {
    const sample = [
      { dataKey: 'gpu_0', name: 'GPU 0', value: 42, color: '#fff' },
    ];
    expect(
      sameChartTooltipPayload(
        sample,
        sample.map((item) => ({ ...item })),
      ),
    ).toBe(true);
    for (const correction of [
      { value: 43 },
      { dataKey: 'gpu_1' },
      { name: 'GPU 1' },
      { color: '#000' },
    ]) {
      expect(
        sameChartTooltipPayload(sample, [{ ...sample[0], ...correction }]),
      ).toBe(false);
    }
    expect(sameChartTooltipPayload(sample, [])).toBe(false);
    expect(sameChartTooltipPayload(undefined, undefined)).toBe(true);
    expect(sameChartTooltipPayload(undefined, [])).toBe(false);
  });
});
