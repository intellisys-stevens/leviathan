import { useEffect, useId, useRef, useState } from 'react';
import { Cpu, Layers3, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatBytes } from '../lib';
import { orderedCapacityRows } from '../gpu-capacity';
import { useGPUCapacity } from '../use-gpu-capacity';
import './gpu-capacity-panel.css';

const stateLabels = {
  available: 'Live',
  partial: 'Partial',
  stale: 'Stale',
  unavailable: 'Unavailable',
  unsupported: 'Unavailable',
  loading: 'Checking',
};

export function GPUCapacityPanel({ hostKey }: { hostKey: string }) {
  const panel = useRef<HTMLElement>(null);
  const headingId = useId();
  const noteId = useId();
  const [visible, setVisible] = useState(
    () => typeof IntersectionObserver === 'undefined',
  );
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    let intersects = typeof IntersectionObserver === 'undefined';
    const update = () =>
      setVisible(
        !document.hidden &&
          (intersects || element.contains(document.activeElement)),
      );
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(([entry]) => {
            intersects = entry.isIntersecting;
            update();
          });
    observer?.observe(element);
    document.addEventListener('visibilitychange', update);
    element.addEventListener('focusin', update);
    element.addEventListener('focusout', update);
    update();
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', update);
      element.removeEventListener('focusin', update);
      element.removeEventListener('focusout', update);
    };
  }, []);

  const capacity = useGPUCapacity(hostKey, visible);
  const state = capacity.error
    ? 'unavailable'
    : capacity.expired
      ? 'stale'
      : (capacity.data?.status ?? 'loading');
  const readable = state === 'available' || state === 'partial';
  const rows = orderedCapacityRows(capacity.data?.rows ?? []);
  const observedAt = capacity.data?.observedAt;
  const message = capacity.error ?? capacity.data?.message;

  return (
    <section
      ref={panel}
      className="frost-panel gpu-capacity-panel"
      aria-labelledby={headingId}
      aria-describedby={noteId}
      data-testid="gpu-capacity-panel"
      data-status={state}
    >
      <header className="gpu-capacity-header">
        <div className="gpu-capacity-heading">
          <h3 id={headingId}>Live GPU capacity</h3>
          <span className="gpu-capacity-status" data-status={state}>
            <span aria-hidden="true" />
            {stateLabels[state]}
          </span>
          {observedAt ? (
            <time dateTime={observedAt} className="gpu-capacity-time">
              Updated{' '}
              {new Date(observedAt).toLocaleTimeString([], {
                hour: 'numeric',
                minute: '2-digit',
                second: '2-digit',
              })}
            </time>
          ) : null}
        </div>
        <Button
          variant="outline"
          className="gpu-capacity-refresh"
          onClick={capacity.refresh}
          disabled={capacity.refreshing}
          aria-label="Refresh live GPU capacity"
        >
          <RefreshCw aria-hidden="true" className="size-3.5" />
          {capacity.refreshing ? 'Refreshing' : 'Refresh'}
        </Button>
      </header>
      {rows.length ? (
        <dl className="gpu-capacity-grid" data-count={Math.min(4, rows.length)}>
          {rows.map((row) => {
            const count =
              readable && row.status === 'available' ? row.available : null;
            const Icon = row.mode === 'native' ? Cpu : Layers3;
            return (
              <div
                className="gpu-capacity-row"
                key={row.id}
                data-mode={row.mode}
              >
                <dt>
                  <span className="gpu-capacity-size">
                    {row.memoryBytes
                      ? formatBytes(row.memoryBytes)
                      : row.profile || 'GPU'}
                  </span>
                  <span className="gpu-capacity-mode">
                    <Icon aria-hidden="true" />
                    {row.mode === 'native' ? 'Native GPU' : 'MIG'}
                  </span>
                  <span className="gpu-capacity-model">
                    {row.model}
                    {row.profile ? ` · ${row.profile}` : ''}
                  </span>
                </dt>
                <dd>
                  <strong
                    className="gpu-capacity-count"
                    data-available={count ?? 'unknown'}
                  >
                    {count === null ? '—' : count.toLocaleString()}
                  </strong>
                  <span>
                    {count === null
                      ? state === 'stale'
                        ? 'Awaiting fresh data'
                        : 'Availability unknown'
                      : 'available now'}
                  </span>
                  {row.status !== 'available' && row.message ? (
                    <p className="gpu-capacity-row-message">{row.message}</p>
                  ) : null}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="gpu-capacity-empty">
          {capacity.loading
            ? 'Checking GPU availability…'
            : message ||
              (state === 'available'
                ? 'No GPU resources are advertised for this host.'
                : 'GPU capacity reporting is unavailable for this host.')}
        </p>
      )}
      {rows.length > 0 && message && state !== 'available' ? (
        <output className="gpu-capacity-message">{message}</output>
      ) : null}
      <p className="gpu-capacity-note" id={noteId}>
        Profile counts are alternatives, not additive. Allocation is validated
        when a workload starts.
      </p>
    </section>
  );
}
