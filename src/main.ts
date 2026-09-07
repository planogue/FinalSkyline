import './style.css';
import { AA, MATCH, MISSILES, WORLD } from './core/config';
import { audio } from './core/audio';
import { defaultMeta, loadMeta, saveMeta } from './core/storage';
import type { PanelId } from './core/types';
import { stepMatch } from './game/engine';
import {
  aaRadius,
  buildingPlacementAt,
  buyAaRadius,
  buyBattery,
  buyBuilding,
  canDeployAt,
  createMatch,
  createOnlineMatch,
  deployZone,
  hasRadar,
  pinTarget,
  shotsRemaining,
  unpinLast,
  type Match,
} from './game/state';
import { applyRemoteAction, type OnlineAction } from './online/actions';
import { applyCitySnapshot, captureCity } from './online/snapshot';
import { initialOnlineState, OnlineService, type OnlineMatchTicket } from './online/service';
import { Camera } from './render/camera';
import { drawScene } from './render/scene';
import { GameUI, PANEL_KEYS, type UiHost, type UiState } from './ui/game-ui';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: false })!;
const uiRoot = document.getElementById('ui') as HTMLElement;

const meta = loadMeta();
let onlineMatchMeta = defaultMeta();
audio.setMuted(meta.muted);
const online = initialOnlineState();

const ui: UiState = {
  panel: 'none',
  selectedTier: 1,
  ammoMult: 1,
  showRings: false,
  aimX: null,
  difficulty: 'easy',
  duration: Infinity,
  placing: null,
  placeX: null,
};

const camera = new Camera();

/** Default framing: the front half of your own city, where the first blocks go up. */
const HOME_VIEW_X = WORLD.cityRight.x0 + 400;
const ENEMY_VIEW_X = WORLD.cityLeft.x1 - 400;

let gameUI: GameUI;
let onlineService: OnlineService;
let onlineResultReported = false;

function enterMatch(match: Match): void {
  host.match = match;
  host.screen = 'game';
  ui.panel = 'none';
  ui.selectedTier = 1;
  ui.aimX = null;
  ui.placing = null;
  ui.placeX = null;
  onlineResultReported = false;
  stepAcc = 0;
  sinceCitySync = 0;
  camera.setMode('city');
  camera.snapTo(HOME_VIEW_X);
}

const host: UiHost = {
  ui,
  meta,
  online,
  match: null,
  screen: 'menu',
  matchMeta() {
    return host.match?.mode === 'online' ? onlineMatchMeta : meta;
  },
  setPanel(panel: PanelId) {
    ui.panel = panel;
    ui.placing = null;
    ui.placeX = null;
    camera.manual = false;
    if (panel === 'icbm') {
      camera.setMode('city');
      camera.focus(ENEMY_VIEW_X);
      ui.showRings = false;
    } else {
      ui.aimX = null;
      camera.focus(HOME_VIEW_X);
      if (panel === 'antiair' || panel === 'abm') ui.showRings = true;
    }
  },
  startMatch() {
    enterMatch(createMatch(ui.difficulty, ui.duration));
  },
  async findOnlineMatch() {
    await onlineService.joinQueue(ui.duration);
  },
  async cancelOnlineQueue() {
    await onlineService.cancelQueue();
  },
  async signUp(username: string, email: string, password: string) {
    await onlineService.signUp(username, email, password);
  },
  async signIn(email: string, password: string) {
    await onlineService.signIn(email, password);
  },
  async addFriend(username: string) {
    await onlineService.addFriend(username);
  },
  async respondFriend(userId: string, accept: boolean) {
    await onlineService.respondFriend(userId, accept);
  },
  async removeFriend(userId: string) {
    await onlineService.removeFriend(userId);
  },
  async sendInvite(userId: string) {
    // Invitations use whatever match length is selected on the menu.
    await onlineService.sendInvite(userId, ui.duration);
  },
  async cancelInvite(inviteId: string) {
    await onlineService.cancelInvite(inviteId);
  },
  async respondInvite(inviteId: string, accept: boolean) {
    await onlineService.respondInvite(inviteId, accept);
  },
  async signOut() {
    await onlineService.signOut();
  },
  sendOnlineAction(action: OnlineAction) {
    if (host.match?.mode === 'online') void onlineService.sendAction(action);
  },
  saveProgress() {
    saveMeta(meta);
    void onlineService.syncProgress(meta);
  },
  quitToMenu() {
    if (host.match?.mode === 'online') {
      if (host.match.phase !== 'over' && !onlineResultReported) {
        onlineResultReported = true;
        // Walking out mid-match is a result for the other player too. Tell them
        // before reporting, or they are left fighting a city that has stopped
        // shooting back and never finishing.
        host.sendOnlineAction({ type: 'match-over', won: false, cause: 'resign' });
        meta.losses++;
        meta.stars += 1;
        saveMeta(meta);
        void onlineService.reportResult(false, 1);
      } else {
        void onlineService.disconnectMatch();
      }
    }
    host.match = null;
    host.screen = 'menu';
    ui.panel = 'none';
    saveMeta(meta);
  },
  setPaused(paused: boolean) {
    const m = host.match;
    if (!m || m.phase === 'over' || m.mode === 'online') return;
    m.phase = paused ? 'paused' : 'playing';
  },
  toggleZoom() {
    camera.manual = false;
    camera.setMode(camera.mode === 'city' ? 'wide' : 'city');
    if (camera.mode === 'city') {
      camera.focus(
        ui.panel === 'icbm'
          ? ENEMY_VIEW_X
          : HOME_VIEW_X,
      );
    }
  },
  openShop() {
    host.screen = 'shop';
  },
  closeShop() {
    host.screen = host.match && host.match.phase !== 'over' ? 'game' : 'menu';
    saveMeta(meta);
    void onlineService.syncProgress(meta);
  },
};

