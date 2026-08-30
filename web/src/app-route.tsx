import { lazy, Suspense } from 'react';
import { App } from './App';

const FleetApp = lazy(() => import('./fleet/FleetApp'));

export type AppRouteKind = 'host' | 'fleet';

export function resolveAppRoute(pathname: string): AppRouteKind {
  return pathname === '/fleet' || pathname === '/fleet/jetstream'
    ? 'fleet'
    : 'host';
}

function FleetLoading() {
  return (
    <main className="mx-auto max-w-[1680px] px-4 py-6 sm:px-6">
      <div
        className="h-20 animate-pulse rounded-md bg-muted"
        aria-label="Loading fleet dashboard"
      />
    </main>
  );
}

export function AppRoute({ pathname }: { pathname: string }) {
  if (resolveAppRoute(pathname) === 'host') return <App />;
  return (
    <Suspense fallback={<FleetLoading />}>
      <FleetApp pathname={pathname} />
    </Suspense>
  );
}
