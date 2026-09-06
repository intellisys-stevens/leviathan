import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { Activity, Clock3, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { components } from '../api.gen';
import type { Snapshot } from '../types';
import './health-status.css';

type HealthStatus = components['schemas']['HealthStatus'];
type Counts = components['schemas']['HealthCounts'];
type HealthDay = HealthStatus['days'][number];
type DisplayComponent = Omit<HealthStatus['components'][number], 'id'> & {
  id: string;
  message?: string;
  lastAcknowledgedAt?: string;
  retryAt?: string;
};
const stateLabels: Record<string, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  unavailable: 'Unavailable',
  unsupported: 'No data',
  unknown: 'No data',
};
const states = [
  'operational',
  'degraded',
  'unavailable',
  'unsupported',
  'unknown',
] as const;
const visibleStates = ['operational', 'degraded', 'unavailable', 'unknown'];
const statusComponents = [
  { id: 'uplink', label: 'Yggdrasil connection' },
  { id: 'system', label: 'Host telemetry' },
  { id: 'gpu', label: 'GPU telemetry' },
];
const emptyCounts = (expected = 0): Counts => ({
  operational: 0,
  degraded: 0,
  unavailable: 0,
  unsupported: 0,
  unknown: expected,
});

export function observationSummary(counts: Counts, expected: number) {
  const known = counts.operational + counts.degraded + counts.unavailable;
  return {
    healthy: known > 0 ? (counts.operational / known) * 100 : null,
    coverage:
      expected > 0
        ? Math.max(0, Math.min(100, (known / expected) * 100))
        : null,
  };
}

export function observationDayState(counts: Counts) {
  if (counts.unavailable > 0) return 'unavailable';
  if (counts.degraded > 0) return 'degraded';
  if (counts.operational > 0) return 'operational';
  return 'unknown';
}

export function elapsedLabel(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  return days > 0
    ? `${days}d ${hours % 24}h`
    : hours > 0
      ? `${hours}h ${minutes % 60}m`
      : `${minutes}m`;
}

function percentLabel(value: number | null) {
  if (value == null) return '—';
  if (value > 0 && value < 0.1) return '<0.1%';
  if (value < 100 && value > 99.9) return '>99.9%';
  return `${Number(value.toFixed(1))}%`;
}

export function overallHealth(components: HealthStatus['components']): string {
  const applicable = components.filter(
    ({ id, state }) =>
      statusComponents.some((component) => component.id === id) &&
      state !== 'unsupported' &&
      state !== 'unknown',
  );
  const usable = applicable.some(
    ({ state }) => state === 'operational' || state === 'degraded',
  );
  if (usable)
    return applicable.every(({ state }) => state === 'operational')
      ? 'operational'
      : 'degraded';
  return applicable.some(({ state }) => state === 'unavailable')
    ? 'unavailable'
    : 'unknown';
}