gameUI = new GameUI(uiRoot, host);
onlineService = new OnlineService(online, meta, {
  changed() {
    saveMeta(meta);
    gameUI.refreshOverlay();
  },
  matched(ticket: OnlineMatchTicket) {
    onlineMatchMeta = defaultMeta();
    const elapsed = Math.max(0, (Date.now() - Date.parse(ticket.startedAt)) / 1000);
    enterMatch(createOnlineMatch(ticket.opponentUsername, ticket.durationSeconds, elapsed));
  },
  action(action) {
    const match = host.match;
    if (!match || match.mode !== 'online' || match.phase !== 'playing') return;
    if (!applyRemoteAction(match, onlineMatchMeta, action)) {
      console.warn('Ignored out-of-sync online action', action);
    }
  },
  snapshot(city) {
    const match = host.match;
    if (!match || match.mode !== 'online' || match.phase !== 'playing') return;
    // Their account of their own city beats whatever this browser worked out.
    applyCitySnapshot(match.enemy, city);
  },
});
void onlineService.init();

// ---------------------------------------------------------------------------
// Canvas sizing
// ---------------------------------------------------------------------------

function resize(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dock = uiRoot.querySelector('.dock') as HTMLElement | null;
  const dockH = dock && host.screen === 'game' ? dock.offsetHeight + 26 : Math.max(150, h * 0.24);
  // Portrait screens have far too much sky, so the horizon is pulled down the page.
  const inset = h > w ? Math.max(dockH, h * 0.16) : dockH;
  camera.resize(w, h, Math.min(h * 0.5, inset));
}

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => window.setTimeout(resize, 120));

// ---------------------------------------------------------------------------
// Pointer input: drag to pan, tap to pin a target
// ---------------------------------------------------------------------------

let dragging = false;
let dragMoved = 0;
let lastX = 0;

/**
 * Where the target cursor was last put, and by what. Aiming with T and the
 * arrow keys used to be thrown away the moment the pointer wandered off the
 * canvas — on the way to the Fight button, say — because the hover cursor and
 * the keyboard cursor were the same field. The pointer may only clear its own.
 */
let aimSource: 'pointer' | 'keyboard' = 'pointer';
let lastAimX = ENEMY_VIEW_X;

