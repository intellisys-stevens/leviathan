import { useCallback, useEffect, useRef, useState } from 'react';
import {
  gpuCapacityRefreshMs,
  gpuCapacityStaleMs,
  parseGPUCapacity,
  type GPUCapacity,
} from './gpu-capacity';

type CapacityState = {
  hostKey: string;
  data: GPUCapacity | null;
  freshUntil: number;
  pending: boolean;
  error: string | null;
};

export function useGPUCapacity(hostKey: string, active: boolean) {
  const refreshRead = useRef<() => void>(() => {});
  const [state, setState] = useState<CapacityState>({
    hostKey,
    data: null,
    freshUntil: 0,
    pending: false,
    error: null,
  });
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let controller: AbortController | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    const read = async () => {
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      timeout = setTimeout(() => controller?.abort(), 3_000);
      setState((previous) => ({
        ...(previous.hostKey === hostKey
          ? previous
          : { hostKey, data: null, freshUntil: 0, error: null }),
        pending: true,
      }));
      try {
        const response = await fetch('/api/v1/gpu-capacity', {
          signal: controller.signal,
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? 'Capacity reporting is not available on this monitor.'
              : 'Capacity could not be refreshed.',
          );
        const data = parseGPUCapacity(await response.json());
        if (disposed) return;
        const receivedAt = Date.now();
        const observedAt = Date.parse(data.observedAt ?? '');
        // Reading an older bridge cache must not give its counts a new 15s life.
        const freshUntil =
          Math.min(
            receivedAt,
            Number.isFinite(observedAt) ? observedAt : receivedAt,
          ) + gpuCapacityStaleMs;
        setNow(receivedAt);
        setState({ hostKey, data, freshUntil, pending: false, error: null });
      } catch (error) {
        if (disposed) return;
        const message = error instanceof Error ? error.message : '';
        setState((previous) => ({
          ...previous,
          pending: false,
          error: [
            'Capacity reporting is not available on this monitor.',
            'Capacity response is invalid.',
            'Capacity observation time is missing.',
          ].includes(message)
            ? message
            : 'Capacity could not be refreshed.',
        }));
      } finally {
        clearTimeout(timeout);
        inFlight = false;
      }
    };
    refreshRead.current = () => void read();
    void read();
    const poll = setInterval(() => void read(), gpuCapacityRefreshMs);
    return () => {
      disposed = true;
      refreshRead.current = () => {};
      controller?.abort();
      clearTimeout(timeout);
      clearInterval(poll);
    };
  }, [hostKey, active]);

  useEffect(() => {
    if (!state.freshUntil) return;
    const remaining = state.freshUntil - Date.now();
    const expiry = setTimeout(() => setNow(Date.now()), Math.max(0, remaining));
    return () => clearTimeout(expiry);
  }, [state.freshUntil]);

  const refresh = useCallback(() => refreshRead.current(), []);
  const current = state.hostKey === hostKey;
  const data = current ? state.data : null;
  const expired = Boolean(data && now >= state.freshUntil);
  return {
    data,
    loading: !data && (!current || state.pending || !state.error),
    refreshing: active && current && state.pending,
    error: current ? state.error : null,
    expired,
    refresh,
  };
}
