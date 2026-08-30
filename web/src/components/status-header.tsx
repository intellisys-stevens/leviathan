import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { AlertTriangle, ChevronDown, Moon, RefreshCw, Sun } from 'lucide-react';
import { memo, useRef, useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { formatSamplingInterval } from '../chart-window';
import type { RuntimeSettings } from '../types';
import type { ConnectionState } from '../use-miglens';

type Props = {
  hostname: string;
  connection: ConnectionState;
  degraded: boolean;
  settings: RuntimeSettings | null;
  theme: 'dark' | 'light';
  onSamplingIntervalChange: (milliseconds: number) => Promise<RuntimeSettings>;
  onToggleTheme: () => void;
};

type SamplingChoicesProps = {
  allowed: number[];
  custom: number | null;
  current: number | null;
  pending: number | null;
  mobile?: boolean;
  onSelect: (milliseconds: number) => void;
};

const defaultSamplingIntervals = [500, 1000, 2000];

function GitHubMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className="size-4"
      aria-hidden="true"
    >
      <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.3c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.4 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3Z" />
    </svg>
  );
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function SamplingChoices({
  allowed,
  custom,
  current,
  pending,
  mobile = false,
  onSelect,
}: SamplingChoicesProps) {
  const choices =
    custom == null
      ? defaultSamplingIntervals
      : [custom, ...defaultSamplingIntervals];

  return (
    <fieldset
      className={`relative isolate flex gap-1 rounded-md border border-border/80 bg-muted/50 p-0.5 ${mobile ? 'w-full' : ''}`}
      aria-busy={pending != null}
    >
      <legend className="sr-only">Sampling interval</legend>
      {choices.map((milliseconds) => {
        const selected = current === milliseconds;
        const applying = pending === milliseconds;
        const isCustom = custom === milliseconds;
        const label = `${isCustom ? 'Custom ' : ''}${formatSamplingInterval(milliseconds)}`;
        return (
          <button
            key={milliseconds}
            type="button"
            className={`relative whitespace-nowrap rounded px-2 font-mono text-[10px] transition-colors focus-visible:z-20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
              mobile
                ? 'h-8 min-w-0 flex-1'
                : `h-6 flex-none ${isCustom ? '' : 'min-w-10'}`
            } ${
              selected
                ? 'z-10 bg-background text-foreground shadow-sm ring-1 ring-border/60'
                : 'text-muted-foreground hover:bg-background/70 hover:text-foreground'
            }`}
            disabled={
              current == null ||
              pending != null ||
              (!isCustom && !allowed.includes(milliseconds))
            }
            aria-label={label}
            aria-pressed={selected}
            onClick={() => onSelect(milliseconds)}
          >
            <span className={applying ? 'opacity-0' : undefined}>{label}</span>
            {applying ? (
              <RefreshCw
                className="absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 animate-spin"
                aria-hidden="true"
              />
            ) : null}
          </button>
        );
      })}
      <output className="sr-only" aria-live="polite">
        {pending == null ? '' : `Applying ${formatSamplingInterval(pending)}`}
      </output>
    </fieldset>
  );
}

