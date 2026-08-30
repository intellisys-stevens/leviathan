export function normalizePathname(pathname: string): string {
  const withoutTrailingSlash = pathname.replace(/\/+$/u, '');
  return withoutTrailingSlash || '/';
}

export function isFleetPathname(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return normalized === '/fleet' || normalized === '/fleet/jetstream';
}

export function isJetstreamFleetPathname(pathname: string): boolean {
  return normalizePathname(pathname) === '/fleet/jetstream';
}
