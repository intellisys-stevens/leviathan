import {
  memo,
  useEffect,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

/** Keep collecting history outside this boundary while its SVG is offscreen. */
export const ChartRenderBoundary = memo(
  function ChartRenderBoundary({
    children,
  }: {
    active: boolean;
    layout?: object;
    children: ReactNode;
  }) {
    return children;
  },
  // Font and viewport changes still need one remeasurement while offscreen.
  (previous, next) =>
    !previous.active && !next.active && previous.layout === next.layout,
);

export function useChartVisibility(
  anchor: RefObject<HTMLElement | null>,
): boolean {
  const [active, setActive] = useState(true);
  useEffect(() => {
    const element = anchor.current;
    if (!element) return;
    const panel = element.closest('.compact-chart-panel') ?? element;
    let intersects = true;
    let printing = false;
    const update = () =>
      setActive(
        printing ||
          (!document.hidden &&
            (intersects || panel.contains(document.activeElement))),
      );
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            ([entry]) => {
              intersects = entry.isIntersecting;
              update();
            },
            { rootMargin: '160px 0px' },
          );
    const beforePrint = () => {
      printing = true;
      update();
    };
    const afterPrint = () => {
      printing = false;
      update();
    };
    observer?.observe(panel);
    document.addEventListener('visibilitychange', update);
    panel.addEventListener('focusin', update);
    panel.addEventListener('focusout', update);
    window.addEventListener('beforeprint', beforePrint);
    window.addEventListener('afterprint', afterPrint);
    update();
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', update);
      panel.removeEventListener('focusin', update);
      panel.removeEventListener('focusout', update);
      window.removeEventListener('beforeprint', beforePrint);
      window.removeEventListener('afterprint', afterPrint);
    };
  }, [anchor]);
  return active;
}
