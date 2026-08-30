import { AlertTriangle, RadioTower } from 'lucide-react';
import { useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { InstanceTable } from './instance-table';
import { isJetstreamFleetPathname } from './paths';
import { PlatformOverview } from './platform-overview';
import type { FleetConnectionState, PlatformObservation } from './types';
import { useFleet } from './use-fleet';

const themeKey = 'miglens.theme.v1';

function connectionLabel(connection: FleetConnectionState): string {
  return connection.charAt(0).toUpperCase() + connection.slice(1);
}

function findJetstream(
  platforms: PlatformObservation[] | undefined,
): PlatformObservation | undefined {
  return platforms?.find(
    ({ platform }) =>
      platform.id.toLowerCase() === 'jetstream' ||
      platform.kind === 'openstack',
  );
}

function findNidhogg(
  platforms: PlatformObservation[] | undefined,
): PlatformObservation | undefined {
  return platforms?.find(
    ({ platform }) =>
      platform.id.toLowerCase() === 'nidhogg' || platform.kind === 'host',
  );
}

function FleetHeader({ connection }: { connection: FleetConnectionState }) {
  return (
    <header className="sticky top-0 z-30 border-b border-border/80 bg-background/95 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1680px] items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="size-9 shrink-0 bg-foreground"
            style={{
              WebkitMask: "url('/miglens-mark.png') center / contain no-repeat",
              mask: "url('/miglens-mark.png') center / contain no-repeat",
            }}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight">
              MIGLens Fleet
            </p>
            <p className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              multi-platform · read-only
            </p>
          </div>
        </div>
        <Badge variant={connection === 'live' ? 'default' : 'secondary'}>
          <RadioTower className="size-3" aria-hidden="true" />
          {connectionLabel(connection)}
        </Badge>
      </div>
    </header>
  );
}

function FleetLoading() {
  return (
    <div className="space-y-4" aria-label="Loading fleet state">
      <Skeleton className="h-20 w-full" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

export default function FleetApp({ pathname }: { pathname: string }) {
  const { snapshot, connection, error } = useFleet();
  const jetstream = findJetstream(snapshot?.platforms);
  const nidhogg = findNidhogg(snapshot?.platforms);
  const showJetstreamInstances = isJetstreamFleetPathname(pathname);

  useEffect(() => {
    const dark = localStorage.getItem(themeKey) !== 'light';
    document.documentElement.classList.toggle('dark', dark);
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <FleetHeader connection={connection} />
      <main className="mx-auto max-w-[1680px] px-4 py-6 sm:px-6">
        {error ? (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 border border-amber-500/30 bg-amber-500/[0.06] p-3 text-sm text-amber-700 dark:text-amber-300"
          >
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <span>{error}. Waiting for the next read-only fleet update.</span>
          </div>
        ) : null}

        <section className="mb-6" aria-labelledby="fleet-heading">
          <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-primary">
            fleet / {showJetstreamInstances ? 'jetstream' : 'platforms'}
          </div>
          <h1
            id="fleet-heading"
            className="mt-2 text-xl font-semibold tracking-[-0.025em] sm:text-2xl"
          >
            {showJetstreamInstances ? 'Jetstream' : 'Platform overview'}
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Cloud inventory, agent reachability, and GPU telemetry are kept as
            separate health layers.
          </p>
        </section>

        {!snapshot ? (
          <FleetLoading />
        ) : (
          <>
            <PlatformOverview nidhogg={nidhogg} jetstream={jetstream} />
            {showJetstreamInstances && jetstream ? (
              <InstanceTable
                instances={jetstream.instances}
                inventory={jetstream.inventory}
              />
            ) : showJetstreamInstances ? (
              <section className="mt-6 border border-dashed border-border bg-card p-10 text-center">
                <h2 className="text-sm font-medium">Jetstream unavailable</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  No OpenStack platform is present in the latest fleet state.
                </p>
              </section>
            ) : null}
            <footer className="mt-6 border-t border-border/70 pt-4 text-center font-mono text-[10px] text-muted-foreground">
              Fleet snapshot #{snapshot.sequence} ·{' '}
              <time dateTime={snapshot.observedAt}>{snapshot.observedAt}</time>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
