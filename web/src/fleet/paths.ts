export function normalizePathname(pathname: string): string {
  const withoutTrailingSlash = pathname.replace(/\/+$/u, '');
  return withoutTrailingSlash || '/';
}

export const platformOverviewPath = '/platforms';
export const jetstreamPlatformPath = '/platforms/jetstream';

export function isFleetPathname(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return (
    normalized === platformOverviewPath ||
    normalized.startsWith(`${platformOverviewPath}/`) ||
    normalized === '/fleet' ||
    normalized.startsWith('/fleet/')
  );
}

export function isPlatformOverviewPathname(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return normalized === platformOverviewPath || normalized === '/fleet';
}

export function isJetstreamFleetPathname(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return (
    normalized === jetstreamPlatformPath || normalized === '/fleet/jetstream'
  );
}
