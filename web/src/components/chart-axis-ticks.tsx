import { formatAxisByteRate, formatAxisTime } from '../use-chart-axis-geometry';

type TickProps = {
  x?: number;
  y?: number;
  fontSize?: number;
  index?: number;
  visibleTicksCount?: number;
  payload?: { value: number };
};

export function TimeAxisTick({
  x,
  y,
  fontSize = 13,
  index = 0,
  visibleTicksCount = 1,
  payload,
}: TickProps) {
  return (
    <text
      className="recharts-cartesian-axis-tick-value"
      x={x}
      y={y}
      dominantBaseline="hanging"
      textAnchor={
        index === visibleTicksCount - 1
          ? 'end'
          : index === 0
            ? 'start'
            : 'middle'
      }
      fill="var(--muted-foreground)"
      fontSize={fontSize}
    >
      {formatAxisTime(Number(payload?.value))}
    </text>
  );
}

export function StackedRateAxisTick({
  x,
  y,
  fontSize = 13,
  payload,
}: TickProps) {
  const [value, unit] = formatAxisByteRate(Number(payload?.value)).split(' ');
  return (
    <text
      className="recharts-cartesian-axis-tick-value"
      x={x}
      y={y}
      textAnchor="end"
      fill="var(--muted-foreground)"
      fontSize={fontSize}
    >
      <tspan x={x} dy="-0.35em">
        {value}
      </tspan>
      <tspan x={x} dy="1em">
        {unit}
      </tspan>
    </text>
  );
}
