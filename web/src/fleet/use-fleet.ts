import { useEffect, useRef, useState } from 'react';
import type { FleetConnectionState, FleetSnapshot } from './types';

function parseFleetSnapshot(value: unknown): FleetSnapshot {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 'fleet-v1' ||
    !('platforms' in value) ||
    !Array.isArray(value.platforms) ||
    !('sequence' in value) ||
    typeof value.sequence !== 'number'
  ) {
    throw new Error('Fleet response uses an incompatible schema');
  }
  return value as FleetSnapshot;
}

export function newestFleetSnapshot(
  current: FleetSnapshot | null,
  next: FleetSnapshot,
): FleetSnapshot {
  return current && current.sequence > next.sequence ? current : next;
}

export function useFleet() {
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);
  const [connection, setConnection] =
    useState<FleetConnectionState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const failures = useRef(0);

  useEffect(() => {
    let active = true;
    void fetch('/api/fleet/v1/state', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Fleet state request failed (${response.status})`);
        return parseFleetSnapshot(await response.json());
      })
      .then((next) => {
        if (!active) return;
        setSnapshot((current) => newestFleetSnapshot(current, next));
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(
          reason instanceof Error ? reason.message : 'Fleet state unavailable',
        );
      });

    const events = new EventSource('/api/fleet/v1/events');
    events.onopen = () => {
      failures.current = 0;
      setConnection('live');
      setError(null);
    };
    events.addEventListener('fleet', (event) => {
      try {
        const next = parseFleetSnapshot(
          JSON.parse((event as MessageEvent<string>).data),
        );
        setSnapshot((current) => newestFleetSnapshot(current, next));
        setConnection('live');
        setError(null);
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : 'A malformed fleet event was ignored',
        );
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

  return { snapshot, connection, error };
}
