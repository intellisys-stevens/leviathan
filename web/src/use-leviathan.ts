import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAlignedHistory } from './aligned-history-request';
import {
  normalizeSnapshot,
  shareStableSnapshot,
  type SnapshotPayload,
} from './snapshot';
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

export function useLeviathan(displayCadenceMs = 0) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null | undefined>(
    undefined,
  );
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [snapshotRetry, setSnapshotRetry] = useState(0);
  const [settingsRetry, setSettingsRetry] = useState(0);
  const failures = useRef(0);
  const snapshotEventGeneration = useRef(0);
  const settingsEventGeneration = useRef(0);
  const streamEpochRef = useRef(0);
  const snapshotRef = useRef<Snapshot | null>(null);
  const pendingSnapshotRef = useRef<{
    snapshot: Snapshot;
    streamEpoch?: number;
  } | null>(null);
  const snapshotCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const displayCadenceRef = useRef(displayCadenceMs);
  const samplingIntervalRef = useRef(0);
  const streamExpiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastSnapshotCommitRef = useRef(0);

  useEffect(() => {
    samplingIntervalRef.current = settings?.samplingIntervalMs ?? 0;
  }, [settings?.samplingIntervalMs]);

  const clearStreamExpiry = useCallback(() => {
    if (streamExpiryTimerRef.current != null)
      clearTimeout(streamExpiryTimerRef.current);
    streamExpiryTimerRef.current = null;
  }, []);

  const armStreamExpiry = useCallback(() => {
    clearStreamExpiry();
    const epoch = streamEpochRef.current;
    const intervals = [samplingIntervalRef.current, displayCadenceRef.current];
    const timeout = Math.max(
      5000,
      ...intervals.map((interval) =>
        Number.isFinite(interval) ? interval * 3 : 0,
      ),
    );
    const deadline = performance.now() + timeout;
    const expire = () => {
      streamExpiryTimerRef.current = null;
      if (epoch !== streamEpochRef.current) return;
      const remaining = deadline - performance.now();
      if (remaining > 0) {
        streamExpiryTimerRef.current = setTimeout(expire, remaining);
        return;
      }
      streamEpochRef.current += 1;
      setConnection('reconnecting');
      setStreamError('Telemetry delayed. Waiting for a fresh sample.');
    };
    streamExpiryTimerRef.current = setTimeout(expire, timeout);
  }, [clearStreamExpiry]);

  const commitSnapshot = useCallback((next: Snapshot, streamEpoch?: number) => {
    const current = snapshotRef.current;
    if (current && next.sequence <= current.sequence) return;
    const shared = shareStableSnapshot(current, next);
    snapshotRef.current = shared;
    lastSnapshotCommitRef.current = Date.now();
    setSnapshot(shared);
    // Socket open is insufficient: only the fresh sample now on screen can
    // restore live activity. Errors also invalidate samples waiting on cadence.
    if (streamEpoch !== undefined && streamEpoch === streamEpochRef.current) {
      setConnection('live');
      setSnapshotError(null);
      setStreamError(null);
    }
  }, []);

  const flushPendingSnapshot = useCallback(() => {
    snapshotCommitTimerRef.current = null;
    const pending = pendingSnapshotRef.current;
    pendingSnapshotRef.current = null;
    if (pending) commitSnapshot(pending.snapshot, pending.streamEpoch);
  }, [commitSnapshot]);

  const queueSnapshot = useCallback(
    (next: Snapshot, streamEpoch?: number) => {
      const current =
        pendingSnapshotRef.current?.snapshot ?? snapshotRef.current;
      if (current && next.sequence <= current.sequence) return false;
      const cadence = displayCadenceRef.current;
      if (cadence <= 0 || snapshotRef.current == null) {
        pendingSnapshotRef.current = null;
        if (snapshotCommitTimerRef.current != null) {
          clearTimeout(snapshotCommitTimerRef.current);
          snapshotCommitTimerRef.current = null;
        }
        commitSnapshot(next, streamEpoch);
        return true;
      }
      pendingSnapshotRef.current = { snapshot: next, streamEpoch };
      if (snapshotCommitTimerRef.current != null) return true;
      const elapsed = Date.now() - lastSnapshotCommitRef.current;
      snapshotCommitTimerRef.current = setTimeout(
        flushPendingSnapshot,
        Math.max(0, cadence - elapsed),
      );
      return true;
    },
    [commitSnapshot, flushPendingSnapshot],
  );

  useEffect(() => {
    displayCadenceRef.current = displayCadenceMs;
    if (pendingSnapshotRef.current == null) return;
    if (snapshotCommitTimerRef.current != null) {
      clearTimeout(snapshotCommitTimerRef.current);
      snapshotCommitTimerRef.current = null;
    }
    if (displayCadenceMs <= 0) {
      flushPendingSnapshot();
      return;
    }
    const elapsed = Date.now() - lastSnapshotCommitRef.current;
    snapshotCommitTimerRef.current = setTimeout(
      flushPendingSnapshot,
      Math.max(0, displayCadenceMs - elapsed),
    );
  }, [displayCadenceMs, flushPendingSnapshot]);

  useEffect(
    () => () => {
      if (snapshotCommitTimerRef.current != null)
        clearTimeout(snapshotCommitTimerRef.current);
      clearStreamExpiry();
    },
    [clearStreamExpiry],
  );

  useEffect(() => {
    let active = true;
    const eventGeneration = snapshotEventGeneration.current;
    void fetch('/api/v1/snapshot', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Snapshot request failed (${response.status})`);
        return response.json() as Promise<SnapshotPayload>;
      })
      .then((data) => {
        if (!active || eventGeneration !== snapshotEventGeneration.current)
          return;
        const next = normalizeSnapshot(data);
        queueSnapshot(next);
        setSnapshotError(null);
      })
      .catch((reason: unknown) => {
        if (!active || eventGeneration !== snapshotEventGeneration.current)
          return;
        setSnapshotError(
          reason instanceof Error ? reason.message : 'Snapshot unavailable',
        );
      });
    return () => {
      active = false;
    };
  }, [queueSnapshot, snapshotRetry]);

  useEffect(() => {
    let active = true;
    const eventGeneration = settingsEventGeneration.current;
    void fetch('/api/v1/settings', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Settings request failed (${response.status})`);
        return response.json() as Promise<RuntimeSettings>;
      })
      .then((data) => {
        if (!active || eventGeneration !== settingsEventGeneration.current)
          return;
        setSettings(data);
        setSettingsError(null);
      })
      .catch((reason: unknown) => {
        if (!active || eventGeneration !== settingsEventGeneration.current)
          return;
        setSettingsError(
          reason instanceof Error ? reason.message : 'Settings unavailable',
        );
      });
    return () => {
      active = false;
    };
  }, [settingsRetry]);

  useEffect(() => {
    let active = true;
    void fetch('/api/v1/version', { cache: 'no-store' })
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
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const events = new EventSource('/api/v1/events');
    events.onopen = () => {
      clearStreamExpiry();
      streamEpochRef.current += 1;
      failures.current = 0;
      setConnection((previous) =>
        previous === 'connecting' ? 'connecting' : 'reconnecting',
      );
      setStreamError(
        snapshotRef.current
          ? 'Stream connected. Waiting for fresh telemetry.'
          : null,
      );
    };
    events.addEventListener('snapshot', (event) => {
      try {
        const payload = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as SnapshotPayload;
        const next = normalizeSnapshot(payload);
        if (
          !Number.isSafeInteger(next.sequence) ||
          next.sequence < 0 ||
          !Number.isFinite(Date.parse(next.sampledAt))
        )
          throw new Error('Invalid snapshot metadata');
        if (queueSnapshot(next, streamEpochRef.current)) {
          snapshotEventGeneration.current += 1;
          armStreamExpiry();
        }
      } catch {
        clearStreamExpiry();
        streamEpochRef.current += 1;
        setConnection(snapshotRef.current ? 'reconnecting' : 'connecting');
        setStreamError('A malformed snapshot event was ignored.');
      }
    });
    events.addEventListener('settings', (event) => {
      try {
        const next = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as RuntimeSettings;
        settingsEventGeneration.current += 1;
        setSettings(next);
        setSettingsError(null);
        setStreamError(null);
      } catch {
        setStreamError('A malformed settings event was ignored.');
      }
    });
    events.onerror = () => {
      clearStreamExpiry();
      streamEpochRef.current += 1;
      failures.current += 1;
      setConnection(failures.current > 4 ? 'disconnected' : 'reconnecting');
      setStreamError('The live stream was interrupted. Reconnecting…');
    };
    return () => {
      events.close();
    };
  }, [queueSnapshot, armStreamExpiry, clearStreamExpiry]);

  const retrySnapshot = useCallback(() => {
    setSnapshotError(null);
    setSnapshotRetry((value) => value + 1);
  }, []);

  const retrySettings = useCallback(() => {
    setSettingsError(null);
    setSettingsRetry((value) => value + 1);
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
        maxPoints: '720',
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

  return {
    snapshot,
    connection,
    snapshotError,
    streamError,
    settingsError,
    retrySnapshot,
    retrySettings,
    history,
    alignedHistory: fetchAlignedHistory,
    settings,
    buildInfo,
  };
}
