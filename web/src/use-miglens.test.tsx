import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildInfo, RuntimeSettings, Snapshot } from './types';
import { useMIGLens } from './use-miglens';

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
  });
});
