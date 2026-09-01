import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  Database,
  LayoutDashboard,
  RefreshCw,
  Server,
  Users,
  XIcon,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { DiagnosticsPanel } from './components/diagnostics-panel';
import { AmbientSnow } from './components/ambient-snow';
import { ChartWindowControl } from './components/chart-window-control';
import { GPUCard } from './components/gpu-card';
import { PerimeterLight } from './components/perimeter-light';
import { PeopleView } from './components/people-view';
import { ProcessTable } from './components/process-table';
import { StatusHeader } from './components/status-header';
import { AttributionSummary } from './components/workspace-attribution';
import {
  readBrowserSetting,
  removeBrowserSetting,
  writeBrowserSetting,
} from './browser-storage';
import {
  chartWindowStorageKey,
  defaultHistoryWindowMs,
  detailChartWindowStorageKey,
  effectiveChartWindow,
  storedChartWindow,
  storedDetailChartWindow,
} from './chart-window';
import {
  displayCadenceStorageKey,
  normalizeDisplayCadence,
  storedDisplayCadence,
} from './display-cadence';
import type { BuildInfo, Selection, SelectionKey, Snapshot } from './types';
import { useMediaQuery } from './use-media-query';
import { useLeviathan } from './use-leviathan';

const DetailSheet = lazy(() => import('./components/detail-sheet'));
const OverviewCharts = lazy(() => import('./components/overview-charts'));
const themeKey = 'leviathan.theme.v1';
const legacyDashboardViewKey = 'leviathan.dashboardView.v1';

export type WorkbenchView =
  | 'overview'
  | 'resources'
  | 'workloads'
  | 'operations';

type OperationsFocus = 'processes' | 'diagnostics';

type ViewDefinition = {
  id: WorkbenchView;
  label: string;
  icon: LucideIcon;
};

export const workbenchViews: readonly ViewDefinition[] = [
  {
    id: 'overview',
    label: 'Overview',
    icon: LayoutDashboard,
  },
  {
    id: 'resources',
    label: 'Resources',
    icon: Boxes,
  },
  {
    id: 'workloads',
    label: 'Workloads',
    icon: Users,
  },
  {
    id: 'operations',
    label: 'Operations',
    icon: Database,
  },
] as const;

const validViews = new Set<WorkbenchView>(workbenchViews.map(({ id }) => id));

export function parseWorkbenchHash(hash: string): WorkbenchView | null {
  const candidate = hash.startsWith('#') ? hash.slice(1) : hash;
  if (candidate === 'processes' || candidate === 'diagnostics') {
    return 'operations';
  }
  return validViews.has(candidate as WorkbenchView)
    ? (candidate as WorkbenchView)
    : null;
}

export function operationsFocusForHash(hash: string): OperationsFocus | null {
  const candidate = hash.startsWith('#') ? hash.slice(1) : hash;
  return candidate === 'processes' || candidate === 'diagnostics'
    ? candidate
    : null;
}

export function resolveInitialWorkbenchView(
  hash: string,
  legacyView: string | null,
): WorkbenchView {
  const direct = parseWorkbenchHash(hash);
  if (direct) return direct;
  if (hash.length > 0) return 'overview';
  if (legacyView === 'people') return 'workloads';
  if (legacyView === 'gpus') return 'resources';
  return 'overview';
}

function initialWorkbenchView(hash: string): WorkbenchView {
  const hasExplicitFragment = window.location.href.includes('#');
  const legacyView =
    hash.length === 0 && !hasExplicitFragment
      ? readBrowserSetting(legacyDashboardViewKey)
      : null;
  const view = resolveInitialWorkbenchView(hash, legacyView);
  if (legacyView === 'people' || legacyView === 'gpus') {
    removeBrowserSetting(legacyDashboardViewKey);
  }
  if (hash !== `#${view}`) {
    window.history.replaceState(window.history.state, '', `#${view}`);
  }
  return view;
}

export function formatBuildVersion(
  buildInfo: BuildInfo | null | undefined,
): string {
  if (buildInfo === undefined) return '…';
  if (buildInfo === null) return 'unavailable';
  const version = buildInfo.version.trim();
  if (!version) return 'unavailable';
  if (version.toLowerCase() === 'dev') return 'dev';
  return version.startsWith('v') || version.startsWith('V')
    ? version
    : `v${version}`;
}

