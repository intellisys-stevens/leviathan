import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AlignedHistory,
  AlignedHistoryRequest,
  Attribution,
  BuildInfo,
  Capabilities,
  Diagnostic,
  HistorySeries,
  Process,
  RuntimeSettings,
  Snapshot,
} from './types';

export type ConnectionState =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'disconnected';

type NullableAttribution = Omit<Attribution, 'workloads' | 'assignments'> & {
  workloads?: Attribution['workloads'] | null;
  assignments?: Attribution['assignments'] | null;
};

type LegacyCapabilities = Omit<Capabilities, 'system'> & {
  system?: Capabilities['system'] | null;
};

export type SnapshotPayload = Omit<
  Snapshot,
  | 'system'
  | 'gpus'
  | 'processes'
  | 'diagnostics'
  | 'attribution'
  | 'capabilities'
> & {
  system?: Snapshot['system'] | null;
  gpus?: Snapshot['gpus'] | null;
  processes?: Snapshot['processes'] | null;
  diagnostics?: Snapshot['diagnostics'] | null;
  attribution?: NullableAttribution | null;
  capabilities: LegacyCapabilities;
};

function arrayOrEmpty<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

// Treat collection fields from the wire as untrusted even though OpenAPI marks
// them as required arrays. Older or partially initialized servers may encode an
// empty Go slice as null; normalizing at the boundary keeps rendering safe.
export function normalizeSnapshot(payload: SnapshotPayload): Snapshot {
  const attribution = payload.attribution;
  const legacySystem = {
    name: 'Linux host telemetry',
    available: false,
    status: 'unsupported' as const,
    message: 'This server predates whole-machine telemetry.',
  };
  const unavailableMetric = (unit: string) => ({
    value: null,
    unit,
    source: 'procfs' as const,
    scope: 'host' as const,
    sampledAt: payload.sampledAt,
    status: 'unsupported' as const,
    message: legacySystem.message,
  });
  const system =
    payload.system ??
    ({
      cpu: {
        model: '',
        logicalProcessors: 0,
        utilization: unavailableMetric('percent'),
        load1: unavailableMetric('load'),
        load5: unavailableMetric('load'),
        load15: unavailableMetric('load'),
        source: 'procfs',
        sampledAt: payload.sampledAt,
        status: 'unsupported',
        message: legacySystem.message,
      },
      memory: {
        totalBytes: null,
        usedBytes: null,
        availableBytes: null,
        utilization: unavailableMetric('percent'),
        source: 'procfs',
        scope: 'host',
        sampledAt: payload.sampledAt,
        status: 'unsupported',
        message: legacySystem.message,
      },
      storage: {
        totalBytes: null,
        usedBytes: null,
        availableBytes: null,
        readBytesPerSecond: unavailableMetric('bytes_per_second'),
        writeBytesPerSecond: unavailableMetric('bytes_per_second'),
        filesystems: [],
        source: 'statfs',
        scope: 'host',
        sampledAt: payload.sampledAt,
        status: 'unsupported',
        message: legacySystem.message,
      },
      sampledAt: payload.sampledAt,
      status: 'unsupported',
      message: legacySystem.message,
    } satisfies Snapshot['system']);
  return {
    ...payload,
    system: {
      ...system,
      storage: {
        ...system.storage,
        filesystems: arrayOrEmpty(system.storage.filesystems),
      },
    },
    gpus: arrayOrEmpty(payload.gpus),
    processes: arrayOrEmpty(payload.processes),
    diagnostics: arrayOrEmpty(payload.diagnostics),
    capabilities: {
      ...payload.capabilities,
      system: payload.capabilities.system ?? legacySystem,
    },
    attribution:
      attribution == null
        ? undefined
        : {
            ...attribution,
            workloads: arrayOrEmpty(attribution.workloads),
            assignments: arrayOrEmpty(attribution.assignments),
          },
  };
}

function sameArray<T>(
  left: readonly T[],
  right: readonly T[],
  equal: (left: T, right: T) => boolean,
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => equal(value, right[index]))
  );
}

function sameProcess(left: Process, right: Process): boolean {
  return (
    left.pid === right.pid &&
    left.user === right.user &&
    left.executable === right.executable &&
    left.commandLine === right.commandLine &&
    left.startTime === right.startTime &&
    left.workloadRef === right.workloadRef &&
    left.status === right.status &&
    left.message === right.message
  );
}

function sameDiagnostic(left: Diagnostic, right: Diagnostic): boolean {
  return (
    left.code === right.code &&
    left.severity === right.severity &&
    left.component === right.component &&
    left.summary === right.summary &&
    left.detail === right.detail &&
    left.remedy === right.remedy &&
    left.status === right.status
  );
}

function sameCapabilities(left: Capabilities, right: Capabilities): boolean {
  const providers = ['system', 'nvml', 'gpm', 'dcgm', 'proc'] as const;
  return (
    left.profileMetrics === right.profileMetrics &&
    providers.every((name) => {
      const current = left[name];
      const next = right[name];
      return (
        current.name === next.name &&
        current.available === next.available &&
        current.status === next.status &&
        current.message === next.message
      );
    })
  );
}

