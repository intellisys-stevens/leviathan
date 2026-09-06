import { useCallback } from 'react';
import {
  Line,
  LineDrawShape,
  type LineDrawShapeProps,
  type LinePointItem,
  type LineProps,
} from 'recharts';
import type { ChartRow } from '../overview-history';

type Props = Omit<LineProps<ChartRow>, 'dataKey' | 'shape' | 'connectNulls'> & {
  dataKey: string;
};

// Keep the shared timestamp rows for tooltips and keyboard selection. Only the
// curve skips rows belonging to other series; explicit nulls still break it.
export function SampledLine({ dataKey, ...props }: Props) {
  const shape = useCallback(
    (shapeProps: LineDrawShapeProps) => (
      <LineDrawShape
        {...shapeProps}
        points={shapeProps.points?.filter((point) => {
          const payload = (point as LinePointItem).payload as
            | ChartRow
            | undefined;
          return payload != null && Object.hasOwn(payload, dataKey);
        })}
        connectNulls={false}
      />
    ),
    [dataKey],
  );
  return (
    <Line {...props} dataKey={dataKey} shape={shape} connectNulls={false} />
  );
}
