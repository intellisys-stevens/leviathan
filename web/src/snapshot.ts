import type {
  Attribution,
  Capabilities,
  Diagnostic,
  Process,
  Snapshot,
} from './types';

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
  | 'workloadTelemetry'
  | 'capabilities'
> & {
  system?: Snapshot['system'] | null;
  gpus?: Snapshot['gpus'] | null;
  processes?: Snapshot['processes'] | null;
  diagnostics?: Snapshot['diagnostics'] | null;
  attribution?: NullableAttribution | null;
  workloadTelemetry?: Snapshot['workloadTelemetry'] | null;
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
    workloadTelemetry:
      payload.workloadTelemetry == null
        ? undefined
        : {
            ...payload.workloadTelemetry,
            owners: arrayOrEmpty(payload.workloadTelemetry.owners).map(
              (owner) => ({
                ...owner,
                workspaces: arrayOrEmpty(owner.workspaces),
                metrics: owner.metrics ?? {},
              }),
            ),
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
    JSON.stringify(left.resolution) === JSON.stringify(right.resolution) &&
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
    // Owner counters arrive independently every two seconds. Keep their exact
    // timestamps/status, but do not resubmit the same sample on every host tick.
    workloadTelemetry:
      JSON.stringify(previous.workloadTelemetry) ===
      JSON.stringify(next.workloadTelemetry)
        ? previous.workloadTelemetry
        : next.workloadTelemetry,
  };
}