function dateLabel(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

const dayColumnWidth = 8; // 5px bar and 3px horizontal gap.
const timelineRowHeight = 44;

export function timelineColumns(width: number, days: number): number {
  return Math.max(1, Math.min(days, Math.round((width + 3) / dayColumnWidth)));
}

export function timelineIndexAtPosition(
  x: number,
  y: number,
  width: number,
  days: number,
): number {
  const columns = timelineColumns(width, days);
  const column = Math.max(
    0,
    Math.min(columns - 1, Math.round((x - 2.5) / dayColumnWidth)),
  );
  const row = Math.max(
    0,
    Math.min(Math.ceil(days / columns) - 1, Math.floor(y / timelineRowHeight)),
  );
  return Math.min(days - 1, row * columns + column);
}

function HealthTimeline({
  component,
  days,
}: {
  component: DisplayComponent;
  days: HealthDay[];
}) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const controlRef = useRef<HTMLInputElement>(null);
  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    cancelled: boolean;
  } | null>(null);
  const descriptionId = useId();
  const selectedIndex = selectedDate
    ? days.findIndex(({ date }) => date === selectedDate)
    : -1;
  const index =
    selectedIndex < 0 ? Math.max(0, days.length - 1) : selectedIndex;
  const selected = days[index];
  if (!selected) return null;
  const counts =
    selected.components[component.id] ?? emptyCounts(selected.expectedSamples);
  const summary = observationSummary(counts, selected.expectedSamples);
  const description = `${selected.date}: ${stateLabels[observationDayState(counts)]}; ${percentLabel(summary.coverage)} coverage`;
  const selectAt = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const next = timelineIndexAtPosition(
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      bounds.width,
      days.length,
    );
    setSelectedDate(days[next].date);
    setInspecting(true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const columns = timelineColumns(
      event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0,
      days.length,
    );
    let next = index;
    switch (event.key) {
      case 'ArrowLeft':
        next = Math.max(0, index - 1);
        break;
      case 'ArrowRight':
        next = Math.min(days.length - 1, index + 1);
        break;
      case 'ArrowUp':
        next = Math.max(0, index - columns);
        break;
      case 'ArrowDown':
        next = Math.min(days.length - 1, index + columns);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = days.length - 1;
        break;
      case 'Escape':
        setInspecting(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    setSelectedDate(days[next].date);
    setInspecting(true);
  };
  return (
    <div className="health-timeline-wrapper">
      <div
        className="health-timeline"
        style={
          {
            '--health-days': days.length,
            '--health-columns': Math.min(30, days.length),
          } as CSSProperties
        }
        onPointerMove={(event) => {
          if (
            gesture.current &&
            Math.hypot(
              event.clientX - gesture.current.x,
              event.clientY - gesture.current.y,
            ) > 10
          ) {
            gesture.current.cancelled = true;
          }
          if (event.pointerType === 'mouse' && event.buttons === 0)
            selectAt(event);
        }}
        onPointerLeave={() => {
          gesture.current = null;
          if (document.activeElement !== controlRef.current)
            setInspecting(false);
        }}
        onPointerDown={(event) => {
          if (gesture.current) {
            gesture.current.cancelled = true;
            return;
          }
          gesture.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            cancelled: false,
          };
        }}
        onPointerUp={(event) => {
          const down = gesture.current;
          gesture.current = null;
          if (
            !down ||
            down.id !== event.pointerId ||
            down.cancelled ||
            Math.hypot(event.clientX - down.x, event.clientY - down.y) > 10
          )
            return;
          selectAt(event);
          controlRef.current?.focus({ preventScroll: true });
        }}
        onPointerCancel={() => {
          gesture.current = null;
        }}
      >
        <input
          ref={controlRef}
          className="health-timeline-control"
          type="range"
          min={1}
          max={days.length}
          step={1}
          value={index + 1}
          aria-label={`${component.label} daily history`}
          aria-valuetext={description}
          aria-describedby={descriptionId}
          onChange={(event) => {
            const next = Math.max(
              0,
              Math.min(days.length - 1, Number(event.target.value) - 1),
            );
            setSelectedDate(days[next].date);
            setInspecting(true);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setInspecting(true)}
          onBlur={() => setInspecting(false)}
        />
        {days.map((bucket) => {
          const dayCounts =
            bucket.components[component.id] ??
            emptyCounts(bucket.expectedSamples);
          const measured =
            dayCounts.operational + dayCounts.degraded + dayCounts.unavailable;
          return (
            <span
              key={bucket.date}
              className="health-day"
              data-state={observationDayState(dayCounts)}
              data-partial={measured > 0 && measured < bucket.expectedSamples}
              data-selected={inspecting && bucket.date === selected.date}
              aria-hidden="true"
            />
          );
        })}
      </div>
      <span id={descriptionId} className="sr-only">
        Left and right inspect one day; up and down move one row. Home selects
        the earliest day and End the latest. Dates use UTC.
      </span>
      {inspecting ? (
        <output className="health-day-tooltip">{description}</output>
      ) : null}
      <div className="health-timeline-dates" aria-hidden="true">
        <span>{dateLabel(days[0].date)}</span>
        <span>{dateLabel(days[days.length - 1].date)}</span>
      </div>
    </div>
  );
}

export function HealthStatusPanel({ snapshot }: { snapshot: Snapshot | null }) {
  const [report, setReport] = useState<HealthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (document.hidden) return;
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      let timedOut = false;
      const deadline = window.setTimeout(() => {
        timedOut = true;
        requestController.abort();
      }, 10_000);
      try {
        const response = await fetch('/api/v1/status', {
          cache: 'no-store',
          signal: requestController.signal,
        });
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? 'Status history requires an updated Leviathan server.'
              : 'Status history could not be refreshed.',
          );
        const data = (await response.json()) as HealthStatus;
        if (!active || controller !== requestController) return;
        setReport(data);
        setError(null);
      } catch (cause) {
        if (!active || (requestController.signal.aborted && !timedOut)) return;
        setError(
          timedOut
            ? 'Status history request timed out.'
            : cause instanceof Error
              ? cause.message
              : 'Status history is unavailable.',
        );
      } finally {
        window.clearTimeout(deadline);
      }
    };
    refreshRef.current = () => {
      void refresh();
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 15_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      refreshRef.current = () => undefined;
    };
  }, []);
  const uptime = snapshot?.system.uptime;
  const hostSeconds =
    uptime && (uptime.status === 'available' || uptime.status === 'estimated')
      ? uptime.value
      : null;
  const startedAt = report?.monitorStartedAt;
  const persistenceMessage =
    report?.persistence.message ||
    (report?.persistence.enabled && !report.persistence.saving
      ? 'History is not being saved.'
      : null);
  const currentState =
    error || !report ? 'unknown' : overallHealth(report.components);
  return (
    <section
      className="health-status space-y-4"
      aria-labelledby="health-status-heading"
    >
      <div className="health-overview frost-panel">
        <div className="health-current">
          <Activity className="size-5 text-primary" aria-hidden="true" />
          <div>
            <h2 id="health-status-heading" className="section-title">
              Current status
            </h2>
            <p className="health-state" data-state={currentState}>
              {stateLabels[currentState]}
            </p>
          </div>
        </div>
        <dl className="health-uptimes">
          <div>
            <dt>
              <Clock3 className="size-4" aria-hidden="true" /> Host uptime
            </dt>
            <dd>{elapsedLabel(hostSeconds)}</dd>
          </div>
          <div>
            <dt>Monitor runtime</dt>
            <dd>
              {elapsedLabel(report?.monitorUptimeSeconds)}
              {startedAt ? (
                <time dateTime={startedAt}>
                  Since {new Date(startedAt).toLocaleString()}
                </time>
              ) : null}
            </dd>
          </div>
        </dl>
      </div>
      {error ? (
        <div className="health-notice">
          <output>
            {error}
            {report
              ? ` Last report: ${new Date(report.sampledAt).toLocaleString()}.`
              : ''}
          </output>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refreshRef.current()}
          >
            <RefreshCw aria-hidden="true" />
            Retry
          </Button>
        </div>
      ) : null}
      {persistenceMessage ? (
        <output className="health-notice">{persistenceMessage}</output>
      ) : null}
      {!report && !error ? (
        <output className="block p-4 text-sm text-muted-foreground">
          Loading status history…
        </output>
      ) : null}
      {report ? (
        <section
          className="frost-panel health-history"
          aria-labelledby="health-history-heading"
        >
          <div className="health-history-heading">
            <h3 id="health-history-heading" className="section-title">
              {report.retentionDays}-day history
            </h3>
            <p>
              Sampled once per minute; gaps stay unobserved.
              {!report.persistence.enabled
                ? ' History is in memory for this session.'
                : ''}
            </p>
          </div>
          <div className="health-components">
            {statusComponents.map((identity) => {
              const component: DisplayComponent = report.components.find(
                ({ id }) => id === identity.id,
              ) ?? { ...identity, state: 'unknown' };
              const total = emptyCounts();
              let expected = 0;
              for (const bucket of report.days) {
                const counts =
                  bucket.components[component.id] ??
                  emptyCounts(bucket.expectedSamples);
                expected += bucket.expectedSamples;
                for (const state of states) total[state] += counts[state];
              }
              const summary = observationSummary(total, expected);
              return (
                <article key={component.id} className="health-component">
                  <div className="health-component-info">
                    <div className="health-component-heading">
                      <h4>{identity.label}</h4>
                      <span
                        className="health-state"
                        data-state={error ? 'unknown' : component.state}
                      >
                        {stateLabels[error ? 'unknown' : component.state]}
                      </span>
                    </div>
                    <div className="health-statistics">
                      <span>
                        <strong>{percentLabel(summary.healthy)}</strong> healthy
                        observations
                      </span>
                      <span>
                        <strong>{percentLabel(summary.coverage)}</strong>{' '}
                        coverage
                      </span>
                    </div>
                    {component.message ? (
                      <p className="health-component-context">
                        {component.message}
                      </p>
                    ) : null}
                    {component.lastAcknowledgedAt || component.retryAt ? (
                      <p className="health-component-context">
                        {component.lastAcknowledgedAt ? (
                          <span>
                            Acknowledged{' '}
                            <time dateTime={component.lastAcknowledgedAt}>
                              {new Date(
                                component.lastAcknowledgedAt,
                              ).toLocaleString()}
                            </time>
                          </span>
                        ) : null}
                        {component.retryAt ? (
                          <span>
                            Next attempt{' '}
                            <time dateTime={component.retryAt}>
                              {new Date(component.retryAt).toLocaleTimeString()}
                            </time>
                          </span>
                        ) : null}
                      </p>
                    ) : null}
                  </div>
                  <HealthTimeline component={component} days={report.days} />
                </article>
              );
            })}
          </div>
          <div className="health-legend" aria-label="History legend">
            {visibleStates.map((state) => (
              <span key={state}>
                <i data-state={state} aria-hidden="true" />
                {stateLabels[state]}
              </span>
            ))}
            <span>
              <i data-partial="true" aria-hidden="true" />
              Partial coverage
            </span>
          </div>
        </section>
      ) : null}
    </section>
  );
}
