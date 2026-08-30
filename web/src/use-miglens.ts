import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BuildInfo,
  HistorySeries,
  RuntimeSettings,
  Snapshot,
} from './types';

export type ConnectionState =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'disconnected';

export function useMIGLens() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null | undefined>(
    undefined,
  );
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const failures = useRef(0);

  useEffect(() => {
    let active = true;
    const snapshotRequest = fetch('/api/v1/snapshot', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Snapshot request failed (${response.status})`);
        return response.json() as Promise<Snapshot>;
      })
      .then((data) => {
        if (!active) return;
        setSnapshot(data);
        setError(null);
      });
    const settingsRequest = fetch('/api/v1/settings', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Settings request failed (${response.status})`);
        return response.json() as Promise<RuntimeSettings>;
      })
      .then((data) => {
        if (active) setSettings(data);
      });
    const buildInfoRequest = fetch('/api/v1/version', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Version request failed (${response.status})`);
        return response.json() as Promise<BuildInfo>;
      })
      .then((data) => {
        if (active) setBuildInfo(data);
      })
      .catch(() => {
        if (active) setBuildInfo(null);
      });
    void Promise.allSettled([
      snapshotRequest,
      settingsRequest,
      buildInfoRequest,
    ]).then((results) => {
      if (!active || results[0].status !== 'rejected') return;
      const reason: unknown = results[0].reason;
      setError(
        reason instanceof Error ? reason.message : 'Snapshot unavailable',
      );
    });

    const events = new EventSource('/api/v1/events');
    events.onopen = () => {
      failures.current = 0;
      setConnection('live');
      setError(null);
    };
    events.addEventListener('snapshot', (event) => {
      try {
        const next = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as Snapshot;
        setSnapshot(next);
        setConnection('live');
        setError(null);
      } catch {
        setError('A malformed snapshot event was ignored');
      }
    });
    events.addEventListener('settings', (event) => {
      try {
        const next = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as RuntimeSettings;
        setSettings(next);
      } catch {
        setError('A malformed settings event was ignored');
      }
    });
    events.onerror = () => {
      failures.current += 1;
      setConnection(failures.current > 4 ? 'disconnected' : 'reconnecting');
    };
    return () => {
      active = false;
      events.close();
    };
  }, []);

  const history = useCallback(
    async (
      entity: string,
      metrics: string[],
      window = '30m',
    ): Promise<HistorySeries> => {
      const query = new URLSearchParams({
        entity,
        metrics: metrics.join(','),
        window,
      });
      const response = await fetch(`/api/v1/history?${query}`, {
        cache: 'no-store',
      });
      if (!response.ok)
        throw new Error(`History request failed (${response.status})`);
      return response.json() as Promise<HistorySeries>;
    },
    [],
  );

  const updateSamplingInterval = useCallback(
    async (samplingIntervalMs: number): Promise<RuntimeSettings> => {
      const response = await fetch('/api/v1/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ samplingIntervalMs }),
      });
      if (!response.ok) {
        let message = `Sampling update failed (${response.status})`;
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload.error) message = payload.error;
        } catch {
          // Keep the concise status fallback when the response is not JSON.
        }
        throw new Error(message);
      }
      const next = (await response.json()) as RuntimeSettings;
      setSettings(next);
      return next;
    },
    [],
  );

  return {
    snapshot,
    connection,
    error,
    history,
    settings,
    buildInfo,
    updateSamplingInterval,
  };
}
