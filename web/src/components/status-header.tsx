import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import {
  AlertTriangle,
  ChevronDown,
  Ellipsis,
  ExternalLink,
  Moon,
  Sun,
} from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { formatSamplingInterval } from '../chart-window';
import type { RuntimeSettings } from '../types';
import { useMediaQuery } from '../use-media-query';
import type { ConnectionState } from '../use-leviathan';
import {
  SegmentedControl,
  type SegmentedControlOption,
} from './segmented-control';

type Props = {
  hostname?: string;
  connection: ConnectionState;
  degraded: boolean;
  settings: RuntimeSettings | null;
  settingsError?: string | null;
  theme: 'dark' | 'light';
  onSamplingIntervalChange: (milliseconds: number) => Promise<RuntimeSettings>;
  onRetrySettings?: () => void;
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
  const options: SegmentedControlOption<number>[] = choices.map(
    (milliseconds) => {
      const isCustom = custom === milliseconds;
      const label = `${isCustom ? 'Custom ' : ''}${formatSamplingInterval(milliseconds)}`;
      return {
        value: milliseconds,
        label,
        ariaLabel: label,
        disabled:
          current == null || (!isCustom && !allowed.includes(milliseconds)),
      };
    },
  );

  return (
    <>
      <SegmentedControl
        ariaLabel="Sampling interval"
        ariaBusy={pending != null}
        className={mobile ? 'w-full' : ''}
        options={options}
        value={current}
        onValueChange={onSelect}
      />
      <output className="sr-only" aria-live="polite">
        {pending == null ? '' : `Applying ${formatSamplingInterval(pending)}`}
      </output>
    </>
  );
}

