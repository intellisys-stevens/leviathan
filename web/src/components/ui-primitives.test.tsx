import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';

describe('shared UI primitive states', () => {
  it('renders null and omitted progress values as unavailable', () => {
    const view = render(
      <Progress
        value={null}
        aria-label="GPU memory"
        className="custom-progress"
        data-testid="gpu-progress"
      />,
    );

    let progress = screen.getByRole('progressbar', { name: 'GPU memory' });
    expect(progress).toHaveClass('custom-progress');
    expect(progress).toHaveAttribute('data-testid', 'gpu-progress');
    expect(progress).toHaveAttribute('data-unavailable');
    expect(progress).toHaveAttribute('aria-valuetext', 'Unavailable');
    expect(progress).not.toHaveAttribute('aria-valuenow');
    expect(
      progress.querySelector('[data-slot="progress-track"]'),
    ).toHaveAttribute('data-unavailable');
    expect(
      progress.querySelector('[data-slot="progress-indicator"]'),
    ).toBeNull();

    view.rerender(<Progress aria-label="GPU activity" />);
    progress = screen.getByRole('progressbar', { name: 'GPU activity' });
    expect(progress).toHaveAttribute('aria-valuetext', 'Unavailable');
    expect(progress).not.toHaveAttribute('aria-valuenow');
    expect(
      progress.querySelector('[data-slot="progress-indicator"]'),
    ).toBeNull();
  });

  it('clamps numeric progress without animating live values', () => {
    const view = render(<Progress value={125} aria-label="GPU activity" />);

    let progress = screen.getByRole('progressbar', { name: 'GPU activity' });
    expect(progress).toHaveAttribute('aria-valuenow', '100');
    let indicator = progress.querySelector('[data-slot="progress-indicator"]');
    expect(indicator).toHaveStyle({ width: '100%' });
    expect(indicator).not.toHaveClass('transition-all');

    view.rerender(<Progress value={-25} aria-label="GPU activity" />);
    progress = screen.getByRole('progressbar', { name: 'GPU activity' });
    expect(progress).toHaveAttribute('aria-valuenow', '0');
    indicator = progress.querySelector('[data-slot="progress-indicator"]');
    expect(indicator).toHaveStyle({ width: '0%' });
  });

  it('uses scoped button motion and keeps badges static', () => {
    render(
      <>
        <Button>Inspect</Button>
        <Badge>Live</Badge>
      </>,
    );

    const button = screen.getByRole('button', { name: 'Inspect' });
    expect(button).toHaveClass(
      'transition-[color,background-color,border-color,opacity,transform]',
      'duration-[var(--duration-feedback)]',
      'ease-[var(--ease-out)]',
      'active:[transform:scale(0.98)]',
    );
    expect(button).not.toHaveClass('transition-all', 'translate-y-px');
    expect(screen.getByText('Live')).not.toHaveClass('transition-all');
  });

  it('uses tokenized full-distance sheet motion and completes controlled closes', async () => {
    const onOpenChangeComplete = vi.fn();
    const sheet = (open: boolean) => (
      <Sheet open={open} onOpenChangeComplete={onOpenChangeComplete}>
        <SheetContent>
          <SheetTitle>GPU details</SheetTitle>
          <SheetDescription>Live GPU telemetry</SheetDescription>
        </SheetContent>
      </Sheet>
    );
    const view = render(sheet(true));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass(
      'transition-[opacity,transform]',
      'duration-[var(--duration-view)]',
      'ease-[var(--ease-drawer)]',
      'data-[side=right]:data-ending-style:[transform:translateX(100%)]',
      'data-[side=right]:data-starting-style:[transform:translateX(100%)]',
    );
    const overlay = document.querySelector('[data-slot="sheet-overlay"]');
    expect(overlay).toHaveClass(
      'transition-opacity',
      'duration-[var(--duration-view)]',
      'ease-[var(--ease-out)]',
    );

    view.rerender(sheet(false));
    await waitFor(() =>
      expect(onOpenChangeComplete).toHaveBeenCalledWith(false),
    );
  });
});
