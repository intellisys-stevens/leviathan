import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleDot,
  Moon,
  RefreshCw,
  Sun,
} from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatSamplingInterval } from '../chart-window';
import type { Capabilities, RuntimeSettings } from '../types';
import type { ConnectionState } from '../use-miglens';

type Props = {
  hostname: string;
  sampledAt: string;
  capabilities: Capabilities;
  connection: ConnectionState;
  degraded: boolean;
  settings: RuntimeSettings | null;
  theme: 'dark' | 'light';
  onSamplingIntervalChange: (milliseconds: number) => Promise<RuntimeSettings>;
  onToggleTheme: () => void;
};

type SamplingChoicesProps = {
  allowed: number[];
  current: number | null;
  pending: number | null;
  mobile?: boolean;
  onSelect: (milliseconds: number) => void;
};

const defaultSamplingIntervals = [500, 1000, 2000];

function providerLabel(capabilities: Capabilities): string {
  const active = Array.from(
    new Set(
      [capabilities.nvml, capabilities.gpm, capabilities.dcgm]
        .filter((provider) => provider.available)
        .map((provider) => provider.name.replace('NVML GPM', 'GPM')),
    ),
  );
  return active.length > 0 ? active.join(' + ') : 'Provider degraded';
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function SamplingChoices({
  allowed,
  current,
  pending,
  mobile = false,
  onSelect,
}: SamplingChoicesProps) {
  return (
    <fieldset
      className={`flex rounded-md bg-background/70 p-0.5 ${mobile ? 'w-full border border-border' : ''}`}
    >
      <legend className="sr-only">Sampling interval</legend>
      {allowed.map((milliseconds) => {
        const selected = current === milliseconds;
        return (
          <button
            key={milliseconds}
            type="button"
            className={`relative flex-1 rounded px-2 font-mono text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
              mobile ? 'h-8' : 'h-6'
            } ${
              selected
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
            disabled={current == null || pending != null}
            aria-pressed={selected}
            onClick={() => onSelect(milliseconds)}
          >
            {formatSamplingInterval(milliseconds)}
          </button>
        );
      })}
    </fieldset>
  );
}

export function StatusHeader({
  hostname,
  sampledAt,
  capabilities,
  connection,
  degraded,
  settings,
  theme,
  onSamplingIntervalChange,
  onToggleTheme,
}: Props) {
  const [pendingSampling, setPendingSampling] = useState<number | null>(null);
  const [samplingError, setSamplingError] = useState<string | null>(null);
  const live = connection === 'live';
  const reconnecting =
    connection === 'reconnecting' || connection === 'connecting';
  const statusName = live
    ? degraded
      ? 'Degraded'
      : 'Live'
    : titleCase(connection);
  const healthy = live && !degraded;
  const currentSampling = settings?.samplingIntervalMs ?? null;
  const allowedSampling =
    settings?.allowedSamplingIntervalsMs ?? defaultSamplingIntervals;
  const customSampling =
    currentSampling != null && !allowedSampling.includes(currentSampling);
  const samplingText =
    currentSampling == null ? '—' : formatSamplingInterval(currentSampling);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(sampledAt));

  async function applySampling(milliseconds: number) {
    if (milliseconds === currentSampling || pendingSampling != null) return;
    setPendingSampling(milliseconds);
    setSamplingError(null);
    try {
      await onSamplingIntervalChange(milliseconds);
    } catch (reason) {
      setSamplingError(
        reason instanceof Error ? reason.message : 'Sampling update failed.',
      );
    } finally {
      setPendingSampling(null);
    }
  }

  const indicator = reconnecting ? (
    <RefreshCw className="size-3 animate-spin" aria-hidden="true" />
  ) : (
    <span
      className={`size-1.5 shrink-0 rounded-full ${healthy ? 'bg-primary' : 'bg-current'}`}
      aria-hidden="true"
    />
  );

  return (
    <header className="sticky top-0 z-30 border-b border-border/80 bg-background/95 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1680px] items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="grid size-9 shrink-0 grid-cols-2 gap-0.5 rounded-md border border-primary/30 bg-primary/10 p-2"
            aria-hidden="true"
          >
            <span className="rounded-[1px] bg-primary" />
            <span className="rounded-[1px] bg-primary/45" />
            <span className="col-span-2 rounded-[1px] bg-primary/70" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight">MIGLens</p>
            <p className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              {hostname} · local read-only
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Badge
            variant="outline"
            className="hidden rounded-md border-border bg-card font-mono text-[11px] text-muted-foreground lg:inline-flex"
          >
            <CircleDot
              className={healthy ? 'text-primary' : 'text-amber-400'}
            />
            {providerLabel(capabilities)}
          </Badge>

          <div
            className="relative hidden md:block"
            data-testid="desktop-live-sampling"
          >
            <div
              className={`flex h-8 items-center overflow-hidden rounded-lg border shadow-sm ${
                healthy
                  ? 'border-primary/25 bg-primary/[0.07]'
                  : 'border-amber-500/30 bg-amber-500/[0.08]'
              }`}
              aria-label="Live status and sampling"
            >
              <div
                className={`flex h-full items-center gap-1.5 px-3 font-mono text-[10px] font-semibold ${healthy ? 'text-primary' : 'text-amber-500'}`}
                aria-live="polite"
              >
                {indicator}
                {statusName}
              </div>
              <span className="h-4 w-px bg-border" aria-hidden="true" />
              <span className="px-2 font-mono text-[8px] uppercase tracking-[0.13em] text-muted-foreground">
                Sampling
              </span>
              <SamplingChoices
                allowed={allowedSampling}
                current={currentSampling}
                pending={pendingSampling}
                onSelect={(milliseconds) => void applySampling(milliseconds)}
              />
              {customSampling ? (
                <span className="whitespace-nowrap px-2 font-mono text-[9px] text-muted-foreground">
                  Custom {samplingText}
                </span>
              ) : null}
              {pendingSampling != null ? (
                <span className="flex items-center gap-1 whitespace-nowrap px-2 font-mono text-[9px] text-muted-foreground">
                  <RefreshCw className="size-2.5 animate-spin" />
                  Applying {formatSamplingInterval(pendingSampling)}…
                </span>
              ) : samplingError ? (
                <AlertTriangle
                  className="mx-2 size-3.5 text-amber-500"
                  aria-label="Sampling update failed"
                />
              ) : null}
            </div>
            {samplingError ? (
              <output className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-max max-w-72 rounded-md border border-amber-500/30 bg-popover px-3 py-2 font-mono text-[10px] text-amber-600 shadow-xl dark:text-amber-300">
                {samplingError}
              </output>
            ) : null}
          </div>

          <div className="md:hidden" data-testid="mobile-live-sampling">
            <PopoverPrimitive.Root>
              <PopoverPrimitive.Trigger
                className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 font-mono text-[10px] font-semibold shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  healthy
                    ? 'border-primary/25 bg-primary/[0.08] text-primary'
                    : 'border-amber-500/30 bg-amber-500/[0.09] text-amber-500'
                }`}
                aria-label={`${statusName} status, sampling ${samplingText}`}
              >
                {indicator}
                <span className="whitespace-nowrap">
                  {statusName} · {samplingText}
                </span>
                <ChevronDown className="size-3" aria-hidden="true" />
              </PopoverPrimitive.Trigger>
              <PopoverPrimitive.Portal>
                <PopoverPrimitive.Positioner
                  side="bottom"
                  align="end"
                  sideOffset={8}
                  className="z-50"
                >
                  <PopoverPrimitive.Popup className="w-[min(18rem,calc(100vw-2rem))] origin-[var(--transform-origin)] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-2xl outline-none transition duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div>
                        <PopoverPrimitive.Title className="text-xs font-semibold">
                          Sampling
                        </PopoverPrimitive.Title>
                        <PopoverPrimitive.Description className="mt-0.5 text-[10px] text-muted-foreground">
                          Shared live update cadence.
                        </PopoverPrimitive.Description>
                      </div>
                      <span
                        className={`flex items-center gap-1 font-mono text-[9px] ${healthy ? 'text-primary' : 'text-amber-500'}`}
                      >
                        {healthy ? <Check className="size-3" /> : indicator}
                        {statusName}
                      </span>
                    </div>
                    <SamplingChoices
                      allowed={allowedSampling}
                      current={currentSampling}
                      pending={pendingSampling}
                      mobile
                      onSelect={(milliseconds) =>
                        void applySampling(milliseconds)
                      }
                    />
                    <div
                      className="mt-2 min-h-4 font-mono text-[9px] text-muted-foreground"
                      aria-live="polite"
                    >
                      {samplingError ? (
                        <span className="text-amber-500">{samplingError}</span>
                      ) : pendingSampling != null ? (
                        `Applying ${formatSamplingInterval(pendingSampling)}…`
                      ) : customSampling ? (
                        `Current · Custom ${samplingText}`
                      ) : (
                        `Current · ${samplingText}`
                      )}
                    </div>
                  </PopoverPrimitive.Popup>
                </PopoverPrimitive.Positioner>
              </PopoverPrimitive.Portal>
            </PopoverPrimitive.Root>
          </div>

          <span className="hidden font-mono text-[10px] text-muted-foreground xl:inline">
            {time}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onToggleTheme}
            aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
        </div>
      </div>
    </header>
  );
}
