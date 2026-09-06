import { useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChartRenderBoundary,
  useChartVisibility,
} from './chart-render-boundary';

afterEach(() => vi.unstubAllGlobals());

describe('chart rendering visibility', () => {
  it('retains the graph offscreen and catches up without losing incoming samples', () => {
    let notify!: IntersectionObserverCallback;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          notify = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const painted = vi.fn();
    function Plot({ samples }: { samples: number[] }) {
      painted(samples);
      return <output data-testid="plot">{samples.join(',')}</output>;
    }
    function Panel({ samples }: { samples: number[] }) {
      const anchor = useRef<HTMLDivElement>(null);
      const active = useChartVisibility(anchor);
      return (
        <section className="compact-chart-panel">
          <output data-testid="latest">{samples.at(-1)}</output>
          <div ref={anchor}>
            <ChartRenderBoundary active={active}>
              <Plot samples={samples} />
            </ChartRenderBoundary>
          </div>
          <button type="button">Inspect</button>
        </section>
      );
    }
    const view = render(<Panel samples={[1]} />);
    const visible = (isIntersecting: boolean) =>
      act(() =>
        notify(
          [{ isIntersecting } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        ),
      );
    visible(false);
    const offscreenCount = painted.mock.calls.length;
    view.rerender(<Panel samples={[1, 2, 3]} />);
    expect(screen.getByTestId('latest')).toHaveTextContent('3');
    expect(screen.getByTestId('plot')).toHaveTextContent('1');
    expect(painted).toHaveBeenCalledTimes(offscreenCount);
    visible(true);
    expect(screen.getByTestId('plot')).toHaveTextContent('1,2,3');
    visible(false);
    view.rerender(<Panel samples={[1, 2, 3, 4]} />);
    act(() => screen.getByRole('button', { name: 'Inspect' }).focus());
    expect(screen.getByTestId('plot')).toHaveTextContent('1,2,3,4');
    act(() => screen.getByRole('button', { name: 'Inspect' }).blur());
    view.rerender(<Panel samples={[1, 2, 3, 4, 5]} />);
    fireEvent(window, new Event('beforeprint'));
    expect(screen.getByTestId('plot')).toHaveTextContent('1,2,3,4,5');
    fireEvent(window, new Event('afterprint'));
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('remeasures offscreen charts after text or viewport changes', () => {
    const initialLayout = { fontSize: 13, width: 600 };
    const view = render(
      <ChartRenderBoundary active={false} layout={initialLayout}>
        <output>initial graph</output>
      </ChartRenderBoundary>,
    );
    view.rerender(
      <ChartRenderBoundary active={false} layout={initialLayout}>
        <output>new sample</output>
      </ChartRenderBoundary>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('initial graph');
    view.rerender(
      <ChartRenderBoundary active={false} layout={{ fontSize: 26, width: 300 }}>
        <output>resized graph with current sample</output>
      </ChartRenderBoundary>,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'resized graph with current sample',
    );
  });

  it('pauses a hidden document and resumes even without intersection support', () => {
    let hidden = false;
    const getter = vi
      .spyOn(document, 'hidden', 'get')
      .mockImplementation(() => hidden);
    function Panel({ value }: { value: string }) {
      const anchor = useRef<HTMLDivElement>(null);
      const active = useChartVisibility(anchor);
      return (
        <div ref={anchor}>
          <ChartRenderBoundary active={active}>
            <output>{value}</output>
          </ChartRenderBoundary>
        </div>
      );
    }
    const view = render(<Panel value="first" />);
    hidden = true;
    fireEvent(document, new Event('visibilitychange'));
    view.rerender(<Panel value="latest" />);
    expect(screen.getByRole('status')).toHaveTextContent('first');
    hidden = false;
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.getByRole('status')).toHaveTextContent('latest');
    getter.mockRestore();
  });
});
