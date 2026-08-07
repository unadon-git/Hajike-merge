import { describe, expect, it } from 'vitest';
import {
  BEST_SCORE_KEY,
  BallBagQueue,
  calculateBumperHitScore,
  calculateBaseScore,
  calculateChargeRatio,
  calculateLaunchSpeed,
  calculateMergeScore,
  canMerge,
  comboMultiplier,
  nextComboCount,
  dangerDurationReached,
  dangerProgress,
  loadBestScore,
  mergedLevel,
  saveBestScore,
  updateBestScore,
} from './gameLogic';

describe('charge and launch speed', () => {
  it('normalizes and clamps charge time', () => {
    expect(calculateChargeRatio(0)).toBe(0);
    expect(calculateChargeRatio(750)).toBeCloseTo(0.5);
    expect(calculateChargeRatio(3_000)).toBe(1);
    expect(calculateChargeRatio(-10)).toBe(0);
  });

  it('interpolates speed between configured endpoints', () => {
    expect(calculateLaunchSpeed(0, 10, 30, 1_000)).toBe(10);
    expect(calculateLaunchSpeed(500, 10, 30, 1_000)).toBe(20);
    expect(calculateLaunchSpeed(2_000, 10, 30, 1_000)).toBe(30);
  });
});

describe('bag and next queue', () => {
  it('uses every entry from the configured bag before repeating', () => {
    const queue = new BallBagQueue(() => 0.1);
    const firstBag = Array.from({ length: 8 }, () => queue.draw());
    expect(firstBag.slice().sort((a, b) => a - b)).toEqual([1, 1, 1, 1, 1, 2, 2, 3]);
  });

  it('keeps NEXT at three values and advances after a draw', () => {
    const queue = new BallBagQueue(() => 0.3);
    const before = queue.peek(3);
    expect(before).toHaveLength(3);
    expect(queue.draw()).toBe(before[0]);
    expect(queue.peek(3)).toHaveLength(3);
  });
});

describe('merge and score rules', () => {
  it('only allows matching unlocked levels below the maximum', () => {
    expect(canMerge(2, 2, false, false)).toBe(true);
    expect(canMerge(2, 3, false, false)).toBe(false);
    expect(canMerge(2, 2, true, false)).toBe(false);
    expect(canMerge(8, 8, false, false)).toBe(false);
    expect(mergedLevel(2, 2)).toBe(3);
    expect(mergedLevel(8, 8)).toBeNull();
  });

  it('applies the specification score formula and combo multipliers', () => {
    expect(calculateBaseScore(2)).toBe(20);
    expect(calculateBaseScore(8)).toBe(1_280);
    expect(comboMultiplier(1)).toBe(1);
    expect(comboMultiplier(2)).toBe(1.2);
    expect(comboMultiplier(3)).toBe(1.5);
    expect(comboMultiplier(5)).toBe(2);
    expect(calculateMergeScore(4, 2)).toBe(96);
    expect(nextComboCount(1, 1_000, 2_000, 1_500)).toBe(2);
    expect(nextComboCount(2, 1_000, 2_501, 1_500)).toBe(1);
    expect(nextComboCount(5, null, 2_000, 1_500)).toBe(1);
  });
});

describe('bumper score rules', () => {
  it('adds the strong-hit bonus without involving combo multipliers', () => {
    expect(calculateBumperHitScore(17)).toBe(5);
    expect(calculateBumperHitScore(18)).toBe(10);
  });
});

describe('danger timer', () => {
  it('does not trigger before the grace period and reaches one at the threshold', () => {
    expect(dangerDurationReached(1_000, 2_999, 2_000)).toBe(false);
    expect(dangerDurationReached(1_000, 3_000, 2_000)).toBe(true);
    expect(dangerProgress(null, 3_000, 2_000)).toBe(0);
    expect(dangerProgress(1_000, 2_000, 2_000)).toBe(0.5);
    expect(dangerProgress(1_000, 5_000, 2_000)).toBe(1);
  });
});

describe('best score persistence', () => {
  it('loads, saves, and updates a storage-backed best score', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        values.set(key, value);
      },
    };

    expect(loadBestScore(storage)).toBe(0);
    expect(saveBestScore(420, storage)).toBe(420);
    expect(values.get(BEST_SCORE_KEY)).toBe('420');
    expect(updateBestScore(300, storage)).toEqual({ best: 420, isNewBest: false });
    expect(updateBestScore(900, storage)).toEqual({ best: 900, isNewBest: true });
    expect(loadBestScore(storage)).toBe(900);
  });
});

