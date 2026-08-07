export const WORLD = {
  width: 720,
  height: 1280,
  field: {
    left: 70,
    right: 570,
    top: 225,
    bottom: 992,
  },
  // The bounding box is kept for layout calculations. The actual lane is
  // defined by GAME_CONFIG.launchLane.path below.
  lane: {
    left: 580,
    right: 655,
    top: 185,
    bottom: 992,
    openingY: 430,
  },
  dangerLineY: 285,
} as const;

export const COLLISION_CATEGORY = {
  ball: 0x0001,
  fieldWall: 0x0002,
  laneWall: 0x0004,
  bumper: 0x0008,
  laneGate: 0x0010,
} as const;

export const SHOCKWAVE_LEVEL_MULTIPLIERS: Record<number, number> = {
  2: 1.0,
  3: 1.2,
  4: 1.5,
  5: 1.9,
  6: 2.4,
  7: 3.0,
  8: 4.0,
};

export const GAME_CONFIG = {
  maxLevel: 8,
  maxChargeTimeMs: 1_500,
  minLaunchSpeed: 42,
  maxLaunchSpeed: 62,
  launchCooldownMs: 250,
  gravityY: 1.05,
  maxBodySpeed: 72,
  launchLane: {
    // Bottom-right start, straight rise, then a leftward arc that exits into
    // the upper part of the field.
    path: [
      { x: 618, y: 927 },
      { x: 618, y: 760 },
      { x: 618, y: 560 },
      { x: 618, y: 430 },
      { x: 614, y: 370 },
      { x: 598, y: 320 },
      { x: 565, y: 280 },
      { x: 520, y: 258 },
      { x: 500, y: 300 },
    ] as const,
    corridorWidth: 72,
    wallThickness: 10,
    segmentOverlap: 18,
    jointRadius: 7,
    exitPosition: { x: 500, y: 300 },
    exitAngleRadians: 2.356194490192345,
    exitDirection: { x: -0.7071, y: 0.7071 },
    exitTriggerRadius: 42,
    exitSpawnOffset: 48,
    gateWidth: 88,
    gateThickness: 12,
    fallbackTimeoutMs: 2_600,
  },
  ball: {
    baseRadius: 25,
    radiusStep: 2,
    baseMass: 1,
    massStep: 0.22,
    restitution: 0.55,
    friction: 0.08,
    frictionAir: 0.012,
    sleepSpeed: 0.75,
    sleepThreshold: 45,
  },
  wall: {
    restitution: 0.5,
    friction: 0.08,
  },
  floor: {
    restitution: 0.28,
    friction: 0.72,
  },
  bumper: {
    radius: 37,
    restitution: 0.92,
    friction: 0.05,
    impulse: 12,
    baseScore: 5,
    strongHitBonus: 5,
    strongHitSpeed: 18,
    scoreCooldownMs: 300,
    pulseDurationMs: 180,
  },
  bag: [1, 1, 1, 1, 1, 2, 2, 3] as const,
  merge: {
    contactTimeMs: 100,
    generatedImpulse: 1.2,
    postMergeDangerGraceMs: 650,
  },
  mergeShockwave: {
    minImpulse: 2.5,
    maxImpulse: 14,
    minRadius: 95,
    maxRadius: 260,
    falloffExponent: 0.75,
    generatedImpulse: 1.4,
    levelMultipliers: SHOCKWAVE_LEVEL_MULTIPLIERS,
  },
  comboWindowMs: 1_500,
  maxLevelBonus: 2_560,
  dangerGraceMs: 2_000,
  dangerBlinkMs: 300,
  stoppedSpeed: 0.9,
  maxLevelExitMs: 1_000,
} as const;

export const BALL_COLORS: Record<number, number> = {
  1: 0x59d46f,
  2: 0x43b9f1,
  3: 0xf05e73,
  4: 0xffcf4d,
  5: 0xa874ea,
  6: 0xff9b42,
  7: 0x5fd6cc,
  8: 0xff7cae,
};

export const BALL_COLORS_CSS: Record<number, string> = {
  1: '#59d46f',
  2: '#43b9f1',
  3: '#f05e73',
  4: '#ffd04c',
  5: '#a874ea',
  6: '#ff9b42',
  7: '#5fd6cc',
  8: '#ff7cae',
};

export function radiusForLevel(level: number): number {
  return GAME_CONFIG.ball.baseRadius + (level - 1) * GAME_CONFIG.ball.radiusStep;
}

export function massForLevel(level: number): number {
  return GAME_CONFIG.ball.baseMass + (level - 1) * GAME_CONFIG.ball.massStep;
}