function StatusHeaderComponent({
  hostname,
  connection,
  degraded,
  settings,
  theme,
  onSamplingIntervalChange,
  onToggleTheme,
}: Props) {
  const [pendingSampling, setPendingSampling] = useState<number | null>(null);
  const [samplingError, setSamplingError] = useState<string | null>(null);
  const pendingSamplingRef = useRef<number | null>(null);
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
  const displayedSampling = pendingSampling ?? currentSampling;
  const allowedSampling =
    settings?.allowedSamplingIntervalsMs ?? defaultSamplingIntervals;
  const customSampling =
    currentSampling != null &&
    !defaultSamplingIntervals.includes(currentSampling)
      ? currentSampling
      : null;
  const displayedSamplingText =
    displayedSampling == null ? '—' : formatSamplingInterval(displayedSampling);
  const cadenceDetails = [
    settings?.profileIntervalMs
      ? `profiles ${formatSamplingInterval(settings.profileIntervalMs)}`
      : null,
    settings?.processIntervalMs
      ? `processes ${formatSamplingInterval(settings.processIntervalMs)}`
      : null,
  ].filter((value): value is string => value != null);
  const cadenceTitle = [
    `GPU metrics ${displayedSamplingText}`,
    ...cadenceDetails,
  ].join(' · ');

  async function applySampling(milliseconds: number) {
    if (milliseconds === currentSampling || pendingSamplingRef.current != null)
      return;
    pendingSamplingRef.current = milliseconds;
    setPendingSampling(milliseconds);
    setSamplingError(null);
    try {
      await onSamplingIntervalChange(milliseconds);
    } catch (reason) {
      setSamplingError(
        reason instanceof Error ? reason.message : 'Sampling update failed.',
      );
    } finally {
      pendingSamplingRef.current = null;
      setPendingSampling(null);
    }
  }

  const indicator = (
    <span
      className={`size-2 shrink-0 rounded-full ${
        healthy
          ? 'bg-primary'
          : live || reconnecting
            ? 'bg-amber-500'
            : 'bg-muted-foreground'
      } ${reconnecting ? 'animate-pulse' : ''}`}
      aria-hidden="true"
    />
  );

  return (
    <header className="sticky top-0 z-30 border-b border-border/80 bg-background/95 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1680px] items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="size-9 shrink-0 bg-foreground"
            style={{
              WebkitMask: "url('/miglens-mark.png') center / contain no-repeat",
              mask: "url('/miglens-mark.png') center / contain no-repeat",
            }}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight">MIGLens</p>
            <p className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              {hostname} · local read-only
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div
            className="relative hidden md:block"
            data-testid="desktop-live-sampling"
          >
            <div
              className="flex h-8 items-center gap-2"
              aria-label="Live status and sampling"
              aria-busy={pendingSampling != null}
            >
              <output
                className={`flex h-full items-center gap-1.5 font-mono text-[10px] font-semibold ${healthy ? 'text-foreground' : 'text-amber-500'}`}
                aria-live="polite"
                aria-label={`Connection status: ${statusName}`}
              >
                {indicator}
                {statusName}
              </output>
              <div title={cadenceTitle}>
                <SamplingChoices
                  allowed={allowedSampling}
                  custom={customSampling}
                  current={displayedSampling}
                  pending={pendingSampling}
                  onSelect={(milliseconds) => void applySampling(milliseconds)}
                />
              </div>
            </div>
            {samplingError ? (
              <output
                role="alert"
                className="absolute right-0 top-[calc(100%+0.5rem)] z-50 flex w-max max-w-72 items-center gap-1.5 rounded-md border border-amber-500/30 bg-popover px-3 py-2 font-mono text-[10px] text-amber-600 shadow-xl dark:text-amber-300"
              >
                <AlertTriangle
                  className="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                <span>{samplingError}</span>
              </output>
            ) : null}
          </div>

          <div className="md:hidden" data-testid="mobile-live-sampling">
            <PopoverPrimitive.Root>
              <PopoverPrimitive.Trigger
                className="flex h-8 items-center gap-1.5 rounded-md border border-border/80 bg-muted/50 px-2.5 font-mono text-[10px] font-semibold text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`${statusName} status, sampling ${displayedSamplingText}`}
                aria-busy={pendingSampling != null}
              >
                {indicator}
                <span className="whitespace-nowrap">
                  {statusName} · {displayedSamplingText}
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
                          Live cadence
                        </PopoverPrimitive.Title>
                        <PopoverPrimitive.Description className="mt-0.5 text-[10px] text-muted-foreground">
                          {cadenceDetails.length > 0
                            ? cadenceTitle
                            : 'Shared live update cadence.'}
                        </PopoverPrimitive.Description>
                      </div>
                      <span
                        className={`flex items-center gap-1 font-mono text-[9px] ${healthy ? 'text-foreground' : 'text-amber-500'}`}
                      >
                        {indicator}
                        {statusName}
                      </span>
                    </div>
                    <div className="relative">
                      <SamplingChoices
                        allowed={allowedSampling}
                        custom={customSampling}
                        current={displayedSampling}
                        pending={pendingSampling}
                        mobile
                        onSelect={(milliseconds) =>
                          void applySampling(milliseconds)
                        }
                      />
                      {samplingError ? (
                        <output
                          role="alert"
                          className="absolute right-0 top-[calc(100%+0.5rem)] z-50 flex w-max max-w-full items-center gap-1.5 rounded-md border border-amber-500/30 bg-popover px-3 py-2 font-mono text-[9px] text-amber-600 shadow-xl dark:text-amber-300"
                        >
                          <AlertTriangle
                            className="size-3.5 shrink-0"
                            aria-hidden="true"
                          />
                          <span>{samplingError}</span>
                        </output>
                      ) : null}
                    </div>
                  </PopoverPrimitive.Popup>
                </PopoverPrimitive.Positioner>
              </PopoverPrimitive.Portal>
            </PopoverPrimitive.Root>
          </div>

          <a
            href="https://github.com/intellisys-stevens/miglens"
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: 'ghost', size: 'icon' })}
            aria-label="Open MIGLens repository on GitHub"
            title="MIGLens on GitHub"
          >
            <GitHubMark />
          </a>

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

export const StatusHeader = memo(StatusHeaderComponent);
