import { type ReactNode, type RefObject, useLayoutEffect, useRef } from 'react';

type Coordinate = {
  x: number;
  y: number;
};

type Size = {
  width: number;
  height: number;
};

type Viewport = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type TooltipPosition = {
  left: number;
  top: number;
  sourceX: number;
  sourceY: number;
};

const viewportInset = 8;
const pointerOffset = 12;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function placeChartTooltip(
  anchor: Pick<DOMRect, 'left' | 'top'>,
  coordinate: Coordinate,
  size: Size,
  viewport: Viewport,
): TooltipPosition {
  const sourceX = anchor.left + coordinate.x;
  const sourceY = anchor.top + coordinate.y;
  const viewportRight = viewport.left + viewport.width;
  const viewportBottom = viewport.top + viewport.height;
  let left = sourceX + pointerOffset;

  if (left + size.width > viewportRight - viewportInset) {
    left = sourceX - pointerOffset - size.width;
  }

  return {
    left: clamp(
      left,
      viewport.left + viewportInset,
      viewportRight - viewportInset - size.width,
    ),
    top: clamp(
      sourceY - size.height / 2,
      viewport.top + viewportInset,
      viewportBottom - viewportInset - size.height,
    ),
    sourceX: coordinate.x,
    sourceY: coordinate.y,
  };
}

function currentViewport(): Viewport {
  const visualViewport = window.visualViewport;
  return {
    left: visualViewport?.offsetLeft ?? 0,
    top: visualViewport?.offsetTop ?? 0,
    width: visualViewport?.width ?? window.innerWidth,
    height: visualViewport?.height ?? window.innerHeight,
  };
}

export function ChartTooltipPortal({
  active,
  anchorRef,
  children,
  coordinate,
  testId,
}: {
  active?: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  coordinate?: Coordinate;
  testId?: string;
}) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const coordinateRef = useRef<Coordinate | null>(null);
  const scheduleRef = useRef<(() => void) | null>(null);
  const coordinateX = coordinate?.x;
  const coordinateY = coordinate?.y;
  const visible = Boolean(
    active && coordinateX != null && coordinateY != null && children,
  );

  useLayoutEffect(() => {
    coordinateRef.current =
      visible && coordinateX != null && coordinateY != null
        ? { x: coordinateX, y: coordinateY }
        : null;
    scheduleRef.current?.();
  }, [coordinateX, coordinateY, visible]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const tooltip = tooltipRef.current;
    if (!visible || !anchor || !tooltip) return;

    let frame: number | null = null;
    let size: Size | null = null;
    let anchorBounds: DOMRect | null = null;
    let viewport: Viewport | null = null;
    let lastTransform: string | null = null;
    const applyPosition = () => {
      const point = coordinateRef.current;
      if (!point || !anchorBounds || !size || !viewport) return;
      const next = placeChartTooltip(anchorBounds, point, size, viewport);
      const transform = `translate3d(${next.left}px, ${next.top}px, 0)`;
      if (lastTransform === transform) return;
      tooltip.style.transform = transform;
      if (lastTransform == null) tooltip.style.visibility = 'visible';
      lastTransform = transform;
    };
    const updatePosition = () => {
      frame = null;
      // Read before writing. Coordinates are chart-local, so refresh the anchor
      // once per frame even when it moved without changing its own dimensions.
      anchorBounds = anchor.getBoundingClientRect();
      size ??= tooltip.getBoundingClientRect();
      viewport = currentViewport();
      applyPosition();
    };
    const schedulePosition = () => {
      if (frame == null) frame = window.requestAnimationFrame(updatePosition);
    };
    const movePosition = () => {
      // Content is already committed. Move with cached geometry immediately so
      // a pending live chart render cannot delay its matching readout by a frame.
      // Any scroll/layout changes are corrected by the coalesced geometry pass.
      applyPosition();
      schedulePosition();
    };
    const invalidateSize = () => {
      size = null;
      schedulePosition();
    };
    // Without ResizeObserver, remeasure on the next content/coordinate commit.
    scheduleRef.current =
      typeof ResizeObserver === 'undefined' ? invalidateSize : movePosition;

    // Place first appearance before paint; later pointer updates reuse these
    // measurements and never hide between coordinates.
    updatePosition();
    window.addEventListener('resize', invalidateSize);
    window.addEventListener('scroll', schedulePosition, {
      capture: true,
      passive: true,
    });
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener('resize', invalidateSize);
    visualViewport?.addEventListener('scroll', schedulePosition, {
      passive: true,
    });
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            for (const entry of entries) {
              if (entry.target !== tooltip) continue;
              const borderBox = entry.borderBoxSize?.[0];
              size = borderBox
                ? { width: borderBox.inlineSize, height: borderBox.blockSize }
                : null;
            }
            schedulePosition();
          });
    resizeObserver?.observe(tooltip);
    resizeObserver?.observe(anchor);
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame);
      scheduleRef.current = null;
      resizeObserver?.disconnect();
      window.removeEventListener('resize', invalidateSize);
      window.removeEventListener('scroll', schedulePosition, true);
      visualViewport?.removeEventListener('resize', invalidateSize);
      visualViewport?.removeEventListener('scroll', schedulePosition);
    };
  }, [anchorRef, visible]);

  useLayoutEffect(() => {
    if (children && typeof ResizeObserver === 'undefined')
      scheduleRef.current?.();
  }, [children]);

  if (!visible) return null;

  return (
    <div
      ref={tooltipRef}
      role="tooltip"
      className="chart-tooltip-portal"
      data-testid={testId}
    >
      {children}
    </div>
  );
}

// Recharts can recreate its payload array for movement within the same sample.
// Compare every displayed field so memoized content also updates for corrected
// live samples, renamed series, changed colors, and visibility/filter changes.
export type ChartTooltipDatum = {
  color?: string;
  dataKey?: unknown;
  name?: string | number;
  value?: number | string | readonly (number | string)[];
};

export function sameChartTooltipPayload(
  previous: readonly ChartTooltipDatum[] | undefined,
  next: readonly ChartTooltipDatum[] | undefined,
): boolean {
  return (
    previous === next ||
    (previous?.length === next?.length &&
      Boolean(
        previous?.every((item, index) => {
          const other = next?.[index];
          return (
            other != null &&
            item.dataKey === other.dataKey &&
            item.name === other.name &&
            item.color === other.color &&
            Object.is(item.value, other.value)
          );
        }),
      ))
  );
}

export const chartTooltipPortalWrapperStyle = {
  position: 'fixed',
  transform: 'none',
  zIndex: 80,
  top: 0,
  left: 0,
  width: 0,
  height: 0,
  pointerEvents: 'none',
} as const;