function selectedEntity(
  snapshot: Snapshot,
  key: SelectionKey | null,
): Selection | null {
  if (!key) return null;
  if (key.kind === 'physical_gpu') {
    const gpu = snapshot.gpus.find((candidate) => candidate.uuid === key.uuid);
    return gpu ? { kind: 'physical_gpu', gpu } : null;
  }
  for (const gpu of snapshot.gpus) {
    for (const gi of gpu.gpuInstances) {
      for (const ci of gi.computeInstances) {
        if (ci.uuid === key.uuid)
          return { kind: 'compute_instance', gpu, gi, ci };
      }
    }
  }
  return null;
}

function summaryFor(snapshot: Snapshot | null) {
  if (!snapshot)
    return {
      gpu: 0,
      gi: 0,
      processes: 0,
      assignedUsers: null,
      assignedWorkspaces: null,
    };
  let gi = 0;
  for (const gpu of snapshot.gpus) {
    gi += gpu.gpuInstances.length;
  }
  let assignedUsers: number | null = null;
  let assignedWorkspaces: number | null = null;
  const attribution = snapshot.attribution;
  if (attribution?.status === 'available') {
    const assignedRefs = new Set(
      attribution.assignments.map(({ workloadRef }) => workloadRef),
    );
    const assigned = attribution.workloads.filter(({ ref }) =>
      assignedRefs.has(ref),
    );
    assignedUsers = new Set(assigned.map(({ ownerName }) => ownerName)).size;
    assignedWorkspaces = new Set(assigned.map(({ ref }) => ref)).size;
  }
  return {
    gpu: snapshot.gpus.length,
    gi,
    processes: snapshot.processes.length,
    assignedUsers,
    assignedWorkspaces,
  };
}

function countLabel(value: number, singular: string, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}

type BrowserViewTransition = {
  finished: Promise<void>;
  ready: Promise<void>;
  skipTransition: () => void;
  updateCallbackDone: Promise<void>;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => BrowserViewTransition;
};

function WorkbenchLoading({
  view,
  headingRef,
}: {
  view: ViewDefinition;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <section
      className="workbench-view space-y-5"
      aria-label={`Loading ${view.label.toLowerCase()} view`}
      aria-busy="true"
      aria-live="polite"
    >
      <div>
        <h1
          id="workbench-view-heading"
          ref={headingRef}
          tabIndex={-1}
          className="view-title"
        >
          {view.label}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Establishing the first complete host snapshot…
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-72 w-full md:col-span-2" />
      </div>
    </section>
  );
}

function ViewIntro({
  view,
  headingRef,
}: {
  view: ViewDefinition;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <div className="view-intro">
      <h1
        id="workbench-view-heading"
        ref={headingRef}
        tabIndex={-1}
        className="view-title"
      >
        {view.label}
      </h1>
    </div>
  );
}

const WorkbenchNavigation = memo(function WorkbenchNavigation({
  activeView,
  diagnosticCount,
  mobile,
  onNavigate,
}: {
  activeView: WorkbenchView;
  diagnosticCount: number;
  mobile: boolean;
  onNavigate: (view: WorkbenchView) => void;
}) {
  return (
    <nav
      className={
        mobile
          ? 'mobile-workbench-nav workbench-nav fixed inset-x-0 bottom-0 z-40 border-t border-border/80 bg-background/92 backdrop-blur-md'
          : 'desktop-workbench-nav workbench-nav sticky top-16 z-20 border-b border-border/80 bg-background/92 backdrop-blur-md'
      }
      aria-label={mobile ? 'Mobile workbench views' : 'Workbench views'}
      data-placement={mobile ? 'bottom' : 'top'}
    >
      <div
        className={
          mobile
            ? 'mx-auto grid max-w-lg grid-cols-4 px-2 pb-[env(safe-area-inset-bottom)] pt-1.5'
            : 'mx-auto flex max-w-[1680px] gap-1 overflow-x-auto px-3 py-2 sm:px-5'
        }
      >
        {workbenchViews.map(({ id, label, icon: Icon }) => {
          const current = id === activeView;
          return (
            <a
              key={id}
              href={`#${id}`}
              className={`workbench-nav-link flowing-surface ${
                mobile
                  ? 'mobile-workbench-nav-link flex-col justify-center gap-0.5 px-1 py-1.5 text-center'
                  : ''
              }`}
              data-active={current}
              aria-current={current ? 'page' : undefined}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                onNavigate(id);
              }}
            >
              <PerimeterLight />
              <span className="relative inline-flex" aria-hidden="true">
                <Icon className={mobile ? 'size-5' : 'size-4'} />
                {mobile && id === 'operations' && diagnosticCount > 0 ? (
                  <span className="diagnostic-count mobile-diagnostic-count absolute -right-3 -top-2">
                    {diagnosticCount}
                  </span>
                ) : null}
              </span>
              <span>{label}</span>
              {!mobile && id === 'operations' && diagnosticCount > 0 ? (
                <span
                  className="diagnostic-count"
                  aria-label={`${diagnosticCount} active`}
                >
                  {diagnosticCount}
                </span>
              ) : null}
              {mobile && id === 'operations' && diagnosticCount > 0 ? (
                <span className="sr-only">
                  , {diagnosticCount} active diagnostics
                </span>
              ) : null}
            </a>
          );
        })}
      </div>
    </nav>
  );
});

