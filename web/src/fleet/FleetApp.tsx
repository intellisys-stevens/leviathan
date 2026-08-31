import { Activity, AlertTriangle, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { readBrowserSetting, writeBrowserSetting } from '../browser-storage';
import { GitHubMark } from '../components/status-header';
import {
  isJetstreamFleetPathname,
  isPlatformOverviewPathname,
  platformOverviewPath,
} from './paths';
import { PlatformOverview } from './platform-overview';
import { JetstreamDashboard } from './jetstream-dashboard';
import type { FleetConnectionState, PlatformObservation } from './types';
import { useFleet } from './use-fleet';

const themeKey = 'leviathan.theme.v1';
const platformName = 'Yggdrasill';
const platformIconPath = '/yggdrasill.png';
const platformFaviconPath = '/yggdrasill-favicon.png';

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

function platformDegraded(platform: PlatformObservation | undefined): boolean {
  if (!platform || platform.inventory.status !== 'available') return true;
  return platform.instances.some(({ instance, managed, agent }) => {
    if (!managed || instance.cloudState !== 'active') return false;
    if (agent.status !== 'available') return true;
    return Boolean(
      agent.snapshot?.diagnostics.some(({ severity }) => severity !== 'info'),
    );
  });
}

function FleetHeader({
  connection,
  degraded,
  scope,
  theme,
  onToggleTheme,
}: {
  connection: FleetConnectionState;
  degraded: boolean;
  scope: string;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}) {
  const live = connection === 'live';
  const healthy = live && !degraded;
  const statusName = live
    ? degraded
      ? 'Degraded'
      : 'Live'
    : connectionLabel(connection);
  return (
    <header className="sticky top-0 z-30 border-b border-border/80 bg-background/95 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1680px] items-center justify-between gap-3 px-4 sm:px-6">
        <a
          href={platformOverviewPath}
          className="flex min-w-0 items-center gap-3 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Open ${platformName} overview`}
        >
          <span
            data-testid="yggdrasill-header-icon"
            className="size-10 shrink-0 bg-contain bg-center bg-no-repeat"
            style={{ backgroundImage: `url("${platformIconPath}")` }}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight">
              {platformName}
            </p>
            <p className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              {scope === 'platform'
                ? 'Leviathan · platform read-only'
                : `${scope} · Leviathan read-only`}
            </p>
          </div>
        </a>
        <div className="flex shrink-0 items-center gap-2">
          <output
            className={`flex h-8 items-center gap-1.5 font-mono text-[10px] font-semibold ${healthy ? 'text-foreground' : 'text-amber-700 dark:text-amber-300'}`}
            aria-live="polite"
            aria-label={`Platform connection status: ${statusName}`}
          >
            <span
              className={`size-2 rounded-full ${healthy ? 'bg-primary' : 'bg-amber-500'} ${connection === 'connecting' || connection === 'reconnecting' ? 'animate-pulse' : ''}`}
              aria-hidden="true"
            />
            {statusName}
          </output>
          <a
            href="https://github.com/intellisys-stevens/leviathan"
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: 'ghost', size: 'icon' })}
            aria-label="Open Leviathan repository on GitHub"
            title="Leviathan on GitHub"
          >
            <GitHubMark />
          </a>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onToggleTheme}
            aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
        </div>
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

function PlatformNotFound() {
  return (
    <section className="border border-dashed border-border bg-card p-10 text-center">
      <h1 className="text-base font-semibold">{platformName} page not found</h1>
      <p className="mt-1 text-xs text-muted-foreground">
        This path is not part of the {platformName} monitoring platform.
      </p>
      <a
        href={platformOverviewPath}
        className="mt-4 inline-flex text-xs font-medium text-primary underline-offset-4 hover:underline"
      >
        Return to platform overview
      </a>
    </section>
  );
}

export default function FleetApp({ pathname }: { pathname: string }) {
  const { snapshot, connection, error } = useFleet();
  const jetstream = findJetstream(snapshot?.platforms);
  const nidhogg = findNidhogg(snapshot?.platforms);
  const showJetstreamInstances = isJetstreamFleetPathname(pathname);
  const showPlatformOverview = isPlatformOverviewPathname(pathname);
  const degraded = snapshot ? platformDegraded(jetstream) : false;
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    readBrowserSetting(themeKey) === 'light' ? 'light' : 'dark',
  );

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    writeBrowserSetting(themeKey, theme);
  }, [theme]);

  useEffect(() => {
    const previousTitle = document.title;
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const hadFaviconHref = favicon?.hasAttribute('href') ?? false;
    const previousFavicon = favicon?.getAttribute('href') ?? null;
    document.title = showJetstreamInstances
      ? `Jetstream · ${platformName}`
      : showPlatformOverview
        ? `${platformName} · Leviathan`
        : `${platformName} page not found`;
    favicon?.setAttribute('href', platformFaviconPath);
    return () => {
      document.title = previousTitle;
      if (favicon && hadFaviconHref && previousFavicon !== null) {
        favicon.setAttribute('href', previousFavicon);
      } else {
        favicon?.removeAttribute('href');
      }
    };
  }, [showJetstreamInstances, showPlatformOverview]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <FleetHeader
        connection={connection}
        degraded={degraded}
        scope={showJetstreamInstances ? 'jetstream' : 'platform'}
        theme={theme}
        onToggleTheme={() =>
          setTheme((value) => (value === 'dark' ? 'light' : 'dark'))
        }
      />
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
            <span>
              {error}. Waiting for the next read-only platform update.
            </span>
          </div>
        ) : null}

        {showPlatformOverview ? (
          <section className="mb-6" aria-labelledby="platform-heading">
            <div className="flex items-center gap-4">
              <span
                data-testid="yggdrasill-icon"
                aria-hidden="true"
                className="size-20 shrink-0 bg-contain bg-center bg-no-repeat sm:size-24"
                style={{ backgroundImage: `url("${platformIconPath}")` }}
              />
              <div>
                <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.15em] text-primary">
                  <Activity className="size-3.5" aria-hidden="true" /> platform
                  / overview
                </div>
                <h1
                  id="platform-heading"
                  className="mt-2 text-xl font-semibold tracking-[-0.025em] sm:text-2xl"
                >
                  {platformName}
                </h1>
                <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                  The Leviathan monitoring platform for Nidhogg and Jetstream,
                  organized by GPUs and People.
                </p>
              </div>
            </div>
          </section>
        ) : null}

        {!showPlatformOverview && !showJetstreamInstances ? (
          <PlatformNotFound />
        ) : !snapshot ? (
          <FleetLoading />
        ) : (
          <>
            {showJetstreamInstances && jetstream ? (
              <JetstreamDashboard platform={jetstream} />
            ) : showJetstreamInstances ? (
              <section className="mt-6 border border-dashed border-border bg-card p-10 text-center">
                <h2 className="text-sm font-medium">Jetstream unavailable</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  No OpenStack platform is present in the latest fleet state.
                </p>
              </section>
            ) : (
              <PlatformOverview nidhogg={nidhogg} jetstream={jetstream} />
            )}
            <footer className="mt-6 border-t border-border/70 pt-4 text-center font-mono text-[10px] text-muted-foreground">
              {platformName} snapshot #{snapshot.sequence} ·{' '}
              <time dateTime={snapshot.observedAt}>{snapshot.observedAt}</time>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
