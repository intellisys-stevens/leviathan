import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePluginReport, type PluginReport } from './use-plugin-report';

const report: PluginReport = { plugins: [] };
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('plugin status reads', () => {
  it('refreshes independently and stops polling when the view unmounts', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(response(report));
    vi.stubGlobal('fetch', fetchMock);
    const view = renderHook(usePluginReport);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.result.current.report).toEqual(report);
    fetchMock.mockResolvedValue(response(report));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    view.unmount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the last report on failure and recovers through refresh', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(report))
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(response(report));
    vi.stubGlobal('fetch', fetchMock);
    const view = renderHook(usePluginReport);
    await waitFor(() => expect(view.result.current.report).toEqual(report));
    act(() => view.result.current.refresh());
    await waitFor(() =>
      expect(view.result.current.error).toBe('Plugin status is unavailable.'),
    );
    expect(view.result.current.report).toEqual(report);
    act(() => view.result.current.refresh());
    await waitFor(() => expect(view.result.current.error).toBeNull());
  });

  it('isolates an invalid response and aborts an obsolete read', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ plugins: null }))
      .mockImplementationOnce(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const view = renderHook(usePluginReport);
    await waitFor(() =>
      expect(view.result.current.error).toBe('Plugin status is unavailable.'),
    );
    expect(view.result.current.report).toBeNull();
    act(() => view.result.current.refresh());
    const signal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
  });
});
