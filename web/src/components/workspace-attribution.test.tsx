import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Attribution } from '../types';
import {
  AttributionDetails,
  AttributionSummary,
  WorkspaceBadges,
} from './workspace-attribution';

const attribution: Attribution = {
  provider: 'kubernetes_dra',
  status: 'available',
  workloads: [
    {
      ref: 'opaque-allocated',
      platform: 'coder',
      kind: 'workspace',
      name: 'active',
      ownerName: 'alice',
    },
    {
      ref: 'opaque-reserved',
      platform: 'coder',
      kind: 'workspace',
      name: 'queued',
      ownerName: 'bob',
    },
  ],
  assignments: [
    {
      workloadRef: 'opaque-allocated',
      entityType: 'physical_gpu',
      entityUuid: 'GPU-a',
      state: 'allocated',
    },
    {
      workloadRef: 'opaque-reserved',
      entityType: 'physical_gpu',
      entityUuid: 'GPU-a',
      state: 'reserved',
    },
  ],
};

describe('workspace attribution presentation', () => {
  it('renders a concise configured-state placeholder when attribution is absent', () => {
    render(<AttributionSummary />);

    expect(
      screen.getByLabelText('Workspace attribution unavailable'),
    ).toHaveTextContent('Workspace attributionNot configured');
  });

  it('treats allocated and reserved DRA states as neutral assignments', () => {
    const targets = [
      { entityType: 'physical_gpu' as const, entityUuid: 'GPU-a' },
    ];
    const view = render(
      <>
        <WorkspaceBadges attribution={attribution} targets={targets} />
        <AttributionDetails attribution={attribution} targets={targets} />
      </>,
    );

    for (const state of ['allocated', 'reserved']) {
      const badge = screen.getByText(state);
      expect(badge).toHaveClass('border-border', 'text-muted-foreground');
      expect(badge).not.toHaveClass('text-primary', 'text-amber-500');
    }
    expect(view.container).not.toHaveTextContent('opaque-allocated');
    expect(view.container).not.toHaveTextContent('opaque-reserved');
  });

  it('groups assigned devices by workspace without exposing opaque refs', async () => {
    const view = render(<AttributionSummary attribution={attribution} />);

    const trigger = screen.getByRole('button', {
      name: /Kubernetes DRA attribution: 2 workspaces, 1 device, available/,
    });
    expect(trigger).toHaveTextContent(/Kubernetes DRA.*2 workspaces.*1 device/);
    fireEvent.click(trigger);
    expect(await screen.findByText('alice / active')).toBeInTheDocument();
    expect(screen.getByText('bob / queued')).toBeInTheDocument();
    expect(
      screen.queryByText(
        'Scheduler assignments; these do not imply active GPU use.',
      ),
    ).toBeNull();
    expect(screen.getAllByText('Physical GPU')).toHaveLength(2);
    expect(view.container).not.toHaveTextContent('GPU-a');
    expect(view.container).not.toHaveTextContent('opaque-allocated');
    expect(view.container).not.toHaveTextContent('opaque-reserved');
  });

  it('confines stale and unavailable attribution to the summary', () => {
    const targets = [
      { entityType: 'physical_gpu' as const, entityUuid: 'GPU-a' },
    ];
    const stale = { ...attribution, status: 'stale' as const };
    const unavailable = { ...attribution, status: 'unavailable' as const };
    const view = render(
      <>
        <AttributionSummary attribution={stale} />
        <WorkspaceBadges attribution={stale} targets={targets} />
        <AttributionDetails attribution={stale} targets={targets} />
      </>,
    );

    expect(
      screen.getByLabelText(
        'Kubernetes DRA attribution: 2 workspaces, 1 device, stale',
      ),
    ).toHaveTextContent('stale');
    expect(screen.queryByText('scheduler assignments')).toBeNull();

    view.rerender(
      <>
        <AttributionSummary attribution={unavailable} />
        <WorkspaceBadges attribution={unavailable} targets={targets} />
        <AttributionDetails attribution={unavailable} targets={targets} />
      </>,
    );
    expect(
      screen.getByLabelText(
        'Kubernetes DRA attribution: 2 workspaces, 1 device, unavailable',
      ),
    ).toHaveTextContent('unavailable');
    expect(screen.queryByText('alice / active')).toBeNull();
  });
});
