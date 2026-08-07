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
    this.emit('hajike:effect', { message: `Lv.${level} Áô∫Â∞ÑÔºÅ` });
    this.time.delayedCall(GAME_CONFIG.launchLane.fallbackTimeoutMs, () => {
      if (this.launchedBallId !== ball.id || !this.balls.has(ball.id)) return;
      this.enterFieldFromLane(ball);
      // ‰ΩéÈÄüË®≠ÂÆö„Å∏Ë™øÊï¥„Åó„ÅüÂ†¥Âêà„Åß„ÇÇ„ÄÅÊ¨°Âºæ„ÅåÊ∞∏‰πÖ„Å´„É≠„ÉÉ„ÇØ„Åï„Çå„Å™„ÅÑ‰øùÈô∫„ÄÇ
      this.enterFieldFromLane(ball);
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
      this.emit('hajike:effect', { message: 'MAX LEVELÔºÅ „Éú„Éº„Éä„ÇπÔºÅ' });
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
    ◊_4∂âûÀk∫wµÁqêπ…ïµΩŸî°âÖ±∞πâΩë‰§Ï(ÄÄÄÅôΩ»Ä°çΩπÕ–Å≠ï‰ÅΩòÅ—°•ÃπçΩπ—Öç—M—Ö…—Ãπ≠ïÂÃ†§§ÅÏ(ÄÄÄÄÄÅçΩπÕ–Åmô•…Õ—%ê∞ÅÕïçΩπë%ëtÄÙÅ≠ï‰πÕ¡±•–†úËú§πµÖ¿°9’µâï»§Ï(ÄÄÄÄÄÅ•òÄ°ô•…Õ—%êÄÙÙÙÅâÖ±∞π•êÅÒÅÕïçΩπë%êÄÙÙÙÅâÖ±∞π•ê§Å—°•ÃπçΩπ—Öç—M—Ö…—Ãπëï±ï—î°≠ï‰§Ï(ÄÄÄÅÙ(ÄÅÙ((ÄÅ¡…•ŸÖ—îÅç…ïÖ—ïM—Ö—•ç	Ωë•ïÃ†§ËÅŸΩ•êÅÏ(ÄÄÄÅçΩπÕ–ÅÖëë]Ö±∞ÄÙÄ†(ÄÄÄÄÄÅ‡ËÅπ’µâï»∞(ÄÄÄÄÄÅ‰ËÅπ’µâï»∞(ÄÄÄÄÄÅ›•ë—†ËÅπ’µâï»∞(ÄÄÄÄÄÅ°ï•ù°–ËÅπ’µâï»∞(ÄÄÄÄÄÅ…ïÕ—•—’—•Ω∏ËÅπ’µâï»∞(ÄÄÄÄÄÅô…•ç—•Ω∏ËÅπ’µâï»∞(ÄÄÄÄÄÅ±Öâï∞ËÅÕ—…•πú∞(ÄÄÄÄÄÅçÖ—ïùΩ…‰ËÅπ’µâï»∞(ÄÄÄÄ§ËÅŸΩ•êÄÙ¯ÅÏ(ÄÄÄÄÄÅçΩπÕ–Å›Ö±∞ÄÙÅ—°•ÃπµÖ——ï»πÖëêπ…ïç—Öπù±î°‡∞Å‰∞Å›•ë—†∞Å°ï•ù°–∞ÅÏ(ÄÄÄÄÄÄÄÅ•ÕM—Ö—•åËÅ—…’î∞(ÄÄÄÄÄÄÄÅ±Öâï∞∞(ÄÄÄÄÄÄÄÅ…ïÕ—•—’—•Ω∏∞(ÄÄÄÄÄÄÄÅô…•ç—•Ω∏∞(ÄÄÄÄÄÄÄÅçΩ±±•Õ•Ωπ•±—ï»ËÅÏ(ÄÄÄÄÄÄÄÄÄÅçÖ—ïùΩ…‰∞(ÄÄÄÄÄÄÄÄÄÅµÖÕ¨ËÅ=11%M%=9}Q=IdπâÖ±∞∞(ÄÄÄÄÄÄÄÅÙ∞(ÄÄÄÄÄÅÙ§Ï(ÄÄÄÄÄÅ—°•ÃπÕ—Ö—•ç	Ωë•ïÃπ¡’Õ†°›Ö±∞§Ï(ÄÄÄÅÙÏ((ÄÄÄÅçΩπÕ–Åô•ï±ë5•ë`ÄÙÄ°]=I1πô•ï±êπ±ïô–Ä¨Å]=I1πô•ï±êπ…•ù°–§ÄºÄ»Ï(ÄÄÄÅçΩπÕ–Åô•ï±ë5•ëdÄÙÄ°]=I1πô•ï±êπ—Ω¿Ä¨Å]=I1πô•ï±êπâΩ——Ω¥§ÄºÄ»Ï(ÄÄÄÅÖëë]Ö±∞°]=I1πô•ï±êπ±ïô–Ä¥Ä‡∞Åô•ï±ë5•ëd∞Äƒÿ∞Å]=I1πô•ï±êπâΩ——Ω¥Ä¥Å]=I1πô•ï±êπ—Ω¿Ä¨Ä–¿∞Å5}=9%π›Ö±∞π…ïÕ—•—’—•Ω∏∞Å5}=9%π›Ö±∞πô…•ç—•Ω∏∞Äùô•ï±êµ±ïô–µ›Ö±∞ú∞Å=11%M%=9}Q=Idπô•ï±ë]Ö±∞§Ï(ÄÄÄÄººÉéWé
èéÛéØé'ñ”éøí‚+ûÆøé˚éü¶èû⁄ké_éñééØé_éõé¶Àñóö‚#éˇéªûBé3é≥éÛéœé„ö"Ôé
'é´éé
#ééØégé
/é(ÄÄÄÅÖëë]Ö±∞°]=I1πô•ï±êπ…•ù°–Ä¨Ä‡∞Ä°]=I1πô•ï±êπ—Ω¿Ä¨Å]=I1πô•ï±êπâΩ——Ω¥§ÄºÄ»∞Äƒÿ∞Å]=I1πô•ï±êπâΩ——Ω¥Ä¥Å]=I1πô•ï±êπ—Ω¿Ä¨Ä–¿∞Å5}=9%π›Ö±∞π…ïÕ—•—’—•Ω∏∞Å5}=9%π›Ö±∞πô…•ç—•Ω∏∞Äùô•ï±êµ…•ù°–µ›Ö±∞ú∞Å=11%M%=9}Q=Idπô•ï±ë]Ö±∞§Ï(ÄÄÄÅÖëë]Ö±∞°ô•ï±ë5•ë`∞Å]=I1πô•ï±êπâΩ——Ω¥Ä¨Ä‡∞Å]=I1πô•ï±êπ…•ù°–Ä¥Å]=I1πô•ï±êπ±ïô–Ä¨ÄÃ»∞Äƒÿ∞Å5}=9%πô±ΩΩ»π…ïÕ—•—’—•Ω∏∞Å5}=9%πô±ΩΩ»πô…•ç—•Ω∏∞Äùô•ï±êµô±ΩΩ»ú∞Å=11%M%=9}Q=Idπô•ï±ë]Ö±∞§Ï(ÄÄÄÅÖëë]Ö±∞°ô•ï±ë5•ë`∞Å]=I1πô•ï±êπ—Ω¿Ä¥Ä‡∞Å]=I1πô•ï±êπ…•ù°–Ä¥Å]=I1πô•ï±êπ±ïô–Ä¨ÄÃ»∞Äƒÿ∞Å5}=9%π›Ö±∞π…ïÕ—•—’—•Ω∏∞Å5}=9%π›Ö±∞πô…•ç—•Ω∏∞Äùô•ï±êµ—Ω¿µ›Ö±∞ú∞Å=11%M%=9}Q=Idπô•ï±ë]Ö±∞§Ï(ÄÄÄÅ—°•Ãπç…ïÖ—ï’…Ÿïë1Ö’πç°1Öπï]Ö±±Ã†§Ï(ÄÅÙ((ÄÅ¡…•ŸÖ—îÅ±Öπï•…ïç—•Ω∏°Õïùµïπ—%πëï‡ËÅπ’µâï»§ËÅYïç—Ω…1•≠îÅÏ(ÄÄÄÅçΩπÕ–Å¡Ö—†ÄÙÅ5}=9%π±Ö’πç°1Öπîπ¡Ö—†Ï(ÄÄÄÅçΩπÕ–ÅÕ—Ö…—%πëï‡ÄÙÅ5Ö—†πµÖ‡†¿∞Å5Ö—†πµ•∏°Õïùµïπ—%πëï‡∞Å¡Ö—†π±ïπù—†Ä¥Ä»§§Ï(ÄÄÄÅçΩπÕ–ÅÕ—Ö…–ÄÙÅ¡Ö—°mÕ—Ö…—%πëï·tÏ(ÄÄÄÅçΩπÕ–ÅïπêÄÙÅ¡Ö—°mÕ—Ö…—%πëï‡Ä¨Ä≈tÏ(ÄÄÄÅçΩπÕ–Åë•Õ—ÖπçîÄÙÅ5Ö—†πµÖ‡°5Ö—†π°Â¡Ω–°ïπêπ‡Ä¥ÅÕ—Ö…–π‡∞Åïπêπ‰Ä¥ÅÕ—Ö…–π‰§∞Äƒ§Ï(ÄÄÄÅ…ï—’…∏ÅÏ(ÄÄÄÄÄÅ‡ËÄ°ïπêπ‡Ä¥ÅÕ—Ö…–π‡§ÄºÅë•Õ—Öπçî∞(ÄÄÄÄÄÅ‰ËÄ°ïπêπ‰Ä¥ÅÕ—Ö…–π‰§ÄºÅë•Õ—Öπçî∞(ÄÄÄÅÙÏ(ÄÅÙ((ÄÅ¡…•ŸÖ—îÅÖëë1ÖπïMïùµïπ–°Õ—Ö…–ËÅYïç—Ω…1•≠î∞ÅïπêËÅYïç—Ω…1•≠î∞Å±Öâï∞ËÅÕ—…•πú§ËÅŸΩ•êÅÏ(ÄÄÄÅçΩπÕ–Åë‡ÄÙÅïπêπ‡Ä¥ÅÕ—Ö…–π‡Ï(ÄÄÄÅçΩπÕ–Åë‰ÄÙÅïπêπ‰Ä¥ÅÕ—Ö…–π‰Ï(ÄÄÄÅçΩπÕ–Å±ïπù—†ÄÙÅ5Ö—†πµÖ‡°5Ö—†π°Â¡Ω–°ë‡∞Åë‰§∞Å5}=9%π±Ö’πç°1Öπîπ›Ö±±Q°•ç≠πïÕÃ§Ï(ÄÄÄÅçΩπÕ–ÅâΩë‰ÄÙÅ—°•ÃπµÖ——ï»πÖëêπ…ïç—Öπù±î†(ÄÄÄÄÄÄ°Õ—Ö…–π‡Ä¨Åïπêπ‡§ÄºÄ»∞(ÄÄÄÄÄÄ°Õ—Ö…–π‰Ä¨Åïπêπ‰§ÄºÄ»∞(ÄÄÄÄÄÅ±ïπù—†Ä¨Å5}=9%π±Ö’πç°1ÖπîπÕïùµïπ—=Ÿï…±Ö¿∞(ÄÄÄÄÄÅ5}=9%π±Ö’πç°1Öπîπ›Ö±±Q°•ç≠πïÕÃ∞(ÄÄÄÄÄÅÏ(ÄÄÄÄÄÄÄÅ•ÕM—Ö—•åËÅ—…’î∞(ÄÄÄÄÄÄÄÅÖπù±îËÅ5Ö—†πÖ—Ö∏»°ë‰∞Åë‡§∞(ÄÄÄÄÄÄÄÅ±Öâï∞∞(ÄÄÄÄÄÄÄÅ…ïÕ—•—’—•Ω∏ËÅ5}=9%π›Ö±∞π…ïÕ—•—’—•Ω∏∞(ÄÄÄÄÄÄÄÅô…•ç—•Ω∏ËÅ5}=9%π›Ö±∞πô…•ç—•Ω∏∞(ÄÄÄÄÄÄÄÅçΩ±±•Õ•Ωπ•±—ï»ËÅÏ(ÄÄÄÄÄÄÄÄÄÅçÖ—ïùΩ…‰ËÅ=11%M%=9}Q=Idπ±Öπï]Ö±∞∞(ÄÄÄÄÄÄÄÄÄÅµÖÕ¨ËÅ=11%M%=9}Q=IdπâÖ±∞∞(ÄÄÄÄÄÄÄÅÙ∞(ÄÄÄÄÄÅÙ∞(ÄÄÄÄ§Ï(ÄÄÄÅ—°•ÃπÕ—Ö—•ç	Ωë•ïÃπ¡’Õ†°âΩë‰§Ï(ÄÅÙ((ÄÅ¡…•ŸÖ—îÅç…ïÖ—ï’…Ÿïë1Ö’πç°1Öπï]Ö±±Ã†§ËÅŸΩ•êÅÏ(ÄÄÄÅçΩπÕ–Å¡Ö—†ÄÙÅ5}=9%π±Ö’πç°1Öπîπ¡Ö—†Ï(ÄÄÄÅçΩπÕ–Å°Ö±ô]•ë—†ÄÙÅ5}=9%π±Ö’πç°1ÖπîπçΩ……•ëΩ…]•ë—†ÄºÄ»Ï(ÄÄÄÅçΩπÕ–Å±ïô—AΩ•π—ÃËÅYïç—Ω…1•≠ïmtÄÙÅmtÏ(ÄÄÄÅçΩπÕ–Å…•ù°—AΩ•π—ÃËÅYïç—Ω…1•≠ïmtÄÙÅmtÏ((ÄÄÄÅôΩ»Ä°±ï–Å•πëï‡ÄÙÄ¿ÏÅ•πëï‡ÄÅ¡Ö—†π±ïπù—†ÏÅ•πëï‡Ä¨ÙÄƒ§ÅÏ(ÄÄÄÄÄÅçΩπÕ–Åë•…ïç—•Ω∏ÄÙÅ—°•Ãπ±Öπï•…ïç—•Ω∏°5Ö—†πµ•∏°•πëï‡∞Å¡Ö—†π±ïπù—†Ä¥Ä»§§Ï(ÄÄÄÄÄÅ•òÄ°•πëï‡ÄÙÙÙÅ¡Ö—†π±ïπù—†Ä¥Äƒ§ÅÏ(ÄÄÄÄÄÄÄÅçΩπÕ–Å¡…ïŸ•Ω’Õ•…ïç—•Ω∏ÄÙÅ—°•Ãπ±Öπï•…ïç—•Ω∏°¡Ö—†π±ïπù—†Ä¥Ä»§Ï(ÄÄÄÄÄÄÄÅë•…ïç—•Ω∏π‡ÄÙÅ¡…ïŸ•Ω’Õ•…ïç—•Ω∏π‡Ï(ÄÄÄÄÄÄÄÅë•…ïç—•Ω∏π‰ÄÙÅ¡…ïŸ•Ω’Õ•…ïç—•Ω∏π‰Ï(ÄÄÄÄÄÅÙ(ÄÄÄÄÄÅçΩπÕ–ÅπΩ…µÖ∞ÄÙÅÏÅ‡ËÄµë•…ïç—•Ω∏π‰∞Å‰ËÅë•…ïç—•Ω∏π‡ÅÙÏ(ÄÄÄÄÄÅ±ïô—AΩ•π—Ãπ¡’Õ†°Ï(ÄÄÄÄÄÄÄÅ‡ËÅ¡Ö—°m•πëï·tπ‡Ä¨ÅπΩ…µÖ∞π‡Ä®Å°Ö±ô]•ë—†∞(ÄÄÄÄÄÄÄÅ‰ËÅ¡Ö—°m•πëï·tπ‰Ä¨ÅπΩ…µÖ∞π‰Ä®Å°Ö±ô]•ë—†∞(ÄÄÄÄÄÅÙ§Ï(ÄÄÄÄÄÅ…•ù°—AΩ•π—Ãπ¡’Õ†°Ï(ÄÄÄÄÄÄÄÅ‡ËÅ¡Ö—°m•πëï·tπ‡Ä¥ÅπΩ…µÖ∞π‡Ä®Å°Ö±ô]•ë—†∞(ÄÄÄÄÄÄÄÅ‰ËÅ¡Ö—°m•πëï·tπ‰Ä¥ÅπΩ…µÖ∞π‰Ä®Å°Ö±ô]•ë—†∞(ÄÄÄÄÄÅÙ§Ï(ÄÄÄÅÙ((ÄÄÄÅôΩ»Ä°±ï–Å•πëï‡ÄÙÄ¿ÏÅ•πëï‡ÄÅ¡Ö—†π±ïπù—†Ä¥ÄƒÏÅ•πëï‡Ä¨ÙÄƒ§ÅÏ(ÄÄÄÄÄÅ—°•ÃπÖëë1ÖπïMïùµïπ–°±ïô—AΩ•π—Õm•πëï·t∞Å±ïô—AΩ•π—Õm•πëï‡Ä¨Ä≈t∞Äù±Ö’πç†µ±Öπîµ±ïô–µ›Ö±∞ú§Ï(ÄÄÄÄÄÅ—°•ÃπÖëë1ÖπïMïùµïπ–°…•ù°—AΩ•π—Õm•πëï·t∞Å…•ù°—AΩ•π—Õm•πëï‡Ä¨Ä≈t∞Äù±Ö’πç†µ±Öπîµ…•ù°–µ›Ö±∞ú§Ï(ÄÄÄÅÙ((ÄÄÄÅôΩ»Ä°çΩπÕ–Å¡Ω•π–ÅΩòÅl∏∏π±ïô—AΩ•π—Ã∞Ä∏∏π…•ù°—AΩ•π—Õt§ÅÏ(ÄÄÄÄÄÅçΩπÕ–Å©Ω•π–ÄÙÅ—°•ÃπµÖ——ï»πÖëêπç•…ç±î†(ÄÄÄÄÄÄÄÅ¡Ω•π–π‡∞(ÄÄÄÄÄÄÄÅ¡Ω•π–π‰∞(ÄÄÄÄÄÄÄÅ5}=9%π±Ö’πç°1Öπîπ©Ω•π—IÖë•’Ã∞(ÄÄÄÄÄÄÄÅÏ(ÄÄÄÄÄÄÄÄÄÅ•ÕM—Ö—•åËÅ—…’î∞(ÄÄÄÄÄÄÄÄÄÅ±Öâï∞ËÄù±Ö’πç†µ±Öπîµ…Ω’πëïêµ©Ω•π–ú∞(ÄÄÄÄÄÄÄÄÄÅ…ïÕ—•—’—•Ω∏ËÅ5}=9%π›Ö±∞π…ïÕ—•—’—•Ω∏∞(ÄÄÄÄÄÄÄÄÄÅô…•ç—•Ω∏ËÅ5}=9%π›Ö±∞πô…•ç—•Ω∏∞(ÄÄÄÄÄÄÄÄÄÅçΩ±±•Õ•Ωπ•±—ï»ËÅÏ(ÄÄÄÄÄÄÄÄÄÄÄÅçÖ—ïùΩ…‰ËÅ=11%M%=9}Q=Idπ±Öπï]Ö±∞∞(ÄÄÄÄÄÄÄÄÄÄÄÅµÖÕ¨ËÅ=11%M%=9}Q=IdπâÖ±∞∞(ÄÄÄÄÄÄÄÄÄÅÙ∞(ÄÄÄÄÄÄÄÅÙ∞(ÄÄÄÄÄÄ§Ï(ÄÄÄÄÄÅ—°•ÃπÕ—Ö—•ç	Ωë•ïÃπ¡’Õ†°©Ω•π–§Ï(ÄÄÄÅÙ((ÄÄÄÅ—°•ÃπÖëë1ÖπïMïùµïπ–°±ïô—AΩ•π—Õl¡t∞Å…•ù°—AΩ•π—Õl¡t∞Äù±Ö’πç†µ±ÖπîµÕ—Ö…–µçÖ¿ú§Ï((ÄÄÄÅçΩπÕ–Åï·•–ÄÙÅ5}=9%π±Ö’πç°1Öπîπï·•—AΩÕ•—•Ω∏Ï(ÄÄÄÅçΩπÕ–Åï·•—Ö—îÄÙÅ—°•ÃπµÖ——ï»πÖëêπ…ïç—Öπù±î†(ÄÄÄÄÄÅï·•–π‡∞(ÄÄÄÄÄÅï·•–π‰∞(ÄÄÄÄÄÅ5}=9%π±Ö’πç°1ÖπîπùÖ—ï]•ë—†∞(ÄÄÄÄÄÅ5}=9%π±Ö’πç°1ÖπîπùÖ—ïQ°•ç≠πïÕÃ∞(ÄÄÄÄÄÅÏ(ÄÄÄÄÄÄÄÅ•ÕM—Ö—•åËÅ—…’î∞(ÄÄÄÄÄÄÄÅÖπù±îËÅ5}=9%π±Ö’πç°1Öπîπï·•—πù±ïIÖë•ÖπÃÄ¨Å5Ö—†πA$ÄºÄ»∞(ÄÄÄÄÄÄÄÅ±Öâï∞ËÄù±Ö’πç†µ±ÖπîµΩπîµ›Ö‰µùÖ—îú∞(ÄÄÄÄÄÄÄÅ…ïÕ—•—’—•Ω∏ËÅ5}=9%π›Ö±∞π…ïÕ—•—’—•Ω∏∞(ÄÄÄÄÄÄÄÅô…•ç—•Ω∏ËÅ5}=9%π›Ö±∞πô…•ç—•Ω∏∞(ÄÄÄÄÄÄÄÅçΩ±±•Õ•Ωπ•±—ï»ËÅÏ(ÄÄÄÄÄÄÄÄÄÅçÖ—ïùΩ…‰ËÅ=11%M%=9}Q=Idπ±ÖπïÖ—î∞(ÄÄÄÄÄÄÄÄÄÅµÖÕ¨ËÅ=11%M%=9}Q=IdπâÖ±∞∞(ÄÄÄÄÄÄÄÅÙ∞(ÄÄÄÄÄÅÙ∞(ÄÄÄÄ§Ï(ÄÄÄÅ—°•ÃπÕ—Ö—•ç	Ωë•ïÃπ¡’Õ†°ï·•—Ö—î§Ï(ÄÅÙ((ÄÅ¡…•ŸÖ—îÅç…ïÖ—ï	’µ¡ï…Ã†§ËÅŸΩ•êÅÏ(ÄÄÄÅçΩπÕ–Å¡ΩÕ•—•ΩπÃÄÙÅl(ÄÄÄÄÄÅÏÅ‡ËÄ»»¿∞Å‰ËÄÃ‹‘ÅÙ∞(ÄÄÄÄÄÅÏÅ‡ËÄ–»¿∞Å‰ËÄÃ‹‘ÅÙ∞(ÄÄÄÄÄÅÏÅ‡ËÄÃ»¿∞Å‰ËÄ‘‡¿ÅÙ∞(ÄÄÄÅtÏ(ÄÄÄÅôΩ»Ä°çΩπÕ–Å¡ΩÕ•—•Ω∏ÅΩòÅ¡ΩÕ•—•ΩπÃ§ÅÏ(ÄÄÄÄÄÅçΩπÕ–ÅâΩë‰ÄÙÅ—°•ÃπµÖ——ï»πÖëêπç•…ç±î°¡ΩÕ•—•Ω∏π‡∞Å¡ΩÕ•—•Ω∏π‰∞Å5}=9%πâ’µ¡ï»π…Öë•’Ã∞ÅÏ(ÄÄÄÄÄÄÄÅ•ÕM—Ö—•åËÅ—…’î∞(ÄÄÄÄÄÄÄÅ±Öâï∞ËÄù°Ö©•≠îµâ’µ¡ï»ú∞(ÄÄÄÄÄÄÄÅ…ïÕ—•—’—•Ω∏ËÅ5}=9%πâ’µ¡ï»π…ïÕ—•—’—•Ω∏∞(ÄÄÄÄÄÄÄÅô…•ç—•Ω∏ËÅ5}=9%πâ’µ¡ï»πô…•ç—•Ω∏∞(ÄÄÄÄÄÄÄÅçΩ±±•Õ•Ωπ•±—ï»ËÅÏ(ÄÄÄÄÄÄÄÄÄÅçÖ—ïùΩ…‰ËÅ=11%M%=9}Q=Idπâ’µ¡ï»∞(ÄÄÄÄÄÄÄÄÄÅµÖÕ¨ËÅ=11%M%=9}Q=IdπâÖ±∞∞(ÄÄÄÄÄÄÄÅÙ∞(ÄÄÄÄÄÅÙ§Ï(ÄÄÄÄÄÅ—°•Ãπâ’µ¡ï…ÃπÕï–°âΩë‰π•ê∞ÅÏ(ÄÄÄÄÄÄÄÅâΩë‰∞(ÄÄÄÄÄÄÄÅ‡ËÅ¡ΩÕ•—•Ω∏π‡∞(ÄÄÄÄÄÄÄÅ‰ËÅ¡ΩÕ•—•Ω∏π‰∞(ÄÄÄÄÄÄÄÅ¡’±ÕïUπ—•∞ËÄ¿∞(ÄÄÄÄÄÅÙ§Ï(ÄÄÄÅÙ(ÄÅÙ((ÄÅ¡…•ŸÖ—îÅ°•—	’µ¡ï»°â’µ¡ï»ËÅ	’µ¡ï…π—•—‰∞ÅâÖ±∞ËÅ	Ö±±π—•—‰∞ÅπΩ‹ËÅπ’µâï»§ËÅŸΩ•êÅÏ(ÄÄÄÅ•òÄ°âÖ±∞π•Õ5ï…ù•πú§Å…ï—’…∏Ï(ÄÄÄÅçΩπÕ–ÅçΩΩ±ëΩ›π-ï‰ÄÙÅÄëÌâÖ±∞π•ëÙËëÌâ’µ¡ï»πâΩë‰π•ëıÄÏ(ÄÄÄÅçΩπÕ–Å±ÖÕ—!•—–ÄÙÅ—°•Ãπâ’µ¡ï…!•—ΩΩ±ëΩ›πÃπùï–°çΩΩ±ëΩ›π-ï‰§Ä¸¸Å9’µâï»π9Q%Y}%9%9%QdÏ(ÄÄÄÅ•òÄ°πΩ‹Ä¥Å±ÖÕ—!•—–ÄÅ5}=9%πâ’µ¡ï»πÕçΩ…ïΩΩ±ëΩ›π5Ã§Å…ï—’…∏Ï(ÄÄÄÅ—°•Ãπâ’µ¡ï…!•—ΩΩ±ëΩ›πÃπÕï–°çΩΩ±ëΩ›π-ï‰∞ÅπΩ‹§Ï(ÄÄÄÅâ’µ¡ï»π¡’±ÕïUπ—•∞ÄÙÅπΩ‹Ä¨Å5}=9%πâ’µ¡ï»π¡’±Õï’…Ö—•Ωπ5ÃÏ(ÄÄÄÅçΩπÕ–Åë‡ÄÙÅâÖ±∞πâΩë‰π¡ΩÕ•—•Ω∏π‡Ä¥Åâ’µ¡ï»π‡Ï(ÄÄÄÅçΩπÕ–Åë‰ÄÙÅâÖ±∞πâΩë‰π¡ΩÕ•—•Ω∏π‰Ä¥Åâ’µ¡ï»π‰Ï(ÄÄÄÅçΩπÕ–Åë•Õ—ÖπçîÄÙÅ5Ö—†πµÖ‡°5Ö—†π°Â¡Ω–°ë‡∞Åë‰§∞Äƒ§Ï(ÄÄÄÅçΩπÕ–ÅπΩ…µÖ∞ÄÙÅÏÅ‡ËÅë‡ÄºÅë•Õ—Öπçî∞Å‰ËÅë‰ÄºÅë•Õ—ÖπçîÅÙÏ(ÄÄÄÅçΩπÕ–Å•µ¡Öç—M¡ïïêÄÙÅ5Ö—†π°Â¡Ω–°âÖ±∞πâΩë‰πŸï±Ωç•—‰π‡∞ÅâÖ±∞πâΩë‰πŸï±Ωç•—‰π‰§Ï(ÄÄÄÅçΩπÕ–Å¡Ω•π—ÃÄÙÅçÖ±ç’±Ö—ï	’µ¡ï…!•—MçΩ…î°•µ¡Öç—M¡ïïê§Ï(ÄÄÄÅ—°•ÃπÕï—	ΩëÂYï±Ωç•—‰°âÖ±∞πâΩë‰∞ÅÏ(ÄÄÄÄÄÅ‡ËÅâÖ±∞πâΩë‰πŸï±Ωç•—‰π‡Ä¨ÅπΩ…µÖ∞π‡Ä®Å5}=9%πâ’µ¡ï»π•µ¡’±Õî∞(ÄÄÄÄÄÅ‰ËÅâÖ±∞πâΩë‰πŸï±Ωç•—‰π‰Ä¨ÅπΩ…µÖ∞π‰Ä®Å5}=9%πâ’µ¡ï»π•µ¡’±Õî∞(ÄÄÄÅÙ§Ï(ÄÄÄÅ—°•ÃπÕçΩ…îÄ¨ÙÅ¡Ω•π—ÃÏ(ÄÄÄÅ—°•ÃπâïÕ—MçΩ…îÄÙÅ5Ö—†πµÖ‡°—°•ÃπâïÕ—MçΩ…î∞Å—°•ÃπÕçΩ…î§Ï(ÄÄÄÅÕÖŸï	ïÕ—MçΩ…î°—°•ÃπâïÕ—MçΩ…î§Ï(ÄÄÄÅ•òÄ°—°•Ãπ±ÖÕ—1Ö’πç°	’µ¡ï…%êÄÑÙÙÅâ’µ¡ï»πâΩë‰π•ê§ÅÏ(ÄÄÄÄÄÅ—°•Ãπ±Ö’πç°	’µ¡ï…!•—Ω’π–Ä¨ÙÄƒÏ(ÄÄÄÄÄÅ—°•Ãπ±ÖÕ—1Ö’πç°	’µ¡ï…%êÄÙÅâ’µ¡ï»πâΩë‰π•êÏ(ÄÄÄÅÙ(ÄÄÄÅ—°•Ãπïµ•–†ù°Ö©•≠îÈÕçΩ…îú∞ÅÏÅÕçΩ…îËÅ—°•ÃπÕçΩ…î∞ÅâïÕ–ËÅ—°•ÃπâïÕ—MçΩ…îÅÙ§Ï(ÄÄÄÅ—°•Ãπïµ•–†ù°Ö©•≠îÈâ’µ¡ï»µ°•–ú∞ÅÏ(ÄÄÄÄÄÅçΩ’π–ËÅ—°•Ãπ±Ö’πç°	’µ¡ï…!•—Ω’π–∞(ÄÄÄÄÄÅ¡Ω•π—Ã∞(ÄÄÄÄÄÅ•µ¡Öç—M¡ïïê∞(ÄÄÄÅÙ§Ï(ÄÄÄÅ—°•ÃπÕ°Ω›	’…Õ–°â’µ¡ï»π‡Ä¨ÅπΩ…µÖ∞π‡Ä®Ä»–∞Åâ’µ¡ï»π‰Ä¨ÅπΩ…µÖ∞π‰Ä®Ä»–∞Ä¡·âôïïôò∞Ä‘§Ï(ÄÅÙ((ÄÅ¡…•ŸÖ—îÅÖ¡¡±ÂM°Ωç≠›ÖŸî°ÕΩ’…çîËÅ	Ö±±π—•—‰§ËÅŸΩ•êÅÏ(ÄÄÄÅçΩπÕ–Åµ’±—•¡±•ï»ÄÙÅ5}=9%πµï…ùïM°Ωç≠›ÖŸîπ±ïŸï±5’±—•¡±•ï…ÕmÕΩ’…çîπ±ïŸï±tÄ¸¸ÄƒÏ(ÄÄÄÅçΩπÕ–Åµ’±—•¡±•ï…A…Ωù…ïÕÃÄÙÅ5Ö—†πµ•∏°5Ö—†πµÖ‡†°µ’±—•¡±•ï»Ä¥Äƒ§ÄºÄÃ∞Ä¿§∞Äƒ§Ï(ÄÄÄÅçΩπÕ–Å•µ¡’±ÕîÄÙÅ5}=9%πµï…ùïM°Ωç≠›ÖŸîπµ•π%µ¡’±Õî(ÄÄÄÄÄÄ¨Ä°5}=9%πµï…ùïM°Ωç≠›ÖŸîπµÖ·%µ¡’±ÕîÄ¥Å5}=9%πµï…ùïM°Ωç≠›ÖŸîπµ•π%µ¡’±Õî§(ÄÄÄÄÄÄÄÄ®Åµ’±—•¡±•ï…A…Ωù…ïÕÃÄ®®Äƒ∏»‘Ï(ÄÄÄÅçΩπÕ–Å…Öë•’ÃÄÙÅ5}=9%πµï…ùïM°Ωç≠›ÖŸîπµ•πIÖë•’Ã(ÄÄÄÄÄÄ¨Ä°5}=9%πµï…ùïM°Ωç≠›ÖŸîπµÖ·IÖë•’ÃÄ¥Å5}=9%πµï…ùïM°Ωç≠›ÖŸîπµ•πIÖë•’Ã§(ÄÄÄÄÄÄÄÄ®Åµ’±—•¡±•ï…A…Ωù…ïÕÃÄ®®Ä¿∏‡‘Ï((ÄÄÄÅôΩ»Ä°çΩπÕ–ÅâÖ±∞ÅΩòÅ—°•ÃπâÖ±±ÃπŸÖ±’ïÃ†§§ÅÏ(ÄÄÄÄÄÅ•òÄ°âÖ±∞π•êÄÙÙÙÅÕΩ’…çîπ•êÅÒÅâÖ±∞π•Õ%π1Ö’πç°1ÖπîÅÒÅâÖ±∞π•Õ5ï…ù•πú§ÅçΩπ—•π’îÏ(ÄÄÄÄÄÅçΩπÕ–Åë‡ÄÙÅâÖ±∞πâΩë‰π¡ΩÕ•—•Ω∏π‡Ä¥ÅÕΩ’…çîπâΩë‰π¡ΩÕ•—•Ω∏π‡Ï(ÄÄÄÄÄÅçΩπÕ–Åë‰ÄÙÅâÖ±∞πâΩë‰π¡ΩÕ•—•Ω∏π‰Ä¥ÅÕΩ’…çîπâΩë‰π¡ΩÕ•—•Ω∏π‰Ï(ÄÄÄÄÄÅçΩπÕ–Åë•Õ—ÖπçîÄÙÅ5Ö—†π°Â¡Ω–°ë‡∞Åë‰§Ï(ÄÄÄÄÄÅ•òÄ°ë•Õ—ÖπçîÄ¯Å…Öë•’ÃÅÒÅë•Õ—ÖπçîÄÄƒ§ÅçΩπ—•π’îÏ(ÄÄÄÄÄÅçΩπÕ–ÅôÖ±±ΩôòÄÙÄ†ƒÄ¥Åë•Õ—ÖπçîÄºÅ…Öë•’Ã§Ä®®Å5}=9%πµï…ùïM°Ωç≠›ÖŸîπôÖ±±Ωôô·¡Ωπïπ–Ï(ÄÄÄÄÄÅçΩπÕ–ÅÕçÖ±îÄÙÅ•µ¡’±ÕîÄ®ÅôÖ±±ΩôòÏ(ÄÄÄÄÄÅ—°•ÃπÕï—	ΩëÂYï±Ωç•—‰°âÖ±∞πâΩë‰∞ÅÏ(ÄÄÄÄÄÄÄÅ‡ËÅâÖ±∞πâΩë‰πŸï±Ωç•—‰π‡Ä¨Ä°ë‡ÄºÅë•Õ—Öπçî§Ä®ÅÕçÖ±î∞(ÄÄÄÄÄÄÄÅ‰ËÅâÖ±∞πâΩë‰πŸï±Ωç•—‰π‰Ä¨Ä°ë‰ÄºÅë•Õ—Öπçî§Ä®ÅÕçÖ±î∞(ÄÄÄÄÄÅÙ§Ï(ÄÄÄÄÄÅ—°•ÃπçÖ¡	ΩëÂM¡ïïê°âÖ±∞πâΩë‰§Ï(ÄÄÄÅÙ(ÄÅÙ((ÄÅ¡…•ŸÖ—îÅçÖ¡±±	ΩëÂM¡ïïëÃ†§ËÅŸΩ•êÅÏ(ÄÄÄÅôΩ»Ä°çΩπÕ–ÅâÖ±∞ÅΩòÅ—°•ÃπâÖ±±ÃπŸÖ±’ïÃ†§§Å—°•ÃπçÖ¡	ΩëÂM¡ïïê°âÖ±∞πâΩë‰§Ï(ÄÅÙ((ÄÅ¡…•ŸÖ—îÅçÖ¡	ΩëÂM¡ïïê°âΩë‰ËÅ5Ö——ï…)Lπ	ΩëÂQÂ¡î§ËÅŸΩ•êÅÏ(ÄÄÄÅçΩπÕ–ÅÕ¡ïïêÄÙÅ5Ö—†π°Â¡Ω–°âΩë‰πŸï±Ωç•—‰π‡∞ÅâΩë‰πŸï±Ωç•—‰π‰§Ï(ÄÄÄÅ•òÄ°Õ¡ïïêÄÙÅ5}=9%πµÖ·	ΩëÂM¡ïïêÅÒÅÕ¡ïïêÄÄ¿∏¿¿ƒ§Å…ï—’…∏Ï(ÄÄÄÅçΩπÕ–ÅÕçÖ±îÄÙÅ5}=9%πµÖ·	ΩëÂM¡ïïêÄºÅÕ¡ïïêÏ(ÄÄÄÅ—°•ÃπÕï—	ΩëÂYï±Ωç•—‰°âΩë‰∞ÅÏ(ÄÄÄÄÄÅ‡ËÅâΩë‰πŸï±Ωç•—‰π‡Ä®ÅÕçÖ±î∞(ÄÄÄÄÄÅ‰ËÅâΩë‰πŸï±Ωç•—‰π‰Ä®ÅÕçÖ±î∞(ÄÄÄÅÙ§Ï(ÄÅÙ((ÄÅ¡…•ŸÖ—îÅÕï—	ΩëÂYï±Ωç•—‰°âΩë‰ËÅ5Ö——ï…)Lπ	ΩëÂQÂ¡î∞ÅŸï±Ωç•—‰ËÅYïç—Ω…1•≠î§ËÅŸΩ•êÅÏ(ÄÄÄÅ—°•ÃπµÖ——ï»πâΩë‰πÕï—Yï±Ωç•—‰°âΩë‰∞ÅŸï±Ωç•—‰§Ï(ÄÅÙ((ÄÅ¡…•ŸÖ—îÅÕï—	ΩëÂπù’±Ö…Yï±Ωç•—‰°âΩë‰ËÅ5Ö——ï…)Lπ	ΩëÂQÂ¡î∞ÅŸï±Ωç•—‰ËÅπ’µâï»§ËÅŸΩ•êÅÏ(ÄÄÄÅ—°•ÃπµÖ——ï»πâΩë‰πÕï—πù’±Ö…Yï±Ωç•—‰°âΩë‰∞ÅŸï±Ωç•—‰§Ï(ÄÅÙ((ÄÅ¡…•ŸÖ—îÅë…Ö›	ΩÖ…ê†§ËÅŸΩ•êÅÏ(ÄÄÄÅ—°•ÃπâΩÖ…ë…Ö¡°•çÃπç±ïÖ»†§Ï(ÄÄÄÅ—°•ÃπâΩÖ…ë…Ö¡°•çÃπô•±±M—Â±î†¡‡¿‡»Ã—Ñ∞Äƒ§Ï(ÄÄÄÅ—°•ÃπâΩÖ…ë…Ö¡°•çÃπô•±±IΩ’πëïëIïç–†‘‘∞Äÿ¿∞Äÿƒ¿∞ÄƒƒÃ¿∞ÄÃ»§Ï(ÄÄÄÅ—°•ÃπâΩÖ…ë…Ö¡°•çÃπ±•πïM—Â±î†ÿ∞Ä¡‡—Ñ›çÖÑ∞Ä¿∏–‘§Ï(ÄÄÄÅ—°•ÃπâΩÖ…ë…Ö¡°•çÃπÕ—…Ω≠ïIΩ’πëïëIïç–†‘‘∞Äÿ¿∞Äÿƒ¿∞ÄƒƒÃ¿∞ÄÃ»§Ï(ÄÄÄÅ—°•ÃπâΩÖ…ë…Ö¡°•çÃπô•±±M—Â±î†¡‡ƒÃ…ò’à∞Äƒ§Ï(ÄÄÄÅ—°•ÃπâΩÖ…ë…Ö¡°•çÃπô•±±IΩ’πëïëIïç–°]=I1πô•ï±êπ±ïô–∞Å]=I1πô•ï±êπ—Ω¿Ä¨Äƒ»∞Å]=I1πô•ï±êπ…•ù°–Ä¥Å]=I1πô•ï±êπ±ïô–∞Å]=I1πô•ï±êπâΩ——Ω¥Ä¥Å]=I1πô•ï±êπ—Ω¿Ä¥Äƒ»∞Äƒÿ§Ï(ÄÄÄÅ—°•ÃπâΩÖ…ë…Ö¡°•çÃπ±•πïM—Â±î†–∞Ä¡‡’ê‰…åƒ∞Ä¿∏‹§Ï(ÄÄÄÅ—°•ÃπâΩÖ…ë…Ö¡°•çÃπÕ—…Ω≠ïIΩ’πëïëIïç–°]=I1πô•ï±êπ±ïô–∞Å]=I1πô•ï±êπ—Ω¿Ä¨Äƒ»∞Å]=I1πô•ï±êπ…•ù°–Ä¥Å]=I1πô•ï±êπ±ïô–∞Å]=I1πô•ï±êπâΩ——Ω¥Ä¥Å]=I1πô•ï±êπ—Ω¿Ä¥Äƒ»∞Äƒÿ§Ï(ÄÄÄÅçΩπÕ–Å±ÖπïAÖ—†ÄÙÅ5}=9%π±Ö’πç°1Öπîπ¡Ö—†Ï(ÄÄÄÅ—°•ÃπâΩÖ…ë…Ö¡°•çÃπ±•πïM—Â±î°5}=9%π±Ö’πç°1ÖπîπçΩ……•ëΩ…]•ë—†∞Ä¡‡ƒÿÕò‹¿∞Äƒ§Ï(ÄÄÄÅôΩ»Ä°±ï–Å•πëï‡ÄÙÄ¿ÏÅ•πëï‡ÄÅ±ÖπïAÖ—†π±ïπù—†Ä¥ÄƒÏÅ•πëï‡Ä¨ÙÄƒ§ÅÏ(ÄÄÄÄÄÅ—°•ÃπâΩÖ…ë…Ö¡°•çÃπ±•πï	ï—›ïï∏†(ÄÄÄÄÄÄÄÅ±ÖπïAÖ—°m•πëï·tπ‡∞(ÄÄÄÄÄÄÄÅ±ÖπïAÖ—°m•πëï·tπ‰∞(ÄÄÄÄÄÄÄÅ±ÖπïAÖ—°m•πëï‡Ä¨Ä≈tπ‡∞(ÄÄÄÄÄÄÄÅ±ÖπïAÖ—°m•πëï‡Ä¨Ä≈tπ‰∞(ÄÄÄÄÄÄ§Ï(ÄÄÄÅÙ(ÄÄÄÅ—°•ÃπâΩÖ…ë…Ö¡°•çÃπ±•πïM—Â±î†–∞Ä¡‡ÿ›àÂïå∞Ä¿∏‡§Ï(ÄÄÄÅôΩ»Ä°±ï–Å•πëï‡ÄÙÄ¿ÏÅ•πëï‡ÄÅ±ÖπïAÖ—†π±ïπù—†Ä¥ÄƒÏÅ•πëï‡Ä¨ÙÄƒ§ÅÏ(ÄÄÄÄÄÅ—°•ÃπâΩÖ…ë…Ö¡°•çÃπ±•πï	ï—›ïï∏†(ÄÄÄÄÄÄÄÅ±ÖπïAÖ—°m•πëï·tπ‡∞(ÄÄÄÄÄÄÄÅ±ÖπïAÖ—°m•πëï·tπ‰∞(ÄÄÄÄÄÄÄÅ±ÖπïAÖ—°m•πëï‡Ä¨Ä≈tπ‡∞(ÄÄÄÄÄÄÄÅ±ÖπïAÖ—°m•πëï‡Ä¨Ä≈tπ‰∞(ÄÄÄÄÄÄ§Ï(ÄÄÄÅÙ(ÄÄÄÅ—°•ÃπâΩÖ…ë…Ö¡°•çÃπô•±±M—Â±î†¡·ÑÕëôôò∞Ä¿∏ÿ‘§Ï(ÄÄÄÅ—°•ÃπâΩÖ…ë…Ö¡°•çÃπô•±±•…ç±î†(ÄÄÄÄÄÅ5}=9%π±Ö’πç°1Öπîπï·•—AΩÕ•—•Ω∏π‡∞(ÄÄÄÄÄÅ5}=9%π±Ö’πç°1Öπîπï·•—AΩÕ•—•Ω∏π‰∞(ÄÄÄÄÄÄ‹∞(ÄÄÄÄ§Ï(ÄÄÄÅ—°•ÃπâΩÖ…ë…Ö¡°•çÃπ±•πïM—Â±î†»∞Ä¡·ôò’àÿ¿∞Ä¿∏»‡§Ï(ÄÄÄÅ—°•ÃπâΩÖ…ë…Ö¡°•çÃπ±•πï	ï—›ïï∏°]=I1πô•ï±êπ±ïô–Ä¨Ä‡∞Å]=I1πëÖπùï…1•πïd∞Å]=I1πô•ï±êπ…•ù°–Ä¥Ä‡∞Å]=I1πëÖπùï…1•πïd§Ï(ÄÅÙ((ÄÅ¡…•ŸÖ—îÅ…ïπëï…]Ω…±ê†§ËÅŸΩ•êÅÏ(ÄÄÄÅçΩπÕ–ÅπΩ‹ÄÙÅ—°•Ãπ—•µîππΩ‹Ï(ÄÄÄÅ—°•ÃπâÖ±±…Ö¡°•çÃπç±ïÖ»†§Ï(ÄÄÄÅ—°•Ãπô·…Ö¡°•çÃπç±ïÖ»†§Ï((ÄÄÄÅôΩ»Ä°çΩπÕ–Åâ’µ¡ï»ÅΩòÅ—°•Ãπâ’µ¡ï…ÃπŸÖ±’ïÃ†§§ÅÏ(ÄÄÄÄÄÅçΩπÕ–Å¡’±ÕîÄÙÅâ’µ¡ï»π¡’±ÕïUπ—•∞Ä¯ÅπΩ‹Ä¸ÄƒÄ¨Ä†°â’µ¡ï»π¡’±ÕïUπ—•∞Ä¥ÅπΩ‹§ÄºÄƒ‡¿§Ä®Ä¿∏»ÄËÄƒÏ(ÄÄÄÄÄÅ—°•ÃπâÖ±±…Ö¡°•çÃπô•±±M—Â±î†¡‡—ÖÑ›ëê∞Äƒ§Ï(ÄÄÄÄÄÅ—°•ÃπâÖ±±…Ö¡°•çÃπô•±±•…ç±î°â’µ¡ï»π‡∞Åâ’µ¡ï»π‰∞Å5}=9%πâ’µ¡ï»π…Öë•’ÃÄ®Å¡’±Õî§Ï(ÄÄÄÄÄÅ—°•ÃπâÖ±±…Ö¡°•çÃπ±•πïM—Â±î†‘∞Ä¡‡·ôëçôò∞Ä¿∏‰‘§Ï(ÄÄÄÄÄÅ—°•ÃπâÖ±±…Ö¡°•çÃπÕ—…Ω≠ï•…ç±î°â’µ¡ï»π‡∞Åâ’µ¡ï»π‰∞Å5}=9%πâ’µ¡ï»π…Öë•’ÃÄ®Å¡’±Õî§Ï(ÄÄÄÄÄÅ—°•ÃπâÖ±±…Ö¡°•çÃπô•±±M—Â±î†¡·î·ôâôò∞Ä¿∏‰§Ï(ÄÄÄÄÄÅ—°•ÃπâÖ±±…Ö¡°•çÃπô•±±•…ç±î°â’µ¡ï»π‡Ä¥Äƒ¿∞Åâ’µ¡ï»π‰Ä¥Äƒ¿∞Ä‰Ä®Å¡’±Õî§Ï(ÄÄÄÄÄÅ—°•ÃπâÖ±±…Ö¡°•çÃπô•±±M—Â±î†¡‡≈à’ê‰ƒ∞Ä¿∏‰‘§Ï(ÄÄÄÄÄÅ—°•ÃπâÖ±±…Ö¡°•çÃπô•±±•…ç±î°â’µ¡ï»π‡Ä¨Ä–∞Åâ’µ¡ï»π‰Ä¨Ä‘∞ÄÿÄ®Å¡’±Õî§Ï(ÄÄÄÅÙ((ÄÄÄÅôΩ»Ä°çΩπÕ–ÅâÖ±∞ÅΩòÅ—°•ÃπâÖ±±ÃπŸÖ±’ïÃ†§§ÅÏ(ÄÄÄÄÄÅçΩπÕ–Å¡ΩÕ•—•Ω∏ÄÙÅâÖ±∞πâΩë‰π¡ΩÕ•—•Ω∏Ï(ÄÄÄÄÄÅçΩπÕ–Å…Öë•’ÃÄÙÅ…Öë•’ÕΩ…1ïŸï∞°âÖ±∞π±ïŸï∞§Ï(ÄÄÄÄÄÅçΩπÕ–ÅçΩ±Ω»ÄÙÅ	11}=1=IMmâÖ±∞π±ïŸï±tÄ¸¸Å	11}=1=IMl≈tÏ(ÄÄÄÄÄÅçΩπÕ–ÅÖ±¡°ÑÄÙÅâÖ±∞π•Õ%π1Ö’πç°1ÖπîÄ¸Ä¿∏‰»ÄËÄƒÏ(ÄÄÄÄÄÅ—°•ÃπâÖ±±…Ö¡°•çÃπô•±±M—Â±î°çΩ±Ω»∞ÅÖ±¡°Ñ§Ï(ÄÄÄÄÄÅ—°•ÃπâÖ±±…Ö¡°•çÃπô•±±•…ç±î°¡ΩÕ•—•Ω∏π‡∞Å¡ΩÕ•—•Ω∏π‰∞Å…Öë•’Ã§Ï(ÄÄÄÄÄÅ—°•ÃπâÖ±±…Ö¡°•çÃπ±•πïM—Â±î†Ã∞Ä¡‡¿‹≈åÃ‰∞Ä¿∏ÿ‡§Ï(ÄÄÄÄÄÅ—°•ÃπâÖ±±…Ö¡°•çÃπÕ—…Ω≠ï•…ç±î°¡ΩÕ•—•Ω∏π‡∞Å¡ΩÕ•—•Ω∏π‰∞Å…Öë•’Ã§Ï(ÄÄÄÄÄÅ—°•ÃπâÖ±±…Ö¡°•çÃπô•±±M—Â±î†¡·ôôôôôò∞Ä¿∏»§Ï(ÄÄÄÄÄÅ—°•ÃπâÖ±±…Ö¡°•çÃπô•±±•…ç±î°¡ΩÕ•—•Ω∏π‡Ä¥Å…Öë•’ÃÄ®Ä¿∏Ã»∞Å¡ΩÕ•—•Ω∏π‰Ä¥Å…Öë•’ÃÄ®Ä¿∏Ã–∞Å…Öë•’ÃÄ®Ä¿∏»§Ï(ÄÄÄÄÄÅâÖ±∞π±Öâï∞πÕï—AΩÕ•—•Ω∏°¡ΩÕ•—•Ω∏π‡∞Å¡ΩÕ•—•Ω∏π‰§Ï(ÄÄÄÅÙ(ÄÅÙ((ÄÅ¡…•ŸÖ—îÅÕ°Ω›	’…Õ–°‡ËÅπ’µâï»∞Å‰ËÅπ’µâï»∞ÅçΩ±Ω»ËÅπ’µâï»∞Å¡Ö…—•ç±ïΩ’π–ÄÙÄ‡§ËÅŸΩ•êÅÏ(ÄÄÄÅçΩπÕ–Å…•πúÄÙÅ—°•ÃπÖëêπç•…ç±î°‡∞Å‰∞Äƒ»∞ÅçΩ±Ω»∞Ä¿∏ƒ‡§πÕï—M—…Ω≠ïM—Â±î†–∞ÅçΩ±Ω»∞Ä¿∏‰§πÕï—ï¡—††–§Ï(ÄÄÄÅ—°•Ãπ—›ïïπÃπÖëê°Ï(ÄÄÄÄÄÅ—Ö…ùï—ÃËÅ…•πú∞(ÄÄÄÄÄÅÕçÖ±îËÄ–∞(ÄÄÄÄÄÅÖ±¡°ÑËÄ¿∞(ÄÄÄÄÄÅë’…Ö—•Ω∏ËÄÃ–¿∞(ÄÄÄÄÄÅïÖÕîËÄù’â•åπ=’–ú∞(ÄÄÄÄÄÅΩπΩµ¡±ï—îËÄ†§ÄÙ¯Å…•πúπëïÕ—…Ω‰†§∞(ÄÄÄÅÙ§Ï((ÄÄÄÅôΩ»Ä°±ï–Å•πëï‡ÄÙÄ¿ÏÅ•πëï‡ÄÅ¡Ö…—•ç±ïΩ’π–ÏÅ•πëï‡Ä¨ÙÄƒ§ÅÏ(ÄÄÄÄÄÅçΩπÕ–ÅÖπù±îÄÙÄ°5Ö—†πA$Ä®Ä»Ä®Å•πëï‡§ÄºÅ¡Ö…—•ç±ïΩ’π–Ï(ÄÄÄÄÄÅçΩπÕ–Åë•Õ—ÖπçîÄÙÄ»»Ä¨Ä°•πëï‡ÄîÄÃ§Ä®Ä‰Ï(ÄÄÄÄÄÅçΩπÕ–Å¡Ö…—•ç±îÄÙÅ—°•ÃπÖëêπç•…ç±î°‡∞Å‰∞Ä–∞ÅçΩ±Ω»∞Ä¿∏‰§πÕï—ï¡—††–§Ï(ÄÄÄÄÄÅ—°•Ãπ—›ïïπÃπÖëê°Ï(ÄÄÄÄÄÄÄÅ—Ö…ùï—ÃËÅ¡Ö…—•ç±î∞(ÄÄÄÄÄÄÄÅ‡ËÅ‡Ä¨Å5Ö—†πçΩÃ°Öπù±î§Ä®Åë•Õ—Öπçî∞(ÄÄÄÄÄÄÄÅ‰ËÅ‰Ä¨Å5Ö—†πÕ•∏°Öπù±î§Ä®Åë•Õ—Öπçî∞(ÄÄÄÄÄÄÄÅÕçÖ±îËÄ¿∏»∞(ÄÄÄÄÄÄÄÅÖ±¡°ÑËÄ¿∞(ÄÄÄÄÄÄÄÅë’…Ö—•Ω∏ËÄÃ‡¿∞(ÄÄÄÄÄÄÄÅïÖÕîËÄù’â•åπ=’–ú∞(ÄÄÄÄÄÄÄÅΩπΩµ¡±ï—îËÄ†§ÄÙ¯Å¡Ö…—•ç±îπëïÕ—…Ω‰†§∞(ÄÄÄÄÄÅÙ§Ï(ÄÄÄÅÙ(ÄÅÙ((ÄÅ¡…•ŸÖ—îÅçΩπ—Öç—-ï‰°ô•…Õ—%êËÅπ’µâï»∞ÅÕïçΩπë%êËÅπ’µâï»§ËÅÕ—…•πúÅÏ(ÄÄÄÅ…ï—’…∏Åô•…Õ—%êÄÅÕïçΩπë%êÄ¸ÅÄëÌô•…Õ—%ëÙËëÌÕïçΩπë%ëıÄÄËÅÄëÌÕïçΩπë%ëÙËëÌô•…Õ—%ëıÄÏ(ÄÅÙ((ÄÅ¡…•ŸÖ—îÅïµ•–°πÖµîËÅÕ—…•πú∞Åëï—Ö•∞ËÅ’π≠πΩ›∏§ËÅŸΩ•êÅÏ(ÄÄÄÅ›•πëΩ‹πë•Õ¡Ö—ç°Ÿïπ–°πï‹Å’Õ—ΩµŸïπ–°πÖµî∞ÅÏÅëï—Ö•∞ÅÙ§§Ï(ÄÅÙ((ÄÅ¡…•ŸÖ—îÅ°Öπë±ïM°’—ëΩ›∏†§ËÅŸΩ•êÅÏ(ÄÄÄÅ›•πëΩ‹π…ïµΩŸïŸïπ—1•Õ—ïπï»†ù°Ö©•≠îÈÖç—•Ω∏ú∞Å—°•ÃπÖç—•Ωπ!Öπë±ï»§Ï(ÄÄÄÅ›•πëΩ‹π…ïµΩŸïŸïπ—1•Õ—ïπï»†ù°Ö©•≠îÈç°Ö…ùîµÕ—Ö…–ú∞Å—°•Ãπç°Ö…ùïM—Ö…—!Öπë±ï»§Ï(ÄÄÄÅ›•πëΩ‹π…ïµΩŸïŸïπ—1•Õ—ïπï»†ù°Ö©•≠îÈç°Ö…ùîµïπêú∞Å—°•Ãπç°Ö…ùïπë!Öπë±ï»§Ï(ÄÄÄÅ—°•ÃπµÖ——ï»π›Ω…±êπΩôò†ùçΩ±±•Õ•ΩπÕ—Ö…–ú∞Å—°•ÃπçΩ±±•Õ•ΩπM—Ö…—!Öπë±ï»§Ï(ÄÄÄÅ—°•ÃπµÖ——ï»π›Ω…±êπΩôò†ùçΩ±±•Õ•Ωπïπêú∞Å—°•ÃπçΩ±±•Õ•Ωππë!Öπë±ï»§Ï(ÄÄÄÅ—°•ÃπçΩπ—Öç—M—Ö…—Ãπç±ïÖ»†§Ï(ÄÄÄÅ—°•Ãπâ’µ¡ï…!•—ΩΩ±ëΩ›πÃπç±ïÖ»†§Ï(ÄÄÄÅ—°•ÃπâÖ±±Ãπç±ïÖ»†§Ï(ÄÄÄÅ—°•ÃπâÖ±±Õ	Â	ΩëÂ%êπç±ïÖ»†§Ï(ÄÄÄÅ—°•Ãπâ’µ¡ï…Ãπç±ïÖ»†§Ï(ÄÄÄÅ—°•Ãπ±Ö’πç°	’µ¡ï…!•—Ω’π–ÄÙÄ¿Ï(ÄÄÄÅ—°•Ãπ±ÖÕ—1Ö’πç°	’µ¡ï…%êÄÙÅπ’±∞Ï(ÄÄÄÅ—°•ÃπÕ—Ö—•ç	Ωë•ïÃπ±ïπù—†ÄÙÄ¿Ï(ÄÅÙ)Ù(