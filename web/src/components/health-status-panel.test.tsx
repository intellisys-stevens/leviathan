import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  elapsedLabel,
  HealthStatusPanel,
  observationDayState,
  observationSummary,
  overallHealth,
  timelineColumns,
  timelineIndexAtPosition,
} from './health-status-panel';
import type { components } from '../api.gen';

type Status = components['schemas']['HealthStatus'];
const counts = {
  operational: 0,
  degraded: 0,
  unavailable: 0,
  unsupported: 0,
  unknown: 0,
};
const report: Status = {
  sampledAt: '2026-09-05T12:00:00Z',
  monitorStartedAt: '2026-09-05T10:00:00Z',
  monitorUptimeSeconds: 7200,
  retentionDays: 90,
  persistence: { enabled: true, saving: true },
  components: [
    {
      id: 'system',
      label: 'Host telemetry',
      state: 'operational',
      observedAt: '2026-09-05T12:00:00Z',
    },
  ],
  days: Array.from({ length: 90 }, (_, index) => ({
    date: new Date(Date.parse('2026-06-08T00:00:00Z') + index * 86400000)
      .toISOString()
      .slice(0, 10),
    expectedSamples: index === 89 ? 721 : 1440,
    components: {
      system:
        index === 89
          ? {
              ...counts,
              operational: 100,
              degraded: 10,
              unavailable: 10,
              unknown: 601,
            }
          : { ...counts, unknown: 1440 },
    },
  })),
};
const hostArticle = () =>
  screen.getByRole('heading', { name: 'Host telemetry' }).closest('article')!;
afterEach(() => vi.unstubAllGlobals());

