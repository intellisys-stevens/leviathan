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

export type SnapshotPayload = Omit<
  Snapshot,
  'gpus' | 'processes' | 'diagnostics' | 'attribution'
> & {
  gpus?: Snapshot['gpus'] | null;
  processes?: Snapshot['processes'] | null;
  diagnostics?: Snapshot['diagnostics'] | null;
  attribution?: NullableAttribution | null;
};

function arrayOrEmpty<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

// Treat collection fields from the wire as untrusted even though OpenAPI marks
// them as required arrays. Older or partially initialized servers may encode an
// empty Go slice as null; normalizing at the boundary keeps rendering safe.
export function normalizeSnapshot(payload: SnapshotPayload): Snapshot {
  const attribution = payload.attribution;
  return {
    ...payload,
    gpus: arrayOrEmpty(payload.gpus),
    processes: arrayOrEmpty(payload.processes),
    diagnostics: arrayOrEmpty(payload.diagnostics),
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
  const providers = ['nvml', 'gpm', 'dcgm', 'proc'] as const;
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

export function useLeviathan() {
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
        return response.json() as Promise<SnapshotPayload>;
      })
      .then((data) => {
        if (!active) return;
        const next = normalizeSnapshot(data);
        setSnapshot((current) => shareStableSnapshot(current, next));
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
        const payload = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as SnapshotPayload;
        const next = normalizeSnapshot(payload);
        setSnapshot((current) => shareStableSnapshot(current, next));
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
    alignedHistory,
    settings,
    buildInfo,
    updateSamplingInterval,
  };
}
