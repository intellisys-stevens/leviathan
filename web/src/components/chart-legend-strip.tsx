import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export function useChartLegendStrip(label: string, seriesKey: string) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const [edges, setEdges] = useState({
    overflow: false,
    start: true,
    end: true,
  });

  useEffect(() => {
    const element = ref.current;
    if (!element || !seriesKey) return;
    const update = () => {
      const next = {
        overflow: element.scrollWidth > element.clientWidth + 1,
        start: element.scrollLeft <= 1,
        end:
          element.scrollLeft + element.clientWidth >= element.scrollWidth - 1,
      };
      setEdges((previous) =>
        previous.overflow === next.overflow &&
        previous.start === next.start &&
        previous.end === next.end
          ? previous
          : next,
      );
    };
    update();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    for (const child of element.children) observer?.observe(child);
    element.addEventListener('scroll', update, { passive: true });
    return () => {
      observer?.disconnect();
      element.removeEventListener('scroll', update);
    };
  }, [seriesKey]);

  function move(direction: -1 | 1) {
    const element = ref.current;
    if (!element) return;
    const items = [...element.querySelectorAll<HTMLButtonElement>('button')];
    const edge = element.getBoundingClientRect();
    const target =
      direction === 1
        ? items.find(
            (item) => item.getBoundingClientRect().right > edge.right + 1,
          )
        : items.findLast(
            (item) => item.getBoundingClientRect().left < edge.left - 1,
          );
    if (target) {
      // Scroll only the strip; the chart and page remain stationary.
      const bounds = target.getBoundingClientRect();
      element.scrollBy({
        left: bounds.left - edge.left,
        behavior: 'instant',
      });
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const element = ref.current;
    if (
      !element ||
      !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
    )
      return;
    const items = [...element.querySelectorAll<HTMLButtonElement>('button')];
    const current = items.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    const index =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : Math.max(
              0,
              Math.min(
                items.length - 1,
                current + (event.key === 'ArrowRight' ? 1 : -1),
              ),
            );
    event.preventDefault();
    event.stopPropagation();
    // Full mobile grids scroll with the page; desktop strips scroll themselves.
    items[index]?.focus({ preventScroll: edges.overflow });
    const target = items[index]?.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    if (target && (target.left < bounds.left || target.right > bounds.right)) {
      element.scrollBy({
        left: target.left - bounds.left,
        behavior: 'instant',
      });
    }
  }

  const controls = edges.overflow ? (
    <fieldset
      className="chart-legend-navigation"
      aria-label={`${label} series navigation`}
    >
      <button
        type="button"
        aria-label={`Previous ${label} series`}
        aria-controls={id}
        disabled={edges.start}
        onClick={() => move(-1)}
      >
        <ChevronLeft aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={`Next ${label} series`}
        aria-controls={id}
        disabled={edges.end}
        onClick={() => move(1)}
      >
        <ChevronRight aria-hidden="true" />
      </button>
    </fieldset>
  ) : null;

  return { props: { ref, id, onKeyDown }, controls };
}
