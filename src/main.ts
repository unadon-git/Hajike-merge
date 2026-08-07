import Phaser from 'phaser';
import './styles.css';
import { BALL_COLORS_CSS, GAME_CONFIG } from './config/gameConfig';
import { HajikeScene } from './scenes/HajikeScene';

type GameAction = 'pause-toggle' | 'restart' | 'resume';
type QueueDetail = { queue: number[] };
type ScoreDetail = { score: number; best: number };
type PowerDetail = { ratio: number };
type InputDetail = { enabled: boolean };
type StatusDetail = { state: string };
type ComboDetail = { count: number; multiplier: number };
type BumperHitDetail = { count: number; points: number; impactSpeed: number };
type DangerDetail = { active: boolean; progress: number };
type GameOverDetail = { score: number; best: number; isNewBest: boolean };

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing UI element: ${selector}`);
  return element;
};

const formatNumber = (value: number): string => new Intl.NumberFormat('ja-JP').format(value);

const scoreValue = $('#score-value');
const bestValue = $('#best-value');
const nextList = $('#next-list');
const powerFill = $('#power-fill');
const launchButton = $('#launch-button') as HTMLButtonElement;
const launchHint = $('#launch-hint');
const pauseButton = $('#pause-button') as HTMLButtonElement;
const dangerLine = $('#danger-line');
const dangerProgress = $('#danger-progress');
const comboToast = $('#combo-toast');
const eventToast = $('#event-toast');
const overlay = $('#overlay');
const overlayKicker = $('#overlay-kicker');
const overlayTitle = $('#overlay-title');
const overlayMessage = $('#overlay-message');
const overlayScore = $('#overlay-score');
const overlayAction = $('#overlay-action');

let isOverlayGameOver = false;
let comboToastTimer: number | undefined;
let eventToastTimer: number | undefined;
let isPointerDown = false;

const dispatchAction = (action: GameAction): void => {
  window.dispatchEvent(new CustomEvent<{ action: GameAction }>('hajike:action', { detail: { action } }));
};

const updateNext = ({ queue }: QueueDetail): void => {
  nextList.replaceChildren(
    ...queue.slice(0, 3).map((level, index) => {
      const item = document.createElement('div');
      item.className = `next-ball ${index === 0 ? 'next-ball-primary' : ''}`;
      item.style.setProperty('--ball-color', BALL_COLORS_CSS[level] ?? BALL_COLORS_CSS[1]);
      item.innerHTML = `<span>${level}</span>`;
      item.setAttribute('aria-label', `繝ｬ繝吶Ν${level}`);
      return item;
    }),
  );
};

const updatePower = ({ ratio }: PowerDetail): void => {
  const clamped = Math.min(Math.max(ratio, 0), 1);
  powerFill.style.transform = `scaleX(${clamped})`;
  launchButton.style.setProperty('--charge-ratio', String(clamped));
};

const showCombo = ({ count, multiplier }: ComboDetail): void => {
  if (count < 2) return;
  comboToast.textContent = `COMBO ${count}  ﾃ・{multiplier.toFixed(2)}`;
  comboToast.classList.add('visible');
  if (comboToastTimer !== undefined) window.clearTimeout(comboToastTimer);
  comboToastTimer = window.setTimeout(() => comboToast.classList.remove('visible'), 1_200);
};

const showEvent = (message: string, duration = 1_600): void => {
  eventToast.textContent = message;
  eventToast.classList.add('visible');
  if (eventToastTimer !== undefined) window.clearTimeout(eventToastTimer);
  eventToastTimer = window.setTimeout(() => eventToast.classList.remove('visible'), duration);
};

const updateOverlay = (visible: boolean): void => {
  overlay.classList.toggle('hidden', !visible);
};

const setOverlayPaused = (): void => {
  isOverlayGameOver = false;
  overlayKicker.textContent = 'PAUSED';
  overlayTitle.textContent = '荳譎ょ●豁｢荳ｭ';
  overlayMessage.textContent = '繧ｲ繝ｼ繝繧貞・髢九〒縺阪∪縺吶・;
  overlayScore.classList.add('hidden');
  overlayAction.textContent = '蜀埼幕';
  updateOverlay(true);
};

const setOverlayGameOver = ({ score, best, isNewBest }: GameOverDetail): void => {
  isOverlayGameOver = true;
  overlayKicker.textContent = isNewBest ? 'NEW BEST!' : 'GAME OVER';
  overlayTitle.textContent = '繧ｲ繝ｼ繝繧ｪ繝ｼ繝舌・';
  overlayMessage.textContent = isNewBest ? '譁ｰ縺励＞繝吶せ繝医せ繧ｳ繧｢縺ｧ縺呻ｼ・ : '繝輔ぅ繝ｼ繝ｫ繝峨′縺・▲縺ｱ縺・↓縺ｪ繧翫∪縺励◆縲・;
  overlayScore.textContent = `SCORE  ${formatNumber(score)}  ・・ BEST  ${formatNumber(best)}`;
  overlayScore.classList.remove('hidden');
  overlayAction.textContent = '繧ゅ≧荳蠎ｦ';
  updateOverlay(true);
};

window.addEventListener('hajike:queue', (event: Event) => updateNext((event as CustomEvent<QueueDetail>).detail));
window.addEventListener('hajike:score', (event: Event) => {
  const { score, best } = (event as CustomEvent<ScoreDetail>).detail;
  scoreValue.textContent = formatNumber(score);
  bestValue.textContent = formatNumber(best);
});
window.addEventListener('hajike:power', (event: Event) => updatePower((event as CustomEvent<PowerDetail>).detail));
window.addEventListener('hajike:input', (event: Event) => {
  const { enabled } = (event as CustomEvent<InputDetail>).detail;
  launchButton.disabled = !enabled;
  launchButton.classList.toggle('disabled', !enabled);
});
window.addEventListener('hajike:status', (event: Event) => {
  const { state } = (event as CustomEvent<StatusDetail>).detail;
  launchHint.textContent = state === 'Charging' ? 'CHARGING' : state.toUpperCase();
  launchButton.classList.toggle('charging', state === 'Charging');
  if (state === 'Paused') setOverlayPaused();
  if (state !== 'Paused' && state !== 'GameOver') updateOverlay(false);
});
window.addEventListener('hajike:combo', (event: Event) => showCombo((event as CustomEvent<ComboDetail>).detail));
window.addEventListener('hajike:bumper-hit', (event: Event) => {
  const { count, points } = (event as CustomEvent<BumperHitDetail>).detail;
  showEvent(`BUMPER x${count}  +${formatNumber(points)}`, 900);
});
window.addEventListener('hajike:danger', (event: Event) => {
  const { active, progress } = (event as CustomEvent<DangerDetail>).detail;
  dangerLine.classList.toggle('warning', active);
  dangerProgress.style.transform = `scaleX(${progress})`;
});
window.addEventListener('hajike:game-over', (event: Event) => setOverlayGameOver((event as CustomEvent<GameOverDetail>).detail));
window.addEventListener('hajike:effect', (event: Event) => {
  const detail = (event as CustomEvent<{ message: string }>).detail;
  showEvent(detail.message);
});

const beginCharge = (event: PointerEvent): void => {
  if (isPointerDown || launchButton.disabled) return;
  event.preventDefault();
  isPointerDown = true;
  launchButton.setPointerCapture?.(event.pointerId);
  window.dispatchEvent(new CustomEvent('hajike:charge-start'));
};

const endCharge = (event: PointerEvent): void => {
  if (!isPointerDown) return;
  event.preventDefault();
  isPointerDown = false;
  window.dispatchEvent(new CustomEvent('hajike:charge-end'));
};

launchButton.addEventListener('pointerdown', beginCharge);
launchButton.addEventListener('pointerup', endCharge);
launchButton.addEventListener('pointercancel', endCharge);
launchButton.addEventListener('lostpointercapture', () => {
  if (isPointerDown) {
    isPointerDown = false;
    window.dispatchEvent(new CustomEvent('hajike:charge-end'));
  }
});

pauseButton.addEventListener('click', () => dispatchAction('pause-toggle'));
overlayAction.addEventListener('click', () => dispatchAction(isOverlayGameOver ? 'restart' : 'resume'));

window.addEventListener('hajike:charge-cancelled', () => {
  isPointerDown = false;
  updatePower({ ratio: 0 });
});

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-canvas',
  width: 720,
  height: 1280,
  transparent: true,
  render: {
    antialias: true,
    pixelArt: false,
    roundPixels: true,
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 720,
    height: 1280,
  },
  physics: {
    default: 'matter',
    matter: {
      gravity: { y: GAME_CONFIG.gravityY, x: 0 },
      enableSleeping: true,
      positionIterations: 8,
      velocityIterations: 6,
      constraintIterations: 2,
      debug: false,
    },
  },
  scene: [HajikeScene],
});

window.addEventListener('beforeunload', () => game.destroy(true));

