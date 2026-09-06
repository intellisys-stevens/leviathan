import { useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import { formatBytesPerSecond } from './lib';

// Keep the complete rate unit on narrow axes, without an unnecessary .0.
export function formatAxisByteRate(value: number): string {
  return formatBytesPerSecond(value).replace(/\.0(?= )/, '');
}

const axisTimeFormatter = new Intl.DateTimeFormat([], {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function formatAxisTime(value: number): string {
  return Number.isFinite(value)
    ? axisTimeFormatter.format(value)
    : 'Invalid Date';
}

export function useChartAxisGeometry(anchor: RefObject<HTMLElement | null>) {
  const [measured, setMeasured] = useState({ fontSize: 13, width: 600 });
  useLayoutEffect(() => {
    const element = anchor.current;
    if (!element) return;
    let frame = 0;
    const observed = new Set<Element>();
    const measure = () => {
      frame = 0;
      let fontSize = 0;
      for (const tick of element.querySelectorAll(
        '.recharts-cartesian-axis-tick-value',
      )) {
        fontSize = Math.max(
          fontSize,
          Number.parseFloat(getComputedStyle(tick).fontSize) || 0,
        );
        if (!observed.has(tick)) {
          observed.add(tick);
          resize?.observe(tick);
        }
      }
      for (const tick of observed) {
        if (!element.contains(tick)) {
          resize?.unobserve(tick);
          observed.delete(tick);
        }
      }
      const width = element.getBoundingClientRect().width;
      setMeasured((previous) => {
        const next = {
          fontSize: fontSize || previous.fontSize,
          width: width || previous.width,
        };
        return previous.fontSize === next.fontSize &&
          previous.width === next.width
          ? previous
          : next;
      });
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    const resize =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(schedule);
    resize?.observe(element);
    // Font preferences can change without changing the chart's layout box.
    // Observing tick text also lets Recharts' auto axes remeasure those changes.
    const mutation = new MutationObserver(schedule);
    mutation.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
    document.fonts?.addEventListener('loadingdone', schedule);
    measure();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resize?.disconnect();
      mutation.disconnect();
      document.fonts?.removeEventListener('loadingdone', schedule);
    };
  }, [anchor]);
  return useMemo(
    () => ({
      tick: { fontSize: measured.fontSize, fill: 'var(--muted-foreground)' },
      top: Math.max(8, Math.ceil(measured.fontSize * 0.65)),
      compactRates: measured.fontSize > 18 && measured.width < 480,
      rateTop: Math.ceil(measured.fontSize * 1.4),
      rateBottom: Math.ceil(measured.fontSize),
      xTickCount: measured.width < 480 || measured.fontSize > 18 ? 2 : 4,
      singleTimeTick: measured.width < 240 && measured.fontSize > 18,
      minTickGap: Math.ceil(measured.fontSize * 0.8),
    }),
    [measured],
  );
}
