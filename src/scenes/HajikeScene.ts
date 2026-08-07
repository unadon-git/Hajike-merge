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
  containCircleInBounds,
  dangerDurationReached,
  dangerProgress,
  canMerge,
  limitVector,
  loadBestScore,
  mergedLevel,
  nextComboCount,
  pointAlongPath,
  projectPointToPath,
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
  private launchPathDistance = 0;
  private launchLastProgressAt = 0;

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

  private readonly chargeCancelHandler = (): void => {
    this.cancelCharge();
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
    this.nextBallId = 1;
    this.score = 0;
    this.bestScore = loadBestScore();
    this.comboCount = 0;
    this.dangerStartedAt = null;
    this.mergeAnimationUntil = 0;
    this.launchedBallId = null;
    this.chargeStartedAt = null;
    this.launchBumperHitCount = 0;
    this.lastLaunchBumperId = null;
    this.launchPathDistance = 0;
    this.launchLastProgressAt = 0;
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
    window.addEventListener('hajike:charge-cancel', this.chargeCancelHandler);
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

    this.capAllBodySpeeds();
    this.updateLaunchProgress(now);
    this.recoverFieldBodies();
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
    this.launchPathDistance = 0;
    this.launchLastProgressAt = this.time.now;
    const launchDirection = this.laneDirection(0);
    this.setBodyVelocity(ball.body, {
      x: launchDirection.x * GAME_CONFIG.launchLane.laneTravelSpeed,
      y: launchDirection.y * GAME_CONFIG.launchLane.laneTravelSpeed,
    });
    this.setBodyAngularVelocity(ball.body, level % 2 === 0 ? 0.045 : -0.045);
    this.setState('Launching');
    this.emit('hajike:effect', { message: `Lv.${level} ç™ºå°„ï¼` });
    this.time.delayedCall(GAME_CONFIG.launchLane.fallbackTimeoutMs, () => {
      if (this.launchedBallId !== ball.id || !this.balls.has(ball.id)) return;
      // ä½Žé€Ÿè¨­å®šã¸èª¿æ•´ã—ãŸå ´åˆã§ã‚‚ã€æ¬¡å¼¾ãŒæ°¸ä¹…ã«ãƒ­ãƒƒã‚¯ã•ã‚Œãªã„ä¿é™ºã€‚
      this.enterFieldFromLane(ball);
    });
  }

  private cancelCharge(): void {
    if (this.state !== 'Charging') return;
    this.chargeStartedAt = null;
    this.emit('hajike:power', { ratio: 0 });
    this.setState('Ready');
  }

  private updateLaunchProgress(now: number): void {
    if (this.launchedBallId === null) return;
    const launchedBall = this.balls.get(this.launchedBallId);
    if (!launchedBall) {
      this.launchedBallId = null;
      if (this.state === 'Launching') this.setState('Ready');
      return;
    }

    if (!launchedBall.isInLaunchLane) return;
    const path = GAME_CONFIG.launchLane.path;
    const projection = projectPointToPath(launchedBall.body.position, path);
    if (projection.distanceAlong >= this.launchPathDistance + GAME_CONFIG.launchLane.progressEpsilon) {
      this.launchLastProgressAt = now;
    }
    this.launchPathDistance = Math.max(this.launchPathDistance, projection.distanceAlong);

    const exit = GAME_CONFIG.launchLane.exitPosition;
    const isAtExit = Phaser.Math.Distance.Between(
      launchedBall.body.position.x,
      launchedBall.body.position.y,
      exit.x,
      exit.y,
    ) <= GAME_CONFIG.launchLane.exitTriggerRadius;
    const isNearPathEnd = this.launchPathDistance
      >= projection.totalLength - GAME_CONFIG.launchLane.exitTriggerRadius;
    if (isAtExit || isNearPathEnd) {
      this.enterFieldFromLane(launchedBall);
      return;
    }

    const isOffCenter = projection.distanceToPath > GAME_CONFIG.launchLane.maxCenterlineOffset;
    const isStalled = now - this.launchLastProgressAt >= GAME_CONFIG.launchLane.stallTimeoutMs;
    const targetDistance = Math.min(
      projection.totalLength,
      this.launchPathDistance + (isStalled
        ? GAME_CONFIG.launchLane.recoveryAdvance
        : GAME_CONFIG.launchLane.lookAheadDistance),
    );
    const target = pointAlongPath(path, targetDistance);

    if (isOffCenter || isStalled) {
      this.setBodyPosition(launchedBall.body, target.point);
      this.setBodyVelocity(launchedBall.body, {
        x: target.direction.x * GAME_CONFIG.launchLane.laneTravelSpeed,
        y: target.direction.y * GAME_CONFIG.launchLane.laneTravelSpeed,
      });
      this.launchPathDistance = targetDistance;
      this.launchLastProgressAt = now;
      return;
    }

    const dx = target.point.x - launchedBall.body.position.x;
    const dy = target.point.y - launchedBall.body.position.y;
    const distance = Math.max(Math.hypot(dx, dy), 1);
    const desiredVelocity = {
      x: (dx / distance) * GAME_CONFIG.launchLane.laneTravelSpeed,
      y: (dy / distance) * GAME_CONFIG.launchLane.laneTravelSpeed,
    };
    const steering = GAME_CONFIG.launchLane.steeringStrength;
    this.setBodyVelocity(launchedBall.body, limitVector({
      x: Phaser.Math.Linear(launchedBall.body.velocity.x, desiredVelocity.x, steering),
      y: Phaser.Math.Linear(launchedBall.body.velocity.y, desiredVelocity.y, steering),
    }, GAME_CONFIG.launchLane.laneTravelSpeed * 1.08));
  }

  private enterFieldFromLane(ball: BallEntity): void {
    if (!ball.isInLaunchLane) return;
    const previousBody = ball.body;
    const entrySpeed = Math.min(
      GAME_CONFIG.maxBodySpeed,
      Math.max(
        GAME_CONFIG.minLaunchSpeed,
        ball.launchSpeed ?? GAME_CONFIG.minLaunchSpeed,
      ),
    );
    const direction = GAME_CONFIG.launchLane.exitDirection;
    const exit = GAME_CONFIG.launchLane.exitPosition;
    const spawnOffset = GAME_CONFIG.launchLane.exitSpawnOffset;
    this.ballsByBodyId.delete(previousBody.id);
    this.matter.world.remove(previousBody);
    const entryPosition = containCircleInBounds(
      {
        x: exit.x + direction.x * spawnOffset,
        y: exit.y + direction.y * spawnOffset,
      },
      radiusForLevel(ball.level),
      WORLD.field,
      GAME_CONFIG.fieldBoundary.containmentPadding,
    ).position;
    const entryBody = this.createBallBody(
      entryPosition.x,
      entryPosition.y,
      ball.level,
      false,
    );
    ball.body = entryBody;
    this.ballsByBodyId.set(entryBody.id, ball);
    ball.isInLaunchLane = false;
    this.setBodyVelocity(entryBody, limitVector({
      x: direction.x * entrySpeed,
      y: direction.y * entrySpeed,
    }, GAME_CONFIG.maxBodySpeed));
    this.setBodyAngularVelocity(entryBody, ball.level % 2 === 0 ? 0.055 : -0.055);
    if (this.launchedBallId === ball.id) this.launchedBallId = null;
    this.launchPathDistance = 0;
    this.launchLastProgressAt = 0;
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
    const rawPosition = {
      x: (ballA.body.position.x + ballB.body.position.x) / 2,
      y: (ballA.ß}:¶‰žËkºwµçI¥Ù…Ñ”±…¹•Q…¹•¹ÑÑA½¥¹Ð¡Á½¥¹Ñ%¹‘•àè¹Õµ‰•È¤èY•Ñ½É1¥­”ì(€€€½¹ÍÐÁ…Ñ €ô5}=9%¹±…Õ¹¡1…¹”¹Á…Ñ ì(€€€¥˜€¡Á½¥¹Ñ%¹‘•à€ðô€À¤É•ÑÕÉ¸Ñ¡¥Ì¹±…¹•¥É•Ñ¥½¸ À¤ì(€€€¥˜€¡Á½¥¹Ñ%¹‘•à€øôÁ…Ñ ¹±•¹Ñ €´€Ä¤É•ÑÕÉ¸Ñ¡¥Ì¹±…¹•¥É•Ñ¥½¸¡Á…Ñ ¹±•¹Ñ €´€È¤ì(€€€½¹ÍÐÁÉ•Ù¥½ÕÌ€ôÑ¡¥Ì¹±…¹•¥É•Ñ¥½¸¡Á½¥¹Ñ%¹‘•à€´€Ä¤ì(€€€½¹ÍÐ¹•áÐ€ôÑ¡¥Ì¹±…¹•¥É•Ñ¥½¸¡Á½¥¹Ñ%¹‘•à¤ì(€€€½¹ÍÐ±•¹Ñ €ô5…Ñ ¹µ…à¡5…Ñ ¹¡åÁ½Ð¡ÁÉ•Ù¥½ÕÌ¹à€¬¹•áÐ¹à°ÁÉ•Ù¥½ÕÌ¹ä€¬¹•áÐ¹ä¤°€Ä¤ì(€€€É•ÑÕÉ¸ì(€€€€€àè€¡ÁÉ•Ù¥½ÕÌ¹à€¬¹•áÐ¹à¤€¼±•¹Ñ °(€€€€€äè€¡ÁÉ•Ù¥½ÕÌ¹ä€¬¹•áÐ¹ä¤€¼±•¹Ñ °(€€€ôì(€ô((€ÁÉ¥Ù…Ñ”…‘‘1…¹•M•µ•¹Ð¡ÍÑ…ÉÐèY•Ñ½É1¥­”°•¹èY•Ñ½É1¥­”°±…‰•°èÍÑÉ¥¹œ¤èÙ½¥ì(€€€½¹ÍÐ‘à€ô•¹¹à€´ÍÑ…ÉÐ¹àì(€€€½¹ÍÐ‘ä€ô•¹¹ä€´ÍÑ…ÉÐ¹äì(€€€½¹ÍÐ±•¹Ñ €ô5…Ñ ¹µ…à¡5…Ñ ¹¡åÁ½Ð¡‘à°‘ä¤°5}=9%¹±…Õ¹¡1…¹”¹Ý…±±Q¡¥­¹•ÍÌ¤ì(€€€½¹ÍÐ‰½‘ä€ôÑ¡¥Ì¹µ…ÑÑ•È¹…‘¹É•Ñ…¹±” (€€€€€€¡ÍÑ…ÉÐ¹à€¬•¹¹à¤€¼€È°(€€€€€€¡ÍÑ…ÉÐ¹ä€¬•¹¹ä¤€¼€È°(€€€€€±•¹Ñ €¬5}=9%¹±…Õ¹¡1…¹”¹Í•µ•¹Ñ=Ù•É±…À°(€€€€€5}=9%¹±…Õ¹¡1…¹”¹Ý…±±Q¡¥­¹•ÍÌ°(€€€€€ì(€€€€€€€¥ÍMÑ…Ñ¥ŒèÑÉÕ”°(€€€€€€€…¹±”è5…Ñ ¹…Ñ…¸È¡‘ä°‘à¤°(€€€€€€€±…‰•°°(€€€€€€€É•ÍÑ¥ÑÕÑ¥½¸è5}=9%¹Ý…±°¹É•ÍÑ¥ÑÕÑ¥½¸°(€€€€€€€™É¥Ñ¥½¸è5}=9%¹Ý…±°¹™É¥Ñ¥½¸°(€€€€€€€½±±¥Í¥½¹¥±Ñ•Èèì(€€€€€€€€€…Ñ•½Éäè=11%M%=9}Q=Id¹±…¹•]…±°°(€€€€€€€€€µ…Í¬è=11%M%=9}Q=Id¹‰…±°°(€€€€€€€ô°(€€€€€ô°(€€€€¤ì(€€€Ñ¡¥Ì¹ÍÑ…Ñ¥	½‘¥•Ì¹ÁÕÍ ¡‰½‘ä¤ì(€ô((€ÁÉ¥Ù…Ñ”É•…Ñ•ÕÉÙ•‘1…Õ¹¡1…¹•]…±±Ì ¤èÙ½¥ì(€€€½¹ÍÐÁ…Ñ €ô5}=9%¹±…Õ¹¡1…¹”¹Á…Ñ ì(€€€½¹ÍÐ¡…±™]¥‘Ñ €ô5}=9%¹±…Õ¹¡1…¹”¹½ÉÉ¥‘½É]¥‘Ñ €¼€Èì(€€€½¹ÍÐ±•™ÑA½¥¹ÑÌèY•Ñ½É1¥­•mt€ômtì(€€€½¹ÍÐÉ¥¡ÑA½¥¹ÑÌèY•Ñ½É1¥­•mt€ômtì((€€€™½È€¡±•Ð¥¹‘•à€ô€Àì¥¹‘•à€ðÁ…Ñ ¹±•¹Ñ ì¥¹‘•à€¬ô€Ä¤ì(€€€€€½¹ÍÐ‘¥É•Ñ¥½¸€ôÑ¡¥Ì¹±…¹•Q…¹•¹ÑÑA½¥¹Ð¡¥¹‘•à¤ì(€€€€€½¹ÍÐ¹½Éµ…°€ôìàè€µ‘¥É•Ñ¥½¸¹ä°äè‘¥É•Ñ¥½¸¹àôì(€€€€€±•™ÑA½¥¹ÑÌ¹ÁÕÍ ¡ì(€€€€€€€àèÁ…Ñ¡m¥¹‘•át¹à€¬¹½Éµ…°¹à€¨¡…±™]¥‘Ñ °(€€€€€€€äèÁ…Ñ¡m¥¹‘•át¹ä€¬¹½Éµ…°¹ä€¨¡…±™]¥‘Ñ °(€€€€€ô¤ì(€€€€€É¥¡ÑA½¥¹ÑÌ¹ÁÕÍ ¡ì(€€€€€€€àèÁ…Ñ¡m¥¹‘•át¹à€´¹½Éµ…°¹à€¨¡…±™]¥‘Ñ °(€€€€€€€äèÁ…Ñ¡m¥¹‘•át¹ä€´¹½Éµ…°¹ä€¨¡…±™]¥‘Ñ °(€€€€€ô¤ì(€€€ô((€€€™½È€¡±•Ð¥¹‘•à€ô€Àì¥¹‘•à€ðÁ…Ñ ¹±•¹Ñ €´€Äì¥¹‘•à€¬ô€Ä¤ì(€€€€€Ñ¡¥Ì¹…‘‘1…¹•M•µ•¹Ð¡±•™ÑA½¥¹ÑÍm¥¹‘•át°±•™ÑA½¥¹ÑÍm¥¹‘•à€¬€Åt°€±…Õ¹ µ±…¹”µ±•™ÐµÝ…±°œ¤ì(€€€€€Ñ¡¥Ì¹…‘‘1…¹•M•µ•¹Ð¡É¥¡ÑA½¥¹ÑÍm¥¹‘•át°É¥¡ÑA½¥¹ÑÍm¥¹‘•à€¬€Åt°€±…Õ¹ µ±…¹”µÉ¥¡ÐµÝ…±°œ¤ì(€€€ô((€€€™½È€¡½¹ÍÐÁ½¥¹Ð½˜l¸¸¹±•™ÑA½¥¹ÑÌ°€¸¸¹É¥¡ÑA½¥¹ÑÍt¤ì(€€€€€½¹ÍÐ©½¥¹Ð€ôÑ¡¥Ì¹µ…ÑÑ•È¹…‘¹¥É±” (€€€€€€€Á½¥¹Ð¹à°(€€€€€€€Á½¥¹Ð¹ä°(€€€€€€€5}=9%¹±…Õ¹¡1…¹”¹©½¥¹ÑI…‘¥ÕÌ°(€€€€€€€ì(€€€€€€€€€¥ÍMÑ…Ñ¥ŒèÑÉÕ”°(€€€€€€€€€±…‰•°è€±…Õ¹ µ±…¹”µÉ½Õ¹‘•µ©½¥¹Ðœ°(€€€€€€€€€É•ÍÑ¥ÑÕÑ¥½¸è5}=9%¹Ý…±°¹É•ÍÑ¥ÑÕÑ¥½¸°(€€€€€€€€€™É¥Ñ¥½¸è5}=9%¹Ý…±°¹™É¥Ñ¥½¸°(€€€€€€€€€½±±¥Í¥½¹¥±Ñ•Èèì(€€€€€€€€€€€…Ñ•½Éäè=11%M%=9}Q=Id¹±…¹•]…±°°(€€€€€€€€€€€µ…Í¬è=11%M%=9}Q=Id¹‰…±°°(€€€€€€€€€ô°(€€€€€€€ô°(€€€€€€¤ì(€€€€€Ñ¡¥Ì¹ÍÑ…Ñ¥	½‘¥•Ì¹ÁÕÍ ¡©½¥¹Ð¤ì(€€€ô((€€€Ñ¡¥Ì¹…‘‘1…¹•M•µ•¹Ð¡±•™ÑA½¥¹ÑÍlÁt°É¥¡ÑA½¥¹ÑÍlÁt°€±…Õ¹ µ±…¹”µÍÑ…ÉÐµ…Àœ¤ì((€€€½¹ÍÐ•á¥Ð€ô5}=9%¹±…Õ¹¡1…¹”¹•á¥ÑA½Í¥Ñ¥½¸ì(€€€€¼¼ƒŽ
ïŽÏŽ
×ŽóŽ¿–ë–>š’sž~—žR£Ž¦Ë–—–ú3Ž¿¢†wžªŽ
¯ŽŽ
ÓŽ«Ž
I™¥•±“Žã–"Ž
+šnÿŽ#Ž(€€€€¼¼ƒ¦žÚkŽ_Ž–>Ï–ŽŽŸŽ³ŽóŽÏŽãŽ»¦šÖŽ
Kž&§žBžjŽ¯¦bËŽCŽ(€€€½¹ÍÐ•á¥Ñ…Ñ”€ôÑ¡¥Ì¹µ…ÑÑ•È¹…‘¹É•Ñ…¹±” (€€€€€•á¥Ð¹à°(€€€€€•á¥Ð¹ä°(€€€€€5}=9%¹±…Õ¹¡1…¹”¹…Ñ•]¥‘Ñ °(€€€€€5}=9%¹±…Õ¹¡1…¹”¹…Ñ•Q¡¥­¹•ÍÌ°(€€€€€ì(€€€€€€€¥ÍMÑ…Ñ¥ŒèÑÉÕ”°(€€€€€€€¥ÍM•¹Í½ÈèÑÉÕ”°(€€€€€€€…¹±”è5}=9%¹±…Õ¹¡1…¹”¹•á¥Ñ¹±•I…‘¥…¹Ì€¬5…Ñ ¹A$€¼€È°(€€€€€€€±…‰•°è€±…Õ¹ µ±…¹”µ½¹”µÝ…äµ…Ñ”œ°(€€€€€€€½±±¥Í¥½¹¥±Ñ•Èèì(€€€€€€€€€…Ñ•½Éäè=11%M%=9}Q=Id¹±…¹•…Ñ”°(€€€€€€€€€µ…Í¬è=11%M%=9}Q=Id¹‰…±°°(€€€€€€€ô°(€€€€€ô°(€€€€¤ì(€€€Ñ¡¥Ì¹ÍÑ…Ñ¥	½‘¥•Ì¹ÁÕÍ ¡•á¥Ñ…Ñ”¤ì(€ô((€ÁÉ¥Ù…Ñ”É•…Ñ•	ÕµÁ•ÉÌ ¤èÙ½¥ì(€€€½¹ÍÐÁ½Í¥Ñ¥½¹Ì€ôl(€€€€€ìàè€ÈÈÀ°äè€ÌÜÔô°(€€€€€ìàè€ÐÈÀ°äè€ÌÜÔô°(€€€€€ìàè€ÌÈÀ°äè€ÔàÀô°(€€€tì(€€€™½È€¡½¹ÍÐÁ½Í¥Ñ¥½¸½˜Á½Í¥Ñ¥½¹Ì¤ì(€€€€€½¹ÍÐ‰½‘ä€ôÑ¡¥Ì¹µ…ÑÑ•È¹…‘¹¥É±”¡Á½Í¥Ñ¥½¸¹à°Á½Í¥Ñ¥½¸¹ä°5}=9%¹‰ÕµÁ•È¹É…‘¥ÕÌ°ì(€€€€€€€¥ÍMÑ…Ñ¥ŒèÑÉÕ”°(€€€€€€€±…‰•°è€¡…©¥­”µ‰ÕµÁ•Èœ°(€€€€€€€É•ÍÑ¥ÑÕÑ¥½¸è5}=9%¹‰ÕµÁ•È¹É•ÍÑ¥ÑÕÑ¥½¸°(€€€€€€€™É¥Ñ¥½¸è5}=9%¹‰ÕµÁ•È¹™É¥Ñ¥½¸°(€€€€€€€½±±¥Í¥½¹¥±Ñ•Èèì(€€€€€€€€€…Ñ•½Éäè=11%M%=9}Q=Id¹‰ÕµÁ•È°(€€€€€€€€€µ…Í¬è=11%M%=9}Q=Id¹‰…±°°(€€€€€€€ô°(€€€€€ô¤ì(€€€€€Ñ¡¥Ì¹‰ÕµÁ•ÉÌ¹Í•Ð¡‰½‘ä¹¥°ì(€€€€€€€‰½‘ä°(€€€€€€€àèÁ½Í¥Ñ¥½¸¹à°(€€€€€€€äèÁ½Í¥Ñ¥½¸¹ä°(€€€€€€€ÁÕ±Í•U¹Ñ¥°è€À°(€€€€€ô¤ì(€€€ô(€ô((€ÁÉ¥Ù…Ñ”¡¥Ñ	ÕµÁ•È¡‰ÕµÁ•Èè	ÕµÁ•É¹Ñ¥Ñä°‰…±°è	…±±¹Ñ¥Ñä°¹½Üè¹Õµ‰•È¤èÙ½¥ì(€€€¥˜€¡‰…±°¹¥Í5•É¥¹œ¤É•ÑÕÉ¸ì(€€€½¹ÍÐ½½±‘½Ý¹-•ä€ô€‘í‰…±°¹¥‘ôè‘í‰ÕµÁ•È¹‰½‘ä¹¥‘õ€ì(€€€½¹ÍÐ±…ÍÑ!¥ÑÐ€ôÑ¡¥Ì¹‰ÕµÁ•É!¥Ñ½½±‘½Ý¹Ì¹•Ð¡½½±‘½Ý¹-•ä¤€üü9Õµ‰•È¹9Q%Y}%9%9%Qdì(€€€¥˜€¡¹½Ü€´±…ÍÑ!¥ÑÐ€ð5}=9%¹‰ÕµÁ•È¹Í½É•½½±‘½Ý¹5Ì¤É•ÑÕÉ¸ì(€€€Ñ¡¥Ì¹‰ÕµÁ•É!¥Ñ½½±‘½Ý¹Ì¹Í•Ð¡½½±‘½Ý¹-•ä°¹½Ü¤ì(€€€‰ÕµÁ•È¹ÁÕ±Í•U¹Ñ¥°€ô¹½Ü€¬5}=9%¹‰ÕµÁ•È¹ÁÕ±Í•ÕÉ…Ñ¥½¹5Ìì(€€€½¹ÍÐ‘à€ô‰…±°¹‰½‘ä¹Á½Í¥Ñ¥½¸¹à€´‰ÕµÁ•È¹àì(€€€½¹ÍÐ‘ä€ô‰…±°¹‰½‘ä¹Á½Í¥Ñ¥½¸¹ä€´‰ÕµÁ•È¹äì(€€€½¹ÍÐ‘¥ÍÑ…¹”€ô5…Ñ ¹µ…à¡5…Ñ ¹¡åÁ½Ð¡‘à°‘ä¤°€Ä¤ì(€€€½¹ÍÐ¹½Éµ…°€ôìàè‘à€¼‘¥ÍÑ…¹”°äè‘ä€¼‘¥ÍÑ…¹”ôì(€€€½¹ÍÐ¥µÁ…ÑMÁ••€ô5…Ñ ¹¡åÁ½Ð¡‰…±°¹‰½‘ä¹Ù•±½¥Ñä¹à°‰…±°¹‰½‘ä¹Ù•±½¥Ñä¹ä¤ì(€€€½¹ÍÐÁ½¥¹ÑÌ€ô…±Õ±…Ñ•	ÕµÁ•É!¥ÑM½É”¡¥µÁ…ÑMÁ••¤ì(€€€Ñ¡¥Ì¹Í•Ñ	½‘åY•±½¥Ñä¡‰…±°¹‰½‘ä°ì(€€€€€àè‰…±°¹‰½‘ä¹Ù•±½¥Ñä¹à€¬¹½Éµ…°¹à€¨5}=9%¹‰ÕµÁ•È¹¥µÁÕ±Í”°(€€€€€äè‰…±°¹‰½‘ä¹Ù•±½¥Ñä¹ä€¬¹½Éµ…°¹ä€¨5}=9%¹‰ÕµÁ•È¹¥µÁÕ±Í”°(€€€ô¤ì(€€€Ñ¡¥Ì¹Í½É”€¬ôÁ½¥¹ÑÌì(€€€Ñ¡¥Ì¹‰•ÍÑM½É”€ô5…Ñ ¹µ…à¡Ñ¡¥Ì¹‰•ÍÑM½É”°Ñ¡¥Ì¹Í½É”¤ì(€€€Í…Ù•	•ÍÑM½É”¡Ñ¡¥Ì¹‰•ÍÑM½É”¤ì(€€€¥˜€¡Ñ¡¥Ì¹±…ÍÑ1…Õ¹¡	ÕµÁ•É%€„ôô‰ÕµÁ•È¹‰½‘ä¹¥¤ì(€€€€€Ñ¡¥Ì¹±…Õ¹¡	ÕµÁ•É!¥Ñ½Õ¹Ð€¬ô€Äì(€€€€€Ñ¡¥Ì¹±…ÍÑ1…Õ¹¡	ÕµÁ•É%€ô‰ÕµÁ•È¹‰½‘ä¹¥ì(€€€ô(€€€Ñ¡¥Ì¹•µ¥Ð ¡…©¥­”éÍ½É”œ°ìÍ½É”èÑ¡¥Ì¹Í½É”°‰•ÍÐèÑ¡¥Ì¹‰•ÍÑM½É”ô¤ì(€€€Ñ¡¥Ì¹•µ¥Ð ¡…©¥­”é‰ÕµÁ•Èµ¡¥Ðœ°ì(€€€€€½Õ¹ÐèÑ¡¥Ì¹±…Õ¹¡	ÕµÁ•É!¥Ñ½Õ¹Ð°(€€€€€Á½¥¹ÑÌ°(€€€€€¥µÁ…ÑMÁ••°(€€€ô¤ì(€€€Ñ¡¥Ì¹Í¡½Ý	ÕÉÍÐ¡‰ÕµÁ•È¹à€¬¹½Éµ…°¹à€¨€ÈÐ°‰ÕµÁ•È¹ä€¬¹½Éµ…°¹ä€¨€ÈÐ°€Áá‰™••™˜°€Ô¤ì(€ô((€ÁÉ¥Ù…Ñ”…ÁÁ±åM¡½­Ý…Ù”¡Í½ÕÉ”è	…±±¹Ñ¥Ñä¤èÙ½¥ì(€€€½¹ÍÐµÕ±Ñ¥Á±¥•È€ô5}=9%¹µ•É•M¡½­Ý…Ù”¹±•Ù•±5Õ±Ñ¥Á±¥•ÉÍmÍ½ÕÉ”¹±•Ù•±t€üü€Äì(€€€½¹ÍÐµÕ±Ñ¥Á±¥•ÉAÉ½É•ÍÌ€ô5…Ñ ¹µ¥¸¡5…Ñ ¹µ…à ¡µÕ±Ñ¥Á±¥•È€´€Ä¤€¼€Ì°€À¤°€Ä¤ì(€€€½¹ÍÐ¥µÁÕ±Í”€ô5}=9%¹µ•É•M¡½­Ý…Ù”¹µ¥¹%µÁÕ±Í”(€€€€€€¬€¡5}=9%¹µ•É•M¡½­Ý…Ù”¹µ…á%µÁÕ±Í”€´5}=9%¹µ•É•M¡½­Ý…Ù”¹µ¥¹%µÁÕ±Í”¤(€€€€€€€€¨µÕ±Ñ¥Á±¥•ÉAÉ½É•ÍÌ€¨¨€Ä¸ÈÔì(€€€½¹ÍÐÉ…‘¥ÕÌ€ô5}=9%¹µ•É•M¡½­Ý…Ù”¹µ¥¹I…‘¥ÕÌ(€€€€€€¬€¡5}=9%¹µ•É•M¡½­Ý…Ù”¹µ…áI…‘¥ÕÌ€´5}=9%¹µ•É•M¡½­Ý…Ù”¹µ¥¹I…‘¥ÕÌ¤(€€€€€€€€¨µÕ±Ñ¥Á±¥•ÉAÉ½É•ÍÌ€¨¨€À¸àÔì((€€€™½È€¡½¹ÍÐ‰…±°½˜Ñ¡¥Ì¹‰…±±Ì¹Ù…±Õ•Ì ¤¤ì(€€€€€¥˜€¡‰…±°¹¥€ôôôÍ½ÕÉ”¹¥ñð‰…±°¹¥Í%¹1…Õ¹¡1…¹”ñð‰…±°¹¥Í5•É¥¹œ¤½¹Ñ¥¹Õ”ì(€€€€€½¹ÍÐ‘à€ô‰…±°¹‰½‘ä¹Á½Í¥Ñ¥½¸¹à€´Í½ÕÉ”¹‰½‘ä¹Á½Í¥Ñ¥½¸¹àì(€€€€€½¹ÍÐ‘ä€ô‰…±°¹‰½‘ä¹Á½Í¥Ñ¥½¸¹ä€´Í½ÕÉ”¹‰½‘ä¹Á½Í¥Ñ¥½¸¹äì(€€€€€½¹ÍÐ‘¥ÍÑ…¹”€ô5…Ñ ¹¡åÁ½Ð¡‘à°‘ä¤ì(€€€€€¥˜€¡‘¥ÍÑ…¹”€øÉ…‘¥ÕÌñð‘¥ÍÑ…¹”€ð€Ä¤½¹Ñ¥¹Õ”ì(€€€€€½¹ÍÐ™…±±½™˜€ô€ Ä€´‘¥ÍÑ…¹”€¼É…‘¥ÕÌ¤€¨¨5}=9%¹µ•É•M¡½­Ý…Ù”¹™…±±½™™áÁ½¹•¹Ðì(€€€€€½¹ÍÐÍ…±”€ô¥µÁÕ±Í”€¨™…±±½™˜ì(€€€€€Ñ¡¥Ì¹Í•Ñ	½‘åY•±½¥Ñä¡‰…±°¹‰½‘ä°ì(€€€€€€€àè‰…±°¹‰½‘ä¹Ù•±½¥Ñä¹à€¬€¡‘à€¼‘¥ÍÑ…¹”¤€¨Í…±”°(€€€€€€€äè‰…±°¹‰½‘ä¹Ù•±½¥Ñä¹ä€¬€¡‘ä€¼‘¥ÍÑ…¹”¤€¨Í…±”°(€€€€€ô¤ì(€€€€€Ñ¡¥Ì¹…Á	½‘åMÁ••¡‰…±°¹‰½‘ä¤ì(€€€ô(€ô((€ÁÉ¥Ù…Ñ”É•½Ù•É¥•±‘	½‘¥•Ì ¤èÙ½¥ì(€€€™½È€¡½¹ÍÐ‰…±°½˜Ñ¡¥Ì¹‰…±±Ì¹Ù…±Õ•Ì ¤¤ì(€€€€€¥˜€¡‰…±°¹¥Í%¹1…Õ¹¡1…¹”¤½¹Ñ¥¹Õ”ì(€€€€€½¹ÍÐÉ…‘¥ÕÌ€ôÉ…‘¥ÕÍ½É1•Ù•°¡‰…±°¹±•Ù•°¤ì(€€€€€½¹ÍÐ‰½‘ä€ô‰…±°¹‰½‘äì(€€€€€½¹ÍÐÁ½Í¥Ñ¥½¹%Í¥¹¥Ñ”€ô9Õµ‰•È¹¥Í¥¹¥Ñ”¡‰½‘ä¹Á½Í¥Ñ¥½¸¹à¤€˜˜9Õµ‰•È¹¥Í¥¹¥Ñ”¡‰½‘ä¹Á½Í¥Ñ¥½¸¹ä¤ì(€€€€€½¹ÍÐÙ•±½¥Ñå%Í¥¹¥Ñ”€ô9Õµ‰•È¹¥Í¥¹¥Ñ”¡‰½‘ä¹Ù•±½¥Ñä¹à¤€˜˜9Õµ‰•È¹¥Í¥¹¥Ñ”¡‰½‘ä¹Ù•±½¥Ñä¹ä¤ì((€€€€€¥˜€ …Á½Í¥Ñ¥½¹%Í¥¹¥Ñ”ñð€…Ù•±½¥Ñå%Í¥¹¥Ñ”¤ì(€€€€€€€Ñ¡¥Ì¹Í•Ñ	½‘åA½Í¥Ñ¥½¸¡‰½‘ä°ì(€€€€€€€€€àè€¡]=I1¹™¥•±¹±•™Ð€¬]=I1¹™¥•±¹É¥¡Ð¤€¼€È°(€€€€€€€€€äè]=I1¹™¥•±¹Ñ½À€¬É…‘¥ÕÌ€¬€ÐÀ°(€€€€€€€ô¤ì(€€€€€€€Ñ¡¥Ì¹Í•Ñ	½‘åY•±½¥Ñä¡‰½‘ä°ìàè€À°äè€Àô¤ì(€€€€€€€Ñ¡¥Ì¹Í•Ñ	½‘å¹Õ±…ÉY•±½¥Ñä¡‰½‘ä°€À¤ì(€€€€€€€½¹Ñ¥¹Õ”ì(€€€€€ô((€€€€€½¹ÍÐ½¹Ñ…¥¹•€ô½¹Ñ…¥¹¥É±•%¹	½Õ¹‘Ì (€€€€€€€‰½‘ä¹Á½Í¥Ñ¥½¸°(€€€€€€€É…‘¥ÕÌ°(€€€€€€€]=I1¹™¥•±°(€€€€€€€5}=9%¹™¥•±‘	½Õ¹‘…Éä¹½¹Ñ…¥¹µ•¹ÑA…‘‘¥¹œ°(€€€€€€¤ì(€€€€€¥˜€ …½¹Ñ…¥¹•¹¡¥Ñ1•™Ð€˜˜€…½¹Ñ…¥¹•¹¡¥ÑI¥¡Ð€˜˜€…½¹Ñ…¥¹•¹¡¥ÑQ½À€˜˜€…½¹Ñ…¥¹•¹¡¥Ñ	½ÑÑ½´¤ì(€€€€€€€½¹Ñ¥¹Õ”ì(€€€€€ô((€€€€€Ñ¡¥Ì¹Í•Ñ	½‘åA½Í¥Ñ¥½¸¡‰½‘ä°½¹Ñ…¥¹•¹Á½Í¥Ñ¥½¸¤ì(€€€€€½¹ÍÐÉ•ÍÑ¥ÑÕÑ¥½¸€ô5}=9%¹™¥•±‘	½Õ¹‘…Éä¹É•½Ù•ÉåI•ÍÑ¥ÑÕÑ¥½¸ì(€€€€€±•ÐÙ•±½¥Ñå`€ô‰½‘ä¹Ù•±½¥Ñä¹àì(€€€€€±•ÐÙ•±½¥Ñåd€ô‰½‘ä¹Ù•±½¥Ñä¹äì(€€€€€¥˜€¡½¹Ñ…¥¹•¹¡¥Ñ1•™Ð€˜˜Ù•±½¥Ñå`€ð€À¤Ù•±½¥Ñå`€ô5…Ñ ¹…‰Ì¡Ù•±½¥Ñå`¤€¨É•ÍÑ¥ÑÕÑ¥½¸ì(€€€€€¥˜€¡½¹Ñ…¥¹•¹¡¥ÑI¥¡Ð€˜˜Ù•±½¥Ñå`€ø€À¤Ù•±½¥Ñå`€ô€µ5…Ñ ¹…‰Ì¡Ù•±½¥Ñå`¤€¨É•ÍÑ¥ÑÕÑ¥½¸ì(€€€€€¥˜€¡½¹Ñ…¥¹•¹¡¥ÑQ½À€˜˜Ù•±½¥Ñåd€ð€À¤Ù•±½¥Ñåd€ô5…Ñ ¹…‰Ì¡Ù•±½¥Ñåd¤€¨É•ÍÑ¥ÑÕÑ¥½¸ì(€€€€€¥˜€¡½¹Ñ…¥¹•¹¡¥Ñ	½ÑÑ½´€˜˜Ù•±½¥Ñåd€ø€À¤Ù•±½¥Ñåd€ô€µ5…Ñ ¹…‰Ì¡Ù•±½¥Ñåd¤€¨É•ÍÑ¥ÑÕÑ¥½¸ì(€€€€€Ñ¡¥Ì¹Í•Ñ	½‘åY•±½¥Ñä¡‰½‘ä°±¥µ¥ÑY•Ñ½È (€€€€€€€ìàèÙ•±½¥Ñå`°äèÙ•±½¥Ñådô°(€€€€€€€5}=9%¹µ…á	½‘åMÁ••°(€€€€€€¤¤ì(€€€€€Ñ¡¥Ì¹Í•Ñ	½‘å¹Õ±…ÉY•±½¥Ñä¡‰½‘ä°‰½‘ä¹…¹Õ±…ÉY•±½¥Ñä€¨€À¸ØÔ¤ì(€€€ô(€ô((€ÁÉ¥Ù…Ñ”…Á±±	½‘åMÁ••‘Ì ¤èÙ½¥ì(€€€™½È€¡½¹ÍÐ‰…±°½˜Ñ¡¥Ì¹‰…±±Ì¹Ù…±Õ•Ì ¤¤Ñ¡¥Ì¹…Á	½‘åMÁ••¡‰…±°¹‰½‘ä¤ì(€ô((€ÁÉ¥Ù…Ñ”…Á	½‘åMÁ••¡‰½‘äè5…ÑÑ•É)L¹	½‘åQåÁ”¤èÙ½¥ì(€€€½¹ÍÐ±¥µ¥Ñ•€ô±¥µ¥ÑY•Ñ½È¡‰½‘ä¹Ù•±½¥Ñä°5}=9%¹µ…á	½‘åMÁ••¤ì(€€€¥˜€¡±¥µ¥Ñ•¹à€ôôô‰½‘ä¹Ù•±½¥Ñä¹à€˜˜±¥µ¥Ñ•¹ä€ôôô‰½‘ä¹Ù•±½¥Ñä¹ä¤É•ÑÕÉ¸ì(€€€Ñ¡¥Ì¹Í•Ñ	½‘åY•±½¥Ñä¡‰½‘ä°±¥µ¥Ñ•¤ì(€ô((€ÁÉ¥Ù…Ñ”Í•Ñ	½‘åY•±½¥Ñä¡‰½‘äè5…ÑÑ•É)L¹	½‘åQåÁ”°Ù•±½¥ÑäèY•Ñ½É1¥­”¤èÙ½¥ì(€€€Ñ¡¥Ì¹µ…ÑÑ•È¹‰½‘ä¹Í•ÑY•±½¥Ñä¡‰½‘ä°Ù•±½¥Ñä¤ì(€ô((€ÁÉ¥Ù…Ñ”Í•Ñ	½‘åA½Í¥Ñ¥½¸¡‰½‘äè5…ÑÑ•É)L¹	½‘åQåÁ”°Á½Í¥Ñ¥½¸èY•Ñ½É1¥­”¤èÙ½¥ì(€€€Ñ¡¥Ì¹µ…ÑÑ•È¹‰½‘ä¹Í•ÑA½Í¥Ñ¥½¸¡‰½‘ä°Á½Í¥Ñ¥½¸¤ì(€ô((€ÁÉ¥Ù…Ñ”Í•Ñ	½‘å¹Õ±…ÉY•±½¥Ñä¡‰½‘äè5…ÑÑ•É)L¹	½‘åQåÁ”°Ù•±½¥Ñäè¹Õµ‰•È¤èÙ½¥ì(€€€Ñ¡¥Ì¹µ…ÑÑ•È¹‰½‘ä¹Í•Ñ¹Õ±…ÉY•±½¥Ñä¡‰½‘ä°Ù•±½¥Ñä¤ì(€ô((€ÁÉ¥Ù…Ñ”‘É…Ý	½…É ¤èÙ½¥ì(€€€Ñ¡¥Ì¹‰½…É‘É…Á¡¥Ì¹±•…È ¤ì(€€€Ñ¡¥Ì¹‰½…É‘É…Á¡¥Ì¹™¥±±MÑå±” ÁàÀàÈÌÑ„°€Ä¤ì(€€€Ñ¡¥Ì¹‰½…É‘É…Á¡¥Ì¹™¥±±I½Õ¹‘•‘I•Ð ÔÔ°€ØÀ°€ØÄÀ°€ÄÄÌÀ°€ÌÈ¤ì(€€€Ñ¡¥Ì¹‰½…É‘É…Á¡¥Ì¹±¥¹•MÑå±” Ø°€ÁàÑ„Ý…„°€À¸ÐÔ¤ì(€€€Ñ¡¥Ì¹‰½…É‘É…Á¡¥Ì¹ÍÑÉ½­•I½Õ¹‘•‘I•Ð ÔÔ°€ØÀ°€ØÄÀ°€ÄÄÌÀ°€ÌÈ¤ì(€€€Ñ¡¥Ì¹‰½…É‘É…Á¡¥Ì¹™¥±±MÑå±” ÁàÄÌÉ˜Õˆ°€Ä¤ì(€€€Ñ¡¥Ì¹‰½…É‘É…Á¡¥Ì¹™¥±±I½Õ¹‘•‘I•Ð¡]=I1¹™¥•±¹±•™Ð°]=I1¹™¥•±¹Ñ½À€¬€ÄÈ°]=I1¹™¥•±¹É¥¡Ð€´]=I1¹™¥•±¹±•™Ð°]=I1¹™¥•±¹‰½ÑÑ½´€´]=I1¹™¥•±¹Ñ½À€´€ÄÈ°€ÄØ¤ì(€€€Ñ¡¥Ì¹‰½…É‘É…Á¡¥Ì¹±¥¹•MÑå±” Ð°€ÁàÕäÉŒÄ°€À¸Ü¤ì(€€€Ñ¡¥Ì¹‰½…É‘É…Á¡¥Ì¹ÍÑÉ½­•I½Õ¹‘•‘I•Ð¡]=I1¹™¥•±¹±•™Ð°]=I1¹™¥•±¹Ñ½À€¬€ÄÈ°]=I1¹™¥•±¹É¥¡Ð€´]=I1¹™¥•±¹±•™Ð°]=I1¹™¥•±¹‰½ÑÑ½´€´]=I1¹™¥•±¹Ñ½À€´€ÄÈ°€ÄØ¤ì(€€€½¹ÍÐ±…¹•A…Ñ €ô5}=9%¹±…Õ¹¡1…¹”¹Á…Ñ ì(€€€Ñ¡¥Ì¹‰½…É‘É…Á¡¥Ì¹±¥¹•MÑå±”¡5}=9%¹±…Õ¹¡1…¹”¹½ÉÉ¥‘½É]¥‘Ñ °€ÁàÄØÍ˜ÜÀ°€Ä¤ì(€€€™½È€¡±•Ð¥¹‘•à€ô€Àì¥¹‘•à€ð±…¹•A…Ñ ¹±•¹Ñ €´€Äì¥¹‘•à€¬ô€Ä¤ì(€€€€€Ñ¡¥Ì¹‰½…É‘É…Á¡¥Ì¹±¥¹•	•ÑÝ••¸ (€€€€€€€±…¹•A…Ñ¡m¥¹‘•át¹à°(€€€€€€€±…¹•A…Ñ¡m¥¹‘•át¹ä°(€€€€€€€±…¹•A…Ñ¡m¥¹‘•à€¬€Åt¹à°(€€€€€€€±…¹•A…Ñ¡m¥¹‘•à€¬€Åt¹ä°(€€€€€€¤ì(€€€ô(€€€Ñ¡¥Ì¹‰½…É‘É…Á¡¥Ì¹±¥¹•MÑå±” Ð°€ÁàØÝˆå•Œ°€À¸à¤ì(€€€™½È€¡±•Ð¥¹‘•à€ô€Àì¥¹‘•à€ð±…¹•A…Ñ ¹±•¹Ñ €´€Äì¥¹‘•à€¬ô€Ä¤ì(€€€€€Ñ¡¥Ì¹‰½…É‘É…Á¡¥Ì¹±¥¹•	•ÑÝ••¸ (€€€€€€€±…¹•A…Ñ¡m¥¹‘•át¹à°(€€€€€€€±…¹•A…Ñ¡m¥¹‘•át¹ä°(€€€€€€€±…¹•A…Ñ¡m¥¹‘•à€¬€Åt¹à°(€€€€€€€±…¹•A…Ñ¡m¥¹‘•à€¬€Åt¹ä°(€€€€€€¤ì(€€€ô(€€€Ñ¡¥Ì¹‰½…É‘É…Á¡¥Ì¹™¥±±MÑå±” Áá„Í‘™™˜°€À¸ØÔ¤ì(€€€Ñ¡¥Ì¹‰½…É‘É…Á¡¥Ì¹™¥±±¥É±” (€€€€€5}=9%¹±…Õ¹¡1…¹”¹•á¥ÑA½Í¥Ñ¥½¸¹à°(€€€€€5}=9%¹±…Õ¹¡1…¹”¹•á¥ÑA½Í¥Ñ¥½¸¹ä°(€€€€€€Ü°(€€€€¤ì(€€€Ñ¡¥Ì¹‰½…É‘É…Á¡¥Ì¹±¥¹•MÑå±” È°€Áá™˜ÕˆØÀ°€À¸Èà¤ì(€€€Ñ¡¥Ì¹‰½…É‘É…Á¡¥Ì¹±¥¹•	•ÑÝ••¸¡]=I1¹™¥•±¹±•™Ð€¬€à°]=I1¹‘…¹•É1¥¹•d°]=I1¹™¥•±¹É¥¡Ð€´€à°]=I1¹‘…¹•É1¥¹•d¤ì(€ô((€ÁÉ¥Ù…Ñ”É•¹‘•É]½É± ¤èÙ½¥ì(€€€½¹ÍÐ¹½Ü€ôÑ¡¥Ì¹Ñ¥µ”¹¹½Üì(€€€Ñ¡¥Ì¹‰…±±É…Á¡¥Ì¹±•…È ¤ì(€€€Ñ¡¥Ì¹™áÉ…Á¡¥Ì¹±•…È ¤ì((€€€™½È€¡½¹ÍÐ‰ÕµÁ•È½˜Ñ¡¥Ì¹‰ÕµÁ•ÉÌ¹Ù…±Õ•Ì ¤¤ì(€€€€€½¹ÍÐÁÕ±Í”€ô‰ÕµÁ•È¹ÁÕ±Í•U¹Ñ¥°€ø¹½Ü€ü€Ä€¬€ ¡‰ÕµÁ•È¹ÁÕ±Í•U¹Ñ¥°€´¹½Ü¤€¼€ÄàÀ¤€¨€À¸È€è€Äì(€€€€€Ñ¡¥Ì¹‰…±±É…Á¡¥Ì¹™¥±±MÑå±” ÁàÑ…„Ý‘°€Ä¤ì(€€€€€Ñ¡¥Ì¹‰…±±É…Á¡¥Ì¹™¥±±¥É±”¡‰ÕµÁ•È¹à°‰ÕµÁ•È¹ä°5}=9%¹‰ÕµÁ•È¹É…‘¥ÕÌ€¨ÁÕ±Í”¤ì(€€€€€Ñ¡¥Ì¹‰…±±É…Á¡¥Ì¹±¥¹•MÑå±” Ô°€Áàá™‘™˜°€À¸äÔ¤ì(€€€€€Ñ¡¥Ì¹‰…±±É…Á¡¥Ì¹ÍÑÉ½­•¥É±”¡‰ÕµÁ•È¹à°‰ÕµÁ•È¹ä°5}=9%¹‰ÕµÁ•È¹É…‘¥ÕÌ€¨ÁÕ±Í”¤ì(€€€€€Ñ¡¥Ì¹‰…±±É…Á¡¥Ì¹™¥±±MÑå±” Áá”á™‰™˜°€À¸ä¤ì(€€€€€Ñ¡¥Ì¹‰…±±É…Á¡¥Ì¹™¥±±¥É±”¡‰ÕµÁ•È¹à€´€ÄÀ°‰ÕµÁ•È¹ä€´€ÄÀ°€ä€¨ÁÕ±Í”¤ì(€€€€€Ñ¡¥Ì¹‰…±±É…Á¡¥Ì¹™¥±±MÑå±” ÁàÅˆÕäÄ°€À¸äÔ¤ì(€€€€€Ñ¡¥Ì¹‰…±±É…Á¡¥Ì¹™¥±±¥É±”¡‰ÕµÁ•È¹à€¬€Ð°‰ÕµÁ•È¹ä€¬€Ô°€Ø€¨ÁÕ±Í”¤ì(€€€ô((€€€™½È€¡½¹ÍÐ‰…±°½˜Ñ¡¥Ì¹‰…±±Ì¹Ù…±Õ•Ì ¤¤ì(€€€€€½¹ÍÐÁ½Í¥Ñ¥½¸€ô‰…±°¹‰½‘ä¹Á½Í¥Ñ¥½¸ì(€€€€€½¹ÍÐÉ…‘¥ÕÌ€ôÉ…‘¥ÕÍ½É1•Ù•°¡‰…±°¹±•Ù•°¤ì(€€€€€½¹ÍÐ½±½È€ô	11}=1=IMm‰…±°¹±•Ù•±t€üü	11}=1=IMlÅtì(€€€€€½¹ÍÐ…±Á¡„€ô‰…±°¹¥Í%¹1…Õ¹¡1…¹”€ü€À¸äÈ€è€Äì(€€€€€Ñ¡¥Ì¹‰…±±É…Á¡¥Ì¹™¥±±MÑå±”¡½±½È°…±Á¡„¤ì(€€€€€Ñ¡¥Ì¹‰…±±É…Á¡¥Ì¹™¥±±¥É±”¡Á½Í¥Ñ¥½¸¹à°Á½Í¥Ñ¥½¸¹ä°É…‘¥ÕÌ¤ì(€€€€€Ñ¡¥Ì¹‰…±±É…Á¡¥Ì¹±¥¹•MÑå±” Ì°€ÁàÀÜÅŒÌä°€À¸Øà¤ì(€€€€€Ñ¡¥Ì¹‰…±±É…Á¡¥Ì¹ÍÑÉ½­•¥É±”¡Á½Í¥Ñ¥½¸¹à°Á½Í¥Ñ¥½¸¹ä°É…‘¥ÕÌ¤ì(€€€€€Ñ¡¥Ì¹‰…±±É…Á¡¥Ì¹™¥±±MÑå±” Áá™™™™™˜°€À¸È¤ì(€€€€€Ñ¡¥Ì¹‰…±±É…Á¡¥Ì¹™¥±±¥É±”¡Á½Í¥Ñ¥½¸¹à€´É…‘¥ÕÌ€¨€À¸ÌÈ°Á½Í¥Ñ¥½¸¹ä€´É…‘¥ÕÌ€¨€À¸ÌÐ°É…‘¥ÕÌ€¨€À¸È¤ì(€€€€€‰…±°¹±…‰•°¹Í•ÑA½Í¥Ñ¥½¸¡Á½Í¥Ñ¥½¸¹à°Á½Í¥Ñ¥½¸¹ä¤ì(€€€ô(€ô((€ÁÉ¥Ù…Ñ”Í¡½Ý	ÕÉÍÐ¡àè¹Õµ‰•È°äè¹Õµ‰•È°½±½Èè¹Õµ‰•È°Á…ÉÑ¥±•½Õ¹Ð€ô€à¤èÙ½¥ì(€€€½¹ÍÐÉ¥¹œ€ôÑ¡¥Ì¹…‘¹¥É±”¡à°ä°€ÄÈ°½±½È°€À¸Äà¤¹Í•ÑMÑÉ½­•MÑå±” Ð°½±½È°€À¸ä¤¹Í•Ñ•ÁÑ  Ð¤ì(€€€Ñ¡¥Ì¹ÑÝ••¹Ì¹…‘¡ì(€€€€€Ñ…É•ÑÌèÉ¥¹œ°(€€€€€Í…±”è€Ð°(€€€€€…±Á¡„è€À°(€€€€€‘ÕÉ…Ñ¥½¸è€ÌÐÀ°(€€€€€•…Í”è€Õ‰¥Œ¹=ÕÐœ°(€€€€€½¹½µÁ±•Ñ”è€ ¤€ôøÉ¥¹œ¹‘•ÍÑÉ½ä ¤°(€€€ô¤ì((€€€™½È€¡±•Ð¥¹‘•à€ô€Àì¥¹‘•à€ðÁ…ÉÑ¥±•½Õ¹Ðì¥¹‘•à€¬ô€Ä¤ì(€€€€€½¹ÍÐ…¹±”€ô€¡5…Ñ ¹A$€¨€È€¨¥¹‘•à¤€¼Á…ÉÑ¥±•½Õ¹Ðì(€€€€€½¹ÍÐ‘¥ÍÑ…¹”€ô€ÈÈ€¬€¡¥¹‘•à€”€Ì¤€¨€äì(€€€€€½¹ÍÐÁ…ÉÑ¥±”€ôÑ¡¥Ì¹…‘¹¥É±”¡à°ä°€Ð°½±½È°€À¸ä¤¹Í•Ñ•ÁÑ  Ð¤ì(€€€€€Ñ¡¥Ì¹ÑÝ••¹Ì¹…‘¡ì(€€€€€€€Ñ…É•ÑÌèÁ…ÉÑ¥±”°(€€€€€€€àèà€¬5…Ñ ¹½Ì¡…¹±”¤€¨‘¥ÍÑ…¹”°(€€€€€€€äèä€¬5…Ñ ¹Í¥¸¡…¹±”¤€¨‘¥ÍÑ…¹”°(€€€€€€€Í…±”è€À¸È°(€€€€€€€…±Á¡„è€À°(€€€€€€€‘ÕÉ…Ñ¥½¸è€ÌàÀ°(€€€€€€€•…Í”è€Õ‰¥Œ¹=ÕÐœ°(€€€€€€€½¹½µÁ±•Ñ”è€ ¤€ôøÁ…ÉÑ¥±”¹‘•ÍÑÉ½ä ¤°(€€€€€ô¤ì(€€€ô(€ô((€ÁÉ¥Ù…Ñ”½¹Ñ…Ñ-•ä¡™¥ÉÍÑ%è¹Õµ‰•È°Í•½¹‘%è¹Õµ‰•È¤èÍÑÉ¥¹œì(€€€É•ÑÕÉ¸™¥ÉÍÑ%€ðÍ•½¹‘%€ü€‘í™¥ÉÍÑ%‘ôè‘íÍ•½¹‘%‘õ€€è€‘íÍ•½¹‘%‘ôè‘í™¥ÉÍÑ%‘õ€ì(€ô((€ÁÉ¥Ù…Ñ”•µ¥Ð¡¹…µ”èÍÑÉ¥¹œ°‘•Ñ…¥°èÕ¹­¹½Ý¸¤èÙ½¥ì(€€€Ý¥¹‘½Ü¹‘¥ÍÁ…Ñ¡Ù•¹Ð¡¹•ÜÕÍÑ½µÙ•¹Ð¡¹…µ”°ì‘•Ñ…¥°ô¤¤ì(€ô((€ÁÉ¥Ù…Ñ”¡…¹‘±•M¡ÕÑ‘½Ý¸ ¤èÙ½¥ì(€€€Ý¥¹‘½Ü¹É•µ½Ù•Ù•¹Ñ1¥ÍÑ•¹•È ¡…©¥­”é…Ñ¥½¸œ°Ñ¡¥Ì¹…Ñ¥½¹!…¹‘±•È¤ì(€€€Ý¥¹‘½Ü¹É•µ½Ù•Ù•¹Ñ1¥ÍÑ•¹•È ¡…©¥­”é¡…É”µÍÑ…ÉÐœ°Ñ¡¥Ì¹¡…É•MÑ…ÉÑ!…¹‘±•È¤ì(€€€Ý¥¹‘½Ü¹É•µ½Ù•Ù•¹Ñ1¥ÍÑ•¹•È ¡…©¥­”é¡…É”µ•¹œ°Ñ¡¥Ì¹¡…É•¹‘!…¹‘±•È¤ì(€€€Ý¥¹‘½Ü¹É•µ½Ù•Ù•¹Ñ1¥ÍÑ•¹•È ¡…©¥­”é¡…É”µ…¹•°œ°Ñ¡¥Ì¹¡…É•…¹•±!…¹‘±•È¤ì(€€€Ñ¡¥Ì¹µ…ÑÑ•È¹Ý½É±¹½™˜ ½±±¥Í¥½¹ÍÑ…ÉÐœ°Ñ¡¥Ì¹½±±¥Í¥½¹MÑ…ÉÑ!…¹‘±•È¤ì(€€€Ñ¡¥Ì¹µ…ÑÑ•È¹Ý½É±¹½™˜ ½±±¥Í¥½¹•¹œ°Ñ¡¥Ì¹½±±¥Í¥½¹¹‘!…¹‘±•È¤ì(€€€Ñ¡¥Ì¹½¹Ñ…ÑMÑ…ÉÑÌ¹±•…È ¤ì(€€€Ñ¡¥Ì¹‰ÕµÁ•É!¥Ñ½½±‘½Ý¹Ì¹±•…È ¤ì(€€€Ñ¡¥Ì¹‰…±±Ì¹±•…È ¤ì(€€€Ñ¡¥Ì¹‰…±±Í	å	½‘å%¹±•…È ¤ì(€€€Ñ¡¥Ì¹‰ÕµÁ•ÉÌ¹±•…È ¤ì(€€€Ñ¡¥Ì¹±…Õ¹¡	ÕµÁ•É!¥Ñ½Õ¹Ð€ô€Àì(€€€Ñ¡¥Ì¹±…ÍÑ1…Õ¹¡	ÕµÁ•É%€ô¹Õ±°ì(€€€Ñ¡¥Ì¹ÍÑ…Ñ¥	½‘¥•Ì¹±•¹Ñ €ô€Àì(€ô)ô(