import { GAME_CONFIG } from '../config/gameConfig';

export type RandomSource = () => number;

export interface ScoreStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface Vector2Like {
  x: number;
  y: number;
}

export interface BoundsLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface PathProjection {
  point: Vector2Like;
  direction: Vector2Like;
  segmentIndex: number;
  distanceAlong: number;
  totalLength: number;
  distanceToPath: number;
  progress: number;
}

export interface ContainedCircle {
  position: Vector2Like;
  hitLeft: boolean;
  hitRight: boolean;
  hitTop: boolean;
  hitBottom: boolean;
}

export const BEST_SCORE_KEY = 'hajike-merge.best-score';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function lerp(start: number, end: number, ratio: number): number {
  return start + (end - start) * ratio;
}

export function limitVector(vector: Vector2Like, maxMagnitude: number): Vector2Like {
  const magnitude = Math.hypot(vector.x, vector.y);
  if (magnitude <= maxMagnitude || magnitude < Number.EPSILON) return { ...vector };
  const scale = maxMagnitude / magnitude;
  return { x: vector.x * scale, y: vector.y * scale };
}

export function projectPointToPath(
  position: Vector2Like,
  path: readonly Vector2Like[],
): PathProjection {
  if (path.length < 2) {
    throw new Error('A launch path requires at least two points.');
  }

  let bestDistanceSquared = Number.POSITIVE_INFINITY;
  let bestPoint = { ...path[0] };
  let bestDirection = { x: 0, y: -1 };
  let bestSegmentIndex = 0;
  let bestDistanceAlong = 0;
  let traversed = 0;
  let totalLength = 0;

  const segmentLengths = path.slice(0, -1).map((point, index) => {
    const next = path[index + 1];
    return Math.hypot(next.x - point.x, next.y - point.y);
  });
  totalLength = segmentLengths.reduce((sum, length) => sum + length, 0);

  for (let index = 0; index < path.length - 1; index += 1) {
    const start = path[index];
    const end = path[index + 1];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.max(segmentLengths[index], Number.EPSILON);
    const lengthSquared = length * length;
    const segmentRatio = clamp(
      ((position.x - start.x) * dx + (position.y - start.y) * dy) / lengthSquared,
      0,
      1,
    );
    const projected = {
      x: start.x + dx * segmentRatio,
      y: start.y + dy * segmentRatio,
    };
    const distanceSquared = (position.x - projected.x) ** 2 + (position.y - projected.y) ** 2;

    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared;
      bestPoint = projected;
      bestDirection = { x: dx / length, y: dy / length };
      bestSegmentIndex = index;
      bestDistanceAlong = traversed + length * segmentRatio;
    }
    traversed += length;
  }

  return {
    point: bestPoint,
    direction: bestDirection,
    segmentIndex: bestSegmentIndex,
    distanceAlong: bestDistanceAlong,
    totalLength,
    distanceToPath: Math.sqrt(bestDistanceSquared),
    progress: totalLength > 0 ? bestDistanceAlong / totalLength : 0,
  };
}

export function pointAlongPath(
  path: readonly Vector2Like[],
  requestedDistance: number,
): { point: Vector2Like; direction: Vector2Like; segmentIndex: number } {
  if (path.length < 2) {
    throw new Error('A launch path requires at least two points.');
  }

  const lengths = path.slice(0, -1).map((point, index) => {
    const next = path[index + 1];
    return Math.hypot(next.x - point.x, next.y - point.y);
  });
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  let remaining = clamp(requestedDistance, 0, totalLength);

  for (let index = 0; index < lengths.length; index += 1) {
    const start = path[index];
    const end = path[index + 1];
    const length = Math.max(lengths[index], Number.EPSILON);
    if (remaining <= length || index === lengths.length - 1) {
      const ratio = clamp(remaining / length, 0, 1);
      return {
        point: {
          x: lerp(start.x, end.x, ratio),
          y: lerp(start.y, end.y, ratio),
        },
        direction: {
          x: (end.x - start.x) / length,
          y: (end.y - start.y) / length,
        },
        segmentIndex: index,
      };
    }
    remaining -= length;
  }

  const finalIndex = path.length - 2;
  return {
    point: { ...path[path.length - 1] },
    direction: {
      x: (path[finalIndex + 1].x - path[finalIndex].x) / Math.max(lengths[finalIndex], Number.EPSILON),
      y: (path[finalIndex + 1].y - path[finalIndex].y) / Math.max(lengths[finalIndex], Number.EPSILON),
    },
    segmentIndex: finalIndex,
  };
}

export function containCircleInBounds(
  position: Vector2Like,
  radius: number,
  bounds: BoundsLike,
  padding = 0,
): ContainedCircle {
  const minX = bounds.left + radius + padding;
  const maxX = bounds.right - radius - padding;
  const minY = bounds.top + radius + padding;
  const maxY = bounds.bottom - radius - padding;
  return {
    position: {
      x: clamp(position.x, minX, maxX),
      y: clamp(position.y, minY, maxY),
    },
    hitLeft: position.x < minX,
    hitRight: position.x > maxX,
    hitTop: position.y < minY,
    hitBottom: position.y > maxY,
  };
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
