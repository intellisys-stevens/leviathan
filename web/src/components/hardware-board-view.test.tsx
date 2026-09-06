import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HardwareBoardView,
  type HardwareBoardViewProps,
} from './hardware-board-view';
import type { HardwareBoardViewOptions } from './gpu-board-renderer';

const renderer = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock('./gpu-board-renderer', () => ({
  registerHardwareBoardView: renderer.register,
}));

const props: HardwareBoardViewProps = {
  sceneKey: 'host:motherboard',
  topologyKey: 'motherboard-v1',
  scene: { kind: 'motherboard', appearance: { cpu: 24, memory: 60 } },
  selectedId: 'cpu',
  highlightedId: null,
  theme: 'dark',
  onSelect: vi.fn(),
  onHighlight: vi.fn(),
  label: 'Motherboard',
  fallback: <p>Illustrative motherboard</p>,
};

function setup(coarse = false) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: coarse && query === '(pointer: coarse)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const handle = {
    update: vi.fn(),
    zoom: vi.fn(),
    focus: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
  };
  renderer.register.mockReturnValue(handle);
  return handle;
}

async function ready() {
  await waitFor(() => expect(renderer.register).toHaveBeenCalledOnce());
  const callbacks = renderer.register.mock
    .calls[0][1] as HardwareBoardViewOptions;
  act(() => {
    callbacks.onViewState({
      focus: 'board',
      canFocusSelected: true,
      canZoomIn: true,
      canZoomOut: true,
    });
    callbacks.onRenderMode('webgl');
  });
  return callbacks;
}

afterEach(() => {
  vi.unstubAllGlobals();
  renderer.register.mockReset();
});

describe('shared hardware view shell', () => {
  it('keeps the full-board default and moves the camera only on Focus selected', async () => {
    const handle = setup();
    const view = render(<HardwareBoardView {...props} />);
    const root = view.container.querySelector('.hardware-board-view');
    expect(root).toHaveAttribute('data-focus', 'board');
    expect(root).toHaveAttribute('data-selected-component', 'cpu');
    expect(view.container.querySelector('.gpu-board-view')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Focus selected' }),
    ).toBeDisabled();
    await ready();
    expect(handle.focus).not.toHaveBeenCalled();

    view.rerender(
      <HardwareBoardView
        {...props}
        selectedId="memory"
        highlightedId="storage"
      />,
    );
    expect(handle.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedId: 'memory',
        highlightedId: 'storage',
      }),
    );
    expect(handle.focus).not.toHaveBeenCalled();
    expect(root).toHaveAttribute('data-focus', 'board');
    fireEvent.click(screen.getByRole('button', { name: 'Focus selected' }));
    expect(handle.focus).toHaveBeenCalledExactlyOnceWith('memory');
    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }));
    expect(handle.reset).toHaveBeenCalledOnce();
    expect(renderer.register).toHaveBeenCalledOnce();
  });

  it('updates fresh and stale telemetry through the existing registration', async () => {
    const handle = setup();
    const view = render(<HardwareBoardView {...props} />);
    await ready();
    view.rerender(
      <HardwareBoardView
        {...props}
        scene={{ kind: 'motherboard', appearance: { cpu: null, memory: null } }}
      />,
    );
    expect(handle.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scene: { kind: 'motherboard', appearance: { cpu: null, memory: null } },
      }),
    );
    expect(renderer.register).toHaveBeenCalledOnce();
    expect(handle.focus).not.toHaveBeenCalled();
    expect(handle.reset).not.toHaveBeenCalled();
  });

  it('retains the shell and touch escape path through graphics fallback', async () => {
    const handle = setup(true);
    const view = render(<HardwareBoardView {...props} />);
    const viewport = screen.getByRole('application');
    const toolbar = screen.getByRole('group', {
      name: 'Motherboard view controls',
    });
    const buttons = Array.from(toolbar.querySelectorAll('button'));
    expect(viewport).toContainElement(screen.getByText('Loading 3D'));
    expect(toolbar).not.toContainElement(screen.getByText('Loading 3D'));
    const callbacks = await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Interact' }));
    expect(handle.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ interactive: true }),
    );
    fireEvent.keyDown(viewport, { key: 'Escape' });
    expect(handle.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ interactive: false }),
    );
    act(() => callbacks.onRenderMode('fallback'));
    expect(
      view.container.querySelector('.hardware-board-view'),
    ).toHaveAttribute('data-render-mode', 'fallback');
    expect(viewport).toContainElement(screen.getByText('3D unavailable'));
    expect(Array.from(toolbar.querySelectorAll('button'))).toEqual(buttons);
    expect(screen.getByText('Illustrative motherboard')).toBeVisible();
  });

  it('disposes a removed scene before detaching its viewport', async () => {
    const handle = setup();
    const view = render(<HardwareBoardView {...props} />);
    await ready();
    const viewport = screen.getByRole('application');
    let connected: boolean | undefined;
    handle.dispose.mockImplementation(() => {
      connected = viewport.isConnected;
    });
    view.rerender(<p>Overview</p>);
    expect(connected).toBe(true);
    expect(viewport.isConnected).toBe(false);
    expect(handle.dispose).toHaveBeenCalledOnce();
  });
});
