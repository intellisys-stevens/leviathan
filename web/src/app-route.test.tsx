import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoute, resolveAppRoute } from './app-route';

vi.mock('./App', () => ({
  App: () => <div>single-host-dashboard</div>,
}));

vi.mock('./fleet/FleetApp', () => ({
  default: ({ pathname }: { pathname: string }) => (
    <div>platform-dashboard:{pathname}</div>
  ),
}));

describe('application routing', () => {
  it('keeps the existing single-host dashboard as the default route', () => {
    expect(resolveAppRoute('/')).toBe('host');
    expect(resolveAppRoute('/anything-else')).toBe('host');

    render(<AppRoute pathname="/" />);
    expect(screen.getByText('single-host-dashboard')).toBeInTheDocument();
  });

  it.each([
    '/platforms',
    '/platforms/',
    '/platforms///',
    '/platforms/jetstream',
    '/platforms/jetstream/',
    '/platforms/not-a-route',
    '/fleet',
    '/fleet/',
    '/fleet///',
    '/fleet/jetstream',
    '/fleet/jetstream/',
    '/fleet/unknown/',
  ])('lazy-loads the platform surface only for %s', async (pathname) => {
    expect(resolveAppRoute(pathname)).toBe('platform');
    render(<AppRoute pathname={pathname} />);
    expect(
      await screen.findByText(`platform-dashboard:${pathname}`),
    ).toBeInTheDocument();
    expect(screen.queryByText('single-host-dashboard')).toBeNull();
  });
});
