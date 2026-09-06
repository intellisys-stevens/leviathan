import { memo } from 'react';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { Boxes, ChevronDown, UserRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  attributionProviderLabel,
  attributedWorkloads,
  workloadLabel,
  type AttributionTarget,
} from '../attribution';
import type { Attribution } from '../types';

function observedLabel(observedAt: string | undefined): string | null {
  if (!observedAt) return null;
  const timestamp = new Date(observedAt);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toLocaleString();
}

export function WorkspaceBadges({
  attribution,
  targets,
  limit = 2,
  showUnassigned = false,
}: {
  attribution?: Attribution;
  targets: readonly AttributionTarget[];
  limit?: number;
  showUnassigned?: boolean;
}) {
  if (!attribution) return null;
  if (attribution.status !== 'available') return null;
  const attributed = attributedWorkloads(attribution, targets);
  if (attributed.length === 0) {
    return showUnassigned ? (
      <Badge
        variant="outline"
        className="rounded border-border font-mono text-[13px] text-muted-foreground"
      >
        {attribution.resolution?.status === 'complete'
          ? 'Unassigned'
          : 'Assignment unknown'}
      </Badge>
    ) : null;
  }
  const visible = attributed.slice(0, limit);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {visible.map(({ workload, state }) => (
        <Badge
          key={workload.ref}
          variant="outline"
          title={`${workloadLabel(workload)} · ${state}`}
          className="max-w-52 rounded border-border bg-muted/45 font-mono text-[13px] text-foreground"
        >
          <span className="truncate">{workloadLabel(workload)}</span>
        </Badge>
      ))}
      {attributed.length > visible.length ? (
        <Badge
          variant="outline"
          className="rounded border-border font-mono text-[13px] text-muted-foreground"
        >
          +{attributed.length - visible.length}
        </Badge>
      ) : null}
    </span>
  );
}

function AttributionSummaryComponent({
  attribution,
}: {
  attribution?: Attribution;
}) {
  const observed = observedLabel(attribution?.observedAt);
  const state = !attribution
    ? 'Not configured'
    : attribution.status === 'available'
      ? attribution.resolution?.status === 'complete'
        ? 'Connected'
        : 'Incomplete'
      : attribution.status === 'stale'
        ? 'Stale'
        : 'Unavailable';
  const healthy =
    attribution?.status === 'available' &&
    attribution.resolution?.status === 'complete';
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        className="assignment-status"
        data-state={
          healthy ? 'connected' : attribution ? 'warning' : 'disabled'
        }
        aria-label={`Assignment integration: ${state}`}
      >
        <span>
          <Boxes className="size-4 shrink-0" aria-hidden="true" />
          <span>Assignments</span>
        </span>
        <span>
          <span className="assignment-status-dot" aria-hidden="true" />
          <span>{state}</span>
          <ChevronDown
            className="motion-chevron size-3.5 shrink-0 group-data-[popup-open]:rotate-180"
            aria-hidden="true"
          />
        </span>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          side="bottom"
          align="end"
          sideOffset={8}
          className="z-50"
        >
          <PopoverPrimitive.Popup className="motion-popover w-[min(23rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl outline-none">
            <PopoverPrimitive.Title className="text-sm font-semibold">
              {attribution
                ? attributionProviderLabel(attribution.provider)
                : 'Workspace attribution'}
            </PopoverPrimitive.Title>
            <PopoverPrimitive.Description className="mt-2 text-sm text-muted-foreground">
              {attribution
                ? attribution.resolution?.status === 'complete'
                  ? 'Assignments describe scheduler intent. Resource activity is shown separately.'
                  : `${attribution.resolution?.unresolvedAssignments || 'Some'} allocation${attribution.resolution?.unresolvedAssignments === 1 ? '' : 's'} pending verification. Unmatched resources have unknown assignment status.`
                : 'No workspace assignment provider is configured.'}
            </PopoverPrimitive.Description>
            {observed ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Last observed{' '}
                <time dateTime={attribution?.observedAt}>{observed}</time>
              </p>
            ) : null}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export const AttributionSummary = memo(AttributionSummaryComponent);

export function AttributionDetails({
  attribution,
  targets,
}: {
  attribution?: Attribution;
  targets: readonly AttributionTarget[];
}) {
  if (!attribution || attribution.status !== 'available') return null;
  const attributed = attributedWorkloads(attribution, targets);
  const observed = observedLabel(attribution.observedAt);
  const provider = attributionProviderLabel(attribution.provider);
  return (
    <section aria-labelledby="workspace-attribution-title">
      <h3
        id="workspace-attribution-title"
        className="mb-2 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
      >
        <UserRound className="size-3.5" /> Workspace attribution
      </h3>
      <div className="border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-3 py-2 font-mono text-[13px] text-muted-foreground">
          <span>
            <span className="block">{provider}</span>
            {observed ? (
              <time
                className="mt-0.5 block text-[13px]"
                dateTime={attribution.observedAt}
              >
                Observed {observed}
              </time>
            ) : null}
          </span>
        </div>
        {attributed.length === 0 ? (
          <p className="p-3 text-[13px] text-muted-foreground">
            {attribution.resolution?.status === 'complete'
              ? 'No workspace assignment reported for this resource.'
              : 'Assignment unknown. Allocation verification is incomplete.'}
          </p>
        ) : (
          <ul className="divide-y divide-border/70">
            {attributed.map(({ workload, state }) => (
              <li
                key={workload.ref}
                className="flex flex-wrap items-start justify-between gap-3 p-3"
              >
                <div className="min-w-0 flex-1 basis-40">
                  <p className="break-words text-sm font-medium">
                    {workloadLabel(workload)}
                  </p>
                  <p className="mt-0.5 font-mono text-[13px] text-muted-foreground">
                    {workload.platform} · {workload.kind}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className="shrink-0 rounded border-border bg-muted/45 font-mono text-[13px] text-muted-foreground"
                >
                  {state}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
