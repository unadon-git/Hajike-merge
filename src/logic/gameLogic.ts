import { GAME_CONFIG } from '../config/gameConfig';

export type RandomSource = () => number;

export interface ScoreStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const BEST_SCORE_KEY = 'hajike-merge.best-score';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function lerp(start: number, end: number, ratio: number): number {
  return start + (end - start) * ratio;
}

export function calculateChargeRatio(holdTimeMs: number, maxChargeTimeMs: number = GAME_CONFIG.maxChargeTimeMs): number {
  return clamp(holdTimeMs / maxChargeTimeMs, 0, 1);
}

export function calculateLaunchSpeed(
  holdTimeMs: number,
  minSpeed: number = GAME_CONFIG.minLaunchSpeed,
  maxSpeed: number = GAME_CONFIG.maxLaunchSpeed,
  maxChargeTimeMs: number = GAME_CONFIG.maxChargeTimeMs,
): number {
  return lerp(minSpeed, maxSpeed, calculateChargeRatio(holdTimeMs, maxChargeTimeMs));
}

export function createShuffledBag(random: RandomSource = Math.random, source: readonly number[] = GAME_CONFIG.bag): number[] {
  const bag = [...source];
  for (let index = bag.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(clamp(random(), 0, 0.999999999) * (index + 1));
    [bag[index], bag[swapIndex]] = [bag[swapIndex], bag[index]];
  }
  return bag;
}

export class BallBagQueue {
  private bag: number[] = [];
  private readonly random: RandomSource;

  public constructor(random: RandomSource = Math.random) {
    this.random = random;
  }

  public fill(count: number): number[] {
    while (this.bag.length < count) {
      this.bag.push(...createShuffledBag(this.random));
    }
    return this.bag.slice(0, count);
  }

  public draw(): number {
    if (this.bag.length === 0) {
      this.bag.push(...createShuffledBag(this.random));
    }
    return this.bag.shift() ?? 1;
  }

  public peek(count = 3): number[] {
    return this.fill(count);
  }

  public reset(): void {
    this.bag = [];
  }
}

export function canMerge(
  levelA: number,
  levelB: number,
  isMergingA: boolean,
  isMergingB: boolean,
  maxLevel: number = GAME_CONFIG.maxLevel,
): boolean {
  return levelA === levelB && !isMergingA && !isMergingB && levelA < maxLevel;
}

export function mergedLevel(levelA: number, levelB: number, maxLevel: number = GAME_CONFIG.maxLevel): number | null {
  return canMerge(levelA, levelB, false, false, maxLevel) ? Math.min(levelA + 1, maxLevel) : null;
}

export function calculateBaseScore(mergedLevelValue: number): number {
  return 10 * 2 ** (mergedLevelValue - 1);
}

export function comboMultiplier(comboCount: number): number {
  if (comboCount <= 1) return 1;
  if (comboCount === 2) return 1.2;
  if (comboCount === 3) return 1.5;
  return 1.5 + (comboCount - 3) * 0.25;
}

export function nextComboCount(
  previousComboCount: number,
  mergedBallCreatedAtMs: number | null,
  nowMs: number,
  comboWindowMs: number = GAME_CONFIG.comboWindowMs,
): number {
  const isChain = mergedBallCreatedAtMs !== null
    && nowMs - mergedBallCreatedAtMs <= comboWindowMs;
  return isChain && previousComboCount > 0 ? previousComboCount + 1 : 1;
}

export function calculateMergeScore(mergedLevelValue: number, comboCount: number): number {
  return Math.round(calculateBaseScore(mergedLevelValue) * comboMultiplier(comboCount));
}

export function calculateBumperHitScore(
  impactSpeed: number,
  baseScore: number = GAME_CONFIG.bumper.baseScore,
  strongHitSpeed: number = GAME_CONFIG.bumper.strongHitSpeed,
  strongHitBonus: number = GAME_CONFIG.bumper.strongHitBonus,
): number {
  return baseScore + (impactSpeed >= strongHitSpeed ? strongHitBonus : 0);
}

export function dangerDurationReached(
  dangerStartedAtMs: number | null,
  nowMs: number,
  graceMs = GAME_CONFIG.dangerGraceMs,
): boolean {
  return dangerStartedAtMs !== null && nowMs - dangerStartedAtMs >= graceMs;
}

export function dangerProgress(
  dangerStartedAtMs: number | null,
  nowMs: number,
  graceMs = GAME_CONFIG.dangerGraceMs,
): number {
  if (dangerStartedAtMs === null) return 0;
  return clamp((nowMs - dangerStartedAtMs) / graceMs, 0, 1);
}

function browserStorage(): ScoreStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadBestScore(storage: ScoreStorage | null = browserStorage()): number {
  if (!storage) return 0;
  try {
    const stored = Number.parseInt(storage.getItem(BEST_SCORE_KEY) ?? '0', 10);
    return Number.isFinite(stored) && stored >= 0 ? stored : 0;
  } catch {
    return 0;
  }
}

export function saveBestScore(score: number, storage: ScoreStorage | null = browserStorage()): number {
  const best = Math.max(0, Math.floor(score));
  if (!storage) return best;
  try {
    storage.setItem(BEST_SCORE_KEY, String(best));
  } catch {
    // Storage failures must not stop the game.
  }
  return best;
}

export function updateBestScore(score: number, storage: ScoreStorage | null = browserStorage()): { best: number; isNewBest: boolean } {
  const previous = loadBestScore(storage);
  const best = Math.max(previous, Math.floor(score));
  if (best > previous) saveBestScore(best, storage);
  return { best, isNewBest: best > previous };
}