describe('status observation presentation', () => {
  it('maps compact ninety-day rows by both coordinates and preserves the full three-month denominator', () => {
    expect(timelineColumns(237, 90)).toBe(30);
    expect(timelineColumns(717, 90)).toBe(90);
    expect(timelineIndexAtPosition(234.5, 22, 237, 90)).toBe(29);
    expect(timelineIndexAtPosition(2.5, 44, 237, 90)).toBe(30);
    expect(timelineIndexAtPosition(234.5, 87, 237, 90)).toBe(59);
    expect(timelineIndexAtPosition(2.5, 88, 237, 90)).toBe(60);
    expect(timelineIndexAtPosition(234.5, 110, 237, 90)).toBe(89);
    expect(timelineIndexAtPosition(714.5, 22, 717, 90)).toBe(89);
    expect(timelineIndexAtPosition(-5, -5, 237, 90)).toBe(0);
    expect(timelineIndexAtPosition(999, 999, 237, 90)).toBe(89);
    const expected = report.days.reduce(
      (sum, day) => sum + day.expectedSamples,
      0,
    );
    expect(expected).toBe(89 * 1440 + 721);
    expect(
      observationSummary(
        { ...counts, operational: 100, degraded: 10, unavailable: 10 },
        expected,
      ).coverage,
    ).toBeCloseTo(0.09311, 5);
  });
  it('excludes unsupported and unknown samples from both healthy observations and coverage', () => {
    expect(
      observationSummary(
        {
          operational: 80,
          degraded: 10,
          unavailable: 10,
          unsupported: 20,
          unknown: 80,
        },
        200,
      ),
    ).toEqual({ healthy: 80, coverage: 50 });
    expect(observationSummary({ ...counts, unknown: 10 }, 10)).toEqual({
      healthy: null,
      coverage: 0,
    });
    expect(observationSummary({ ...counts, unsupported: 10 }, 10)).toEqual({
      healthy: null,
      coverage: 0,
    });
    expect(observationSummary(counts, 0)).toEqual({
      healthy: null,
      coverage: null,
    });
    expect(elapsedLabel(-1)).toBe('—');
    expect(elapsedLabel(90061)).toBe('1d 1h');
  });

  it('colors days by their worst measured observation and collapses unsupported into no data', () => {
    expect(
      observationDayState({ ...counts, operational: 1439, unavailable: 1 }),
    ).toBe('unavailable');
    expect(
      observationDayState({ ...counts, operational: 90, degraded: 10 }),
    ).toBe('degraded');
    expect(
      observationDayState({ ...counts, operational: 1, unknown: 1439 }),
    ).toBe('operational');
    expect(observationDayState({ ...counts, unsupported: 1440 })).toBe(
      'unknown',
    );
  });

  it('excludes workspace attribution from overall status and distinguishes partial failures', () => {
    const core = report.components[0];
    expect(
      overallHealth([
        core,
        { id: 'attribution', label: 'Assignments', state: 'unavailable' },
      ]),
    ).toBe('operational');
    expect(
      overallHealth([core, { id: 'gpu', label: 'GPU', state: 'unsupported' }]),
    ).toBe('operational');
    expect(
      overallHealth([core, { id: 'gpu', label: 'GPU', state: 'unavailable' }]),
    ).toBe('degraded');
    expect(overallHealth([{ ...core, state: 'unavailable' }])).toBe(
      'unavailable',
    );
    expect(overallHealth([])).toBe('unknown');
  });

  it('shows only the three status components and no day inspector or unsupported label', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...report,
              components: [
                ...report.components,
                {
                  id: 'attribution',
                  label: 'Workspace attribution',
                  state: 'unavailable',
                },
                { id: 'gpu', label: 'GPU telemetry', state: 'unsupported' },
              ],
            }),
          ),
      ),
    );
    render(<HealthStatusPanel snapshot={null} />);
    expect(
      await screen.findByRole('heading', { name: 'Yggdrasil connection' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'GPU telemetry' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Workspace attribution')).toBeNull();
    expect(screen.queryByText('Unsupported')).toBeNull();
    expect(screen.queryByLabelText('Inspect day')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getAllByRole('slider')).toHaveLength(3);
    expect(screen.queryByText(/2026-09-04: No data/)).toBeNull();
  });

  it('inspects timelines directly with keyboard and preserves the selected date through refresh', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(report))),
    );
    const { container } = render(<HealthStatusPanel snapshot={null} />);
    expect(await screen.findByText('83.3%')).toBeInTheDocument();
    expect(screen.getByText('2h 0m')).toBeInTheDocument();
    expect(screen.getByText('<0.1%')).toBeInTheDocument();
    const slider = screen.getByRole('slider', {
      name: 'Host telemetry daily history',
    });
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      '2026-09-05: Unavailable; 16.6% coverage',
    );
    fireEvent.focus(slider);
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(slider).toHaveValue('1');
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      '2026-06-08: No data; 0% coverage',
    );
    expect(
      screen.getByText('2026-06-08: No data; 0% coverage'),
    ).toBeInTheDocument();
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(slider).toHaveValue('1'));
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider).toHaveValue('2');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider).toHaveValue('3');
    fireEvent.keyDown(slider, { key: 'Home' });
    fireEvent.keyDown(slider, { key: 'End' });
    expect(slider).toHaveValue('90');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider).toHaveValue('90');
    expect(
      hostArticle().querySelector('[data-state="unavailable"].health-day'),
    ).toHaveAttribute('data-partial', 'true');
    expect(
      hostArticle().querySelector('[data-state="unknown"].health-day'),
    ).toHaveAttribute('data-partial', 'false');
    fireEvent.keyDown(slider, { key: 'Escape' });
    expect(container.querySelector('.health-day-tooltip')).toBeNull();
  });

  it('keeps meaningful status messages and upload receipt/retry times visible', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...report,
              components: [
                ...report.components,
                {
                  id: 'uplink',
                  label: 'Yggdrasil connection',
                  state: 'degraded',
                  message: 'Yggdrasil could not be reached.',
                  lastAcknowledgedAt: '2026-09-05T11:59:50Z',
                  retryAt: '2026-09-05T12:00:05Z',
                },
              ],
            }),
          ),
      ),
    );
    render(<HealthStatusPanel snapshot={null} />);
    expect(
      await screen.findByText('Yggdrasil could not be reached.'),
    ).toBeInTheDocument();
    const article = screen
      .getByRole('heading', { name: 'Yggdrasil connection' })
      .closest('article')!;
    expect(
      article.querySelector('time[datetime="2026-09-05T11:59:50Z"]'),
    ).toBeInTheDocument();
    expect(
      article.querySelector('time[datetime="2026-09-05T12:00:05Z"]'),
    ).toBeInTheDocument();
    expect(within(article).getByText('Degraded')).toBeInTheDocument();
  });

  it('inspects taps without converting vertical scrolling, cancellation, or a second pointer into selection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(report))),
    );
    render(<HealthStatusPanel snapshot={null} />);
    const slider = await screen.findByRole('slider', {
      name: 'Host telemetry daily history',
    });
    vi.spyOn(slider.parentElement!, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      right: 237,
      top: 0,
      bottom: 132,
      width: 237,
      height: 132,
      toJSON: () => ({}),
    });
    const pointer = (type: string, x: number, y: number, id = 1) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, {
        clientX: x,
        clientY: y,
        pointerId: id,
        pointerType: 'touch',
        buttons: type === 'pointerup' ? 0 : 1,
      });
      fireEvent(slider, event);
      return event;
    };
    expect(pointer('pointerdown', 2.5, 10).defaultPrevented).toBe(false);
    pointer('pointermove', 2.5, 60);
    pointer('pointerup', 2.5, 60);
    expect(slider).toHaveValue('90');
    pointer('pointerdown', 2.5, 10);
    pointer('pointercancel', 2.5, 10);
    pointer('pointerup', 2.5, 10);
    expect(slider).toHaveValue('90');
    pointer('pointerdown', 2.5, 10);
    pointer('pointerdown', 10.5, 10, 2);
    pointer('pointerup', 10.5, 10, 2);
    pointer('pointerup', 2.5, 10);
    expect(slider).toHaveValue('90');
    pointer('pointerdown', 2.5, 10);
    pointer('pointerup', 2.5, 10);
    expect(slider).toHaveValue('1');
    expect(slider).toHaveFocus();
    pointer('pointerdown', 2.5, 66);
    pointer('pointerup', 2.5, 66);
    expect(slider).toHaveValue('31');
    pointer('pointerdown', 234.5, 110);
    pointer('pointerup', 234.5, 110);
    expect(slider).toHaveValue('90');
    fireEvent.keyDown(slider, { key: 'ArrowUp' });
    expect(slider).toHaveValue('60');
    fireEvent.keyDown(slider, { key: 'ArrowDown' });
    expect(slider).toHaveValue('90');
  });

  it('shows journal warnings even while new observations are being saved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...report,
              persistence: {
                enabled: true,
                saving: true,
                message: 'Skipped a damaged history record.',
              },
            }),
          ),
      ),
    );
    render(<HealthStatusPanel snapshot={null} />);
    expect(
      await screen.findByText('Skipped a damaged history record.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/History is not being saved/)).toBeNull();
  });

  it('shows clock warnings when history is memory-only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...report,
              persistence: {
                enabled: false,
                saving: false,
                message: 'Clock changed; the observation gap remains unknown.',
              },
            }),
          ),
      ),
    );
    render(<HealthStatusPanel snapshot={null} />);
    expect(
      await screen.findByText(
        'Clock changed; the observation gap remains unknown.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/History is not being saved/)).toBeNull();
  });

  it('uses monotonic runtime even when the wall clock moved backward', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ...report, sampledAt: '2026-09-05T09:00:00Z' }),
          ),
      ),
    );
    render(<HealthStatusPanel snapshot={null} />);
    expect(await screen.findByText('2h 0m')).toBeInTheDocument();
  });

  it('leaves runtime unavailable when an older server omits monotonic uptime', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ...report, monitorUptimeSeconds: undefined }),
          ),
      ),
    );
    render(<HealthStatusPanel snapshot={null} />);
    await screen.findByText('83.3%');
    expect(screen.queryByText('2h 0m')).toBeNull();
    expect(
      screen.getByText('Monitor runtime').nextElementSibling?.textContent,
    ).toMatch(/^—/);
  });

  it('recovers from missing endpoints and reports persistence failure separately', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...report,
            persistence: {
              enabled: true,
              saving: false,
              message: 'State directory is read-only.',
            },
          }),
        ),
      );
    vi.stubGlobal('fetch', fetch);
    render(<HealthStatusPanel snapshot={null} />);
    expect(
      await screen.findByText(/requires an updated Leviathan server/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByText('State directory is read-only.'),
    ).toBeInTheDocument();
    expect(screen.getByText('83.3%')).toBeInTheDocument();
  });

  it('retains history on refresh failure while current status becomes no data', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(report)))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(report)));
    vi.stubGlobal('fetch', fetch);
    const { container } = render(<HealthStatusPanel snapshot={null} />);
    expect(await screen.findByText('83.3%')).toBeInTheDocument();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(
      await screen.findByText(
        /Status history could not be refreshed.*Last report:/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('83.3%')).toBeInTheDocument();
    expect(
      container.querySelector('.health-current .health-state'),
    ).toHaveAttribute('data-state', 'unknown');
    expect(within(hostArticle()).getByText('No data')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(
        container.querySelector('.health-current .health-state'),
      ).toHaveAttribute('data-state', 'operational'),
    );
    expect(
      screen.queryByText(/Status history could not be refreshed/),
    ).toBeNull();
  });

  it('does not claim healthy history before any measured observations exist', async () => {
    const empty = {
      ...report,
      components: report.components.map((component) => ({
        ...component,
        state: 'unknown',
      })),
      days: report.days.map((day) => ({
        ...day,
        components: { system: { ...counts, unsupported: day.expectedSamples } },
      })),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(empty))),
    );
    render(<HealthStatusPanel snapshot={null} />);
    await screen.findByRole('heading', { name: 'Host telemetry' });
    expect(hostArticle().querySelector('.health-statistics')).toHaveTextContent(
      '— healthy observations0% coverage',
    );
    expect(screen.queryByText('100%')).toBeNull();
    expect(
      screen.getByRole('slider', { name: 'Host telemetry daily history' }),
    ).toHaveAttribute('aria-valuetext', '2026-09-05: No data; 0% coverage');
  });
});