function sameAttribution(
  left: Attribution | undefined,
  right: Attribution | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.provider === right.provider &&
    left.status === right.status &&
    left.observedAt === right.observedAt &&
    sameArray(
      left.workloads,
      right.workloads,
      (current, next) =>
        current.ref === next.ref &&
        current.platform === next.platform &&
        current.kind === next.kind &&
        current.name === next.name &&
        current.ownerName === next.ownerName,
    ) &&
    sameArray(
      left.assignments,
      right.assignments,
      (current, next) =>
        current.workloadRef === next.workloadRef &&
        current.entityType === next.entityType &&
        current.entityUuid === next.entityUuid &&
        current.state === next.state,
    )
  );
}

// Preserve slow-changing slices across full snapshot SSE events so memoized
// process, diagnostic, capability, and attribution views do not repaint at the
// GPU telemetry cadence.
export function shareStableSnapshot(
  previous: Snapshot | null,
  next: Snapshot,
): Snapshot {
  if (!previous) return next;
  return {
    ...next,
    host:
      previous.host.hostname === next.host.hostname &&
      previous.host.os === next.host.os &&
      previous.host.arch === next.host.arch
        ? previous.host
        : next.host,
    processes: sameArray(previous.processes, next.processes, sameProcess)
      ? previous.processes
      : next.processes,
    diagnostics: sameArray(
      previous.diagnostics,
      next.diagnostics,
      sameDiagnostic,
    )
      ? previous.diagnostics
      : next.diagnostics,
    capabilities: sameCapabilities(previous.capabilities, next.capabilities)
      ? previous.capabilities
      : next.capabilities,
    attribution: sameAttribution(previous.attribution, next.attribution)
      ? previous.attribution
      : next.attribution,
  };
}

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
  const snapshotRef = useRef<Snapshot | null>(null);
  const pendingSnapshotRef = useRef<Snapshot | null>(null);
  const snapshotCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const displayCadenceRef = useRef(displayCadenceMs);
  const lastSnapshotCommitRef = useRef(0);
  const remoteCSRFRef = useRef<string | null>(null);

  const commitSnapshot = useCallback((next: Snapshot) => {
    const current = snapshotRef.current;
    if (current && next.sequence <= current.sequence) return;
    const shared = shareStableSnapshot(current, next);
    snapshotRef.current = shared;
    lastSnapshotCommitRef.current = Date.now();
    setSnapshot(shared);
  }, []);

  const flushPendingSnapshot = useCallback(() => {
    snapshotCommitTimerRef.current = null;
    const pending = pendingSnapshotRef.current;
    pendingSnapshotRef.current = null;
    if (pending) commitSnapshot(pending);
  }, [commitSnapshot]);

  const queueSnapshot = useCallback(
    (next: Snapshot) => {
      const current = pendingSnapshotRef.current ?? snapshotRef.current;
      if (current && next.sequence <= current.sequence) return;
      const cadence = displayCadenceRef.current;
      if (cadence <= 0 || snapshotRef.current == null) {
        pendingSnapshotRef.current = null;
        if (snapshotCommitTimerRef.current != null) {
          clearTimeout(snapshotCommitTimerRef.current);
          snapshotCommitTimerRef.current = null;
        }
        commitSnapshot(next);
        return;
      }
      pendingSnapshotRef.current = next;
      if (snapshotCommitTimerRef.current != null) return;
      const elapsed = Date.now() - lastSnapshotCommitRef.current;
      snapshotCommitTimerRef.current = setTimeout(
        flushPendingSnapshot,
        Math.max(0, cadence - elapsed),
      );
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
    },
    [],
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
        const remoteCSRF = response.headers.get('X-Leviathan-CSRF-Token');
        remoteCSRFRef.current =
          remoteCSRF && remoteCSRF.length <= 128 ? remoteCSRF : null;
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
      failures.current = 0;
      setConnection('live');
      setStreamError(null);
    };
    events.addEventListener('snapshot', (event) => {
      try {
        const payload = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as SnapshotPayload;
        const next = normalizeSnapshot(payload);
        snapshotEventGeneration.current += 1;
        queueSnapshot(next);
        setConnection('live');
        setSnapshotError(null);
        setStreamError(null);
      } catch {
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
      failures.current += 1;
      setConnection(failures.current > 4 ? 'disconnected' : 'reconnecting');
      setStreamError('The live stream was interrupted. Reconnecting…');
    };
    return () => {
      events.close();
    };
  }, [queueSnapshot]);

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

  const alignedHistory = useCallback(
    async (request: AlignedHistoryRequest): Promise<AlignedHistory> => {
      const response = await fetch('/api/v1/history/aligned', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!response.ok)
        throw new Error(`Aligned history request failed (${response.status})`);
      return response.json() as Promise<AlignedHistory>;
    },
    [],
  );

  const updateSamplingInterval = useCallback(
    async (samplingIntervalMs: number): Promise<RuntimeSettings> => {
      const eventGeneration = settingsEventGeneration.current;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (remoteCSRFRef.current)
        headers['X-Leviathan-CSRF-Token'] = remoteCSRFRef.current;
      const response = await fetch('/api/v1/settings', {
        method: 'PATCH',
        headers,
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
      if (eventGeneration === settingsEventGeneration.current)
        setSettings(next);
      return next;
    },
    [],
  );

  return {
    snapshot,
    connection,
    // Keep the compatibility alias while callers move to scoped errors.
    error: snapshot ? streamError : (snapshotError ?? streamError),
    snapshotError,
    streamError,
    settingsError,
    retrySnapshot,
    retrySettings,
    history,
    alignedHistory,
    settings,
    buildInfo,
    updateSamplingInterval,
  };
}
