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
  resolution: {
    status: 'complete',
    unresolvedAssignments: 0,
    reasonCodes: [],
    workloads: [],
  },
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
      screen.getByLabelText('Assignment integration: Not configured'),
    ).toHaveTextContent('AssignmentsNot configured');
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

  it('discloses integration provenance without repeating workspace lists', async () => {
    const view = render(<AttributionSummary attribution={attribution} />);
    const trigger = screen.getByRole('button', {
      name: 'Assignment integration: Connected',
    });
    expect(trigger).toHaveTextContent('AssignmentsConnected');
    expect(screen.queryByText('Kubernetes DRA')).toBeNull();
    fireEvent.click(trigger);
    expect(await screen.findByText('Kubernetes DRA')).toBeInTheDocument();
    expect(
      screen.getByText(/Assignments describe scheduler intent/),
    ).toBeInTheDocument();
    expect(screen.queryByText('alice / active')).toBeNull();
    expect(view.container).not.toHaveTextContent('opaque-allocated');
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
      screen.getByLabelText('Assignment integration: Stale'),
    ).toHaveTextContent('Stale');
    expect(screen.queryByText('scheduler assignments')).toBeNull();

    view.rerender(
      <>
        <AttributionSummary attribution={unavailable} />
        <WorkspaceBadges attribution={unavailable} targets={targets} />
        <AttributionDetails attribution={unavailable} targets={targets} />
      </>,
    );
    expect(
      screen.getByLabelText('Assignment integration: Unavailable'),
    ).toHaveTextContent('Unavailable');
    expect(screen.queryByText('alice / active')).toBeNull();
  });
});

it('shows unknown assignment and verification details for an incomplete inventory', () => {
  const current: Attribution = {
    ...attribution,
    resolution: {
      status: 'incomplete',
      unresolvedAssignments: 2,
      reasonCodes: ['preparation_pending'],
      workloads: [
        {
          workloadRef: 'opaque-allocated',
          unresolvedAssignments: 2,
          reasonCodes: ['preparation_pending'],
        },
      ],
    },
  };
  const targets = [
    { entityType: 'compute_instance' as const, entityUuid: 'MIG-pending' },
  ];
  render(
    <>
      <WorkspaceBadges attribution={current} targets={targets} showUnassigned />
      <AttributionDetails attribution={current} targets={targets} />
      <AttributionSummary attribution={current} />
    </>,
  );
  expect(screen.getByText('Assignment unknown')).toBeInTheDocument();
  expect(screen.queryByText('Unassigned')).toBeNull();
  expect(
    screen.getByText(/Allocation verification is incomplete/),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: 'Assignment integration: Incomplete' }),
  );
  expect(
    screen.getByText(/2 allocations pending verification/),
  ).toBeInTheDocument();
});
