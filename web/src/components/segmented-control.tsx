import { useId, type CSSProperties, type ReactNode } from 'react';

export type SegmentedControlOption<T extends string | number> = {
  value: T;
  label: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
};

type Props<T extends string | number> = {
  ariaLabel: string;
  options: readonly SegmentedControlOption<T>[];
  value: T | null;
  onValueChange: (value: T) => void;
  ariaBusy?: boolean;
  className?: string;
  itemClassName?: string;
};

type SegmentedControlStyle = CSSProperties & {
  '--segment-count': number;
  '--active-index': number;
};

export function SegmentedControl<T extends string | number>({
  ariaLabel,
  options,
  value,
  onValueChange,
  ariaBusy = false,
  className = '',
  itemClassName = '',
}: Props<T>) {
  const generatedName = useId();
  const selectedIndex = options.findIndex((option) => option.value === value);
  const style: SegmentedControlStyle = {
    '--segment-count': Math.max(options.length, 1),
    '--active-index': Math.max(selectedIndex, 0),
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-busy={ariaBusy}
      className={`segmented-control ${className}`}
      style={style}
    >
      {selectedIndex >= 0 ? (
        <span
          className="segmented-thumb transition-transform duration-200 ease-[var(--ease-onscreen)] motion-reduce:transition-none"
          aria-hidden="true"
        />
      ) : null}
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <label
            key={option.value}
            data-active={selected ? 'true' : undefined}
            data-disabled={option.disabled ? 'true' : undefined}
            className={`segmented-item flex items-center justify-center has-[:focus-visible]:shadow-[0_0_0_2px_var(--ring)] ${option.disabled ? 'pointer-events-none cursor-not-allowed opacity-[0.36]' : 'cursor-pointer'} ${itemClassName}`}
          >
            <input
              type="radio"
              name={generatedName}
              value={option.value}
              checked={selected}
              disabled={option.disabled}
              aria-label={option.ariaLabel}
              className="sr-only"
              onChange={() => {
                if (!option.disabled) onValueChange(option.value);
              }}
            />
            {option.label}
          </label>
        );
      })}
    </div>
  );
}
