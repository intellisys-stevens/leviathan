import {
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

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
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const coordinateX = coordinate?.x;
  const coordinateY = coordinate?.y;
  const visible = Boolean(
    active && coordinateX != null && coordinateY != null && children,
  );

  useLayoutEffect(() => {
    if (!visible) return;

    const handleViewportChange = () => {
      setViewport(currentViewport());
    };
    handleViewportChange();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, {
      capture: true,
      passive: true,
    });
    window.visualViewport?.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('scroll', handleViewportChange, {
      passive: true,
    });
    const tooltip = tooltipRef.current;
    const resizeObserver =
      typeof ResizeObserver === 'undefined' || !tooltip
        ? null
        : new ResizeObserver(handleViewportChange);
    if (resizeObserver && tooltip) resizeObserver.observe(tooltip);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
      window.visualViewport?.removeEventListener(
        'resize',
        handleViewportChange,
      );
      window.visualViewport?.removeEventListener(
        'scroll',
        handleViewportChange,
      );
    };
  }, [visible]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const tooltip = tooltipRef.current;
    if (
      !visible ||
      coordinateX == null ||
      coordinateY == null ||
      !anchor ||
      !tooltip
    ) {
      setPosition(null);
      return;
    }

    const next = placeChartTooltip(
      anchor.getBoundingClientRect(),
      { x: coordinateX, y: coordinateY },
      tooltip.getBoundingClientRect(),
      viewport ?? currentViewport(),
    );
    setPosition((current) =>
      current &&
      current.left === next.left &&
      current.top === next.top &&
      current.sourceX === next.sourceX &&
      current.sourceY === next.sourceY
        ? current
        : next,
    );
  }, [anchorRef, coordinateX, coordinateY, viewport, visible]);

  if (!visible || coordinateX == null || coordinateY == null) return null;

  const positioned =
    position?.sourceX === coordinateX && position.sourceY === coordinateY;

  return (
    <div
      ref={tooltipRef}
      role="tooltip"
      className="chart-tooltip-portal"
      data-testid={testId}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: positioned ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>
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
