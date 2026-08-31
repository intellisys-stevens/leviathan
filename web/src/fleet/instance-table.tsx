import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type {
  AgentObservation,
  AgentStatus,
  CloudState,
  InstanceObservation,
  InventoryHealth,
  PolicyReason,
  TelemetryState,
} from './types';
import {
  gpuConnectedUsersLabel,
  processInspectionState,
} from './process-inspection';

const cloudLabels: Record<CloudState, string> = {
  active: 'Running',
  shelved: 'Shelved',
  shelved_offloaded: 'Shelved offloaded',
  shutoff: 'Shut off',
  building: 'Building',
  paused: 'Paused',
  suspended: 'Suspended',
  error: 'Error',
  unknown: 'Unknown',
};

const agentLabels: Record<AgentStatus, string> = {
  not_managed: 'Not monitored',
  not_configured: 'Not configured',
  available: 'Live',
  unreachable: 'Unreachable',
  stale: 'Stale',
  incompatible: 'Incompatible',
};

const sourceLabels: Record<NonNullable<AgentObservation['source']>, string> = {
  leviathan_agent: 'Leviathan agent',
  exosphere_console: 'Exosphere console',
  leviathan_uplink: 'Leviathan uplink',
};

export function observationSourceLabel(agent: AgentObservation): string {
  const source = agent.source ? sourceLabels[agent.source] : undefined;
  if (!source) return agentLabels[agent.status] ?? 'Unknown';
  if (agent.status === 'available') return source;
  if (agent.status === 'stale') return `${source} · stale`;
  return `${source} · ${agentLabels[agent.status] ?? 'Unknown'}`;
}

const policyLabels: Record<PolicyReason, string> = {
  allowed: 'Approved test scope',
  agent_not_configured: 'Approved · agent not configured',
  not_allowlisted: 'Inventory only',
  creator_mismatch: 'Creator mismatch',
  cloud_not_active: 'Not running',
};

function statusClasses(status: string): string {
  if (status === 'available' || status === 'active' || status === 'healthy')
    return 'border-primary/30 bg-primary/10 text-primary';
  if (
    status === 'error' ||
    status === 'unreachable' ||
    status === 'incompatible'
  )
    return 'border-destructive/30 bg-destructive/10 text-destructive';
  return 'border-border bg-muted/50 text-muted-foreground';
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  return (
    <span
      className={`inline-flex h-5 items-center rounded-full border px-2 font-mono text-[10px] font-medium ${statusClasses(status)}`}
    >
      {label}
    </span>
  );
}

export function telemetryState(
  observation: InstanceObservation,
): TelemetryState {
  const snapshot = observation.agent.snapshot;
  if (!snapshot) return 'unavailable';
  if (snapshot.diagnostics.some(({ severity }) => severity === 'error'))
    return 'error';
  if (snapshot.diagnostics.some(({ severity }) => severity === 'warning'))
    return 'degraded';
  return 'healthy';
}

function resourceSummary(observation: InstanceObservation): string {
  const gpus = observation.agent.snapshot?.gpus ?? [];
  const gpuInstances = gpus.reduce(
    (total, gpu) => total + gpu.gpuInstances.length,
    0,
  );
  const computeInstances = gpus.reduce(
    (total, gpu) =>
      total +
      gpu.gpuInstances.reduce(
        (subtotal, instance) => subtotal + instance.computeInstances.length,
        0,
      ),
    0,
  );
  if (!observation.agent.snapshot) return 'Unavailable';
  return `${gpus.length} GPU · ${gpuInstances} GI · ${computeInstances} CI`;
}

export function telemetryLabel(state: TelemetryState): string {
  switch (state) {
    case 'healthy':
      return 'Healthy';
    case 'degraded':
      return 'Degraded';
    case 'error':
      return 'Error';
    default:
      return 'Unavailable';
  }
}

function formatObservedAt(value: string | undefined): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function InstanceTable({
  instances,
  inventory,
}: {
  instances: InstanceObservation[];
  inventory: InventoryHealth;
}) {
  return (
    <section className="mt-6" aria-labelledby="jetstream-instances-heading">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            id="jetstream-instances-heading"
            className="text-sm font-semibold"
          >
            Jetstream instances
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Creator identity and GPU-connected users are reported independently.
          </p>
        </div>
        <Badge variant="outline">
          {instances.length} {instances.length === 1 ? 'instance' : 'instances'}
        </Badge>
      </div>

      {inventory.status !== 'available' ? (
        <div className="mb-3 flex items-start gap-2 border border-amber-500/30 bg-amber-500/[0.06] p-3 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <p>
            Inventory is {inventory.status}. Last successful refresh:{' '}
            <time dateTime={inventory.lastSuccessAt}>
              {formatObservedAt(inventory.lastSuccessAt)}
            </time>
            .
          </p>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {instances.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium">
              No Jetstream instances reported
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              The controller will retain this read-only view while inventory
              refreshes.
            </p>
          </div>
        ) : (
          <Table
            containerClassName="max-h-[34rem]"
            aria-label="Jetstream instances"
          >
            <TableHeader className="bg-muted/45">
              <TableRow>
                <TableHead>Instance</TableHead>
                <TableHead>Creator</TableHead>
                <TableHead>Cloud</TableHead>
                <TableHead>Telemetry source</TableHead>
                <TableHead>Telemetry</TableHead>
                <TableHead>GPU-connected users</TableHead>
                <TableHead>Resources</TableHead>
                <TableHead>Scope</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {instances.map((observation) => {
                const { instance, agent } = observation;
                const users = gpuConnectedUsersLabel(observation);
                const telemetry = telemetryState(observation);
                return (
                  <TableRow
                    key={instance.uuid}
                    data-testid="fleet-instance-row"
                  >
                    <TableCell className="min-w-56 whitespace-normal">
                      <p className="font-medium text-foreground">
                        {instance.name}
                      </p>
                      <p className="mt-0.5 break-all font-mono text-[9px] text-muted-foreground">
                        {instance.uuid}
                      </p>
                      {instance.flavor ? (
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          {instance.flavor}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-56 whitespace-normal break-all font-mono text-xs">
                      {instance.creatorUsername || 'Unknown'}
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        status={instance.cloudState}
                        label={cloudLabels[instance.cloudState] ?? 'Unknown'}
                      />
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        status={agent.status}
                        label={observationSourceLabel(agent)}
                      />
                      <p className="mt-1 text-[9px] text-muted-foreground">
                        <time dateTime={agent.observedAt}>
                          {formatObservedAt(agent.observedAt)}
                        </time>
                      </p>
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        status={telemetry}
                        label={telemetryLabel(telemetry)}
                      />
                      {agent.snapshot &&
                      agent.snapshot.diagnostics.length > 0 ? (
                        <p className="mt-1 text-[9px] text-muted-foreground">
                          {agent.snapshot.diagnostics.length} diagnostics
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-56 whitespace-normal">
                      {users}
                      {processInspectionState(observation) === 'incomplete' ? (
                        <p className="mt-1 text-[9px] text-amber-700 dark:text-amber-300">
                          Partial process coverage
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-[10px]">
                      {resourceSummary(observation)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={observation.managed ? 'secondary' : 'outline'}
                      >
                        {policyLabels[observation.policyReason] ??
                          'Inventory only'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}