function StatusHeaderComponent({
  hostname,
  connection,
  degraded,
  settings,
  settingsError = null,
  theme,
  onSamplingIntervalChange,
  onRetrySettings,
  onToggleTheme,
}: Props) {
  const [pendingSampling, setPendingSampling] = useState<number | null>(null);
  const [samplingBusy, setSamplingBusy] = useState(false);
  const [samplingError, setSamplingError] = useState<string | null>(null);
  const settingsSampling = settings?.samplingIntervalMs ?? null;
  const [confirmedOverride, setConfirmedOverride] = useState<{
    source: number | null;
    value: number;
  } | null>(null);
  const confirmedSampling =
    confirmedOverride?.source === settingsSampling
      ? confirmedOverride.value
      : settingsSampling;
  const confirmedSamplingRef = useRef<number | null>(confirmedSampling);
  const settingsSamplingRef = useRef(settingsSampling);
  const optimisticSamplingRef = useRef<number | null>(null);
  const queuedSamplingRef = useRef<number | null>(null);
  const samplingWriteInFlightRef = useRef(false);
  const updateSamplingRef = useRef(onSamplingIntervalChange);
  const desktop = useMediaQuery('(min-width: 768px)');
  const live = connection === 'live';
  const reconnecting =
    connection === 'reconnecting' || connection === 'connecting';
  const statusName = live
    ? degraded
      ? 'Degraded'
      : 'Live'
    : titleCase(connection);
  const healthy = live && !degraded;
  const displayedSampling = pendingSampling ?? confirmedSampling;
  const allowedSampling =
    settings?.allowedSamplingIntervalsMs ?? defaultSamplingIntervals;
  const customSampling =
    confirmedSampling != null &&
    !defaultSamplingIntervals.includes(confirmedSampling)
      ? confirmedSampling
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
  const cadenceError = samplingError ?? settingsError;

  useEffect(() => {
    confirmedSamplingRef.current = confirmedSampling;
    settingsSamplingRef.current = settingsSampling;
    updateSamplingRef.current = onSamplingIntervalChange;
  }, [confirmedSampling, onSamplingIntervalChange, settingsSampling]);

  async function drainSamplingQueue() {
    if (samplingWriteInFlightRef.current) return;
    samplingWriteInFlightRef.current = true;
    setSamplingBusy(true);
    let lastFailure: string | null = null;

    try {
      while (queuedSamplingRef.current != null) {
        const milliseconds = queuedSamplingRef.current;
        queuedSamplingRef.current = null;

        if (milliseconds === confirmedSamplingRef.current) {
          lastFailure = null;
          continue;
        }

        try {
          const settingsAtRequest = settingsSamplingRef.current;
          const next = await updateSamplingRef.current(milliseconds);
          if (settingsSamplingRef.current !== settingsAtRequest) {
            confirmedSamplingRef.current = settingsSamplingRef.current;
            setConfirmedOverride(null);
          } else {
            confirmedSamplingRef.current = next.samplingIntervalMs;
            setConfirmedOverride({
              source: settingsSamplingRef.current,
              value: next.samplingIntervalMs,
            });
          }
          lastFailure = null;
        } catch (reason) {
          lastFailure =
            reason instanceof Error
              ? reason.message
              : 'Sampling update failed.';
        }
      }
    } finally {
      samplingWriteInFlightRef.current = false;
      optimisticSamplingRef.current = null;
      setPendingSampling(null);
      setSamplingBusy(false);
      setSamplingError(lastFailure);
    }
  }

  function applySampling(milliseconds: number) {
    const displayed =
      optimisticSamplingRef.current ?? confirmedSamplingRef.current;
    if (confirmedSamplingRef.current == null || milliseconds === displayed)
      return;
    queuedSamplingRef.current = milliseconds;
    optimisticSamplingRef.current = milliseconds;
    setPendingSampling(milliseconds);
    setSamplingError(null);
    void drainSamplingQueue();
  }

  const indicator = (
    <span
      className={`size-2 shrink-0 rounded-full ${
        healthy
          ? 'bg-primary'
          : live || reconnecting
            ? 'bg-amber-500'
            : 'bg-muted-foreground'
      } ${reconnecting ? 'motion-safe:animate-pulse' : ''}`}
      aria-hidden="true"
    />
  );

  return (
    <header className="leviathan-header sticky top-0 z-30 border-b border-input bg-background/95 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1680px] items-center justify-between gap-2 px-3 sm:gap-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
          <span
            className="leviathan-mark size-8 shrink-0 bg-primary md:size-10"
            style={{
              WebkitMask:
                "url('/leviathan-mark.svg') center / contain no-repeat",
              mask: "url('/leviathan-mark.svg') center / contain no-repeat",
            }}
            aria-hidden="true"
            data-testid="leviathan-header-mark"
          />
          <div className="min-w-0">
            <p className="text-[15px] font-semibold tracking-tight">
              Leviathan
            </p>
            <p className="hidden truncate font-mono text-[13px] uppercase tracking-[0.12em] text-muted-foreground md:block">
              {hostname || 'Connecting to local host'}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div
            className="relative hidden md:block"
            data-testid="desktop-live-sampling"
          >
            <fieldset
              className="flex h-8 items-center gap-2 border-0 p-0"
              aria-label="Live status and sampling"
              aria-busy={samplingBusy}
            >
              <output
                className={`flex h-full items-center gap-1.5 font-mono text-[13px] font-semibold ${healthy ? 'text-foreground' : 'text-amber-700 dark:text-amber-300'}`}
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
                  onSelect={applySampling}
                />
              </div>
            </fieldset>
            {cadenceError ? (
              <output
                role="alert"
                className="sampling-error-popover absolute right-0 top-[calc(100%+0.5rem)] z-50 flex w-max max-w-80 items-center gap-2 rounded-md border border-amber-500/30 bg-popover px-3 py-2 font-mono text-[13px] text-amber-700 shadow-xl dark:text-amber-300"
              >
                <AlertTriangle
                  className="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                <span>{cadenceError}</span>
                {!samplingError && onRetrySettings ? (
                  <button
                    type="button"
                    className="rounded border border-current/35 px-2 py-1 font-semibold outline-none hover:bg-amber-500/10 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={onRetrySettings}
                  >
                    Retry
                  </button>
                ) : null}
              </output>
            ) : null}
          </div>

          <div className="md:hidden" data-testid="mobile-live-sampling">
            <PopoverPrimitive.Root key={desktop ? 'desktop' : 'mobile'}>
              <PopoverPrimitive.Trigger
                className="flex h-8 items-center gap-1.5 rounded-md border border-input bg-popover px-2.5 font-mono text-[13px] font-semibold text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`${statusName} status, sampling ${displayedSamplingText}`}
                aria-busy={samplingBusy}
              >
                {indicator}
                <span className="whitespace-nowrap">
                  <span className="mobile-status-name">{statusName} · </span>
                  {displayedSamplingText}
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
                  <PopoverPrimitive.Popup className="motion-popover w-[min(18rem,calc(100vw-2rem))] origin-[var(--transform-origin)] rounded-lg border border-input bg-popover p-3 text-popover-foreground shadow-2xl outline-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div>
                        <PopoverPrimitive.Title className="text-sm font-semibold">
                          Live cadence
                        </PopoverPrimitive.Title>
                        <PopoverPrimitive.Description className="mt-0.5 text-[13px] text-muted-foreground">
                          {cadenceDetails.length > 0
                            ? cadenceTitle
                            : 'Shared live update cadence.'}
                        </PopoverPrimitive.Description>
                      </div>
                      <span
                        className={`flex items-center gap-1 font-mono text-[13px] ${healthy ? 'text-foreground' : 'text-amber-700 dark:text-amber-300'}`}
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
                        onSelect={applySampling}
                      />
                      {cadenceError ? (
                        <output
                          role="alert"
                          className="sampling-error-popover absolute right-0 top-[calc(100%+0.5rem)] z-50 flex w-max max-w-full items-center gap-2 rounded-md border border-amber-500/30 bg-popover px-3 py-2 font-mono text-[13px] text-amber-700 shadow-xl dark:text-amber-300"
                        >
                          <AlertTriangle
                            className="size-3.5 shrink-0"
                            aria-hidden="true"
                          />
                          <span>{cadenceError}</span>
                          {!samplingError && onRetrySettings ? (
                            <button
                              type="button"
                              className="rounded border border-current/35 px-2 py-1 font-semibold outline-none hover:bg-amber-500/10 focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={onRetrySettings}
                            >
                              Retry
                            </button>
                          ) : null}
                        </output>
                      ) : null}
                    </div>
                  </PopoverPrimitive.Popup>
                </PopoverPrimitive.Positioner>
              </PopoverPrimitive.Portal>
            </PopoverPrimitive.Root>
          </div>

          <div className="hidden items-center gap-1 md:flex">
            <a
              href="https://github.com/intellisys-stevens/leviathan"
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: 'ghost', size: 'icon' })}
              aria-label="Open Leviathan repository on GitHub"
              title="Leviathan on GitHub"
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
              <span className="theme-icon-stack" aria-hidden="true">
                <Sun data-active={theme === 'dark'} />
                <Moon data-active={theme === 'light'} />
              </span>
            </Button>
          </div>

          <div className="mobile-header-more md:hidden">
            <PopoverPrimitive.Root key={desktop ? 'desktop' : 'mobile'}>
              <PopoverPrimitive.Trigger
                className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                aria-label="Open app menu"
              >
                <Ellipsis className="size-5" aria-hidden="true" />
              </PopoverPrimitive.Trigger>
              <PopoverPrimitive.Portal>
                <PopoverPrimitive.Positioner
                  side="bottom"
                  align="end"
                  sideOffset={8}
                  className="z-50"
                >
                  <PopoverPrimitive.Popup className="motion-popover w-[min(15rem,calc(100vw-1.5rem))] origin-[var(--transform-origin)] rounded-xl border border-input bg-popover p-2 text-popover-foreground shadow-2xl outline-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
                    <PopoverPrimitive.Title className="sr-only">
                      App menu
                    </PopoverPrimitive.Title>
                    <div className="grid gap-1">
                      <a
                        href="https://github.com/intellisys-stevens/leviathan"
                        target="_blank"
                        rel="noreferrer"
                        className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label="Open Leviathan repository on GitHub"
                      >
                        <GitHubMark />
                        <span className="flex-1">GitHub repository</span>
                        <ExternalLink
                          className="size-3.5 text-muted-foreground"
                          aria-hidden="true"
                        />
                      </a>
                      <button
                        type="button"
                        className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-left text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={onToggleTheme}
                        aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
                      >
                        {theme === 'dark' ? (
                          <Sun className="size-4" aria-hidden="true" />
                        ) : (
                          <Moon className="size-4" aria-hidden="true" />
                        )}
                        Use {theme === 'dark' ? 'light' : 'dark'} theme
                      </button>
                    </div>
                  </PopoverPrimitive.Popup>
                </PopoverPrimitive.Positioner>
              </PopoverPrimitive.Portal>
            </PopoverPrimitive.Root>
          </div>
        </div>
      </div>
    </header>
  );
}

export const StatusHeader = memo(StatusHeaderComponent);
