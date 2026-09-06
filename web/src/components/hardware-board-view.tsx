import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Focus, Minus, Plus, RotateCcw, Hand } from 'lucide-react';
import type { HardwareScene } from './hardware-scene';
import type {
  HardwareBoardViewHandle,
  HardwareBoardViewOptions,
  BoardViewState,
} from './gpu-board-renderer';
import './gpu-board-view.css';

export type HardwareBoardViewProps = {
  sceneKey: string;
  topologyKey: string;
  scene: HardwareScene;
  selectedId?: string | null;
  theme: 'dark' | 'light';
  highlightedId: string | null;
  onHighlight: (id: string | null) => void;
  onSelect: (id: string) => void;
  fallback?: ReactNode;
  label?: string;
};

export function HardwareBoardView({
  fallback,
  label = 'Hardware board',
  selectedId = null,
  ...props
}: HardwareBoardViewProps) {
  const element = useRef<HTMLDivElement>(null);
  const handle = useRef<HardwareBoardViewHandle | null>(null);
  const [mode, setMode] = useState<'loading' | 'webgl' | 'fallback'>(() =>
    typeof window.matchMedia === 'function' ? 'loading' : 'fallback',
  );
  const [coarse, setCoarse] = useState(
    () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches,
  );
  const [interacting, setInteracting] = useState(false);
  const [viewState, setViewState] = useState<BoardViewState>({
    focus: props.scene.kind === 'gpu' ? 'chip' : 'board',
    canFocusSelected: false,
    canZoomIn: true,
    canZoomOut: true,
  });
  const descriptionID = useId();
  const interactive = !coarse || interacting;
  const current = useRef({ ...props, selectedId, interactive });
  useLayoutEffect(() => {
    current.current = { ...props, selectedId, interactive };
  }, [props, selectedId, interactive]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(pointer: coarse)');
    const changed = () => {
      setCoarse(media.matches);
      setInteracting(false);
    };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);

  useLayoutEffect(() => {
    let mounted = true;
    let local: HardwareBoardViewHandle | null = null;
    const viewport = element.current;
    const exitInteraction = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setInteracting(false);
        event.stopPropagation();
      }
    };
    viewport?.addEventListener('keydown', exitInteraction);
    if (typeof window.matchMedia !== 'function')
      return () => viewport?.removeEventListener('keydown', exitInteraction);
    void import('./gpu-board-renderer')
      .then(({ registerHardwareBoardView }) => {
        if (!mounted || !element.current) return;
        const options: HardwareBoardViewOptions = {
          ...current.current,
          sceneKey: props.sceneKey,
          onRenderMode: (next) => {
            if (mounted) setMode(next);
          },
          onViewState: (next) => {
            if (mounted)
              setViewState((previous) =>
                previous.focus === next.focus &&
                previous.canZoomIn === next.canZoomIn &&
                previous.canZoomOut === next.canZoomOut &&
                previous.canFocusSelected === next.canFocusSelected
                  ? previous
                  : next,
              );
          },
        };
        local = registerHardwareBoardView(element.current, options);
        handle.current = local;
      })
      .catch(() => {
        if (mounted) setMode('fallback');
      });
    return () => {
      mounted = false;
      viewport?.removeEventListener('keydown', exitInteraction);
      handle.current = null;
      local?.dispose();
    };
  }, [props.sceneKey]);

  useEffect(() => {
    handle.current?.update({
      ...props,
      selectedId,
      interactive,
      onRenderMode: setMode,
      onViewState: (next) =>
        setViewState((previous) =>
          previous.focus === next.focus &&
          previous.canZoomIn === next.canZoomIn &&
          previous.canZoomOut === next.canZoomOut &&
          previous.canFocusSelected === next.canFocusSelected
            ? previous
            : next,
        ),
    });
  }, [props, selectedId, interactive]);

  const ready = mode === 'webgl';
  const gpu = props.scene.kind === 'gpu';
  const className = (part: string) =>
    `hardware-board-${part}${gpu ? ` gpu-board-${part}` : ''}`;
  return (
    <div
      className={className('view')}
      data-render-mode={mode}
      data-interacting={coarse && interacting}
      data-focus={viewState.focus}
      data-scene-kind={props.scene.kind}
      data-selected-component={selectedId ?? ''}
      data-highlighted-chip={props.highlightedId ?? ''}
    >
      <div
        className={className('viewport')}
        ref={element}
        role="application"
        aria-label={`${label}, interactive 3D view`}
        aria-describedby={descriptionID}
      >
        <div className={className('static')} aria-hidden={ready || undefined}>
          {fallback}
        </div>
        {!ready ? (
          <span className={className('render-status')}>
            {mode === 'loading' ? 'Loading 3D' : '3D unavailable'}
          </span>
        ) : null}
      </div>
      <fieldset
        className={className('toolbar')}
        aria-label={`${label} view controls`}
      >
        {coarse ? (
          <button
            type="button"
            className={className('interact')}
            disabled={!ready}
            aria-pressed={interacting}
            onClick={() => setInteracting((value) => !value)}
          >
            <Hand size={16} aria-hidden="true" />{' '}
            {interacting ? 'Done' : 'Interact'}
          </button>
        ) : null}
        <button
          type="button"
          disabled={!ready || !viewState.canZoomOut}
          aria-label="Zoom out"
          onClick={() => handle.current?.zoom('out')}
        >
          <Minus size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          disabled={!ready || !viewState.canZoomIn}
          aria-label="Zoom in"
          onClick={() => handle.current?.zoom('in')}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={className('focus')}
          disabled={
            !ready || (!gpu && (!selectedId || !viewState.canFocusSelected))
          }
          aria-pressed={gpu ? viewState.focus === 'chip' : undefined}
          onClick={() =>
            handle.current?.focus(
              gpu
                ? viewState.focus === 'chip'
                  ? 'board'
                  : 'chip'
                : selectedId!,
            )
          }
        >
          <Focus size={16} aria-hidden="true" />
          {gpu ? ' Focus chip' : ' Focus selected'}
        </button>
        <button
          type="button"
          disabled={!ready}
          aria-label="Reset view"
          onClick={() => handle.current?.reset()}
        >
          <RotateCcw size={16} aria-hidden="true" />
        </button>
      </fieldset>
      <p className="sr-only" id={descriptionID}>
        {coarse
          ? 'Enable Interact to rotate with one finger or zoom with two fingers. Done returns to page scrolling. '
          : 'Drag to rotate. Select the board before scrolling to zoom. '}
        Arrow keys rotate, plus and minus zoom, and Home resets the view.{' '}
        {gpu
          ? 'Tap a chip region or use the resource buttons below to open its details.'
          : 'Select a component on the board or use its section heading below. Focus selected moves the camera to that component.'}
      </p>
    </div>
  );
}

export default HardwareBoardView;
