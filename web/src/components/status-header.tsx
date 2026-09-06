import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { AlertTriangle, ChevronDown, Moon, Sun } from 'lucide-react';
import { memo } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { formatSamplingInterval } from '../chart-window';
import { displayCadencePresets } from '../display-cadence';
import type { RuntimeSettings } from '../types';
import { useMediaQuery } from '../use-media-query';
import type { ConnectionState } from '../use-leviathan';
import { SegmentedControl } from './segmented-control';

type Props = {
  hostname?: string;
  connection: ConnectionState;
  degraded: boolean;
  settings: RuntimeSettings | null;
  settingsError?: string | null;
  displayCadenceMs: number;
  onDisplayCadenceChange: (milliseconds: number) => void;
  theme: 'dark' | 'light';
  onRetrySettings?: () => void;
  onToggleTheme: () => void;
};

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

function StatusHeaderComponent({
  hostname,
  connection,
  degraded,
  settings,
  settingsError = null,
  displayCadenceMs,
  onDisplayCadenceChange,
  theme,
  onRetrySettings,
  onToggleTheme,
}: Props) {
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
  const hostSamplingIntervalMs = settings?.samplingIntervalMs;
  const displayedCadenceText = formatSamplingInterval(displayCadenceMs);
  const hostSamplingText =
    hostSamplingIntervalMs == null
      ? 'unavailable'
      : formatSamplingInterval(hostSamplingIntervalMs);
  const cadenceDetails = [
    settings?.profileIntervalMs
      ? `profiles ${formatSamplingInterval(settings.profileIntervalMs)}`
      : null,
    settings?.processIntervalMs
      ? `processes ${formatSamplingInterval(settings.processIntervalMs)}`
      : null,
  ].filter((value): value is string => value != null);
  const cadenceTitle = [
    `Host samples ${hostSamplingText}`,
    ...cadenceDetails,
  ].join(' · ');

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
      <div className="leviathan-header-inner mx-auto flex min-h-16 max-w-[1680px] flex-wrap items-center justify-between gap-2 px-3 py-2 sm:gap-3 sm:px-6">
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
            <p className="leviathan-wordmark text-[15px] font-semibold tracking-tight">
              Leviathan
            </p>
            <p className="hidden truncate font-mono text-[13px] uppercase tracking-[0.12em] text-muted-foreground md:block">
              {hostname || 'Connecting to local host'}
            </p>
          </div>
        </div>

        <div className="leviathan-header-actions ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
          <div
            className="relative hidden md:block"
            data-testid="desktop-live-sampling"
          >
            <div
              className="flex h-8 items-center gap-2 border-0 p-0"
              title={`${cadenceTitle}. Browser view updates ${displayedCadenceText}.`}
            >
              <output
                className={`flex h-full items-center gap-1.5 font-mono text-[13px] font-semibold ${healthy ? 'text-foreground' : 'text-amber-700 dark:text-amber-300'}`}
                aria-live="polite"
                aria-label={`Connection status: ${statusName}`}
              >
                {indicator}
                {statusName}
              </output>
              <SegmentedControl
                ariaLabel="View updates"
                options={displayCadencePresets}
                value={displayCadenceMs}
                onValueChange={onDisplayCadenceChange}
              />
            </div>
            {settingsError ? (
              <output
                role="alert"
                className="sampling-error-popover absolute right-0 top-[calc(100%+0.5rem)] z-50 flex w-max max-w-80 items-center gap-2 rounded-md border border-amber-500/30 bg-popover px-3 py-2 font-mono text-[13px] text-amber-700 shadow-xl dark:text-amber-300"
              >
                <AlertTriangle
                  className="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                <span>{settingsError}</span>
                {onRetrySettings ? (
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
                className="mobile-status-trigger flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-md border border-input bg-popover px-2 font-mono text-[13px] font-semibold text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`${statusName} status, view updates ${displayedCadenceText}`}
              >
                {indicator}
                <span className="whitespace-nowrap">
                  <span className="mobile-status-name">{statusName} · </span>
                  {displayedCadenceText}
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
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <PopoverPrimitive.Title className="text-sm font-semibold">
                          View updates
                        </PopoverPrimitive.Title>
                        <p className="mt-1 break-all text-xs text-muted-foreground">
                          {hostname || 'This host'}
                        </p>
                      </div>
                      <span
                        className={`flex items-center gap-1 font-mono text-[13px] ${healthy ? 'text-foreground' : 'text-amber-700 dark:text-amber-300'}`}
                      >
                        {indicator}
                        {statusName}
                      </span>
                    </div>
                    <div className="relative mt-3">
                      <SegmentedControl
                        ariaLabel="View updates"
                        options={displayCadencePresets}
                        value={displayCadenceMs}
                        onValueChange={onDisplayCadenceChange}
                        className="w-full"
                        itemClassName="min-h-11 min-w-11"
                      />
                      {settingsError ? (
                        <output
                          role="alert"
                          className="sampling-error-popover absolute right-0 top-[calc(100%+0.5rem)] z-50 flex w-max max-w-full items-center gap-2 rounded-md border border-amber-500/30 bg-popover px-3 py-2 font-mono text-[13px] text-amber-700 shadow-xl dark:text-amber-300"
                        >
                          <AlertTriangle
                            className="size-3.5 shrink-0"
                            aria-hidden="true"
                          />
                          <span>{settingsError}</span>
                          {onRetrySettings ? (
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

          <div className="flex items-center gap-2">
            <a
              href="https://github.com/intellisys-stevens/leviathan"
              target="_blank"
              rel="noreferrer"
              className={`${buttonVariants({ variant: 'ghost', size: 'icon' })} min-h-11 min-w-11`}
              aria-label="Open Leviathan repository on GitHub"
              title="Leviathan on GitHub"
            >
              <GitHubMark />
            </a>

            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11"
              onClick={onToggleTheme}
              aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
            >
              <span className="theme-icon-stack" aria-hidden="true">
                <Sun data-active={theme === 'dark'} />
                <Moon data-active={theme === 'light'} />
              </span>
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}

export const StatusHeader = memo(StatusHeaderComponent);
