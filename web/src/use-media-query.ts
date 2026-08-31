import { useCallback, useSyncExternalStore } from 'react';

function mediaQueryList(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
    return null;
  return window.matchMedia(query);
}

export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const media = mediaQueryList(query);
      if (!media) return () => {};

      const onChange = () => onStoreChange();
      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', onChange);
        return () => media.removeEventListener('change', onChange);
      }

      const legacyMedia = media as unknown as {
        addListener: (listener: () => void) => void;
        removeListener: (listener: () => void) => void;
      };
      legacyMedia.addListener(onChange);
      return () => legacyMedia.removeListener(onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(
    () => mediaQueryList(query)?.matches ?? fallback,
    [fallback, query],
  );
  const getServerSnapshot = useCallback(() => fallback, [fallback]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
