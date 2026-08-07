import Phaser from 'phaser';
import {
  BALL_COLORS,
  COLLISION_CATEGORY,
  GAME_CONFIG,
  WORLD,
  massForLevel,
  radiusForLevel,
} from '../config/gameConfig';
import {
  BallBagQueue,
  calculateBumperHitScore,
  calculateChargeRatio,
  calculateLaunchSpeed,
  calculateMergeScore,
  comboMultiplier,
  dangerDurationReached,
  dangerProgress,
  canMerge,
  loadBestScore,
  mergedLevel,
  nextComboCount,
  saveBestScore,
  updateBestScore,
} from '../logic/gameLogic';

type GameState = 'Initializing' | 'Ready' | 'Charging' | 'Launching' | 'Resolving' | 'Paused' | 'GameOver';

interface VectorLike {
  x: number;
  y: number;
}

interface BallEntity {
  id: number;
  level: number;
  body: MatterJS.BodyType;
  label: Phaser.GameObjects.Text;
  isMerging: boolean;
  isInLaunchLane: boolean;
  mergeCreatedAt: number | null;
  launchSpeed: number | null;
}

interface BumperEntity {
  body: MatterJS.BodyType;
  x: number;
  y: number;
  pulseUntil: number;
}

interface CollisionPairLike {
  bodyA: MatterJS.BodyType;
  bodyB: MatterJS.BodyType;
}

interface CollisionEventLike {
  pairs: CollisionPairLike[];
}

interface GameActionDetail {
  action: 'pause-toggle' | 'restart' | 'resume';
}

export class HajikeScene extends Phaser.Scene {
  private readonly balls = new Map<number, BallEntity>();
  private readonly ballsByBodyId = new Map<number, BallEntity>();
  private readonly bumpers = new Map<number, BumperEntity>();
  private readonly contactStarts = new Map<string, number>();
  private readonly bumperHitCooldowns = new Map<string, number>();
  private readonly staticBodies: MatterJS.BodyType[] = [];
  private readonly random = Math.random;
  private bag!: BallBagQueue;
  private boardGraphics!: Phaser.GameObjects.Graphics;
  private ballGraphics!: Phaser.GameObjects.Graphics;
  private fxGraphics!: Phaser.GameObjects.Graphics;
  private nextBallId = 1;
  private state: GameState = 'Initializing';
  private stateBeforePause: GameState = 'Ready';
  private score = 0;
  private bestScore = 0;
  private comboCount = 0;
  private dangerStartedAt: number | null = null;
  private mergeAnimationUntil = 0;
  private launchedBallId: number | null = null;
  private chargeStartedAt: number | null = null;
  private launchBumperHitCount = 0;
  private lastLaunchBumperId: number | null = null;

  private readonly actionHandler = (event: Event): void => {
    const { action } = (event as CustomEvent<GameActionDetail>).detail;
    if (action === 'pause-toggle') {
      this.togglePause();
    } else if (action === 'restart') {
      this.restartGame();
    } else if (action === 'resume') {
      this.resumeGame();
    }
  };

  private readonly chargeStartHandler = (): void => {
    this.beginCharge();
  };

  private readonly chargeEndHandler = (): void => {
    this.releaseCharge();
  };

  private readonly collisionStartHandler = (event: CollisionEventLike): void => {
    const now = this.time.now;
    for (const pair of event.pairs) {
      const ballA = this.ballsByBodyId.get(pair.bodyA.id);
      const ballB = this.ballsByBodyId.get(pair.bodyB.id);
      const bumper = this.bumpers.get(pair.bodyA.id) ?? this.bumpers.get(pair.bodyB.id);
      const bumperBall = ballA ?? ballB;

      if (bumper && bumperBall) {
        this.hitBumper(bumper, bumperBall, now);
        continue;
      }

      if (ballA && ballB && canMerge(
        ballA.level,
        ballB.level,
        ballA.isMerging,
        ballB.isMerging,
        GAME_CONFIG.maxLevel,
      )) {
        this.contactStarts.set(this.contactKey(ballA.id, ballB.id), now);
      }
    }
  };

  private readonly collisionEndHandler = (event: CollisionEventLike): void => {
    for (const pair of event.pairs) {
      const ballA = this.ballsByBodyId.get(pair.bodyA.id);
      const ballB = this.ballsByBodyId.get(pair.bodyB.id);
      if (ballA && ballB) {
        this.contactStarts.delete(this.contactKey(ballA.id, ballB.id));
      }
    }
  };

  public constructor() {
    super('HajikeScene');
  }

