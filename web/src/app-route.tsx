import { lazy, Suspense } from 'react';
import { App } from './App';
import { isFleetPathname } from './fleet/paths';

const FleetApp = lazy(() => import('./fleet/FleetApp'));

export type AppRouteKind = 'host' | 'platform';

export function resolveAppRoute(pathname: string): AppRouteKind {
  return isFleetPathname(pathname) ? 'platform' : 'host';
}

function FleetLoading() {
  return (
    <main className="mx-auto max-w-[1680px] px-4 py-6 sm:px-6">
      <div
        className="h-20 animate-pulse rounded-md bg-muted"
        aria-label="Loading platform dashboard"
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
