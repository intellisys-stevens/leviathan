'use client';

import { Progress as ProgressPrimitive } from '@base-ui/react/progress';

import { cn } from '../../lib/utils';

type ProgressProps = Omit<ProgressPrimitive.Root.Props, 'value'> & {
  value?: number | null;
};

function Progress({
  className,
  children,
  value,
  'aria-valuetext': ariaValueText,
  ...props
}: ProgressProps) {
  const clampedValue =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(100, Math.max(0, value))
      : null;
  const unavailable = clampedValue == null;

  return (
    <ProgressPrimitive.Root
      {...props}
      value={clampedValue}
      aria-valuetext={
        ariaValueText ?? (unavailable ? 'Unavailable' : undefined)
      }
      data-unavailable={unavailable ? '' : undefined}
      data-slot="progress"
      className={cn('flex flex-wrap gap-3', className)}
    >
      {children}
      <ProgressTrack
        data-unavailable={unavailable ? '' : undefined}
        className={unavailable ? 'bg-muted/60' : undefined}
      >
        {unavailable ? null : <ProgressIndicator />}
      </ProgressTrack>
    </ProgressPrimitive.Root>
  );
}

function ProgressTrack({ className, ...props }: ProgressPrimitive.Track.Props) {
  return (
    <ProgressPrimitive.Track
      className={cn(
        'bg-muted h-1 rounded-full relative flex w-full items-center overflow-x-hidden',
        className,
      )}
      data-slot="progress-track"
      {...props}
    />
  );
}

function ProgressIndicator({
  className,
  ...props
}: ProgressPrimitive.Indicator.Props) {
  return (
    <ProgressPrimitive.Indicator
      data-slot="progress-indicator"
      className={cn('bg-primary h-full', className)}
      {...props}
    />
  );
}

function ProgressLabel({ className, ...props }: ProgressPrimitive.Label.Props) {
  return (
    <ProgressPrimitive.Label
      className={cn('text-sm font-medium', className)}
      data-slot="progress-label"
      {...props}
    />
  );
}

function ProgressValue({ className, ...props }: ProgressPrimitive.Value.Props) {
  return (
    <ProgressPrimitive.Value
      className={cn(
        'text-muted-foreground ml-auto text-sm tabular-nums',
        className,
      )}
      data-slot="progress-value"
      {...props}
    />
  );
}

export {
  Progress,
  ProgressTrack,
  ProgressIndicator,
  ProgressLabel,
  ProgressValue,
};