  public create(): void {
    this.bag = new BallBagQueue(this.random);
    this.score = 0;
    this.bestScore = loadBestScore();
    this.comboCount = 0;
    this.dangerStartedAt = null;
    this.mergeAnimationUntil = 0;
    this.launchedBallId = null;
    this.chargeStartedAt = null;
    this.launchBumperHitCount = 0;
    this.lastLaunchBumperId = null;
    this.bumperHitCooldowns.clear();
    this.state = 'Initializing';

    this.boardGraphics = this.add.graphics().setDepth(0);
    this.ballGraphics = this.add.graphics().setDepth(1);
    this.fxGraphics = this.add.graphics().setDepth(3);
    this.drawBoard();
    this.createStaticBodies();
    this.createBumpers();
    this.matter.world.setGravity(0, GAME_CONFIG.gravityY);
    this.matter.world.on('collisionstart', this.collisionStartHandler);
    this.matter.world.on('collisionend', this.collisionEndHandler);
    window.addEventListener('hajike:action', this.actionHandler);
    window.addEventListener('hajike:charge-start', this.chargeStartHandler);
    window.addEventListener('hajike:charge-end', this.chargeEndHandler);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.handleShutdown, this);

    this.emit('hajike:score', { score: this.score, best: this.bestScore });
    this.emit('hajike:queue', { queue: this.bag.peek(3) });
    this.emit('hajike:power', { ratio: 0 });
    this.setState('Ready');
    this.renderWorld();
  }

  public override update(): void {
    if (this.state === 'Paused' || this.state === 'GameOver') return;

    const now = this.time.now;
    if (this.state === 'Charging' && this.chargeStartedAt !== null) {
      const holdTime = now - this.chargeStartedAt;
      this.emit('hajike:power', {
        ratio: calculateChargeRatio(holdTime, GAME_CONFIG.maxChargeTimeMs),
      });
    }

    this.updateLaunchProgress();
    this.resolveMergeContacts(now);
    this.capAllBodySpeeds();
    this.updateDangerState(now);
    this.renderWorld();
  }

  private beginCharge(): void {
    if (this.state !== 'Ready' || this.launchedBallId !== null) return;
    this.chargeStartedAt = this.time.now;
    this.setState('Charging');
    this.emit('hajike:power', { ratio: 0 });
  }

  private releaseCharge(): void {
    if (this.state !== 'Charging' || this.chargeStartedAt === null) return;
    const holdTime = this.time.now - this.chargeStartedAt;
    const speed = calculateLaunchSpeed(
      holdTime,
      GAME_CONFIG.minLaunchSpeed,
      GAME_CONFIG.maxLaunchSpeed,
      GAME_CONFIG.maxChargeTimeMs,
    );
    this.chargeStartedAt = null;
    this.emit('hajike:power', { ratio: 0 });

    const level = this.bag.draw();
    this.emit('hajike:queue', { queue: this.bag.peek(3) });
    this.launchBumperHitCount = 0;
    this.lastLaunchBumperId = null;
    const start = GAME_CONFIG.launchLane.path[0];
    const ball = this.createBall(
      start.x,
      start.y,
      level,
      true,
      null,
      speed,
    );
    this.launchedBallId = ball.id;
    const launchDirection = this.laneDirection(0);
    this.setBodyVelocity(ball.body, {
      x: launchDirection.x * speed,
      y: launchDirection.y * speed,
    });
    this.setBodyAngularVelocity(ball.body, level % 2 === 0 ? 0.045 : -0.045);
    this.setState('Launching');
    this.emit('hajike:effect', { message: `Lv.${level} 逋ｺ蟆・ｼ～ });
    this.time.delayedCall(GAME_CONFIG.launchLane.fallbackTimeoutMs, () => {
      if (this.launchedBallId !== ball.id || !this.balls.has(ball.id)) return;
      this.enterFieldFromLane(ball);
      // 菴朱溯ｨｭ螳壹∈隱ｿ謨ｴ縺励◆蝣ｴ蜷医〒繧ゅ∵ｬ｡蠑ｾ縺梧ｰｸ荵・↓繝ｭ繝・け縺輔ｌ縺ｪ縺・ｿ晞匱縲・      this.enterFieldFromLane(ball);
    });
  }

  private updateLaunchProgress(): void {
    if (this.launchedBallId === null) return;
    const launchedBall = this.balls.get(this.launchedBallId);
    if (!launchedBall) {
      this.launchedBallId = null;
      if (this.state === 'Launching') this.setState('Ready');
      return;
    }

    const exit = GAME_CONFIG.launchLane.exitPosition;
    const isAtExit = Phaser.Math.Distance.Between(
      launchedBall.body.position.x,
      launchedBall.body.position.y,
      exit.x,
      exit.y,
    ) <= GAME_CONFIG.launchLane.exitTriggerRadius;
    if (launchedBall.isInLaunchLane && isAtExit) {
      this.enterFieldFromLane(launchedBall);
    }
  }

  private enterFieldFromLane(ball: BallEntity): void {
    if (!ball.isInLaunchLane) return;
    const previousBody = ball.body;
    const entrySpeed = Math.min(
      GAME_CONFIG.maxBodySpeed,
      Math.max(
        Math.hypot(previousBody.velocity.x, previousBody.velocity.y),
        (ball.launchSpeed ?? GAME_CONFIG.minLaunchSpeed) * 0.9,
      ),
    );
    const direction = GAME_CONFIG.launchLane.exitDirection;
    const exit = GAME_CONFIG.launchLane.exitPosition;
    const spawnOffset = GAME_CONFIG.launchLane.exitSpawnOffset;
    this.ballsByBodyId.delete(previousBody.id);
    this.matter.world.remove(previousBody);
    const entryBody = this.createBallBody(
      exit.x + direction.x * spawnOffset,
      exit.y + direction.y * spawnOffset,
      ball.level,
      false,
    );
    ball.body = entryBody;
    this.ballsByBodyId.set(entryBody.id, ball);
    ball.isInLaunchLane = false;
    this.setBodyVelocity(entryBody, {
      x: direction.x * entrySpeed,
      y: direction.y * entrySpeed,
    });
    if (this.launchedBallId === ball.id) this.launchedBallId = null;
    if (this.state === 'Launching') this.setState('Ready');
  }

  private resolveMergeContacts(now: number): void {
    const candidates: Array<{ a: BallEntity; b: BallEntity; key: string }> = [];
    const balls = [...this.balls.values()];

    for (let firstIndex = 0; firstIndex < balls.length; firstIndex += 1) {
      const ballA = balls[firstIndex];
      if (ballA.isInLaunchLane || ballA.isMerging) continue;
      for (let secondIndex = firstIndex + 1; secondIndex < balls.length; secondIndex += 1) {
        const ballB = balls[secondIndex];
        if (ballB.isInLaunchLane || !canMerge(
          ballA.level,
          ballB.level,
          ballA.isMerging,
          ballB.isMerging,
          GAME_CONFIG.maxLevel,
        )) continue;

        const distance = Phaser.Math.Distance.Between(
          ballA.body.position.x,
          ballA.body.position.y,
          ballB.body.position.x,
          ballB.body.position.y,
        );
        const touchingDistance = radiusForLevel(ballA.level) + radiusForLevel(ballB.level) + 4;
        if (distance > touchingDistance) {
          this.contactStarts.delete(this.contactKey(ballA.id, ballB.id));
          continue;
        }

        const key = this.contactKey(ballA.id, ballB.id);
        const contactStartedAt = this.contactStarts.get(key) ?? now;
        this.contactStarts.set(key, contactStartedAt);
        if (now - contactStartedAt >= GAME_CONFIG.merge.contactTimeMs) {
          candidates.push({ a: ballA, b: ballB, key });
        }
      }
    }

    const locked = new Set<number>();
    for (const candidate of candidates) {
      if (locked.has(candidate.a.id) || locked.has(candidate.b.id)) continue;
      if (!this.balls.has(candidate.a.id) || !this.balls.has(candidate.b.id)) continue;
      locked.add(candidate.a.id);
      locked.add(candidate.b.id);
      this.performMerge(candidate.a, candidate.b, candidate.key, now);
    }
  }

  private performMerge(ballA: BallEntity, ballB: BallEntity, key: string, now: number): void {
    const nextLevel = mergedLevel(ballA.level, ballB.level, GAME_CONFIG.maxLevel);
    if (nextLevel === null) return;

    ballA.isMerging = true;
    ballB.isMerging = true;
    const position = {
      x: (ballA.body.position.x + ballB.body.position.x) / 2,
      y: (ballA.body.position.y + ballB.body.position.y) / 2,
    };
    const velocity = {
      x: (ballA.body.velocity.x + ballB.body.velocity.x) / 2,
      y: (ballA.body.velocity.y + ballB.body.velocity.y) / 2,
    };
    this.contactStarts.delete(key);
    this.removeBall(ballA);
    this.removeBall(ballB);

    const chainCreatedAtCandidates = [ballA.mergeCreatedAt, ballB.mergeCreatedAt]
      .filter((createdAt): createdAt is number => createdAt !== null)
      .filter((createdAt) => now - createdAt <= GAME_CONFIG.comboWindowMs);
    const chainCreatedAt = chainCreatedAtCandidates.length > 0
      ? Math.max(...chainCreatedAtCandidates)
      : null;
    const mergedBall = this.createBall(position.x, position.y, nextLevel, false, now);
    this.setBodyVelocity(mergedBall.body, {
      x: velocity.x,
      y: velocity.y - GAME_CONFIG.merge.generatedImpulse,
    });
    this.setBodyAngularVelocity(mergedBall.body, velocity.x * 0.01);

    this.comboCount = nextComboCount(
      this.comboCount,
      chainCreatedAt,
      now,
      GAME_CONFIG.comboWindowMs,
    );
    const points = calculateMergeScore(nextLevel, this.comboCount);
    this.score += points;
    this.bestScore = Math.max(this.bestScore, this.score);
    saveBestScore(this.bestScore);
    this.mergeAnimationUntil = Math.max(
      this.mergeAnimationUntil,
      now + GAME_CONFIG.merge.postMergeDangerGraceMs,
    );
    this.applyShockwave(mergedBall);
    this.emit('hajike:score', { score: this.score, best: this.bestScore });
    this.emit('hajike:combo', {
      count: this.comboCount,
      multiplier: comboMultiplier(this.comboCount),
    });
    this.showBurst(position.x, position.y, BALL_COLORS[nextLevel] ?? BALL_COLORS[1]);

    if (nextLevel === GAME_CONFIG.maxLevel) {
      this.score += GAME_CONFIG.maxLevelBonus;
      this.bestScore = Math.max(this.bestScore, this.score);
      saveBestScore(this.bestScore);
      this.emit('hajike:score', { score: this.score, best: this.bestScore });
      this.emit('hajike:effect', { message: 'MAX LEVEL・・繝懊・繝翫せ・・ });
      this.time.delayedCall(GAME_CONFIG.maxLevelExitMs, () => {
        if (this.balls.has(mergedBall.id)) this.removeBall(mergedBall);
      });
    }
  }

  private updateDangerState(now: number): void {
    if (this.mergeAnimationUntil > now) {
      if (this.dangerStartedAt !== null) {
        this.dangerStartedAt = null;
        this.emit('hajike:danger', { active: false, progress: 0 });
      }
      return;
    }
    const dangerBall = [...this.balls.values()].some((ball) => {
      const speed = Math.hypot(ball.body.velocity.x, ball.body.velocity.y);
      const isStopped = ball.body.isSleeping || speed <= GAME_CONFIG.stoppedSpeed;
      const isOverLine = ball.body.position.y - radiusForLevel(ball.level) <= WORLD.dangerLineY;
      return !ball.isInLaunchLane && !ball.isMerging && isStopped && isOverLine;
    });

    if (dangerBall) {
      if (this.dangerStartedAt === null) this.dangerStartedAt = now;
      const progress = dangerProgress(this.dangerStartedAt, now, GAME_CONFIG.dangerGraceMs);
      this.emit('hajike:danger', { active: true, progress });
      if (dangerDurationReached(this.dangerStartedAt, now, GAME_CONFIG.dangerGraceMs)) {
        this.gameOver();
      }
      return;
    }

    if (this.dangerStartedAt !== null) {
      this.dangerStartedAt = null;
      this.emit('hajike:danger', { active: false, progress: 0 });
    }
  }

  private gameOver(): void {
    if (this.state === 'GameOver') return;
    this.chargeStartedAt = null;
    this.emit('hajike:charge-cancelled', {});
    this.setState('GameOver');
    this.matter.world.pause();
    const result = updateBestScore(this.score);
    this.bestScore = result.best;
    this.emit('hajike:score', { score: this.score, best: this.bestScore });
    this.emit('hajike:game-over', {
      score: this.score,
      best: this.bestScore,
      isNewBest: result.isNewBest,
    });
  }

  private togglePause(): void {
    if (this.state === 'GameOver') return;
    if (this.state === 'Paused') {
      this.resumeGame();
      return;
    }
    this.stateBeforePause = this.state;
    if (this.state === 'Charging') {
      this.chargeStartedAt = null;
      this.emit('hajike:charge-cancelled', {});
    }
    this.matter.world.pause();
    this.setState('Paused');
  }

  private resumeGame(): void {
    if (this.state !== 'Paused') return;
    this.matter.world.resume();
    this.setState(this.stateBeforePause === 'Charging' ? 'Ready' : this.stateBeforePause);
  }

  private restartGame(): void {
    this.scene.restart();
  }

  private setState(nextState: GameState): void {
    this.state = nextState;
    this.emit('hajike:status', { state: nextState });
    this.emit('hajike:input', { enabled: nextState === 'Ready' });
  }

  private createBall(
    x: number,
    y: number,
    level: number,
    isInLaunchLane: boolean,
    mergeCreatedAt: number | null = null,
    launchSpeed: number | null = null,
  ): BallEntity {
    const id = this.nextBallId;
    this.nextBallId += 1;
    const radius = radiusForLevel(level);
    const body = this.createBallBody(x, y, level, isInLaunchLane);
    const label = this.add.text(x, y, String(level), {
      color: '#ffffff',
      fontFamily: 'Arial, sans-serif',
      fontSize: `${Math.round(radius * 0.95)}px`,
      fontStyle: 'bold',
      stroke: '#14375b',
      strokeThickness: Math.max(2, Math.round(radius * 0.11)),
    }).setOrigin(0.5).setDepth(2);
    const ball: BallEntity = {
      id,
      level,
      body,
      label,
      isMerging: false,
      isInLaunchLane,
      mergeCreatedAt,
      launchSpeed,
    };
    this.balls.set(id, ball);
    this.ballsByBodyId.set(body.id, ball);
    return ball;
  }

  private createBallBody(x: number, y: number, level: number, isInLaunchLane: boolean): MatterJS.BodyType {
    const radius = radiusForLevel(level);
    const launchMask = COLLISION_CATEGORY.ball
      | COLLISION_CATEGORY.laneWall
      | COLLISION_CATEGORY.bumper;
    const fieldMask = COLLISION_CATEGORY.ball
      | COLLISION_CATEGORY.fieldWall
      | COLLISION_CATEGORY.bumper
      | COLLISION_CATEGORY.laneGate;
    return this.matter.add.circle(x, y, radius, {
      label: 'hajike-ball',
      density: 0.001 * massForLevel(level),
      restitution: GAME_CONFIG.ball.restitution,
      friction: GAME_CONFIG.ball.friction,
      frictionAir: GAME_CONFIG.ball.frictionAir,
      slop: 0.02,
      sleepThreshold: GAME_CONFIG.ball.sleepThreshold,
      collisionFilter: {
        category: COLLISION_CATEGORY.ball,
        mask: isInLaunchLane ? launchMask : fieldMask,
      },
    });
  }

  private removeBall(ball: BallEntity): void {
    this.balls.delete(ball.id);
    this.ballsByBodyId.delete(ball.body.id);
    ball.label.destroy();
    this.matter.world.remove(ball.body);
    for (const key of this.contactStarts.keys()) {
      const [firstId, secondId] = key.split(':').map(Number);
      if (firstId === ball.id || secondId === ball.id) this.contactStarts.delete(key);
    }
  }

  private createStaticBodies(): void {
    const addWall = (
      x: number,
      y: number,
      width: number,
      height: number,
      restitution: number,
      friction: number,
      label: string,
      category: number,
    ): void => {
      const wall = this.matter.add.rectangle(x, y, width, height, {
        isStatic: true,
        label,
        restitution,
        friction,
        collisionFilter: {
          category,
          mask: COLLISION_CATEGORY.ball,
        },
      });
      this.staticBodies.push(wall);
    };

    const fieldMidX = (WORLD.field.left + WORLD.field.right) / 2;
    const fieldMidY = (WORLD.field.top + WORLD.field.bottom) / 2;
    addWall(WORLD.field.left - 8, fieldMidY, 16, WORLD.field.bottom - WORLD.field.top + 40, GAME_CONFIG.wall.restitution, GAME_CONFIG.wall.friction, 'field-left-wall', COLLISION_CATEGORY.fieldWall);
    // 繝輔ぅ繝ｼ繝ｫ繝牙・縺ｯ荳顔ｫｯ縺ｾ縺ｧ騾｣邯壹＠縺溷｣√↓縺励※縲・ｲ蜈･貂医∩縺ｮ逅・′繝ｬ繝ｼ繝ｳ縺ｸ謌ｻ繧峨↑縺・ｈ縺・↓縺吶ｋ縲・    addWall(WORLD.field.right + 8, (WORLD.field.top + WORLD.field.bottom) / 2, 16, WORLD.field.bottom - WORLD.field.top + 40, GAME_CONFIG.wall.restitution, GAME_CONFIG.wall.friction, 'field-right-wall', COLLISION_CATEGORY.fieldWall);
    addWall(fieldMidX, WORLD.field.bottom + 8, WORLD.field.right - WORLD.field.left + 32, 16, GAME_CONFIG.floor.restitution, GAME_CONFIG.floor.friction, 'field-floor', COLLISION_CATEGORY.fieldWall);
    addWall(fieldMidX, WORLD.field.top - 8, WORLD.field.right - WORLD.field.left + 32, 16, GAME_CONFIG.wall.restitution, GAME_CONFIG.wall.friction, 'field-top-wall', COLLISION_CATEGORY.fieldWall);
    this.createCurvedLaunchLaneWalls();
  }

  private laneDirection(segmentIndex: number): VectorLike {
    const path = GAME_CONFIG.launchLane.path;
    const startIndex = Math.max(0, Math.min(segmentIndex, path.length - 2));
    const start = path[startIndex];
    const end = path[startIndex + 1];
    const distance = Math.max(Math.hypot(end.x - start.x, end.y - start.y), 1);
    return {
      x: (end.x - start.x) / distance,
      y: (end.y - start.y) / distance,
    };
  }

  private addLaneSegment(start: VectorLike, end: VectorLike, label: string): void {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.max(Math.hypot(dx, dy), GAME_CONFIG.launchLane.wallThickness);
    const body = this.matter.add.rectangle(
      (start.x + end.x) / 2,
      (start.y + end.y) / 2,
      length + GAME_CONFIG.launchLane.segmentOverlap,
      GAME_CONFIG.launchLane.wallThickness,
      {
        isStatic: true,
        angle: Math.atan2(dy, dx),
        label,
        restitution: GAME_CONFIG.wall.restitution,
        friction: GAME_CONFIG.wall.friction,
        collisionFilter: {
          category: COLLISION_CATEGORY.laneWall,
          mask: COLLISION_CATEGORY.ball,
        },
      },
    );
    this.staticBodies.push(body);
  }

  private createCurvedLaunchLaneWalls(): void {
    const path = GAME_CONFIG.launchLane.path;
    const halfWidth = GAME_CONFIG.launchLane.corridorWidth / 2;
    const leftPoints: VectorLike[] = [];
    const rightPoints: VectorLike[] = [];

    for (let index = 0; index < path.length; index += 1) {
      const direction = this.laneDirection(Math.min(index, path.length - 2));
      if (index === path.length - 1) {
        const previousDirection = this.laneDirection(path.length - 2);
        direction.x = previousDirection.x;
        direction.y = previousDirection.y;
      }
      const normal = { x: -direction.y, y: direction.x };
      leftPoints.push({
        x: path[index].x + normal.x * halfWidth,
        y: path[index].y + normal.y * halfWidth,
      });
      rightPoints.push({
        x: path[index].x - normal.x * halfWidth,
        y: path[index].y - normal.y * halfWidth,
      });
    }

    for (let index = 0; index < path.length - 1; index += 1) {
      this.addLaneSegment(leftPoints[index], leftPoints[index + 1], 'launch-lane-left-wall');
      this.addLaneSegment(rightPoints[index], rightPoints[index + 1], 'launch-lane-right-wall');
    }

    for (const point of [...leftPoints, ...rightPoints]) {
      const joint = this.matter.add.circle(
        point.x,
        point.y,
        GAME_CONFIG.launchLane.jointRadius,
        {
          isStatic: true,
          label: 'launch-lane-rounded-joint',
          restitution: GAME_CONFIG.wall.restitution,
          friction: GAME_CONFIG.wall.friction,
          collisionFilter: {
            category: COLLISION_CATEGORY.laneWall,
            mask: COLLISION_CATEGORY.ball,
          },
        },
      );
      this.staticBodies.push(joint);
    }

    this.addLaneSegment(leftPoints[0], rightPoints[0], 'launch-lane-start-cap');

    const exit = GAME_CONFIG.launchLane.exitPosition;
    const exitGate = this.matter.add.rectangle(
      exit.x,
      exit.y,
      GAME_CONFIG.launchLane.gateWidth,
      GAME_CONFIG.launchLane.gateThickness,
      {
        isStatic: true,
        angle: GAME_CONFIG.launchLane.exitAngleRadians + Math.PI / 2,
        label: 'launch-lane-one-way-gate',
        restitution: GAME_CONFIG.wall.restitution,
        friction: GAME_CONFIG.wall.friction,
        collisionFilter: {
          category: COLLISION_CATEGORY.laneGate,
          mask: COLLISION_CATEGORY.ball,
        },
      },
    );
    this.staticBodies.push(exitGate);
  }

  private createBumpers(): void {
    const positions = [
      { x: 220, y: 375 },
      { x: 420, y: 375 },
      { x: 320, y: 580 },
    ];
    for (const position of positions) {
      const body = this.matter.add.circle(position.x, position.y, GAME_CONFIG.bumper.radius, {
        isStatic: true,
        label: 'hajike-bumper',
        restitution: GAME_CONFIG.bumper.restitution,
        friction: GAME_CONFIG.bumper.friction,
        collisionFilter: {
          category: COLLISION_CATEGORY.bumper,
          mask: COLLISION_CATEGORY.ball,
        },
      });
      this.bumpers.set(body.id, {
        body,
        x: position.x,
        y: position.y,
        pulseUntil: 0,
      });
    }
  }

  private hitBumper(bumper: BumperEntity, ball: BallEntity, now: number): void {
    if (ball.isMerging) return;
    const cooldownKey = `${ball.id}:${bumper.body.id}`;
    const lastHitAt = this.bumperHitCooldowns.get(cooldownKey) ?? Number.NEGATIVE_INFINITY;
    if (now - lastHitAt < GAME_CONFIG.bumper.scoreCooldownMs) return;
    this.bumperHitCooldowns.set(cooldownKey, now);
    bumper.pulseUntil = now + GAME_CONFIG.bumper.pulseDurationMs;
    const dx = ball.body.position.x - bumper.x;
    const dy = ball.body.position.y - bumper.y;
    const distance = Math.max(Math.hypot(dx, dy), 1);
    const normal = { x: dx / distance, y: dy / distance };
    const impactSpeed = Math.hypot(ball.body.velocity.x, ball.body.velocity.y);
    const points = calculateBumperHitScore(impactSpeed);
    this.setBodyVelocity(ball.body, {
      x: ball.body.velocity.x + normal.x * GAME_CONFIG.bumper.impulse,
      y: ball.body.velocity.y + normal.y * GAME_CONFIG.bumper.impulse,
    });
    this.score += points;
    this.bestScore = Math.max(this.bestScore, this.score);
    saveBestScore(this.bestScore);
    if (this.lastLaunchBumperId !== bumper.body.id) {
      this.launchBumperHitCount += 1;
      this.lastLaunchBumperId = bumper.body.id;
    }
    this.emit('hajike:score', { score: this.score, best: this.bestScore });
    this.emit('hajike:bumper-hit', {
      count: this.launchBumperHitCount,
      points,
      impactSpeed,
    });
    this.showBurst(bumper.x + normal.x * 24, bumper.y + normal.y * 24, 0xbfeeff, 5);
  }

  private applyShockwave(source: BallEntity): void {
    const multiplier = GAME_CONFIG.mergeShockwave.levelMultipliers[source.level] ?? 1;
    const multiplierProgress = Math.min(Math.max((multiplier - 1) / 3, 0), 1);
    const impulse = GAME_CONFIG.mergeShockwave.minImpulse
      + (GAME_CONFIG.mergeShockwave.maxImpulse - GAME_CONFIG.mergeShockwave.minImpulse)
        * multiplierProgress ** 1.25;
    const radius = GAME_CONFIG.mergeShockwave.minRadius
      + (GAME_CONFIG.mergeShockwave.maxRadius - GAME_CONFIG.mergeShockwave.minRadius)
        * multiplierProgress ** 0.85;

    for (const ball of this.balls.values()) {
      if (ball.id === source.id || ball.isInLaunchLane || ball.isMerging) continue;
      const dx = ball.body.position.x - source.body.position.x;
      const dy = ball.body.position.y - source.body.position.y;
      const distance = Math.hypot(dx, dy);
      if (distance > radius || distance < 1) continue;
      const falloff = (1 - distance / radius) ** GAME_CONFIG.mergeShockwave.falloffExponent;
      const scale = impulse * falloff;
      this.setBodyVelocity(ball.body, {
        x: ball.body.velocity.x + (dx / distance) * scale,
        y: ball.body.velocity.y + (dy / distance) * scale,
      });
      this.capBodySpeed(ball.body);
    }
  }

  private capAllBodySpeeds(): void {
    for (const ball of this.balls.values()) this.capBodySpeed(ball.body);
  }

  private capBodySpeed(body: MatterJS.BodyType): void {
    const speed = Math.hypot(body.velocity.x, body.velocity.y);
    if (speed <= GAME_CONFIG.maxBodySpeed || speed < 0.001) return;
    const scale = GAME_CONFIG.maxBodySpeed / speed;
    this.setBodyVelocity(body, {
      x: body.velocity.x * scale,
      y: body.velocity.y * scale,
    });
  }

  private setBodyVelocity(body: MatterJS.BodyType, velocity: VectorLike): void {
    this.matter.body.setVelocity(body, velocity);
  }

  private setBodyAngularVelocity(body: MatterJS.BodyType, velocity: number): void {
    this.matter.body.setAngularVelocity(body, velocity);
  }

  private drawBoard(): void {
    this.boardGraphics.clear();
    this.boardGraphics.fillStyle(0x08234a, 1);
    this.boardGraphics.fillRoundedRect(55, 60, 610, 1130, 32);
    this.boardGraphics.lineStyle(6, 0x4a7caa, 0.45);
    this.boardGraphics.strokeRoundedRect(55, 60, 610, 1130, 32);
    this.boardGraphics.fillStyle(0x132f5b, 1);
    this.boardGraphics.fillRoundedRect(WORLD.field.left, WORLD.field.top + 12, WORLD.field.right - WORLD.field.left, WORLD.field.bottom - WORLD.field.top - 12, 16);
    this.boardGraphics.lineStyle(4, 0x5d92c1, 0.7);
    this.boardGraphics.strokeRoundedRect(WORLD.field.left, WORLD.field.top + 12, WORLD.field.right - WORLD.field.left, WORLD.field.bottom - WORLD.field.top - 12, 16);
    const lanePath = GAME_CONFIG.launchLane.path;
    this.boardGraphics.lineStyle(GAME_CONFIG.launchLane.corridorWidth, 0x163f70, 1);
    for (let index = 0; index < lanePath.length - 1; index += 1) {
      this.boardGraphics.lineBetween(
        lanePath[index].x,
        lanePath[index].y,
        lanePath[index + 1].x,
        lanePath[index + 1].y,
      );
    }
    this.boardGraphics.lineStyle(4, 0x67b9ec, 0.8);
    for (let index = 0; index < lanePath.length - 1; index += 1) {
      this.boardGraphics.lineBetween(
        lanePath[index].x,
        lanePath[index].y,
        lanePath[index + 1].x,
        lanePath[index + 1].y,
      );
    }
    this.boardGraphics.fillStyle(0xa3dfff, 0.65);
    this.boardGraphics.fillCircle(
      GAME_CONFIG.launchLane.exitPosition.x,
      GAME_CONFIG.launchLane.exitPosition.y,
      7,
    );
    this.boardGraphics.lineStyle(2, 0xff5b60, 0.28);
    this.boardGraphics.lineBetween(WORLD.field.left + 8, WORLD.dangerLineY, WORLD.field.right - 8, WORLD.dangerLineY);
  }

  private renderWorld(): void {
    const now = this.time.now;
    this.ballGraphics.clear();
    this.fxGraphics.clear();

    for (const bumper of this.bumpers.values()) {
      const pulse = bumper.pulseUntil > now ? 1 + ((bumper.pulseUntil - now) / 180) * 0.2 : 1;
      this.ballGraphics.fillStyle(0x4aa7dd, 1);
      this.ballGraphics.fillCircle(bumper.x, bumper.y, GAME_CONFIG.bumper.radius * pulse);
      this.ballGraphics.lineStyle(5, 0x8fdcff, 0.95);
      this.ballGraphics.strokeCircle(bumper.x, bumper.y, GAME_CONFIG.bumper.radius * pulse);
      this.ballGraphics.fillStyle(0xe8fbff, 0.9);
      this.ballGraphics.fillCircle(bumper.x - 10, bumper.y - 10, 9 * pulse);
      this.ballGraphics.fillStyle(0x1b5d91, 0.95);
      this.ballGraphics.fillCircle(bumper.x + 4, bumper.y + 5, 6 * pulse);
    }

    for (const ball of this.balls.values()) {
      const position = ball.body.position;
      const radius = radiusForLevel(ball.level);
      const color = BALL_COLORS[ball.level] ?? BALL_COLORS[1];
      const alpha = ball.isInLaunchLane ? 0.92 : 1;
      this.ballGraphics.fillStyle(color, alpha);
      this.ballGraphics.fillCircle(position.x, position.y, radius);
      this.ballGraphics.lineStyle(3, 0x071c39, 0.68);
      this.ballGraphics.strokeCircle(position.x, position.y, radius);
      this.ballGraphics.fillStyle(0xffffff, 0.2);
      this.ballGraphics.fillCircle(position.x - radius * 0.32, position.y - radius * 0.34, radius * 0.2);
      ball.label.setPosition(position.x, position.y);
    }
  }

  private showBurst(x: number, y: number, color: number, particleCount = 8): void {
    const ring = this.add.circle(x, y, 12, color, 0.18).setStrokeStyle(4, color, 0.9).setDepth(4);
    this.tweens.add({
      targets: ring,
      scale: 4,
      alpha: 0,
      duration: 340,
      ease: 'Cubic.Out',
      onComplete: () => ring.destroy(),
    });

    for (let index = 0; index < particleCount; index += 1) {
      const angle = (Math.PI * 2 * index) / particleCount;
      const distance = 22 + (index % 3) * 9;
      const particle = this.add.circle(x, y, 4, color, 0.9).setDepth(4);
      this.tweens.add({
        targets: particle,
        x: x + Math.cos(angle) * distance,
        y: y + Math.sin(angle) * distance,
        scale: 0.2,
        alpha: 0,
        duration: 380,
        ease: 'Cubic.Out',
        onComplete: () => particle.destroy(),
      });
    }
  }

  private contactKey(firstId: number, secondId: number): string {
    return firstId < secondId ? `${firstId}:${secondId}` : `${secondId}:${firstId}`;
  }

  private emit(name: string, detail: unknown): void {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  private handleShutdown(): void {
    window.removeEventListener('hajike:action', this.actionHandler);
    window.removeEventListener('hajike:charge-start', this.chargeStartHandler);
    window.removeEventListener('hajike:charge-end', this.chargeEndHandler);
    this.matter.world.off('collisionstart', this.collisionStartHandler);
    this.matter.world.off('collisionend', this.collisionEndHandler);
    this.contactStarts.clear();
    this.bumperHitCooldowns.clear();
    this.balls.clear();
    this.ballsByBodyId.clear();
    this.bumpers.clear();
    this.launchBumperHitCount = 0;
    this.lastLaunchBumperId = null;
    this.staticBodies.length = 0;
  }
}

