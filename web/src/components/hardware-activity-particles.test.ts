import { describe, expect, it } from 'vitest';
import { particleBudgets } from './hardware-activity-particles';

describe('visible activity particle budgets', () => {
  it('preserves demand below the ceiling and proportionally shares crowded scenes', () => {
    expect(particleBudgets([], 256)).toEqual([]);
    expect(particleBudgets([64, 48, 0], 256)).toEqual([64, 48, 0]);
    const demand = [64, 64, 64, 64, 64, 48, 0];
    const budgets = particleBudgets(demand, 256);
    expect(budgets.reduce((sum, budget) => sum + budget, 0)).toBe(256);
    budgets.forEach((budget, index) => {
      expect(budget).toBeLessThanOrEqual(demand[index]);
      if (demand[index]) expect(budget).toBeGreaterThan(0);
    });
    expect(budgets.at(-1)).toBe(0);
    expect(particleBudgets(demand, 0)).toEqual(demand.map(() => 0));
  });
});
