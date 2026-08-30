import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoute, resolveAppRoute } from './app-route';

vi.mock('./App', () => ({
  App: () => <div>single-host-dashboard</div>,
}));

vi.mock('./fleet/FleetApp', () => ({
  default: ({ pathname }: { pathname: string }) => (
    <div>fleet-dashboard:{pathname}</div>
  ),
}));

describe('application routing', () => {
  it('keeps the existing single-host dashboard as the default route', () => {
    expect(resolveAppRoute('/')).toBe('host');
    expect(resolveAppRoute('/anything-else')).toBe('host');
    expect(resolveAppRoute('/fleet/jetstream/instance-id')).toBe('host');
    expect(resolveAppRoute('/fleet/unknown/')).toBe('host');

    render(<AppRoute pathname="/" />);
    expect(screen.getByText('single-host-dashboard')).toBeInTheDocument();
  });

  it.each([
    '/fleet',
    '/fleet/',
    '/fleet///',
    '/fleet/jetstream',
    '/fleet/jetstream/',
  ])('lazy-loads the fleet surface only for %s', async (pathname) => {
    expect(resolveAppRoute(pathname)).toBe('fleet');
    render(<AppRoute pathname={pathname} />);
    expect(
      await screen.findByText(`fleet-dashboard:${pathname}`),
    ).toBeInTheDocument();
    expect(screen.queryByText('single-host-dashboard')).toBeNull();
  });
});