function setAim(x: number, source: 'pointer' | 'keyboard'): void {
  aimSource = source;
  ui.aimX = x;
  lastAimX = x;
}

function aimable(): boolean {
  return (
    host.screen === 'game' &&
    !!host.match &&
    host.match.phase === 'playing' &&
    ui.panel === 'icbm' &&
    ui.placing === null
  );
}

function placing(): boolean {
  return host.screen === 'game' && !!host.match && host.match.phase === 'playing' && ui.placing !== null;
}

function clampTargetX(x: number): number {
  return Math.max(WORLD.cityLeft.x0 - 200, Math.min(WORLD.cityLeft.x1 + 200, x));
}

canvas.addEventListener('pointerdown', (e) => {
  audio.init();
  dragging = true;
  dragMoved = 0;
  lastX = e.clientX;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (placing()) ui.placeX = camera.toWorldX(e.clientX);
  if (aimable()) setAim(clampTargetX(camera.toWorldX(e.clientX)), 'pointer');
  if (!dragging) return;
  const dx = e.clientX - lastX;
  lastX = e.clientX;
  dragMoved += Math.abs(dx);
  if (dragMoved > 6) camera.panBy(dx);
});

canvas.addEventListener('pointerup', (e) => {
  if (dragging && dragMoved <= 6) handleTap(e.clientX);
  dragging = false;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
});

canvas.addEventListener('pointercancel', () => {
  dragging = false;
});

canvas.addEventListener('pointerleave', () => {
  // Only the hover cursor goes; a mark placed with the keyboard stays put.
  if (aimSource === 'pointer') ui.aimX = null;
});

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    camera.zoomBy(e.deltaY > 0 ? 1.12 : 1 / 1.12);
  },
  { passive: false },
);

function handleTap(clientX: number): void {
  handleWorldAction(camera.toWorldX(clientX));
}

/**
 * @param quiet suppresses the refusal sound and toast. Set while a held Enter
 *              is repeating: the first refusal is worth hearing, the twentieth
 *              in the same second is not.
 */
function handleWorldAction(worldX: number, quiet = false): void {
  const match = host.match;
  if (!match) return;
  const refuse = (message: string): void => {
    if (quiet) return;
    audio.deny();
    gameUI.toast(message);
  };

  // Siting a new anti-air battery on your own land.
  if (placing() && ui.placing !== null) {
    ui.placeX = worldX;
    const zone = ui.placing.kind === 'building' ? WORLD.cityRight : deployZone('player');
    buildCursor = Math.max(zone.x0, Math.min(zone.x1, worldX));
    const placement = ui.placing;
    if (placement.kind === 'building') {
      const slot = buildingPlacementAt(match.player, placement.type, worldX);
      if (!slot) {
        refuse('Choose a free plot on your land');
        return;
      }
      if (buyBuilding(match, match.player, placement.type, slot.x)) {
        host.sendOnlineAction({ type: 'build-building', buildingType: placement.type, x: slot.x });
        audio.build();
        ui.placing = null;
        ui.placeX = null;
      } else {
        refuse('Not enough cash or build limit reached');
      }
    } else {
      const type = placement.type;
      if (!canDeployAt(match.player, worldX, type)) {
        const zone = deployZone('player');
        refuse(
          worldX < zone.x0 || worldX > zone.x1
            ? 'That is not your land'
            : 'Choose a position on your land',
        );
        return;
      }
      if (buyBattery(match.player, type, worldX)) {
        host.sendOnlineAction({ type: 'build-battery', batteryType: type, x: worldX });
        audio.build();
        ui.placing = null;
        ui.placeX = null;
      } else {
        refuse('Not enough cash');
      }
    }
    return;
  }

  if (!aimable()) return;
  const shot = pinTarget(match.player, ui.selectedTier, clampTargetX(worldX));
  if (shot) {
    host.sendOnlineAction({ type: 'pin-target', tier: ui.selectedTier, x: shot.x });
    lastAimX = shot.x;
    audio.pin();
    return;
  }
  // Say exactly which of the three reasons stopped the shot.
  const def = MISSILES[ui.selectedTier - 1];
  if (!match.player.missileUnlocked[ui.selectedTier - 1]) {
    refuse(`${def.name} is locked — unlock it in Upgrades ($${def.unlockCost})`);
  } else if (shotsRemaining(match.player, ui.selectedTier) <= 0) {
    refuse(`No ${def.name} rounds left this match`);
  } else {
    refuse(`${def.name} costs $${def.cost} — you have $${Math.floor(match.player.money)}`);
  }
}