function GPUGrid({
  snapshot,
  onSelect,
}: {
  snapshot: Snapshot;
  onSelect: (selection: Selection) => void;
}) {
  return (
    <div className="grid grid-cols-1 items-stretch gap-4 xl:grid-cols-2">
      {snapshot.gpus.length === 0 ? (
        <div className="frost-panel border border-dashed border-border bg-card p-10 text-center xl:col-span-2">
          <p className="text-[15px] font-medium">No NVIDIA GPUs detected</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Run <span className="font-mono">leviathan doctor</span> to inspect
            driver and library visibility.
          </p>
        </div>
      ) : (
        snapshot.gpus.map((gpu) => (
          <GPUCard
            key={gpu.uuid}
            gpu={gpu}
            attribution={snapshot.attribution}
            onSelect={onSelect}
          />
        ))
      )}
    </div>
  );
}

export function DetailSheetFallback({
  open,
  onOpenChange,
  onOpenChangeComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete?: (open: boolean) => void;
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <SheetContent
        className="detail-sheet-surface mobile-detail-sheet frost-sheet w-full max-w-none overflow-y-auto border-input bg-popover p-6"
        data-testid="detail-sheet-fallback"
        showCloseButton={false}
      >
        <SheetHeader className="mobile-detail-sheet-header relative p-0 pr-12 text-left">
          <SheetClose
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute -top-1 right-0 min-h-11 min-w-11"
              />
            }
          >
            <XIcon aria-hidden="true" />
            <span className="sr-only">Close</span>
          </SheetClose>
          <p className="eyebrow">Resource inspection</p>
          <SheetTitle className="mt-2 text-lg font-semibold">
            Loading resource details
          </SheetTitle>
        </SheetHeader>
        <SheetDescription className="text-sm" aria-live="polite">
          Preparing retained telemetry and attribution…
        </SheetDescription>
        <Skeleton className="mt-6 h-16 w-2/3" />
        <Skeleton className="mt-6 h-64 w-full" />
      </SheetContent>
    </Sheet>
  );
}

