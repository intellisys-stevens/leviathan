import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GPUBoardView, type GPUBoardViewProps } from './gpu-board-view';
import type { HardwareBoardViewOptions } from './gpu-board-renderer';

const renderer = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock('./gpu-board-renderer', () => ({
  registerHardwareBoardView: renderer.register,
}));

function mockMedia(coarse = false) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: coarse && query === '(pointer: coarse)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}
function bridge() {
  const value = {
    update: vi.fn(),
    zoom: vi.fn(),
    focusChip: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
  };
  renderer.register.mockReturnValue(value);
  return value;
}
const props: GPUBoardViewProps = {
  gpuKey: 'host/GPU-1',
  topologyKey: 'generation-1',
  regions: [{ id: 'CI-1', label: 'CI 1', x: 0, y: 0, width: 1, height: 1 }],
  theme: 'dark',
  highlightedId: null,
  onHighlight: vi.fn(),
  onSelect: vi.fn(),
  fallback: <p>Static GPU board</p>,
  label: 'GPU 1',
};

afterEach(() => {
  vi.unstubAllGlobals();
  renderer.register.mockReset();
});

describe('GPU board React bridge', () => {
  it('uses the static fallback immediately when browser media APIs are absent', () => {
    vi.stubGlobal('matchMedia', undefined);
    const view = render(<GPUBoardView {...props} />);
    expect(view.container.querySelector('.gpu-board-view')).toHaveAttribute(
      'data-render-mode',
      'fallback',
    );
    expect(screen.getByText('3D unavailable')).toBeVisible();
    expect(renderer.register).not.toHaveBeenCalled();
  });

  it('keeps the static board until the shared renderer confirms a successful frame', async () => {
    mockMedia();
    bridge();
    const view = render(<GPUBoardView {...props} />);
    expect(view.container.querySelector('.gpu-board-view')).toHaveAttribute(
      'data-render-mode',
      'loading',
    );
    expect(screen.getByText('Static GPU board')).toBeInTheDocument();
    const toolbar = screen.getByRole('group', { name: 'GPU 1 view controls' });
    const controls = Array.from(toolbar.querySelectorAll('button'));
    expect(screen.getByRole('application')).toContainElement(
      screen.getByText('Loading 3D'),
    );
    expect(toolbar).not.toContainElement(screen.getByText('Loading 3D'));
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    await waitFor(() => expect(renderer.register).toHaveBeenCalledOnce());
    const callbacks = renderer.register.mock
      .calls[0][1] as HardwareBoardViewOptions;
    act(() => callbacks.onRenderMode('webgl'));
    expect(view.container.querySelector('.gpu-board-view')).toHaveAttribute(
      'data-render-mode',
      'webgl',
    );
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled();
    expect(Array.from(toolbar.querySelectorAll('button'))).toEqual(controls);
    act(() => callbacks.onRenderMode('fallback'));
    expect(view.container.querySelector('.gpu-board-view')).toHaveAttribute(
      'data-render-mode',
      'fallback',
    );
    expect(screen.getByText('3D unavailable')).toBeVisible();
    expect(screen.getByRole('application')).toContainElement(
      screen.getByText('3D unavailable'),
    );
    expect(Array.from(toolbar.querySelectorAll('button'))).toEqual(controls);
    expect(screen.getByRole('button', { name: 'Focus chip' })).toBeDisabled();
  });

  it('updates telemetry and selection callbacks without registering another renderer view', async () => {
    mockMedia();
    const controls = bridge();
    const view = render(<GPUBoardView {...props} />);
    await waitFor(() => expect(renderer.register).toHaveBeenCalledOnce());
    const onSelect = vi.fn();
    view.rerender(
      <GPUBoardView
        {...props}
        highlightedId="CI-1"
        onSelect={onSelect}
        theme="light"
        appearances={[{ id: 'CI-1', state: 'assigned', activity: 75 }]}
      />,
    );
    await waitFor(() =>
      expect(controls.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          highlightedId: 'CI-1',
          onSelect,
          theme: 'light',
          scene: expect.objectContaining({
            kind: 'gpu',
            appearances: [{ id: 'CI-1', state: 'assigned', activity: 75 }],
          }),
        }),
      ),
    );
    expect(renderer.register).toHaveBeenCalledOnce();
    view.unmount();
    expect(controls.dispose).toHaveBeenCalledOnce();
  });

  it('disposes the renderer view before its viewport leaves the DOM', async () => {
    mockMedia();
    const controls = bridge();
    const view = render(<GPUBoardView {...props} />);
    await waitFor(() => expect(renderer.register).toHaveBeenCalledOnce());
    const viewport = screen.getByRole('application');
    let connectedDuringDisposal: boolean | undefined;
    controls.dispose.mockImplementation(() => {
      connectedDuringDisposal = viewport.isConnected;
    });

    view.rerender(<p>No GPU telemetry</p>);

    expect(controls.dispose).toHaveBeenCalledOnce();
    expect(connectedDuringDisposal).toBe(true);
    expect(viewport.isConnected).toBe(false);
  });

  it('lets phone users enter interaction and return to page scrolling with Done or Escape', async () => {
    mockMedia(true);
    const controls = bridge();
    render(<GPUBoardView {...props} />);
    await waitFor(() => expect(renderer.register).toHaveBeenCalledOnce());
    const callbacks = renderer.register.mock
      .calls[0][1] as HardwareBoardViewOptions;
    expect(callbacks.interactive).toBe(false);
    act(() => callbacks.onRenderMode('webgl'));
    fireEvent.click(screen.getByRole('button', { name: 'Interact' }));
    expect(screen.getByRole('button', { name: 'Done' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(controls.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ interactive: true }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(controls.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ interactive: false }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Interact' }));
    fireEvent.keyDown(screen.getByRole('application'), { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Interact' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});