/**
 * Holding Enter keeps dropping marks. The browser's auto-repeat fires far
 * faster than anyone means to spend money, so repeats are paced; a fresh press
 * always goes straight through.
 */
const MARK_REPEAT_MS = 110;
let lastRepeatMark = 0;

function repeatMarkReady(): boolean {
  const now = performance.now();
  if (now - lastRepeatMark < MARK_REPEAT_MS) return false;
  lastRepeatMark = now;
  return true;
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

let buildCursor = WORLD.cityRight.x0 + 15;

function focusCursor(x: number): void {
  camera.focus(x);
  camera.manual = true;
}

function prepareCursor(): void {
  if (ui.placing) {
    ui.placeX ??= buildCursor;
    focusCursor(ui.placeX);
    // Enter now places the selected item instead of re-clicking its card.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }
}

uiRoot.addEventListener('click', prepareCursor);

window.addEventListener('keydown', (e) => {
  const target = e.target;
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey ||
    (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select')))) return;
  const key = e.key.toLowerCase();
  // Never spend cash or launch repeatedly because a key is held down — except
  // Enter while aiming, where holding it down to walk a line of marks across a
  // city is the whole point. That path is paced below.
  if (e.repeat && !key.startsWith('arrow') && !(key === 'enter' && aimable())) {
    if (key !== 'tab') e.preventDefault();
    return;
  }
  const match = host.match;
  if (key === 'escape') {
    e.preventDefault();
    if (ui.placing !== null) {
      ui.placing = null;
      ui.placeX = null;
      return;
    }
    if (host.screen === 'shop') host.closeShop();
    else if (match && match.phase === 'playing' && ui.panel !== 'none') host.setPanel('none');
    else if (match && match.phase === 'playing') host.setPaused(true);
    else if (match && match.phase === 'paused') host.setPaused(false);
    return;
  }
  audio.init();
  if (gameUI.handleKey(e)) {
    e.preventDefault();
    prepareCursor();
    return;
  }
  if (host.screen !== 'game' || !match || match.phase !== 'playing') return;
  // Upgrades are a keyboard-navigable modal; battlefield actions stay blocked.
  if (ui.panel === 'upgrades') return;
  // A focused button normally keeps Enter for itself, which is right in a menu.
  // On the battlefield it meant that picking a missile with the mouse left the
  // card holding Enter, so the next press re-selected the card instead of
  // marking a target. While there is a cursor on the map, Enter is the map's.
  if (key === 'enter' && document.activeElement?.matches('button, summary') && !placing() && !aimable()) return;
  const panel = (Object.entries(PANEL_KEYS) as [PanelId, string][]).find(([, value]) => value === key)?.[0];
  if (panel) {
    e.preventDefault();
    host.setPanel(panel);
    if (panel === 'icbm') {
      setAim(clampTargetX(lastAimX), 'keyboard');
      focusCursor(lastAimX);
    }
    return;
  }
  if (key === 't') {
    e.preventDefault();
    if (ui.panel !== 'icbm') host.setPanel('icbm');
    setAim(clampTargetX(ui.aimX ?? lastAimX), 'keyboard');
    focusCursor(ui.aimX!);
    // Enter must pin the target, not re-press whatever card was last clicked.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return;
  }
  if (key.startsWith('arrow')) {
    e.preventDefault();
    const direction = key === 'arrowleft' || key === 'arrowdown' ? -1 : 1;
    const step = e.shiftKey ? 2 : (key === 'arrowup' || key === 'arrowdown') ? 150 : 30;
    if (ui.placing) {
      const zone = ui.placing.kind === 'building' ? WORLD.cityRight : deployZone('player');
      buildCursor = Math.max(zone.x0, Math.min(zone.x1, (ui.placeX ?? buildCursor) + direction * step));
      ui.placeX = buildCursor;
      focusCursor(buildCursor);
    } else if (aimable()) {
      setAim(clampTargetX((ui.aimX ?? lastAimX) + direction * step), 'keyboard');
      focusCursor(ui.aimX!);
    } else {
      camera.panBy(-direction * step * camera.scale);
    }
    return;
  }
  if (key === '+' || key === '=' || key === '-') {
    e.preventDefault();
    camera.zoomBy(key === '-' ? 1.12 : 1 / 1.12);
    return;
  }
  if (key === 'enter' && (placing() || aimable())) {
    e.preventDefault();
    if (e.repeat && !repeatMarkReady()) return;
    lastRepeatMark = performance.now();
    handleWorldAction(ui.placing ? (ui.placeX ?? buildCursor) : (ui.aimX ?? lastAimX), e.repeat);
    return;
  }
  if (key === ' ' || key === 'f') {
    e.preventDefault();
    if (ui.panel !== 'icbm') host.setPanel('icbm');
    gameUI.sync();
    (uiRoot.querySelector('.fightbtn') as HTMLButtonElement | null)?.click();
    return;
  }
  if (key === 'z' && ui.panel === 'icbm') {
    e.preventDefault();
    if (unpinLast(match.player)) {
      host.sendOnlineAction({ type: 'unpin-target' });
      audio.click();
    }
  }
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let last = performance.now();
let lastDockH = 0;
let overSaved = false;

/**
 * Debug handle for playtesting: `__finalSkyline.speed = 8` in the console fast-forwards
 * the clock so the 7-minute build-limit steps and the day/night cycle can be
 * checked without waiting them out.
 */
const debug = {
  speed: 1,
  /** Snapshot used by the automated checks and handy when playtesting. */
  debugState() {
    const m = host.match;
    if (!m) return null;
    return {
      time: Math.round(m.time),
      duration: m.duration,
      money: Math.round(m.player.money),
      phase: m.phase,
      panel: ui.panel,
      selectedTier: ui.selectedTier,
      placing: ui.placing,
      placeX: ui.placeX,
      aimX: ui.aimX,
      queued: m.player.queued.length,
      pending: m.player.pending.length,
      launched: m.player.stats.launched,
      enemyLaunched: m.enemy.stats.launched,
      buildingXs: m.player.buildings.filter((b) => !b.destroyed).map((b) => Math.round(b.x)),
      batteries: m.player.batteries.length,
      batteryXs: m.player.batteries.map((b) => Math.round(b.x)),
      batteryHp: m.player.batteries.map((b) => Math.round(b.hp)),
      enemyBuildings: m.enemy.buildings.filter((b) => !b.destroyed).length,
    };
  },
  /** How the price of a repeatable in-match upgrade climbs, for sanity checks. */
  probeUpgradePrices(buys = 12) {
    const m = host.match;
    if (!m) return null;
    const out: number[] = [];
    const before = m.player.money;
    m.player.money = 1e9;
    for (let i = 0; i < buys; i++) {
      out.push(m.player.aaRadiusPrice[0]);
      buyAaRadius(m.player, 0);
    }
    // Undo the probe so it cannot be used to cheat.
    m.player.aaRadiusPrice[0] = out[0];
    m.player.aaRadiusBonus[0] -= AA[0].radiusStep * buys;
    m.player.money = before;
    return out;
  },
  /** Playtesting helper: flatten your own city, to watch the losing countdown. */
  levelCity() {
    const m = host.match;
    if (!m) return null;
    for (const b of m.player.buildings) {
      if (b.destroyed) continue;
      b.hp = 0;
      b.destroyed = true;
      b.collapse = 0;
    }
    return m.player.buildings.length;
  },
  /** Playtesting helper: knock the enemy city down to a given health fraction. */
  damageEnemy(fraction = 0.4) {
    const m = host.match;
    if (!m) return null;
    for (const b of m.enemy.buildings) {
      if (b.destroyed) continue;
      b.hp = Math.max(1, b.maxHp * fraction * (0.4 + Math.random() * 1.2));
      if (b.hp > b.maxHp) b.hp = b.maxHp;
    }
    return m.enemy.buildings.length;
  },
  /**
   * Audition a detonation without waiting for the ceasefire — the blast scales
   * with the tier and changes character with what it went off against.
   * `__finalSkyline.testExplosion(6, 'building')`
   */
  testExplosion(tier = 6, surface: 'building' | 'antiair' | 'ground' = 'ground', pan = 0) {
    audio.init();
    audio.explosion(tier, surface, pan);
    return { tier, surface };
  },
  /**
   * The live online state, so the friends panel can be dressed with fixture
   * data and inspected without two signed-in accounts:
   * `Object.assign(__finalSkyline.online(), { friends: [...] });
   *  __finalSkyline.refreshOverlay()`
   */
  online() {
    return online;
  },
  /**
   * Audition the combat sounds without waiting for a battle:
   * `__finalSkyline.testSound('launch', 6)`
   */
  testSound(which: 'launch' | 'interceptorLaunch' | 'intercept', tier = 1, pan = 0) {
    audio.init();
    if (which === 'launch') audio.launch(tier, pan);
    else if (which === 'interceptorLaunch') audio.interceptorLaunch(pan);
    else audio.intercept(pan);
    return which;
  },
  /** Top up the war chest, for playtesting the late-tier weapons. */
  grant(amount = 5000) {
    const m = host.match;
    if (!m) return null;
    m.player.money += amount;
    return Math.round(m.player.money);
  },
  /** Jump the clock past the opening ceasefire, for playtesting the shooting. */
  skipCeasefire() {
    const m = host.match;
    if (!m) return null;
    m.time = Math.max(m.time, MATCH.peaceSeconds + 0.5);
    return Math.round(m.time);
  },
  missileTable() {
    return MISSILES.map((d) => ({ tier: d.roman, cost: d.cost, speed: d.speed, dmg: d.damage, reload: d.reload }));
  },
  /**
   * The rebuild request the online service fires on every state change.
   * Calling it while a match runs used to leave the main menu painted over the
   * battlefield, so it is worth being able to reproduce from the console.
   */
  refreshOverlay() {
    gameUI.refreshOverlay();
    return true;
  },
  /** What the overlay is currently showing, if anything. */
  overlayState() {
    const node = uiRoot.querySelector('.overlay') as HTMLElement | null;
    if (!node) return null;
    return { display: node.style.display, children: node.children.length, screen: host.screen };
  },
};
(window as unknown as { __finalSkyline: typeof debug }).__finalSkyline = debug;

/** Left-over time not yet handed to the simulation, in seconds. */
let stepAcc = 0;
/** Seconds since this player last told the opponent what their city looks like. */
let sinceCitySync = 0;

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000) * Math.max(0.1, Math.min(20, debug.speed));
  last = now;

  const match = host.match;
  if (match && host.screen === 'game' && match.phase === 'playing') {
    // Always in steps of exactly MATCH.stepSeconds, however fast this machine
    // paints. Stepping by the frame time instead meant a 60Hz laptop and a
    // 144Hz desktop sampled every flight and every interception differently,
    // and their two copies of the battle drifted apart from the first salvo.
    stepAcc += dt;
    // This frame's own share of time, plus a small budget to make up a short
    // stall. Anything past that is dropped rather than sprinted through, so a
    // stutter cannot snowball into the browser chasing its own tail.
    const budget = Math.ceil(dt / MATCH.stepSeconds) + MATCH.maxStepsPerFrame;
    let steps = 0;
    while (stepAcc >= MATCH.stepSeconds && steps < budget) {
      stepMatch(match, MATCH.stepSeconds, host.matchMeta());
      stepAcc -= MATCH.stepSeconds;
      steps++;
    }
    if (steps >= budget) stepAcc = 0;

    if (match.mode === 'online' && match.phase === 'playing') {
      sinceCitySync += dt;
      if (sinceCitySync >= MATCH.citySyncSeconds) {
        sinceCitySync = 0;
        onlineService.sendSnapshot(captureCity(match.player));
      }
    }
  }
  if (match?.result) {
    if (!overSaved) {
      overSaved = true;
      if (match.mode === 'online') {
        if (!onlineResultReported) {
          onlineResultReported = true;
          // Both browsers run the whole battle, so neither can assume the other
          // reached the same conclusion at the same moment. Say so out loud.
          // A ruling that arrived from the opponent needs no echo.
          if (!match.result.fromOpponent) {
            host.sendOnlineAction({
              type: 'match-over',
              won: match.result.won,
              cause: isFinite(match.duration) && match.time >= match.duration ? 'time' : 'wipeout',
            });
          }
          meta.stars += match.result.stars;
          if (match.result.won) meta.wins++;
          else meta.losses++;
          saveMeta(meta);
          void onlineService.reportResult(match.result.won, match.result.stars);
        }
      } else {
        host.saveProgress();
      }
    }
  } else {
    overSaved = false;
  }

  // Keep the view on whatever city the player is looking at as it grows.
  if (match && host.screen === 'game') {
    const watching = ui.panel === 'icbm' ? match.enemy : match.player;
    const alive = watching.buildings.filter((b) => !b.destroyed);
    const fallback = ui.panel === 'icbm' ? ENEMY_VIEW_X : HOME_VIEW_X;
    const centre = alive.length ? alive.reduce((a, b) => a + b.x, 0) / alive.length : fallback;
    camera.follow(centre);
  }

  camera.update(dt);
  ctx.save();
  drawScene(ctx, match ?? idleMatch(), camera, {
    showRings: ui.showRings || ui.panel === 'antiair' || ui.panel === 'abm',
    aiming: ui.panel === 'icbm',
    aimTier: ui.selectedTier,
    aimX: ui.panel === 'icbm' ? ui.aimX : null,
    meta: host.matchMeta(),
    hasRadar: match ? hasRadar(match.player) : true,
    radarIntel: match ? match.player.radarIntel : true,
    deploy:
      match && ui.placing?.kind === 'battery'
        ? {
            type: ui.placing.type,
            x: ui.placeX,
            valid: ui.placeX !== null && canDeployAt(match.player, ui.placeX, ui.placing.type),
            radius: aaRadius(match.player, ui.placing.type, host.matchMeta()),
          }
        : null,
    buildingDeploy:
      match && ui.placing?.kind === 'building' && ui.placeX !== null
        ? (() => {
            const slot = buildingPlacementAt(match.player, ui.placing.type, ui.placeX!);
            return {
              type: ui.placing.type,
              x: slot?.x ?? ui.placeX!,
              layer: slot?.layer ?? 1,
              valid: slot !== null,
            };
          })()
        : null,
  });
  ctx.restore();

  gameUI.sync();

  // The dock changes height between panels; keep the ground line clear of it.
  const dock = uiRoot.querySelector('.dock') as HTMLElement | null;
  const h = dock && host.screen === 'game' ? dock.offsetHeight : 0;
  if (h !== lastDockH) {
    lastDockH = h;
    resize();
  }

  requestAnimationFrame(frame);
}

/** A frozen, decorative battlefield used as the menu backdrop. */
let idle: Match | null = null;
function idleMatch(): Match {
  if (!idle) {
    idle = createMatch('easy', MATCH.durationSeconds);
    idle.phase = 'paused';
    idle.time = MATCH.durationSeconds * 0.17; // late afternoon
    for (const side of [idle.player, idle.enemy]) {
      side.money = 100000;
      for (const [type, n] of [[0, 5], [1, 4], [2, 4], [3, 3], [4, 3], [5, 2], [6, 2], [7, 1], [8, 1]] as const) {
        for (let i = 0; i < n; i++) buyBuilding(idle, side, type);
      }
      for (const type of [0, 1, 3]) buyBattery(side, type);
      side.money = MATCH.startingMoney;
    }
  }
  return idle;
}

resize();
window.setTimeout(resize, 60);
requestAnimationFrame(frame);

window.addEventListener('beforeunload', () => saveMeta(meta));
