import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAlignedHistory } from './aligned-history-request';
import type { AlignedHistory, AlignedHistoryRequest } from './types';

afterEach(() => vi.unstubAllGlobals());

function request(count = 1, metrics = 1): AlignedHistoryRequest {
  return {
    window: '30m',
    maxPoints: 720,
    series: Array.from({ length: count }, (_, index) => ({
      key: `series_${index}`,
      entity: `gpu_${index}`,
      metrics: Array.from(
        { length: metrics },
        (_, metric) => `metric_${metric}`,
      ),
    })),
  };
}

function json(value: AlignedHistory) {
  return { ok: true, json: async () => value } as Response;
}

describe('aligned history transport', () => {
  it('keeps a normal request in one HTTP call and returns its unchanged response', async () => {
    const input = request();
    const response = { ...input, points: [] };
    const fetch = vi.fn().mockResolvedValue(json(response));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchAlignedHistory(input)).toBe(response);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      '/api/v1/history/aligned',
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
        body: JSON.stringify(input),
      }),
    );
  });

  it('splits long valid plugin identities by UTF-8 bytes and preserves exact timestamps and gaps', async () => {
    const input = request(21);
    input.series = input.series.map((series, index) => {
      const uuid = `${'a'.repeat(128)}/${String(index).padStart(512, 'r')}`;
      const generation = `${uuid}@plugin:${'%2F'.repeat(4096)}`;
      return { ...series, key: `gi:${generation}`, entity: generation };
    });
    const first = '2026-09-28T00:00:00.000000001Z';
    const second = '2026-09-28T00:00:00.000000002Z';
    const gap = '2026-09-28T00:00:01Z';
    const batches: AlignedHistoryRequest[] = [];
    const complete: Array<() => void> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options: RequestInit) => {
        const body = options.body as string;
        expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(
          256 * 1024,
        );
        const batch = JSON.parse(body) as AlignedHistoryRequest;
        const index = batches.push(batch) - 1;
        const response = json({
          window: input.window,
          series: batch.series,
          points:
            index < 2
              ? [
                  {
                    sampledAt: index === 0 ? second : first,
                    values: {
                      [batch.series[0].key]: { metric_0: 0.123456789 },
                    },
                  },
                  { sampledAt: gap, values: { [batch.series[0].key]: {} } },
                ]
              : [],
        });
        return new Promise<Response>((resolve) =>
          complete.push(() => resolve(response)),
        );
      }),
    );
    const pending = fetchAlignedHistory(input);
    expect(batches).toHaveLength(3);
    for (const finish of complete.toReversed()) finish();
    const result = await pending;
    expect(result.series).toEqual(input.series);
    expect(result.points.map(({ sampledAt }) => sampledAt)).toEqual([
      first,
      second,
      gap,
    ]);
    expect(result.points[0].values[batches[1].series[0].key]).toEqual({
      metric_0: 0.123456789,
    });
    expect(result.points[2].values).toEqual({
      [batches[0].series[0].key]: {},
      [batches[1].series[0].key]: {},
    });
    expect(result.points[2].values).not.toHaveProperty(
      batches[2].series[0].key,
    );
  });

  it.each([
    { count: 257, metrics: 1, sizes: [256, 1] },
    { count: 65, metrics: 16, sizes: [64, 1] },
  ])(
    'respects series and total metric limits for $count descriptors',
    async ({ count, metrics, sizes }) => {
      const batches: AlignedHistoryRequest[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, options: RequestInit) => {
          const batch = JSON.parse(
            options.body as string,
          ) as AlignedHistoryRequest;
          batches.push(batch);
          return json({ ...batch, points: [] });
        }),
      );
      const input = request(count, metrics);
      expect((await fetchAlignedHistory(input)).series).toEqual(input.series);
      expect(batches.map(({ series }) => series.length)).toEqual(sizes);
    },
  );

  it('limits concurrency to four and cancels active children without starting queued requests', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, options: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = options.signal!;
            signals.push(signal);
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      ),
    );
    const controller = new AbortController();
    const rejection = expect(
      fetchAlignedHistory(request(1025), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(signals).toHaveLength(4);
    controller.abort();
    await rejection;
    expect(signals).toHaveLength(4);
    expect(signals.every(({ aborted }) => aborted)).toBe(true);
  });

  it('aborts sibling requests when one child fails', async () => {
    const signals: AbortSignal[] = [];
    let fail!: () => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, options: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const signal = options.signal!;
            signals.push(signal);
            if (signals.length === 1)
              fail = () => resolve({ ok: false, status: 503 } as Response);
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      ),
    );
    const rejection = expect(
      fetchAlignedHistory(request(1025)),
    ).rejects.toThrow('Aligned history request failed (503)');
    fail();
    await rejection;
    expect(signals).toHaveLength(4);
    expect(signals.every(({ aborted }) => aborted)).toBe(true);
  });

  it('rejects oversized individual descriptors and cross-batch duplicate keys before fetching', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const oversized = request();
    oversized.series[0].entity = 'é'.repeat(140_000);
    await expect(fetchAlignedHistory(oversized)).rejects.toThrow(
      'request size limit',
    );
    const duplicate = request(257);
    duplicate.series[256].key = duplicate.series[0].key;
    await expect(fetchAlignedHistory(duplicate)).rejects.toThrow(
      'keys must be unique',
    );
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      fetchAlignedHistory(request(), aborted.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
