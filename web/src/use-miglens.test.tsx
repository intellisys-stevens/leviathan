import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildInfo, RuntimeSettings, Snapshot } from './types';
import {
  normalizeSnapshot,
  shareStableSnapshot,
  type SnapshotPayload,
  useMIGLens,
} from './use-miglens';

const snapshot: Snapshot = {
  schemaVersion: 'v1',
  sequence: 1,
  sampledAt: '2026-08-29T12:00:00Z',
  host: { hostname: 'fixture', os: 'linux', arch: 'amd64' },
  gpus: [],
  processes: [],
  diagnostics: [],
  capabilities: {
    nvml: { name: 'NVML', available: true, status: 'available' },
    gpm: { name: 'GPM', available: false, status: 'unsupported' },
    dcgm: { name: 'DCGM', available: false, status: 'unsupported' },
    proc: { name: '/proc', available: true, status: 'available' },
    profileMetrics: false,
  },
};

const initialSettings: RuntimeSettings = {
  samplingIntervalMs: 1000,
  profileIntervalMs: 1000,
  processIntervalMs: 1000,
  historyWindowMs: 60 * 60 * 1000,
  allowedSamplingIntervalsMs: [500, 1000, 2000],
};

const buildInfo: BuildInfo = {
  version: '0.1.0',
  commit: 'abc1234',
  buildDate: '2026-08-30T12:00:00Z',
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<EventListener>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback =
      typeof listener === 'function'
        ? listener
        : (event: Event) => listener.handleEvent(event);
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  emit(type: string, value: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(value) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close() {}
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestURL(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe('useMIGLens runtime settings', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads settings in parallel and synchronizes dashboard tabs through SSE', async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestURL(input);
        if (url === '/api/v1/snapshot') return jsonResponse(snapshot);
        if (url === '/api/v1/settings' && init?.method === 'PATCH') {
          if (typeof init.body !== 'string')
            throw new Error('expected a JSON string body');
          const body = JSON.parse(init.body) as {
            samplingIntervalMs: number;
          };
          return jsonResponse({
            ...initialSettings,
            samplingIntervalMs: body.samplingIntervalMs,
          });
        }
        if (url === '/api/v1/settings') return jsonResponse(initialSettings);
        if (url === '/api/v1/version') return jsonResponse(buildInfo);
        if (url.startsWith('/api/v1/history?'))
          return jsonResponse({
            entity: 'GPU/a',
            metrics: ['temperature', 'power'],
            window: '1h0m0s',
            points: [],
          });
        if (url === '/api/v1/history/aligned' && init?.method === 'POST') {
          if (typeof init.body !== 'string')
            throw new Error('expected an aligned history JSON body');
          const body = JSON.parse(init.body) as {
            window: string;
            series: unknown[];
          };
          return jsonResponse({
            window: body.window,
            series: body.series,
            points: [],
          });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = renderHook(() => useMIGLens());
    const second = renderHook(() => useMIGLens());
    await waitFor(() => {
      expect(first.result.current.settings?.samplingIntervalMs).toBe(1000);
      expect(second.result.current.settings?.samplingIntervalMs).toBe(1000);
      expect(first.result.current.buildInfo).toEqual(buildInfo);
      expect(second.result.current.buildInfo).toEqual(buildInfo);
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(
      fetchMock.mock.calls.slice(0, 3).map(([input]) => requestURL(input)),
    ).toEqual(['/api/v1/snapshot', '/api/v1/settings', '/api/v1/version']);

    act(() => {
      for (const events of FakeEventSource.instances)
        events.emit('settings', {
          ...initialSettings,
          samplingIntervalMs: 500,
        });
    });
    expect(first.result.current.settings?.samplingIntervalMs).toBe(500);
    expect(second.result.current.settings?.samplingIntervalMs).toBe(500);

    await act(async () => {
      await first.result.current.updateSamplingInterval(2000);
    });
    expect(first.result.current.settings?.samplingIntervalMs).toBe(2000);
    const patch = fetchMock.mock.calls.find(
      ([url, init]) =>
        requestURL(url) === '/api/v1/settings' &&
        (init as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patch?.[1]).toMatchObject({
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{"samplingIntervalMs":2000}',
    });

    await act(async () => {
      await first.result.current.history(
        'GPU/a',
        ['temperature', 'power'],
        '1h',
      );
    });
    const historyCall = fetchMock.mock.calls.find(([input]) =>
      requestURL(input).startsWith('/api/v1/history?'),
    );
    const historyURL = new URL(
      requestURL(historyCall?.[0] as string),
      'http://miglens.local',
    );
    expect(historyURL.searchParams.get('entity')).toBe('GPU/a');
    expect(historyURL.searchParams.get('metrics')).toBe('temperature,power');
    expect(historyURL.searchParams.get('window')).toBe('1h');
    expect(historyURL.searchParams.get('maxPoints')).toBe('720');

    await act(async () => {
      await first.result.current.alignedHistory({
        window: '30m',
        maxPoints: 720,
        series: [
          {
            key: 'gpu:fixture',
            entity: 'GPU/fixture',
            metrics: ['temperature'],
          },
        ],
      });
    });
    const alignedCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        requestURL(input) === '/api/v1/history/aligned' &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(alignedCall?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const alignedBody = alignedCall?.[1]?.body;
    expect(typeof alignedBody).toBe('string');
    expect(JSON.parse(alignedBody as string)).toEqual({
      window: '30m',
      maxPoints: 720,
      series: [
        { key: 'gpu:fixture', entity: 'GPU/fixture', metrics: ['temperature'] },
      ],
    });
  });

  it('reuses unchanged slow-moving slices across telemetry snapshots', () => {
    const previous: Snapshot = {
      ...structuredClone(snapshot),
      processes: [{ pid: 42, user: 'worker', status: 'available' }],
      diagnostics: [
        {
          code: 'fixture',
          severity: 'warning',
          component: 'test',
          summary: 'Fixture warning',
          status: 'stale',
        },
      ],
      attribution: {
        provider: 'kubernetes_dra',
        status: 'available',
        workloads: [
          {
            ref: 'opaque',
            platform: 'coder',
            kind: 'workspace',
            name: 'training',
            ownerName: 'alice',
          },
        ],
        assignments: [
          {
            workloadRef: 'opaque',
            entityType: 'physical_gpu',
            entityUuid: 'GPU-fixture',
            state: 'allocated',
          },
        ],
      },
    };
    const next = structuredClone(previous);
    next.sequence = 2;
    next.sampledAt = '2026-08-29T12:00:01Z';

    const shared = shareStableSnapshot(previous, next);
    expect(shared.host).toBe(previous.host);
    expect(shared.processes).toBe(previous.processes);
    expect(shared.diagnostics).toBe(previous.diagnostics);
    expect(shared.capabilities).toBe(previous.capabilities);
    expect(shared.attribution).toBe(previous.attribution);

    const changed = structuredClone(next);
    changed.processes[0].pid = 43;
    changed.attribution!.assignments[0].state = 'reserved';
    const updated = shareStableSnapshot(previous, changed);
    expect(updated.processes).not.toBe(previous.processes);
    expect(updated.attribution).not.toBe(previous.attribution);
  });

  it('normalizes nullable wire collections before snapshots are shared', async () => {
    const nullablePayload: SnapshotPayload = {
      ...snapshot,
      processes: null,
      diagnostics: null,
      attribution: {
        provider: 'kubernetes_dra',
        status: 'available',
        workloads: null,
        assignments: null,
      },
    };
    const normalized = normalizeSnapshot(nullablePayload);
    expect(normalized.processes).toEqual([]);
    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.attribution?.workloads).toEqual([]);
    expect(normalized.attribution?.assignments).toEqual([]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = requestURL(input);
        if (url === '/api/v1/snapshot') return jsonResponse(nullablePayload);
        if (url === '/api/v1/settings') return jsonResponse(initialSettings);
        if (url === '/api/v1/version') return jsonResponse(buildInfo);
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    const hook = renderHook(() => useMIGLens());
    await waitFor(() => {
      expect(hook.result.current.snapshot?.processes).toEqual([]);
      expect(hook.result.current.snapshot?.diagnostics).toEqual([]);
      expect(hook.result.current.snapshot?.attribution?.workloads).toEqual([]);
      expect(hook.result.current.snapshot?.attribution?.assignments).toEqual(
        [],
      );
    });

    act(() => {
      FakeEventSource.instances[0].emit('snapshot', {
        ...nullablePayload,
        sequence: 2,
      });
    });
    expect(hook.result.current.snapshot?.sequence).toBe(2);
    expect(hook.result.current.snapshot?.processes).toEqual([]);
  });
});