export function App() {
  const [displayCadenceMs, setDisplayCadenceMs] = useState(() =>
    storedDisplayCadence(),
  );
  const leviathan = useLeviathan(displayCadenceMs);
  const {
    snapshot,
    connection,
    error: legacyError,
    history,
    alignedHistory,
    settings,
    buildInfo,
  } = leviathan;
  const snapshotError =
    leviathan.snapshotError ?? (!snapshot ? legacyError : null);
  const streamError = leviathan.streamError ?? (snapshot ? legacyError : null);
  const settingsError = leviathan.settingsError ?? null;
  const retrySnapshot = leviathan.retrySnapshot ?? (() => undefined);
  const retrySettings = leviathan.retrySettings ?? (() => undefined);
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== displayCadenceStorageKey) return;
      setDisplayCadenceMs(normalizeDisplayCadence(event.newValue));
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);
  const [initialHash] = useState(() => window.location.hash);
  const pendingOperationsFocusRef = useRef<OperationsFocus | null>(
    operationsFocusForHash(initialHash),
  );
  const [activeView, setActiveView] = useState<WorkbenchView>(() =>
    initialWorkbenchView(initialHash),
  );
  const activeViewRef = useRef(activeView);
  const viewHeadingRef = useRef<HTMLHeadingElement>(null);
  const activeTransitionRef = useRef<BrowserViewTransition | null>(null);
  const [selectedKey, setSelectedKey] = useState<SelectionKey | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const detailMountedRef = useRef(false);
  const pendingDestinationFocusRef = useRef<{
    focus: boolean;
    operationsFocus?: OperationsFocus | null;
  } | null>(null);
  const [processQuery, setProcessQuery] = useState('');
  const [selectedPersonKey, setSelectedPersonKey] = useState<string | null>(
    null,
  );
  const [requestedChartWindowMs, setRequestedChartWindowMs] =
    useState(storedChartWindow);
  const [requestedDetailChartWindowMs, setRequestedDetailChartWindowMs] =
    useState(storedDetailChartWindow);
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    readBrowserSetting(themeKey) === 'light' ? 'light' : 'dark',
  );
  const desktopWorkbench = useMediaQuery('(min-width: 768px)', true);

  const focusDestination = useCallback(
    (focus: boolean, operationsFocus?: OperationsFocus | null) => {
      window.requestAnimationFrame(() => {
        if (operationsFocus) {
          const heading = document.getElementById(
            operationsFocus === 'diagnostics'
              ? 'diagnostics-heading'
              : 'process-heading',
          );
          if (!heading) {
            pendingOperationsFocusRef.current = operationsFocus;
            return;
          }
          pendingOperationsFocusRef.current = null;
          heading.scrollIntoView?.({ block: 'start', behavior: 'auto' });
          if (focus) heading.focus({ preventScroll: true });
          return;
        }
        pendingOperationsFocusRef.current = null;
        window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
        if (focus) viewHeadingRef.current?.focus({ preventScroll: true });
      });
    },
    [],
  );

  const changeView = useCallback(
    (
      next: WorkbenchView,
      focus = true,
      operationsFocus?: OperationsFocus | null,
    ) => {
      const deferDestinationFocus = detailMountedRef.current;
      if (deferDestinationFocus) {
        pendingDestinationFocusRef.current = { focus, operationsFocus };
      }
      if (activeViewRef.current === next) {
        setDetailOpen(false);
        if (!deferDestinationFocus) focusDestination(focus, operationsFocus);
        return;
      }
      setDetailOpen(false);
      const commit = () => {
        flushSync(() => setActiveView(next));
        activeViewRef.current = next;
        if (!deferDestinationFocus) focusDestination(focus, operationsFocus);
      };
      const reducedMotion = window.matchMedia?.(
        '(prefers-reduced-motion: reduce)',
      ).matches;
      const transitionDocument = document as ViewTransitionDocument;
      if (!reducedMotion && transitionDocument.startViewTransition) {
        activeTransitionRef.current?.skipTransition();
        const transition = transitionDocument.startViewTransition(commit);
        activeTransitionRef.current = transition;
        void transition.ready.catch(() => undefined);
        void transition.updateCallbackDone.catch(() => undefined);
        const clearTransition = () => {
          if (activeTransitionRef.current === transition)
            activeTransitionRef.current = null;
        };
        void transition.finished.then(clearTransition, clearTransition);
      } else {
        commit();
      }
    },
    [focusDestination],
  );

  const navigateTo = useCallback(
    (next: WorkbenchView, operationsFocus?: OperationsFocus) => {
      if (window.location.hash !== `#${next}`) {
        window.history.pushState(window.history.state, '', `#${next}`);
      }
      changeView(next, true, operationsFocus);
    },
    [changeView],
  );

  useEffect(() => {
    const previousScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    return () => {
      window.history.scrollRestoration = previousScrollRestoration;
    };
  }, []);

  useEffect(() => {
    if (!operationsFocusForHash(initialHash)) focusDestination(false);
  }, [focusDestination, initialHash]);

  useEffect(() => {
    const onHashChange = () => {
      const operationsFocus = operationsFocusForHash(window.location.hash);
      const parsed = parseWorkbenchHash(window.location.hash);
      const next = parsed ?? 'overview';
      if (!parsed || operationsFocus) {
        window.history.replaceState(window.history.state, '', `#${next}`);
      }
      changeView(next, true, operationsFocus);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [changeView]);

  useEffect(() => {
    const syncVisibility = () => {
      document.documentElement.dataset.ambientPaused = document.hidden
        ? 'true'
        : 'false';
    };
    syncVisibility();
    document.addEventListener('visibilitychange', syncVisibility);
    return () => {
      document.removeEventListener('visibilitychange', syncVisibility);
      delete document.documentElement.dataset.ambientPaused;
    };
  }, []);

  useEffect(() => {
    if (!snapshot || activeView !== 'operations') return;
    const focus = pendingOperationsFocusRef.current;
    if (!focus) return;
    pendingOperationsFocusRef.current = null;
    focusDestination(true, focus);
  }, [activeView, focusDestination, snapshot]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#09131f' : '#edf6f8');
    writeBrowserSetting(themeKey, theme);
  }, [theme]);

  const openSelection = useCallback((next: Selection) => {
    detailMountedRef.current = true;
    setSelectedKey(
      next.kind === 'physical_gpu'
        ? { kind: next.kind, uuid: next.gpu.uuid }
        : { kind: next.kind, uuid: next.ci.uuid },
    );
    setDetailOpen(true);
  }, []);

  const handleDetailOpenChange = useCallback((open: boolean) => {
    if (open) detailMountedRef.current = true;
    setDetailOpen(open);
  }, []);

  const handleDetailOpenChangeComplete = useCallback(
    (open: boolean) => {
      if (open) return;
      detailMountedRef.current = false;
      setSelectedKey(null);
      const pending = pendingDestinationFocusRef.current;
      if (!pending) return;
      pendingDestinationFocusRef.current = null;
      focusDestination(pending.focus, pending.operationsFocus);
    },
    [focusDestination],
  );
  const retentionMs = Math.max(
    1,
    settings?.historyWindowMs ?? defaultHistoryWindowMs,
  );
  const chartWindowMs = effectiveChartWindow(
    requestedChartWindowMs,
    retentionMs,
  );
  const detailChartWindowMs = effectiveChartWindow(
    requestedDetailChartWindowMs,
    retentionMs,
  );

  const selectChartWindow = useCallback((milliseconds: number) => {
    setRequestedChartWindowMs(milliseconds);
    writeBrowserSetting(chartWindowStorageKey, String(milliseconds));
  }, []);

  const selectDetailChartWindow = useCallback((milliseconds: number) => {
    setRequestedDetailChartWindowMs(milliseconds);
    writeBrowserSetting(detailChartWindowStorageKey, String(milliseconds));
  }, []);

  const selectDisplayCadence = useCallback((milliseconds: number) => {
    const next = normalizeDisplayCadence(milliseconds);
    setDisplayCadenceMs(next);
    writeBrowserSetting(displayCadenceStorageKey, String(next));
  }, []);

  const summary = useMemo(() => summaryFor(snapshot), [snapshot]);
  const selection = snapshot ? selectedEntity(snapshot, selectedKey) : null;
  useEffect(() => {
    if (!selectedKey || selection) return;
    const frame = window.requestAnimationFrame(() => {
      detailMountedRef.current = false;
      setDetailOpen(false);
      setSelectedKey(null);
      const pending = pendingDestinationFocusRef.current;
      if (!pending) return;
      pendingDestinationFocusRef.current = null;
      focusDestination(pending.focus, pending.operationsFocus);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusDestination, selectedKey, selection]);
  const activeDefinition =
    workbenchViews.find(({ id }) => id === activeView) ?? workbenchViews[0];
  const activeDiagnostics =
    snapshot?.diagnostics.filter(({ severity }) => severity !== 'info') ?? [];
  const degraded = activeDiagnostics.length > 0;
  const globalIssue =
    snapshotError ||
    streamError ||
    connection !== 'live' ||
    activeDiagnostics.length > 0;

  const summaryItems: Array<{
    value: string;
    label: string;
    mobileLabel: string;
    ariaLabel: string;
    icon: LucideIcon;
    target: WorkbenchView;
  }> = [
    {
      value: `${countLabel(summary.gpu, 'GPU')} · ${countLabel(summary.gi, 'instance')}`,
      label: 'Resources',
      mobileLabel: 'Resources',
      ariaLabel: `Resources: ${countLabel(summary.gpu, 'physical GPU')} and ${countLabel(summary.gi, 'GPU instance')}`,
      icon: Server,
      target: 'resources',
    },
    {
      value:
        summary.assignedUsers == null || summary.assignedWorkspaces == null
          ? '—'
          : `${countLabel(summary.assignedUsers, 'user')} · ${countLabel(summary.assignedWorkspaces, 'workspace')}`,
      label: 'Assigned workloads',
      mobileLabel: 'Workloads',
      ariaLabel:
        summary.assignedUsers == null || summary.assignedWorkspaces == null
          ? 'Assigned workloads: unavailable'
          : `Assigned workloads: ${countLabel(summary.assignedUsers, 'user')} and ${countLabel(summary.assignedWorkspaces, 'workspace')}`,
      icon: Users,
      target: 'workloads',
    },
    {
      value: String(summary.processes),
      label: 'GPU processes',
      mobileLabel: 'Processes',
      ariaLabel: `GPU processes: ${summary.processes}`,
      icon: Database,
      target: 'operations',
    },
  ];

  return (
    <div className="app-shell min-h-screen text-foreground">
      <AmbientSnow enabled={theme === 'dark'} />
      <StatusHeader
        hostname={snapshot?.host.hostname}
        connection={connection}
        degraded={degraded}
        settings={settings}
        settingsError={settingsError}
        theme={theme}
        displayCadenceMs={displayCadenceMs}
        onDisplayCadenceChange={selectDisplayCadence}
        onRetrySettings={retrySettings}
        onToggleTheme={() =>
          setTheme((value) => (value === 'dark' ? 'light' : 'dark'))
        }
      />

      <WorkbenchNavigation
        activeView={activeView}
        diagnosticCount={activeDiagnostics.length}
        mobile={!desktopWorkbench}
        onNavigate={navigateTo}
      />

      <main className="mx-auto max-w-[1680px] px-4 py-5 sm:px-6 sm:py-7">
        {globalIssue ? (
          <section
            className="health-ribbon mb-5"
            aria-label="Active host health"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                {snapshotError
                  ? snapshot
                    ? `${snapshotError} The last complete snapshot remains visible.`
                    : snapshotError
                  : connection !== 'live'
                    ? `Live stream ${connection}. The last complete snapshot remains visible.${streamError ? ` ${streamError}` : ''}`
                    : streamError
                      ? streamError
                      : `${activeDiagnostics.length} active provider ${activeDiagnostics.length === 1 ? 'diagnostic' : 'diagnostics'}.`}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {snapshotError ? (
                <Button size="sm" variant="outline" onClick={retrySnapshot}>
                  <RefreshCw aria-hidden="true" /> Retry snapshot
                </Button>
              ) : null}
              {snapshot ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => navigateTo('operations', 'diagnostics')}
                >
                  Diagnostics <ArrowRight aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          </section>
        ) : null}

        {!snapshot ? (
          <WorkbenchLoading
            view={activeDefinition}
            headingRef={viewHeadingRef}
          />
        ) : (
          <div
            className="workbench-view"
            key={activeView}
            data-view={activeView}
          >
            <ViewIntro view={activeDefinition} headingRef={viewHeadingRef} />

            {activeView === 'overview' ? (
              <div className="mt-6 space-y-5">
                <section
                  className="overview-summary frost-panel snow-capped"
                  data-snow-cap="split"
                  aria-label="Host summary"
                >
                  <div className="overview-attribution-cell">
                    <AttributionSummary
                      attribution={snapshot.attribution}
                      snapshot={snapshot}
                    />
                  </div>
                  <div className="overview-kpi-grid" aria-label="Host totals">
                    {summaryItems.map(
                      ({
                        value,
                        label,
                        mobileLabel,
                        ariaLabel,
                        icon: Icon,
                        target,
                      }) => (
                        <button
                          key={label}
                          type="button"
                          className="summary-link flowing-surface group rounded-lg text-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          aria-label={ariaLabel}
                          onClick={() => navigateTo(target)}
                        >
                          <PerimeterLight />
                          <span className="flex items-center justify-center gap-1.5 font-mono text-lg font-semibold text-primary">
                            <Icon
                              className="summary-icon size-4"
                              aria-hidden="true"
                            />{' '}
                            {value}
                          </span>
                          <span
                            className="mt-1 block text-[13px] font-medium text-muted-foreground"
                            aria-hidden="true"
                          >
                            <span className="desktop-only-label">{label}</span>
                            <span className="mobile-only-label">
                              {mobileLabel}
                            </span>
                          </span>
                        </button>
                      ),
                    )}
                  </div>
                </section>

                <section aria-labelledby="host-telemetry-heading">
                  <div className="section-heading-row">
                    <h2 id="host-telemetry-heading" className="section-title">
                      Telemetry
                    </h2>
                    <ChartWindowControl
                      chartWindowMs={chartWindowMs}
                      retentionMs={retentionMs}
                      onChartWindowChange={selectChartWindow}
                    />
                  </div>
                  {snapshot.gpus.length === 0 ? (
                    <div className="mt-4 border border-dashed border-border bg-card p-10 text-center">
                      <p className="text-[15px] font-medium">
                        Host telemetry unavailable
                      </p>
                      <p className="mt-1 text-[13px] text-muted-foreground">
                        No GPU entities are available for history collection.
                      </p>
                    </div>
                  ) : (
                    <Suspense
                      fallback={
                        <section
                          className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2"
                          aria-label="Loading GPU history charts"
                        >
                          {[
                            'utilization',
                            'memory',
                            'temperature',
                            'memory-activity',
                            'pcie',
                          ].map((name) => (
                            <Skeleton key={name} className="h-[320px] w-full" />
                          ))}
                        </section>
                      }
                    >
                      <OverviewCharts
                        snapshot={snapshot}
                        connection={connection}
                        loadHistory={alignedHistory}
                        chartWindowMs={chartWindowMs}
                        retentionMs={retentionMs}
                      />
                    </Suspense>
                  )}
                </section>
              </div>
            ) : null}

            {activeView === 'resources' ? (
              <section className="mt-6" aria-labelledby="gpu-topology-heading">
                <h2 id="gpu-topology-heading" className="section-title mb-3">
                  GPU topology
                </h2>
                <GPUGrid snapshot={snapshot} onSelect={openSelection} />
              </section>
            ) : null}

            {activeView === 'workloads' ? (
              <section
                className="mt-6 space-y-4"
                aria-labelledby="assigned-workloads-heading"
              >
                <h2 id="assigned-workloads-heading" className="section-title">
                  Assigned workspaces
                </h2>
                <AttributionSummary
                  attribution={snapshot.attribution}
                  snapshot={snapshot}
                />
                <PeopleView
                  snapshot={snapshot}
                  onSelect={openSelection}
                  selectedPersonKey={selectedPersonKey}
                  onSelectedPersonChange={setSelectedPersonKey}
                  loadHistory={alignedHistory}
                  chartWindowMs={chartWindowMs}
                  retentionMs={retentionMs}
                  onChartWindowChange={selectChartWindow}
                />
              </section>
            ) : null}

            {activeView === 'operations' ? (
              <div className="mt-6 space-y-5">
                <ProcessTable
                  processes={snapshot.processes}
                  procCapability={snapshot.capabilities.proc}
                  attribution={snapshot.attribution}
                  query={processQuery}
                  onQueryChange={setProcessQuery}
                />
                <DiagnosticsPanel diagnostics={snapshot.diagnostics} />
              </div>
            ) : null}
          </div>
        )}

        <footer className="app-footer mt-8 border-t border-border/70 pb-1 pt-4 text-center text-[13px] text-muted-foreground">
          <p className="desktop-footer-copy flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5">
            <span>
              Built with <span aria-hidden="true">⚔️</span> by{' '}
              <a
                href="https://intellisys.haow.us/team/"
                className="font-semibold text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Intellisys Dragoons
              </a>{' '}
              and Codex
            </span>{' '}
            <span className="whitespace-nowrap font-mono text-[13px]">
              · Leviathan {formatBuildVersion(buildInfo)}
            </span>
          </p>
          <p className="mobile-footer-copy">
            <span>
              <span aria-hidden="true">⚔️</span>{' '}
              <a
                href="https://intellisys.haow.us/team/"
                className="font-semibold text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Intellisys Dragoons
              </a>{' '}
              <span aria-hidden="true">×</span> Codex{' '}
            </span>
            <span className="font-mono text-[13px]">
              Leviathan {formatBuildVersion(buildInfo)}
            </span>
          </p>
        </footer>
      </main>

      {selection ? (
        <Suspense
          fallback={
            <DetailSheetFallback
              open={detailOpen}
              onOpenChange={handleDetailOpenChange}
              onOpenChangeComplete={handleDetailOpenChangeComplete}
            />
          }
        >
          <DetailSheet
            selection={selection}
            attribution={snapshot?.attribution}
            open={detailOpen}
            onOpenChange={handleDetailOpenChange}
            onOpenChangeComplete={handleDetailOpenChangeComplete}
            loadHistory={history}
            chartWindowMs={detailChartWindowMs}
            retentionMs={retentionMs}
            onChartWindowChange={selectDetailChartWindow}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
