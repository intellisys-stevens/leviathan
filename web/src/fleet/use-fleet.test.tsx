import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetSnapshot } from './types';
import { newestFleetSnapshot, useFleet } from './use-fleet';

const initialState: FleetSnapshot = {
  schemaVersion: 'fleet-v1',
  sequence: 1,
  observedAt: '2026-08-30T19:00:00Z',
  platforms: [],
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly close = vi.fn();
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
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('useFleet', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads the fleet state and follows named fleet SSE events', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(initialState));
    vi.stubGlobal('fetch', fetchMock);

    const hook = renderHook(() => useFleet());
    await waitFor(() =>
      expect(hook.result.current.snapshot).toEqual(initialState),
    );
    expect(fetchMock).toHaveBeenCalledWith('/api/fleet/v1/state', {
      cache: 'no-store',
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe('/api/fleet/v1/events');

    act(() => FakeEventSource.instances[0].onopen?.());
    expect(hook.result.current.connection).toBe('live');

    const update = { ...initialState, sequence: 2 };
    act(() => FakeEventSource.instances[0].emit('fleet', update));
    expect(hook.result.current.snapshot?.sequence).toBe(2);
    expect(hook.result.current.error).toBeNull();

    hook.unmount();
    expect(FakeEventSource.instances[0].close).toHaveBeenCalledOnce();
  });

  it('ignores older states and reports incompatible events without clearing the last good state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(initialState)),
    );
    const hook = renderHook(() => useFleet());
    await waitFor(() => expect(hook.result.current.snapshot?.sequence).toBe(1));

    const current = { ...initialState, sequence: 4 };
    act(() => FakeEventSource.instances[0].emit('fleet', current));
    act(() =>
      FakeEventSource.instances[0].emit('fleet', {
        ...initialState,
        sequence: 3,
      }),
    );
    expect(hook.result.current.snapshot?.sequence).toBe(4);

    act(() =>
      FakeEventSource.instances[0].emit('fleet', {
        schemaVersion: 'fleet-v2',
        sequence: 5,
        platforms: [],
      }),
    );
    expect(hook.result.current.snapshot?.sequence).toBe(4);
    expect(hook.result.current.error).toMatch(/incompatible schema/i);
  });

  it('distinguishes reconnecting from a sustained disconnection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(initialState)),
    );
    const hook = renderHook(() => useFleet());
    await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());

    act(() => FakeEventSource.instances[0].onerror?.());
    expect(hook.result.current.connection).toBe('reconnecting');
    act(() => {
      for (let index = 0; index < 4; index += 1)
        FakeEventSource.instances[0].onerror?.();
    });
    expect(hook.result.current.connection).toBe('disconnected');
  });
});

describe('newestFleetSnapshot', () => {
  it('keeps a newer SSE state when an older request finishes later', () => {
    const newer = { ...initialState, sequence: 8 };
    expect(newestFleetSnapshot(newer, initialState)).toBe(newer);
    expect(newestFleetSnapshot(null, initialState)).toBe(initialState);
  });
});
