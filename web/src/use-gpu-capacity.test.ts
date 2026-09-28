import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGPUCapacity } from './use-gpu-capacity';

const payload = (revision = 1) => ({
  status: 'available',
  observedAt: new Date().toISOString(),
  revision,
  rows: [
    {
      id: 'native',
      mode: 'native',
      model: 'Synthetic GPU',
      memoryBytes: 80 * 1024 ** 3,
      available: revision,
      status: 'available',
    },
  ],
});
const respond = (revision = 1) =>
  new Response(JSON.stringify(payload(revision)), {
    headers: { 'Content-Type': 'application/json' },
  });
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('visible GPU capacity polling', () => {
  it('expires from the source observation without renewing old cached counts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...payload(),
            observedAt: new Date(Date.now() - 14_000).toISOString(),
          }),
        ),
      ),
    );
    const { result } = renderHook(() => useGPUCapacity('a', true));
    await flush();
    expect(result.current.expired).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(result.current.expired).toBe(true);
  });

  it('starts only when visible, refreshes every five seconds and stops when hidden', async () => {
    const fetcher = vi.fn().mockImplementation(async () => respond());
    vi.stubGlobal('fetch', fetcher);
    const { result, rerender } = renderHook(
      ({ active }) => useGPUCapacity('host-a', active),
      { initialProps: { active: false } },
    );
    expect(fetcher).not.toHaveBeenCalled();
    rerender({ active: true });
    await flush();
    expect(result.current.data?.rows[0].available).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    rerender({ active: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    rerender({ active: true });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('aborts hidden and obsolete host reads and ignores their late responses', async () => {
    const requests: {
      resolve: (response: Response) => void;
      signal: AbortSignal;
    }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, options: RequestInit) =>
          new Promise<Response>((resolve) =>
            requests.push({ resolve, signal: options.signal! }),
          ),
      ),
    );
    const { result, rerender } = renderHook(
      ({ host, active }) => useGPUCapacity(host, active),
      { initialProps: { host: 'a', active: true } },
    );
    rerender({ host: 'b', active: true });
    expect(requests[0].signal.aborted).toBe(true);
    await act(async () => {
      requests[1].resolve(respond(2));
    });
    await act(async () => {
      requests[0].resolve(respond(99));
    });
    expect(result.current.data?.revision).toBe(2);
    act(() => result.current.refresh());
    expect(requests).toHaveLength(3);
    rerender({ host: 'b', active: false });
    expect(requests[2].signal.aborted).toBe(true);
    expect(result.current.refreshing).toBe(false);
  });

  it('retains the last rows on failure while exposing an error and age expiry', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(respond())
      .mockRejectedValue(new Error('internal server detail must not be shown'));
    vi.stubGlobal('fetch', fetcher);
    const { result } = renderHook(() => useGPUCapacity('a', true));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current.data?.revision).toBe(1);
    expect(result.current.error).toBe('Capacity could not be refreshed.');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.expired).toBe(true);
  });

  it('recovers through manual refresh without overlapping a pending read', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(respond(3));
    vi.stubGlobal('fetch', fetcher);
    const { result } = renderHook(() => useGPUCapacity('a', true));
    await flush();
    expect(result.current.error).toMatch(/not available on this monitor/);
    act(() => result.current.refresh());
    await flush();
    expect(result.current.data?.rows[0].available).toBe(3);
    expect(result.current.error).toBeNull();
  });

  it('times out a stalled transport and can retry on the next interval', async () => {
    const fetcher = vi.fn(
      (_url, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const { result } = renderHook(() => useGPUCapacity('a', true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(result.current.error).toBe('Capacity could not be refreshed.');
    expect(result.current.refreshing).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
