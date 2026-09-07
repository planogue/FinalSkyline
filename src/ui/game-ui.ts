import {
  AA,
  AA_MAX_PER_TYPE,
  BUILDINGS,
  BOTS,
  MATCH,
  META,
  MISSILES,
  RADAR_INTEL_COST,
  canIntercept,
  onlineDuration,
  onlineDurationLabel,
  type Difficulty,
} from '../core/config';
import type { MetaSave, PanelId } from '../core/types';
import { audio } from '../core/audio';
import type { OnlineAction } from '../online/actions';
import type { MatchInvite, OnlineState } from '../online/service';
import {
  aaCost,
  aaRadius,
  aaReload,
  buildingLimit,
  buyAaRadius,
  buyAaReload,
  buyAmmo,
  buyMissileUpgrade,
  buyRadarIntel,
  canUnlockMissile,
  cityValue,
  clearQueue,
  countBuildings,
  commitQueue,
  incomePerTick,
  inPeace,
  missileReload,
  secondsToNextLimit,
  shotsRemaining,
  type Match,
} from '../game/state';
import { nightAmount } from '../render/scene';
import {
  ICON_ABM,
  ICON_BACK,
  ICON_CITY,
  ICON_CLOCK,
  ICON_ICBM,
  ICON_PAUSE,
  ICON_RADIUS,
  ICON_SOUND_OFF,
  ICON_SOUND_ON,
  ICON_STAR,
  ICON_UPGRADE,
  ICON_ZOOM,
  aaIcon,
  abmIcon,
  buildingIcon,
  missileIcon,
} from './icons';

/** Row shortcut keys on the in-match Upgrades screen, in display order. */
const UPGRADE_ROW_KEYS = ['r', 'd', 'm', 'e'];

export interface UiState {
  panel: PanelId;
  selectedTier: number;
  ammoMult: 1 | 5 | 10;
  showRings: boolean;
  aimX: number | null;
  difficulty: Difficulty;
  /** Infinity for an unlimited match. */
  duration: number;
  /** Item awaiting a tap on the player's land, or null. */
  placing: { kind: 'building' | 'battery'; type: number } | null;
  /** World x under the cursor while placing. */
  placeX: number | null;
}

export interface UiHost {
  ui: UiState;
  meta: MetaSave;
  match: Match | null;
  online: OnlineState;
  matchMeta(): MetaSave;
  setPanel(panel: PanelId): void;
  startMatch(): void;
  findOnlineMatch(): Promise<void>;
  cancelOnlineQueue(): Promise<void>;
  signUp(username: string, email: string, password: string): Promise<void>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  addFriend(username: string): Promise<void>;
  respondFriend(userId: string, accept: boolean): Promise<void>;
  removeFriend(userId: string): Promise<void>;
  sendInvite(userId: string): Promise<void>;
  cancelInvite(inviteId: string): Promise<void>;
  respondInvite(inviteId: string, accept: boolean): Promise<void>;
  sendOnlineAction(action: OnlineAction): void;
  saveProgress(): void;
  quitToMenu(): void;
  setPaused(paused: boolean): void;
  toggleZoom(): void;
  openShop(): void;
  closeShop(): void;
  screen: 'menu' | 'shop' | 'game';
}

type CardUpdate = () => void;

export const PANEL_KEYS: Partial<Record<PanelId, string>> = {
  buildings: 'b', antiair: 'a', abm: 'r', icbm: 'i', upgrades: 'u',
};

function shortcut(node: HTMLElement, key: string, label = key.toUpperCase()): void {
  node.dataset.key = key;
  node.dataset.hint = label;
  node.setAttribute('aria-keyshortcuts', key === 'esc' ? 'Escape' : key);
    if (node.title) node.setAttribute('aria-label', node.title);
}

const money = (n: number): string => {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

const clock = (s: number): string => {
  const t = Math.max(0, Math.floor(s));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

/** What a battery is good for, from the battery's side of the question. */
function interceptsWhat(def: (typeof AA)[number]): string {
  const tiers = MISSILES.filter((m) => canIntercept(def, m.tier));
  if (!tiers.length) return 'spots incoming fire';
  return `intercepts ${tiers.map((m) => m.roman).join(' and ')} only`;
}

/** Plain-English summary of which systems can engage a missile tier. */
function interceptedBy(tier: number): string {
  const systems = AA.filter((def) => canIntercept(def, tier));
  if (!systems.length) return 'cannot be intercepted';
  return `stopped by ${systems.map((def) => `${def.name} ${def.roman}`).join(' or ')}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

export class GameUI {
  private root: HTMLElement;
  private host: UiHost;

  private topbar!: HTMLElement;
  private enemyMoney!: HTMLElement;
  private playerMoney!: HTMLElement;
  private enemyName!: HTMLElement;
  private timeEl!: HTMLElement;
  private redBar!: HTMLElement;
  private statusbar!: HTMLElement;
  private wipeoutEl!: HTMLElement;
  private dayIcon!: HTMLElement;
  private ringsBtn!: HTMLButtonElement;

  private dock!: HTMLElement;
  private dockScroll!: HTMLElement;
  private dockBack!: HTMLElement;
  private fightBtn!: HTMLButtonElement;
  private hintEl!: HTMLElement;
  private toastEl!: HTMLElement;
  private overlay!: HTMLElement;

  private cardUpdates: CardUpdate[] = [];
  private builtPanel: PanelId | null = null;
  private overlayKind: 'none' | 'menu' | 'shop' | 'pause' | 'result' | 'upgrades' = 'none';
  private toastTimer = 0;
  private showKeyboardHints = true;
  private upgradeRow = 2;
  private keyboardGuide!: HTMLElement;

  toggleKeyboardHints(): void {
    this.showKeyboardHints = !this.showKeyboardHints;
    this.root.classList.toggle('hide-keyboard-hints', !this.showKeyboardHints);
    try { localStorage.setItem('final-skyline:keyboard-hints', String(this.showKeyboardHints)); } catch { /* optional preference */ }
    this.root.querySelectorAll<HTMLButtonElement>('.hints-toggle').forEach((button) => {
      button.textContent = `Key hints: ${this.showKeyboardHints ? 'on' : 'off'}`;
      button.setAttribute('aria-pressed', String(this.showKeyboardHints));
    });
  }

  private hintsToggle(): HTMLButtonElement {
    const button = el('button', 'btn ghost hints-toggle', `Key hints: ${this.showKeyboardHints ? 'on' : 'off'}`);
    shortcut(button, 'h');
    button.setAttribute('aria-pressed', String(this.showKeyboardHints));
    button.addEventListener('click', () => this.toggleKeyboardHints());
    return button;
  }

  /** Activate the same buttons used by pointer input, scoped to the visible overlay. */
  handleKey(event: KeyboardEvent): boolean {
    this.sync();
    const key = event.key.toLowerCase();
    if (key === 'h') {
      this.toggleKeyboardHints();
      return true;
    }
    const overlayOpen = this.overlayKind !== 'none';
    const scope = overlayOpen ? this.overlay : this.root;
    if (key === 'tab' && overlayOpen) {
      const items = Array.from(scope.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary'))
        .filter((node) => node.getClientRects().length > 0);
      const first = items[0];
      const last = items[items.length - 1];
      if (first && (!scope.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last))) {
        (event.shiftKey ? last : first).focus();
        return true;
      }
    }
    // Enter/Space retain native activation for a focused button or summary.
    if ((key === 'enter' || key === ' ') && document.activeElement?.matches('button, summary')) return false;
    if (this.overlayKind === 'upgrades') {
      const row = UPGRADE_ROW_KEYS.indexOf(key);
      if (row >= 0) {
        this.upgradeRow = row;
        this.highlightUpgradeRow();
        return true;
      }
    }
    const buttons = Array.from(scope.querySelectorAll<HTMLButtonElement>('button[data-key]'));
    const button = buttons.find((node) => node.dataset.key === key && !node.disabled && node.getClientRects().length > 0 &&
      (this.overlayKind !== 'upgrades' || !node.closest('[data-upgrade-row]') || node.closest<HTMLElement>('[data-upgrade-row]')?.dataset.upgradeRow === String(this.upgradeRow)));
    if (!button) return false;
    button.click();
    button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  }

  private highlightUpgradeRow(): void {
    this.overlay.querySelectorAll<HTMLElement>('[data-upgrade-row]').forEach((row) => {
      row.classList.toggle('keyboard-row', Number(row.dataset.upgradeRow) === this.upgradeRow);
    });
  }

  constructor(root: HTMLElement, host: UiHost) {
    this.root = root;
    this.host = host;
    try { this.showKeyboardHints = localStorage.getItem('final-skyline:keyboard-hints') !== 'false'; } catch { /* optional preference */ }
    this.root.classList.toggle('hide-keyboard-hints', !this.showKeyboardHints);
    this.buildChrome();
  }

  // -------------------------------------------------------------- chrome

  private buildChrome(): void {
    this.root.innerHTML = '';

    // Top bar ------------------------------------------------------------
    this.topbar = el('div', 'topbar');
    const pause = el('button', 'iconbtn', ICON_PAUSE);
    pause.title = 'Pause';
    shortcut(pause, 'p');
    pause.addEventListener('click', () => {
      if (this.host.match?.mode === 'online') {
        audio.deny();
        this.toast('Online matches cannot be paused');
        return;
      }
      audio.click();
      this.host.setPaused(true);
    });

    const enemyPill = el('div', 'pill enemy');
    enemyPill.innerHTML = `<span class="coin">${ICON_STAR}</span><span></span>`;
    this.enemyMoney = enemyPill.lastElementChild as HTMLElement;

    const score = el('div', 'scorebar');
    score.innerHTML = `<div class="row"><span class="en"></span><span class="time">00:00</span><span>You</span></div>
      <div class="track"><div class="red"></div><div class="blue"></div></div>`;
    this.enemyName = score.querySelector('.en') as HTMLElement;
    this.timeEl = score.querySelector('.time') as HTMLElement;
    this.redBar = score.querySelector('.red') as HTMLElement;

    const zoom = el('button', 'iconbtn', ICON_ZOOM);
    zoom.title = 'Toggle battlefield view';
    shortcut(zoom, 'v');
    zoom.addEventListener('click', () => {
      audio.click();
      this.host.toggleZoom();
    });

    this.ringsBtn = el('button', 'iconbtn', ICON_RADIUS);
    this.ringsBtn.title = 'Show defence radius';
    shortcut(this.ringsBtn, 'g');
    this.ringsBtn.addEventListener('click', () => {
      audio.click();
      this.host.ui.showRings = !this.host.ui.showRings;
      this.ringsBtn.classList.toggle('on', this.host.ui.showRings);
    });

    this.dayIcon = el('div', 'iconbtn');
    this.dayIcon.style.pointerEvents = 'none';

    const playerPill = el('div', 'pill you');
    playerPill.innerHTML = `<span class="coin">${ICON_STAR}</span><span></span>`;
    this.playerMoney = playerPill.lastElementChild as HTMLElement;

    this.topbar.append(pause, enemyPill, score, zoom, this.ringsBtn, this.dayIcon, playerPill);
    this.root.appendChild(this.topbar);

    // Status chips --------------------------------------------------------
    this.statusbar = el('div', 'statusbar');
    this.root.appendChild(this.statusbar);

    // The last seconds before a levelled city is a lost match. Nothing else on
    // screen is allowed to be this loud.
    this.wipeoutEl = el('div', 'wipeout');
    this.wipeoutEl.style.display = 'none';
    this.wipeoutEl.setAttribute('role', 'status');
    this.root.appendChild(this.wipeoutEl);

    // Dock ----------------------------------------------------------------
    this.dock = el('div', 'dock');
    this.dockScroll = el('div', 'dock-scroll');
    this.dockBack = el('div', 'dock-back');
    const sound = el('button', 'iconbtn');
    sound.title = 'Toggle sound';
    shortcut(sound, 'm');
    sound.addEventListener('click', () => {
      const next = !audio.muted;
      audio.setMuted(next);
      this.host.meta.muted = next;
      sound.innerHTML = next ? ICON_SOUND_OFF : ICON_SOUND_ON;
    });
    sound.innerHTML = audio.muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
    const utilities = el('div', 'dock-utilities');
    utilities.append(sound, this.hintsToggle());
    this.dock.append(utilities, this.dockBack, this.dockScroll);
    this.root.appendChild(this.dock);

    this.fightBtn = el('button', 'fightbtn', 'Fight');
    shortcut(this.fightBtn, 'f', 'F / Space');
    this.fightBtn.style.display = 'none';
    this.fightBtn.addEventListener('click', () => this.onFight());
    this.root.appendChild(this.fightBtn);

    this.hintEl = el('div', 'hint');
    this.hintEl.style.display = 'none';
    this.root.appendChild(this.hintEl);

    this.keyboardGuide = el('div', 'keyboard-guide');
    this.root.appendChild(this.keyboardGuide);

    this.toastEl = el('div', 'toast');
    this.root.appendChild(this.toastEl);

    this.overlay = el('div', 'overlay');
    this.overlay.style.display = 'none';
    this.root.appendChild(this.overlay);
  }

  toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 1500);
  }

  /**
   * Rebuilds the current overlay after account or queue state changes.
   * The flag matters: clearing `overlayKind` alone would be a no-op whenever
   * the overlay is *already* meant to be gone, leaving the menu painted over a
   * live match — which is what happened the instant matchmaking succeeded.
   */
  refreshOverlay(): void {
    this.overlayDirty = true;
  }

  private overlayDirty = false;

  // ------------------------------------------------------------ per frame

  sync(): void {
    const { match, ui, meta } = this.host;
    const inGame = this.host.screen === 'game' && match !== null;

    this.topbar.style.display = inGame ? '' : 'none';
    this.statusbar.style.display = inGame ? '' : 'none';
    this.dock.style.display = inGame ? '' : 'none';
    this.keyboardGuide.style.display = inGame ? '' : 'none';
    this.keyboardGuide.textContent = 'B Build · A Anti-Air · R Ammo · U Upgrades · I Missiles · T Aim · F/Space Fight · H Hints';
    if (ui.placing || ui.panel === 'icbm') {
      this.keyboardGuide.textContent += ' · ←/→ Move · ↑/↓ Jump · Shift Fine · Enter Place/Pin · Esc Cancel';
    } else {
      this.keyboardGuide.textContent += ' · Arrows Pan · +/− Zoom · Tab Select · Enter Activate';
    }
    this.ringsBtn.classList.toggle('on', ui.showRings);

    if (inGame && match) {
      this.syncTop(match);
      this.syncStatus(match);
      if (this.builtPanel !== ui.panel) this.buildDock();
      for (const u of this.cardUpdates) u();
      this.syncFightBar(match);
      this.syncWipeout(match);
    } else {
      this.fightBtn.style.display = 'none';
      this.hintEl.style.display = 'none';
      this.wipeoutEl.style.display = 'none';
    }

    this.syncOverlay(inGame ? match : null, meta);
    const modal = this.overlayKind !== 'none';
    this.dock.inert = modal;
    this.topbar.inert = modal;
    this.fightBtn.inert = modal;
    this.keyboardGuide.hidden = modal;
  }

  private syncTop(match: Match): void {
    this.enemyMoney.textContent = money(match.enemy.money);
    this.playerMoney.textContent = money(match.player.money);
    this.enemyName.textContent = match.enemy.name;
    this.timeEl.textContent = isFinite(match.duration)
      ? `${clock(match.time)} / ${clock(match.duration)}`
      : `${clock(match.time)} · ∞`;
    const pv = cityValue(match.player);
    const ev = cityValue(match.enemy);
    const total = pv + ev;
    const redShare = total > 0 ? ev / total : 0.5;
    this.redBar.style.width = `${(redShare * 100).toFixed(1)}%`;

    const night = nightAmount(match);
    this.dayIcon.innerHTML =
      night > 0.5
        ? `<svg viewBox="0 0 64 64"><path d="M40 8 a24 24 0 1 0 16 34 A20 20 0 0 1 40 8 Z" fill="#dfe6f2"/></svg>`
        : `<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="13" fill="#ffd447"/>${Array.from(
            { length: 8 },
            (_, i) => {
              const a = (i * Math.PI) / 4;
              const x1 = 32 + Math.cos(a) * 19;
              const y1 = 32 + Math.sin(a) * 19;
              const x2 = 32 + Math.cos(a) * 26;
              const y2 = 32 + Math.sin(a) * 26;
              return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="#ffd447" stroke-width="5" stroke-linecap="round"/>`;
            },
          ).join('')}</svg>`;
  }

  /**
   * Counts the player out while their city is flat. It only runs once the
   * ceasefire is over, which is the same condition the engine uses to start the
   * clock — so the number on screen is the one that will actually end the match.
   */
  private syncWipeout(match: Match): void {
    const timer = match.player.wipeoutTimer;
    if (timer <= 0 || match.phase !== 'playing') {
      this.wipeoutEl.style.display = 'none';
      return;
    }
    const left = Math.max(0, Math.ceil(MATCH.wipeoutGraceSeconds - timer));
    // Losing the match outranks a coaching tip, and they share the same strip.
    this.hintEl.style.display = 'none';
    this.wipeoutEl.style.display = '';
    // Rubble left behind says the city was levelled; no plot ever taken says
    // this player simply never built one.
    const label = match.player.buildings.length ? 'CITY LEVELLED — REBUILD NOW' : 'NO CITY — BUILD NOW';
    this.wipeoutEl.innerHTML =
      `<div class="wipeout-label">${label}</div><div class="wipeout-count">${left}</div>`;
    // A flash on each new second, so it reads as a countdown out of the corner
    // of an eye that is busy elsewhere.
    this.wipeoutEl.classList.toggle('tick', left !== this.lastWipeoutSecond);
    this.lastWipeoutSecond = left;
  }

  private lastWipeoutSecond = -1;

  private syncStatus(match: Match): void {
    const chips: string[] = [];
    if (inPeace(match)) {
      chips.push(`<div class="chip peace">CEASEFIRE <b>${clock(MATCH.peaceSeconds - match.time)}</b></div>`);
    } else {
      chips.push(`<div class="chip war">WEAPONS FREE</div>`);
    }
    chips.push(`<div class="chip income">INCOME <b>+${money(incomePerTick(match.player))}</b> / 2s</div>`);
    if (match.mode === 'online') chips.push('<div class="chip"><b>ONLINE</b> · equal base loadout</div>');
    const next = secondsToNextLimit(match);
    if (isFinite(next)) chips.push(`<div class="chip">BUILD LIMIT +1 in <b>${clock(next)}</b></div>`);
    else chips.push(`<div class="chip">BUILD LIMIT MAXED</div>`);
    const incoming = match.missiles.filter((m) => m.side === 'enemy').length;
    if (incoming > 0) chips.push(`<div class="chip war">INCOMING <b>${incoming}</b></div>`);
    if (window.innerHeight > window.innerWidth) {
      chips.push('<div class="chip">↻ Turn your phone sideways for the full battlefield</div>');
    }
    this.statusbar.innerHTML = chips.join('');
  }

  private syncFightBar(match: Match): void {
    const ui = this.host.ui;
    const aiming = ui.panel === 'icbm';
    const queued = match.player.queued.length;
    const pending = match.player.pending.length;
    this.fightBtn.style.display = aiming && ui.placing === null ? '' : 'none';
    this.fightBtn.classList.toggle('dim', queued === 0 || inPeace(match));
    this.fightBtn.textContent = queued > 0 ? `Fight (${queued})` : 'Fight';

    if (ui.placing !== null) {
      this.hintEl.style.display = '';
      if (ui.placing.kind === 'building') {
        const def = BUILDINGS[ui.placing.type];
        this.hintEl.innerHTML = `Tap a free plot on <b>your land</b> to build ${def.name} (<b>$${def.cost}</b>). Tap its card again to cancel.`;
      } else {
        const def = AA[ui.placing.type];
        const price = aaCost(match.player, ui.placing.type);
        this.hintEl.innerHTML = `Tap anywhere on <b>your land</b> to site the ${def.interceptsTier === 0 ? 'radar' : `${def.name} ${def.roman}`} (<b>$${price}</b>). Tap its card again to cancel.`;
      }
      return;
    }

    if (aiming) {
      this.hintEl.style.display = '';
      if (inPeace(match)) {
        this.hintEl.innerHTML = `Ceasefire for <b>${clock(MATCH.peaceSeconds - match.time)}</b> — you can still pin targets now.`;
      } else if (queued === 0 && pending === 0) {
        const def = MISSILES[ui.selectedTier - 1];
        this.hintEl.innerHTML = `Pick a missile, then <b>tap their city</b> to pin a target. ${def.roman} costs <b>$${def.cost}</b> a shot.`;
      } else {
        this.hintEl.innerHTML = `<b>${queued}</b> pinned · <b>${pending}</b> in the tube — press <b>Fight</b> to launch.`;
      }
      this.hintEl.innerHTML += '<span class="keyboard-extra">T aim · Enter pin · Z undo · C clear pins</span>';
    } else if (ui.panel === 'none' && match.player.buildings.length === 0) {
      this.hintEl.style.display = '';
      this.hintEl.innerHTML = `Open <b>Buildings</b> and put up your first block — every building pays out every 2 seconds.`;
    } else {
      this.hintEl.style.display = 'none';
    }
  }

  private onFight(): void {
    const match = this.host.match;
    if (!match) return;
    if (match.player.queued.length === 0) {
      audio.deny();
      this.toast('Pin at least one target first');
      return;
    }
    const n = commitQueue(match.player);
    if (n > 0) this.host.sendOnlineAction({ type: 'commit-targets' });
    audio.buy();
    this.toast(`${n} ${n === 1 ? 'missile' : 'missiles'} away`);
  }

  // ----------------------------------------------------------------- dock

  private buildDock(): void {
    const ui = this.host.ui;
    this.builtPanel = ui.panel;
    this.cardUpdates = [];
    this.dockScroll.innerHTML = '';
    this.dockBack.innerHTML = '';
    if (ui.panel !== 'none') this.dockBack.appendChild(this.backCard());

    switch (ui.panel) {
      case 'none':
        this.buildRootPanel();
        break;
      case 'buildings':
        this.buildBuildingsPanel();
        break;
      case 'antiair':
        this.buildAntiAirPanel();
        break;
      case 'abm':
        this.buildAbmPanel();
        break;
      case 'icbm':
        this.buildIcbmPanel();
        break;
      case 'upgrades':
        break;
    }
    this.dockScroll.scrollLeft = 0;
    if (ui.panel === 'none') {
      this.dockScroll.querySelectorAll<HTMLElement>('.card').forEach((card, index) => {
        shortcut(card, ['u', 'b', 'a', 'r', 'i'][index]);
      });
    } else {
      let index = 0;
      this.dockScroll.querySelectorAll<HTMLElement>('.card').forEach((card) => {
        if (!card.dataset.key) shortcut(card, String(++index));
      });
    }
  }

  private card(opts: {
    art: string;
    cost?: string;
    count?: string;
    tier?: string;
    meta?: string;
    delta?: string;
    ring?: string;
    big?: boolean;
    title?: string;
    onClick: () => void;
    update?: (parts: {
      root: HTMLElement;
      cost: HTMLElement;
      count: HTMLElement;
      meta: HTMLElement;
      delta: HTMLElement;
    }) => void;
  }): HTMLElement {
    const root = el('button', `card${opts.big ? ' big' : ''}`);
    if (opts.title) root.title = opts.title;
    const art = el('div', 'art', opts.art);
    const cost = el('div', 'cost', opts.cost ?? '');
    const count = el('div', 'count', opts.count ?? '');
    const metaEl = el('div', 'meta', opts.meta ?? '');
    const delta = el('div', 'delta', opts.delta ?? '');
    root.append(art, metaEl, count, cost, delta);
    if (opts.tier) {
      const t = el('div', 'tier', opts.tier);
      root.appendChild(t);
    }
    if (opts.ring) {
      const r = el('div', 'ring');
      r.style.background = opts.ring;
      root.appendChild(r);
    }
    root.addEventListener('click', opts.onClick);
    if (opts.update) {
      const parts = { root, cost, count, meta: metaEl, delta };
      const fn = () => opts.update!(parts);
      this.cardUpdates.push(fn);
      fn();
    }
    this.dockScroll.appendChild(root);
    return root;
  }

  private backCard(): HTMLElement {
    const b = el('button', 'card');
    b.innerHTML = `<div class="art">${ICON_BACK}</div>`;
    b.title = 'Back';
    shortcut(b, 'escape', 'Esc');
    b.addEventListener('click', () => {
      audio.click();
      this.host.setPanel('none');
    });
    return b;
  }

  private buildRootPanel(): void {
    const entries: { icon: string; label: string; panel: PanelId }[] = [
      { icon: ICON_UPGRADE, label: 'Upgrades', panel: 'upgrades' },
      { icon: ICON_CITY, label: 'Build', panel: 'buildings' },
      { icon: aaIcon(3), label: 'Anti-Air', panel: 'antiair' },
      { icon: ICON_ABM, label: 'ABM', panel: 'abm' },
      { icon: ICON_ICBM, label: 'ICBM', panel: 'icbm' },
    ];
    for (const e of entries) {
      this.card({
        art: e.icon,
        cost: e.label,
        title: e.label,
        onClick: () => {
          audio.click();
          this.host.setPanel(e.panel);
        },
      });
    }
  }

  private buildBuildingsPanel(): void {
    for (const def of BUILDINGS) {
      this.card({
        art: buildingIcon(def.id),
        cost: `$${def.cost}`,
        title: `${def.name} — +$${def.income}/2s, ${def.hp} HP`,
        onClick: () => {
          const match = this.host.match;
          if (!match) return;
          const ui = this.host.ui;
          if (ui.placing?.kind === 'building' && ui.placing.type === def.id) {
            ui.placing = null;
            ui.placeX = null;
            audio.click();
            return;
          }
          if (countBuildings(match.player, def.id) >= buildingLimit(match, def.id)) {
            audio.deny();
            this.toast('Build limit reached — wait for the next unlock');
            return;
          }
          if (match.player.money < def.cost) {
            audio.deny();
            this.toast('Not enough cash');
            return;
          }
          ui.placing = { kind: 'building', type: def.id };
          ui.placeX = null;
          audio.click();
          this.toast('Tap your land to place it');
        },
        update: ({ root, count }) => {
          const match = this.host.match;
          if (!match) return;
          const limit = buildingLimit(match, def.id);
          const built = countBuildings(match.player, def.id);
          count.textContent = `${built}/${limit}`;
          root.classList.toggle('dim', built >= limit || match.player.money < def.cost);
          root.classList.toggle(
            'sel',
            this.host.ui.placing?.kind === 'building' && this.host.ui.placing.type === def.id,
          );
        },
      });
    }
  }

  private buildAntiAirPanel(): void {
    for (const def of AA) {
      this.card({
        art: aaIcon(def.id),
        tier: def.roman,
        ring: def.color,
        title:
          def.interceptsTier === 0
            ? 'Radar — early warning: impact markers appear seconds sooner and off-screen missiles get tracked'
            : `${def.name} — ${interceptsWhat(def)}. Leave space between radars and anti-air systems`,
        onClick: () => {
          const match = this.host.match;
          if (!match) return;
          const ui = this.host.ui;
          if (ui.placing?.kind === 'battery' && ui.placing.type === def.id) {
            ui.placing = null;
            ui.placeX = null;
            audio.click();
            return;
          }
          if (match.player.aaOwned[def.id] >= AA_MAX_PER_TYPE) {
            audio.deny();
            this.toast(`Max ${AA_MAX_PER_TYPE} of each system`);
            return;
          }
          const price = aaCost(match.player, def.id);
          if (match.player.money < price) {
            audio.deny();
            this.toast('Not enough cash');
            return;
          }
          ui.placing = { kind: 'battery', type: def.id };
          ui.placeX = null;
          ui.showRings = true;
          this.ringsBtn.classList.add('on');
          audio.click();
          this.toast('Tap your land to place it');
        },
        update: ({ root, count, cost }) => {
          const match = this.host.match;
          if (!match) return;
          const owned = match.player.aaOwned[def.id];
          count.textContent = `${owned}/${AA_MAX_PER_TYPE}`;
          const price = aaCost(match.player, def.id);
          cost.textContent = !isFinite(price) ? 'MAX' : price === 0 ? 'Free +1' : `$${price}`;
          root.classList.toggle('dim', !isFinite(price) || match.player.money < price);
          root.classList.toggle(
            'sel',
            this.host.ui.placing?.kind === 'battery' && this.host.ui.placing.type === def.id,
          );
        },
      });
    }
  }

  private buildAbmPanel(): void {
    const mult = el('button', 'card');
    mult.innerHTML = `<div class="art" style="font-size:26px;font-weight:900;color:#1b2028">x${this.host.ui.ammoMult}</div>`;
    mult.title = 'Rounds bought per tap';
    shortcut(mult, 'x');
    mult.addEventListener('click', () => {
      audio.click();
      const order: (1 | 5 | 10)[] = [1, 5, 10];
      const i = order.indexOf(this.host.ui.ammoMult);
      this.host.ui.ammoMult = order[(i + 1) % order.length];
      (mult.firstElementChild as HTMLElement).textContent = `x${this.host.ui.ammoMult}`;
    });
    this.dockScroll.appendChild(mult);

    for (const def of AA) {
      if (def.interceptsTier === 0) continue;
      this.card({
        art: abmIcon(def.id),
        tier: def.roman,
        ring: def.color,
        cost: `$${def.ammoCost}`,
        title: `${def.name} rounds — each one can knock down a single tier ${def.roman} missile`,
        onClick: () => {
          const match = this.host.match;
          if (!match) return;
          if (match.player.aaOwned[def.id] === 0) {
            audio.deny();
            this.toast(`Build an ${def.name} launcher first`);
            return;
          }
          const n = buyAmmo(match.player, def.id, this.host.ui.ammoMult);
          if (n > 0) {
            audio.buy();
            this.host.sendOnlineAction({ type: 'buy-ammo', batteryType: def.id, count: n });
          }
          else {
            audio.deny();
            this.toast(match.player.ammo[def.id] >= def.ammoCap ? 'Magazine full' : 'Not enough cash');
          }
        },
        update: ({ root, count }) => {
          const match = this.host.match;
          if (!match) return;
          count.textContent = String(match.player.ammo[def.id]);
          const noLauncher = match.player.aaOwned[def.id] === 0;
          root.classList.toggle('dim', noLauncher || match.player.money < def.ammoCost);
        },
      });
    }
  }

  private buildIcbmPanel(): void {
    const undo = el('button', 'card');
    undo.title = 'Clear all pinned targets';
    shortcut(undo, 'c');
    undo.innerHTML = `<div class="art" style="font-size:12px;font-weight:900;color:#1b2028;text-align:center;line-height:1.2">CLEAR<br>PINS</div>`;
    undo.addEventListener('click', () => {
      const match = this.host.match;
      if (!match) return;
      if (match.player.queued.length === 0) {
        audio.deny();
        return;
      }
      clearQueue(match.player);
      this.host.sendOnlineAction({ type: 'clear-targets' });
      audio.click();
      this.toast('Targets cleared, cash refunded');
    });
    this.dockScroll.appendChild(undo);

    for (const def of MISSILES) {
      this.card({
        art: missileIcon(def.tier),
        tier: def.roman,
        cost: `$${def.cost}`,
        title: `${def.name} — ${def.damage} dmg, ${def.speed} m/s, ${interceptedBy(def.tier)}`,
        onClick: () => {
          const match = this.host.match;
          if (!match) return;
          if (!match.player.missileUnlocked[def.tier - 1]) {
            audio.deny();
            this.toast(
              canUnlockMissile(match.player, def.tier)
                ? `Unlock ${def.name} in Upgrades ($${def.unlockCost})`
                : `Unlock ${MISSILES[def.tier - 2].name} ${MISSILES[def.tier - 2].roman} first`,
            );
            return;
          }
          audio.click();
          this.host.ui.selectedTier = def.tier;
          for (const u of this.cardUpdates) u();
        },
        update: ({ root, count, meta }) => {
          const match = this.host.match;
          if (!match) return;
          const unlocked = match.player.missileUnlocked[def.tier - 1];
          const sel = this.host.ui.selectedTier === def.tier;
          root.classList.toggle('sel', sel && unlocked);
          root.classList.toggle('dim', !unlocked);
          const pinned =
            match.player.queued.filter((q) => q.tier === def.tier).length +
            match.player.pending.filter((q) => q.tier === def.tier).length;
          if (def.perMatchLimit > 0) {
            const left = Math.max(0, shotsRemaining(match.player, def.tier));
            count.textContent = `${left}/${def.perMatchLimit}`;
          } else {
            count.textContent = pinned > 0 ? `+${pinned}` : '';
          }
          const cd = match.player.launchCooldown[def.tier - 1];
          meta.textContent = !unlocked ? '\u{1F512}' : cd > 0.05 ? `${cd.toFixed(1)}s` : '';
        },
      });
    }
  }

  // ------------------------------------------------------------- overlays

  private syncOverlay(match: Match | null, meta: MetaSave): void {
    const want: typeof this.overlayKind =
      this.host.screen === 'menu'
        ? 'menu'
        : this.host.screen === 'shop'
          ? 'shop'
          : match?.phase === 'over'
            ? 'result'
            : match?.phase === 'paused'
              ? 'pause'
              : this.host.ui.panel === 'upgrades'
                ? 'upgrades'
                : 'none';

    if (want !== this.overlayKind || this.overlayDirty) {
      const active = document.activeElement;
      const keepFocus =
        active instanceof HTMLElement && this.overlay.contains(active) ? active.dataset.focusKey ?? null : null;
      const caret = active instanceof HTMLInputElement ? active.selectionStart : null;
      this.overlayDirty = false;
      this.overlayKind = want;
      this.overlay.className = `overlay${want === 'upgrades' ? ' upgrades' : ''}`;
      this.overlay.innerHTML = '';
      this.overlay.style.display = want === 'none' ? 'none' : '';
      this.upgradeUpdates = [];
      this.menuUpdates = [];
      if (want === 'menu') this.buildMenu(meta);
      else if (want === 'shop') this.buildShop(meta);
      else if (want === 'pause') this.buildPause();
      else if (want === 'result' && match) this.buildResult(match, meta);
      else if (want === 'upgrades' && match) this.buildUpgrades(match);
      // All other controls remain reachable using native Tab + Enter navigation.
      this.overlay.querySelectorAll<HTMLElement>('button, summary').forEach((node) => {
        if (!node.dataset.hint) node.dataset.hint = 'Tab ↵';
      });
      if (want !== 'none' && document.activeElement instanceof HTMLElement && !this.overlay.contains(document.activeElement)) document.activeElement.blur();
      if (keepFocus) {
        const again = this.overlay.querySelector<HTMLElement>(`[data-focus-key="${keepFocus}"]`);
        again?.focus();
        if (again instanceof HTMLInputElement && caret !== null) again.setSelectionRange(caret, caret);
      }
    }
    if (want === 'upgrades') for (const u of this.upgradeUpdates) u();
    if (want === 'menu') for (const u of this.menuUpdates) u();
  }

  private upgradeUpdates: CardUpdate[] = [];
  /** Ticking text on the menu — the invitation countdowns. */
  private menuUpdates: CardUpdate[] = [];
  /** What the player has typed into the add-friend box, kept across rebuilds. */
  private friendDraft = '';

  private buildMenu(meta: MetaSave): void {
    const ui = this.host.ui;
    const wrap = el('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;width:min(760px,100%);margin:auto 0;';

    wrap.appendChild(el('h1', undefined, 'Final Skyline'));
    const stars = el('div', 'starline', `${ICON_STAR}<span>${meta.stars}</span>`);
    wrap.appendChild(stars);
    wrap.appendChild(
      el(
        'p',
        'sub',
        'Build a city that pays you every two seconds, screen it with layered anti-air, and flatten theirs before the clock runs out. Ceasefire holds for the first two minutes.',
      ),
    );

    const grid = el('div', 'diffgrid');
    (Object.keys(BOTS) as Difficulty[]).forEach((d, index) => {
      const b = el('button', `diff${ui.difficulty === d ? ' sel' : ''}`);
      b.innerHTML = `<div class="t">${BOTS[d].label}</div><div class="d">${BOTS[d].blurb}</div>`;
      shortcut(b, String(index + 1));
      b.addEventListener('click', () => {
        audio.click();
        ui.difficulty = d;
        grid.querySelectorAll('.diff').forEach((n) => n.classList.remove('sel'));
        b.classList.add('sel');
      });
      grid.appendChild(b);
    });
    wrap.appendChild(grid);

    const lenRow = el('div', 'row center');
    lenRow.style.marginTop = '4px';
    const lengths: { label: string; value: number }[] = [
      { label: '5 min', value: 300 },
      { label: '10 min', value: 600 },
      { label: '15 min', value: 900 },
      { label: 'Unlimited', value: Infinity },
    ];
    for (const len of lengths) {
      const b = el('button', 'btn ghost', len.label);
      shortcut(b, String(lengths.indexOf(len) + 5));
      if (ui.duration === len.value) b.style.borderColor = 'var(--gold)';
      b.addEventListener('click', () => {
        audio.click();
        ui.duration = len.value;
        lenRow.querySelectorAll('button').forEach((n) => ((n as HTMLElement).style.borderColor = ''));
        b.style.borderColor = 'var(--gold)';
        // The online card names the length it will queue for, so redraw it.
        this.refreshOverlay();
      });
      lenRow.appendChild(b);
    }
    wrap.appendChild(lenRow);
    const lenNote = el(
      'p',
      'sub',
      'An unlimited match runs until one city is levelled — lose every building and fail to rebuild within ' +
        `${MATCH.wipeoutGraceSeconds} seconds and it is over.`,
    );
    lenNote.style.margin = '2px 0 0';
    lenNote.style.fontSize = '12px';
    wrap.appendChild(lenNote);

    const actions = el('div', 'row center');
    actions.style.marginTop = '10px';
    const play = el('button', 'btn primary', 'Play');
    shortcut(play, 'enter', 'Enter');
    play.addEventListener('click', () => {
      audio.init();
      audio.click();
      this.host.startMatch();
    });
    const shop = el('button', 'btn', 'Star Shop');
    shortcut(shop, 's');
    shop.addEventListener('click', () => {
      audio.click();
      this.host.openShop();
    });
    actions.append(play, shop, this.hintsToggle());
    wrap.appendChild(actions);

    wrap.appendChild(this.buildOnlineCard());

    const record = el(
      'p',
      'sub',
      `Record: <b style="color:#59e07a">${meta.wins}W</b> / <b style="color:#ff5a4d">${meta.losses}L</b>`,
    );
    record.style.marginTop = '12px';
    wrap.appendChild(record);

    const help = el('details');
    help.style.cssText = 'max-width:620px;color:#aab4c0;font-size:13px;line-height:1.6;margin-top:6px;';
    help.innerHTML = `<summary style="cursor:pointer;font-weight:800;color:#dfe6ee;padding:6px 0">How it works</summary>
      <ul style="padding-left:18px;margin:6px 0">
        <li><b>Buildings</b> pay income every 2 seconds. Pick a type, then tap a free plot on your land to place it. Each type has a cap that rises by one every ${MATCH.limitStepSeconds / 60} minutes; a levelled building frees its slot so you can rebuild.</li>
        <li><b>Anti-air</b> comes in five tiers plus a radar. A tier ${'Ⅰ'}–${'Ⅴ'} battery only stops the matching missile tier — max two of each — and THAAD alone is quick enough to also knock down a Bunker Buster, if it is sited near where the warhead is aimed. Pick a system, then tap your own land to site it with room between it and every existing radar or anti-air system. Batteries can be bombed, and replaced once they are.</li>
        <li><b>ABM rounds</b> are the ammunition. An empty battery cannot intercept anything.</li>
        <li><b>Upgrades</b> (in-match, paid in cash) widen defence radius, cut anti-air reload, and unlock heavier missiles.</li>
        <li><b>Attacking</b>: open ICBM, pick a tier, tap their city to pin targets, then hit Fight. Each tier launches on its own reload timer, and heavier tiers unlock one at a time — you cannot skip ahead to the big warheads.</li>
        <li><b>Stars</b> earned from matches buy permanent radius and reload upgrades in the Star Shop.</li>
        <li><b>Keyboard</b>: B buildings, A anti-air, R ammunition, U upgrades, I missiles. Number keys select an item. T moves to targeting; arrows move the cursor (up/down make larger jumps, Shift moves precisely). Enter places or pins, F/Space fights, Z undoes a pin, C clears pins, X cycles ammo quantities. P pauses, V changes view, G shows coverage, M mutes, H hides keyboard hints. Tab and Enter operate menus and the Star Shop. In Upgrades, choose R (radius), D (defence reload), or M (missiles), then a number.</li>
      </ul>`;
    wrap.appendChild(help);

    this.overlay.appendChild(wrap);
  }

  private buildOnlineCard(): HTMLElement {
    const state = this.host.online;
    const card = el('section', 'online-card');
    const title = el('div', 'online-title', '<span>Online Match</span><span class="online-beta">BETA</span>');
    card.appendChild(title);

    if (!state.configured || state.phase === 'disabled') {
      card.appendChild(el('p', 'online-message', state.message));
      return card;
    }

    if (!state.username) {
      const busy = state.phase === 'loading';
      const submit = (action: () => Promise<void>) => {
        audio.init();
        audio.click();
        void action();
      };

      const fields = el('div', 'auth-fields');
      const username = el('input', 'auth-input');
      username.placeholder = 'Username (for sign up)';
      username.autocomplete = 'username';
      username.maxLength = 20;
      username.dataset.focusKey = 'auth-username';
      const email = el('input', 'auth-input');
      email.type = 'email';
      email.placeholder = 'Email';
      email.autocomplete = 'email';
      email.dataset.focusKey = 'auth-email';
      const password = el('input', 'auth-input');
      password.type = 'password';
      password.placeholder = 'Password';
      password.autocomplete = 'current-password';
      password.dataset.focusKey = 'auth-password';
      fields.append(username, email, password);
      card.appendChild(fields);

      const row = el('div', 'online-actions');
      const signUp = el('button', 'btn primary', 'Create account');
      const signIn = el('button', 'btn', 'Sign in');
      signUp.disabled = busy;
      signIn.disabled = busy;
      signUp.addEventListener('click', () => submit(() => this.host.signUp(username.value, email.value, password.value)));
      signIn.addEventListener('click', () => submit(() => this.host.signIn(email.value, password.value)));
      password.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') submit(() => this.host.signIn(email.value, password.value));
      });
      row.append(signUp, signIn);
      card.appendChild(row);
    } else {
      const profile = el('div', 'online-profile');
      const name = el('strong');
      name.textContent = state.username;
      const record = el('span');
      record.textContent = `${state.wins}W / ${state.losses}L · ${state.stars} stars`;
      profile.append(name, record);
      card.appendChild(profile);

      const row = el('div', 'online-actions');
      if (state.phase === 'queueing') {
        const cancel = el('button', 'btn ghost', 'Cancel search');
        cancel.addEventListener('click', () => {
          audio.click();
          void this.host.cancelOnlineQueue();
        });
        row.appendChild(cancel);
      } else {
        const duration = onlineDuration(this.host.ui.duration);
        const queue = el('button', 'btn primary', `Queue · ${onlineDurationLabel(duration)}`);
        queue.disabled = state.phase === 'loading';
        queue.addEventListener('click', () => {
          audio.init();
          audio.click();
          void this.host.findOnlineMatch();
        });
        const signOut = el('button', 'btn ghost', 'Sign out');
        signOut.addEventListener('click', () => {
          audio.click();
          void this.host.signOut();
        });
        row.append(queue, signOut);
      }
      card.appendChild(row);
      card.appendChild(this.buildFriendsPanel(state));
    }

    const message = el('p', `online-message${state.phase === 'error' ? ' error' : ''}`);
    message.textContent = state.message;
    card.appendChild(message);
    return card;
  }

  /**
   * Friends, who is online, and direct invitations. The whole block is rebuilt
   * whenever the poll finds something new, so nothing here may hold state that
   * the player can see — the countdowns tick through `menuUpdates` instead.
   */
  private buildFriendsPanel(state: OnlineState): HTMLElement {
    const panel = el('section', 'friends');
    panel.appendChild(el('div', 'friends-title', 'Friends'));

    // --- invitations first: one of them is on a 90-second clock ------------
    for (const invite of state.invites) {
      panel.appendChild(this.buildInviteRow(invite));
    }

    // --- someone wants to be added ----------------------------------------
    for (const friend of state.friends.filter((f) => f.status === 'incoming')) {
      const row = el('div', 'friend-row');
      row.append(el('span', 'friend-name', `${friend.username} wants to be friends`));
      const accept = el('button', 'btn small', 'Accept');
      accept.addEventListener('click', () => {
        audio.click();
        void this.host.respondFriend(friend.userId, true);
      });
      const decline = el('button', 'btn ghost small', 'Decline');
      decline.addEventListener('click', () => {
        audio.click();
        void this.host.respondFriend(friend.userId, false);
      });
      row.append(accept, decline);
      panel.appendChild(row);
    }

    // --- the list itself ---------------------------------------------------
    const invitedIds = new Set(
      state.invites.filter((i) => i.direction === 'outgoing').map((i) => i.userId),
    );
    const accepted = state.friends.filter((f) => f.status === 'accepted');
    const inMatch = state.phase === 'matched';

    for (const friend of accepted) {
      const row = el('div', 'friend-row');
      const dot = el('span', `friend-dot${friend.online ? ' on' : ''}`);
      dot.title = friend.online ? 'Online now' : 'Offline';
      const name = el('span', 'friend-name');
      name.textContent = friend.username;
      const presence = el('span', 'friend-presence', friend.online ? 'online' : 'offline');
      row.append(dot, name, presence);

      const invite = el('button', 'btn small', 'Invite');
      const alreadyAsked = invitedIds.has(friend.userId);
      invite.disabled = !friend.online || alreadyAsked || inMatch;
      invite.title = !friend.online
        ? `${friend.username} is not online`
        : alreadyAsked
          ? 'Already invited — waiting for an answer'
          : `Invite ${friend.username} to a ${onlineDurationLabel(onlineDuration(this.host.ui.duration))} match`;
      invite.addEventListener('click', () => {
        audio.click();
        void this.host.sendInvite(friend.userId);
      });

      const remove = el('button', 'btn ghost small', '×');
      remove.title = `Remove ${friend.username}`;
      remove.addEventListener('click', () => {
        audio.click();
        void this.host.removeFriend(friend.userId);
      });
      row.append(invite, remove);
      panel.appendChild(row);
    }

    // --- requests we sent, still unanswered --------------------------------
    for (const friend of state.friends.filter((f) => f.status === 'outgoing')) {
      const row = el('div', 'friend-row');
      const name = el('span', 'friend-name');
      name.textContent = friend.username;
      row.append(el('span', 'friend-dot'), name, el('span', 'friend-presence', 'request sent'));
      const cancel = el('button', 'btn ghost small', '×');
      cancel.title = `Withdraw the request to ${friend.username}`;
      cancel.addEventListener('click', () => {
        audio.click();
        void this.host.removeFriend(friend.userId);
      });
      row.appendChild(cancel);
      panel.appendChild(row);
    }

    if (!accepted.length && !state.friends.length) {
      panel.appendChild(el('p', 'friends-empty', 'Add a commander by name to see when they are online.'));
    }

    // --- add by name -------------------------------------------------------
    const add = el('div', 'friend-add');
    const input = el('input', 'auth-input');
    input.placeholder = 'Commander name';
    input.maxLength = 20;
    input.autocomplete = 'off';
    input.value = this.friendDraft;
    input.dataset.focusKey = 'friend-add';
    input.addEventListener('input', () => {
      this.friendDraft = input.value;
    });
    const submit = () => {
      audio.click();
      const name = input.value;
      this.friendDraft = '';
      input.value = '';
      void this.host.addFriend(name);
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    const addBtn = el('button', 'btn small', 'Add');
    addBtn.addEventListener('click', submit);
    add.append(input, addBtn);
    panel.appendChild(add);

    if (state.friendMessage) {
      const note = el('p', 'online-message');
      note.textContent = state.friendMessage;
      panel.appendChild(note);
    }
    return panel;
  }

  /** One invitation, with the live countdown to its 90-second deadline. */
  private buildInviteRow(invite: MatchInvite): HTMLElement {
    const row = el('div', 'friend-row invite');
    const label = el('span', 'friend-name');
    const length = onlineDurationLabel(invite.durationSeconds);
    label.textContent =
      invite.direction === 'incoming'
        ? `${invite.username} invites you — ${length}`
        : `Waiting for ${invite.username} — ${length}`;
    const clock = el('span', 'invite-clock');
    row.append(label, clock);

    // Rebuilt only when the poll finds news, so the seconds tick from here.
    this.menuUpdates.push(() => {
      const left = Math.max(0, Math.ceil((Date.parse(invite.expiresAt) - Date.now()) / 1000));
      clock.textContent = `${left}s`;
      clock.classList.toggle('urgent', left <= 15);
    });

    if (invite.direction === 'incoming') {
      const accept = el('button', 'btn primary small', 'Accept');
      accept.addEventListener('click', () => {
        audio.init();
        audio.click();
        void this.host.respondInvite(invite.id, true);
      });
      const decline = el('button', 'btn ghost small', 'Decline');
      decline.addEventListener('click', () => {
        audio.click();
        void this.host.respondInvite(invite.id, false);
      });
      row.append(accept, decline);
    } else {
      const cancel = el('button', 'btn ghost small', 'Cancel');
      cancel.addEventListener('click', () => {
        audio.click();
        void this.host.cancelInvite(invite.id);
      });
      row.appendChild(cancel);
    }
    return row;
  }

  private buildShop(meta: MetaSave): void {
    const wrap = el('div');
    wrap.style.cssText = 'width:min(900px,100%);margin:auto 0;';
    const head = el('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;';
    const back = el('button', 'btn ghost', '← Back');
    shortcut(back, 'escape', 'Esc');
    back.addEventListener('click', () => {
      audio.click();
      this.host.closeShop();
    });
    const starEl = el('div', 'starline', `${ICON_STAR}<span>${meta.stars}</span>`);
    head.append(back, starEl);
    wrap.appendChild(head);
    wrap.appendChild(el('h2', undefined, 'Star Shop'));
    wrap.appendChild(
      el('p', 'sub', 'Permanent upgrades. They carry into every match you play from now on.'),
    );

    const refresh = () => {
      (starEl.lastElementChild as HTMLElement).textContent = String(meta.stars);
      wrap.querySelectorAll<HTMLElement>('.shopcard').forEach((n) => n.dispatchEvent(new CustomEvent('refresh')));
    };

    const section = (title: string, cards: HTMLElement[]) => {
      wrap.appendChild(el('h2', undefined, title));
      const g = el('div', 'shopgrid');
      cards.forEach((c) => g.appendChild(c));
      wrap.appendChild(g);
    };

    const shopCard = (
      icon: string,
      name: string,
      value: () => string,
      level: () => number,
      maxLevel: number,
      price: (lv: number) => number,
      buy: () => void,
    ): HTMLElement => {
      const c = el('button', 'shopcard');
      const ic = el('div', 'ic', icon);
      const txt = el('div', 'txt');
      const n = el('div', 'n', name);
      const v = el('div', 'v');
      txt.append(n, v);
      const p = el('div', 'p');
      c.append(ic, txt, p);
      const update = () => {
        const lv = level();
        const maxed = lv >= maxLevel;
        v.textContent = `${value()} · Lv ${lv}/${maxLevel}`;
        p.innerHTML = maxed ? 'MAX' : `${ICON_STAR}<span>${price(lv)}</span>`;
        c.classList.toggle('dim', maxed || meta.stars < price(lv));
      };
      c.addEventListener('refresh', update);
      c.addEventListener('click', () => {
        const lv = level();
        if (lv >= maxLevel) {
          audio.deny();
          return;
        }
        const cost = price(lv);
        if (meta.stars < cost) {
          audio.deny();
          this.toast('Not enough stars');
          return;
        }
        meta.stars -= cost;
        buy();
        audio.buy();
        this.host.saveProgress();
        refresh();
      });
      update();
      return c;
    };

    section(
      `Defence radius (+${META.radiusStep} m per level)`,
      AA.map((def) =>
        shopCard(
          aaIcon(def.id),
          def.interceptsTier === 0 ? 'Radar' : `${def.name} ${def.roman}`,
          () => `${def.baseRadius + meta.radiusLevel[def.id] * META.radiusStep} m`,
          () => meta.radiusLevel[def.id],
          META.radiusMaxLevel,
          META.radiusCost,
          () => meta.radiusLevel[def.id]++,
        ),
      ),
    );

    section(
      `Anti-air reload (−${META.aaReloadStep}s per level)`,
      AA.filter((d) => d.interceptsTier > 0).map((def) =>
        shopCard(
          abmIcon(def.id),
          `${def.name} ${def.roman}`,
          () =>
            `${Math.max(META.minReload, def.baseReload - meta.aaReloadLevel[def.id] * META.aaReloadStep).toFixed(2)}s`,
          () => meta.aaReloadLevel[def.id],
          META.aaReloadMaxLevel,
          META.aaReloadCost,
          () => meta.aaReloadLevel[def.id]++,
        ),
      ),
    );

    section(
      `Missile reload (−${META.missileReloadStep}s per level)`,
      MISSILES.map((def) =>
        shopCard(
          missileIcon(def.tier),
          `${def.name} ${def.roman}`,
          () =>
            `${Math.max(META.minReload, def.reload - meta.missileReloadLevel[def.tier - 1] * META.missileReloadStep).toFixed(2)}s`,
          () => meta.missileReloadLevel[def.tier - 1],
          META.missileReloadMaxLevel,
          META.missileReloadCost,
          () => meta.missileReloadLevel[def.tier - 1]++,
        ),
      ),
    );

    this.overlay.appendChild(wrap);
  }

  private buildPause(): void {
    const wrap = el('div');
    wrap.style.cssText = 'margin:auto 0;text-align:center;width:min(420px,100%);';
    wrap.appendChild(el('h2', undefined, 'Paused'));
    const row = el('div');
    row.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-top:10px;';
    const resume = el('button', 'btn primary', 'Resume');
    shortcut(resume, 'p');
    resume.addEventListener('click', () => {
      audio.click();
      this.host.setPaused(false);
    });
    const soundBtn = el('button', 'btn ghost', audio.muted ? 'Sound: off' : 'Sound: on');
    shortcut(soundBtn, 'm');
    soundBtn.addEventListener('click', () => {
      const next = !audio.muted;
      audio.setMuted(next);
      this.host.meta.muted = next;
      soundBtn.textContent = next ? 'Sound: off' : 'Sound: on';
    });
    const quit = el('button', 'btn ghost', 'Quit to menu');
    shortcut(quit, 'q');
    quit.addEventListener('click', () => {
      audio.click();
      this.host.quitToMenu();
    });
    row.append(resume, soundBtn, this.hintsToggle(), quit);
    wrap.appendChild(row);
    this.overlay.appendChild(wrap);
  }

  private buildResult(match: Match, meta: MetaSave): void {
    const r = match.result!;
    const wrap = el('div', 'result');
    wrap.style.margin = 'auto 0';
    wrap.appendChild(el('div', `verdict ${r.won ? 'win' : 'loss'}`, r.won ? 'Victory' : 'Defeat'));
    wrap.appendChild(el('p', 'sub', r.reason));

    const stars = el('div', 'starline');
    stars.style.justifyContent = 'center';
    stars.innerHTML = `${ICON_STAR}<span>+${r.stars}</span><span style="font-size:14px;color:#9fb0c4;font-weight:700">(${meta.stars} total)</span>`;
    wrap.appendChild(stars);

    const s = match.player.stats;
    const grid = el('div', 'statgrid');
    const stat = (k: string, v: string) => {
      const d = el('div', 'stat');
      d.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div>`;
      grid.appendChild(d);
    };
    stat('Your city', `$${r.playerValue}`);
    stat('Their city', `$${r.enemyValue}`);
    stat('Missiles fired', String(s.launched));
    stat('Shot down for you', String(s.intercepted));
    stat('Buildings lost', String(s.destroyedBuildings));
    stat('Buildings razed', String(match.enemy.stats.destroyedBuildings));
    wrap.appendChild(grid);

    const row = el('div', 'row center');
    const again = el('button', 'btn primary', match.mode === 'online' ? 'Back to online' : 'Play again');
    shortcut(again, 'enter', 'Enter');
    again.addEventListener('click', () => {
      audio.click();
      if (match.mode === 'online') this.host.quitToMenu();
      else this.host.startMatch();
    });
    const shop = el('button', 'btn', 'Star Shop');
    shop.addEventListener('click', () => {
      audio.click();
      this.host.openShop();
    });
    const menu = el('button', 'btn ghost', 'Main menu');
    shortcut(menu, 'q');
    menu.addEventListener('click', () => {
      audio.click();
      this.host.quitToMenu();
    });
    row.append(again, shop, menu);
    shortcut(shop, 's');
    wrap.appendChild(row);
    this.overlay.appendChild(wrap);
  }

  private buildUpgrades(match: Match): void {
    const meta = this.host.matchMeta();
    const wrap = el('div');
    wrap.style.cssText = 'width:min(1080px,100%);margin:auto 0;';

    const head = el('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;';
    const back = el('button', 'btn ghost', '← Back');
    shortcut(back, 'escape', 'Esc');
    back.addEventListener('click', () => {
      audio.click();
      this.host.setPanel('none');
    });
    const cash = el('div', 'starline');
    cash.innerHTML = `${ICON_STAR}<span class="cash"></span>`;
    head.append(back, cash);
    wrap.appendChild(head);
    this.upgradeUpdates.push(() => {
      (cash.querySelector('.cash') as HTMLElement).textContent = money(match.player.money);
    });

    let rowIndex = 0;
    const mkRow = (title: string, cards: HTMLElement[]) => {
      const rowKey = UPGRADE_ROW_KEYS[rowIndex].toUpperCase();
      const heading = el('h2', undefined, title);
      heading.dataset.hint = rowKey;
      wrap.appendChild(heading);
      const row = el('div', 'row center');
      row.dataset.upgradeRow = String(rowIndex++);
      cards.forEach((c, index) => {
        shortcut(c, String(index + 1), `${rowKey} → ${index + 1}`);
        row.appendChild(c);
      });
      wrap.appendChild(row);
    };

    const upgradeCard = (
      art: string,
      tier: string,
      ring: string,
      head1: () => string,
      price: () => string,
      delta: string,
      canBuy: () => boolean,
      onBuy: () => boolean,
      title: string,
    ): HTMLElement => {
      const root = el('button', 'card split');
      root.title = title;
      const artEl = el('div', 'art', art);
      const metaEl = el('div', 'meta');
      const costEl = el('div', 'cost');
      const deltaEl = el('div', 'delta', delta);
      const tierEl = el('div', 'tier', tier);
      const ringEl = el('div', 'ring');
      ringEl.style.background = ring;
      root.append(artEl, metaEl, tierEl, costEl, deltaEl, ringEl);
      root.addEventListener('click', () => {
        if (!canBuy()) {
          audio.deny();
          this.toast('Not enough cash');
          return;
        }
        if (onBuy()) audio.buy();
        else audio.deny();
      });
      this.upgradeUpdates.push(() => {
        metaEl.textContent = head1();
        costEl.textContent = price();
        root.classList.toggle('dim', !canBuy());
      });
      return root;
    };

    mkRow(
      'Upgrade defence radius',
      AA.map((def) =>
        upgradeCard(
          aaIcon(def.id),
          def.roman,
          def.color,
          () => `${Math.round(aaRadius(match.player, def.id, meta))}m`,
          () => `$${match.player.aaRadiusPrice[def.id]}`,
          `+${def.radiusStep}m`,
          () => match.player.money >= match.player.aaRadiusPrice[def.id],
          () => {
            const bought = buyAaRadius(match.player, def.id);
            if (bought) this.host.sendOnlineAction({ type: 'aa-radius', batteryType: def.id });
            return bought;
          },
          `${def.interceptsTier === 0 ? 'Radar' : def.name} coverage`,
        ),
      ),
    );

    mkRow(
      'Upgrade to reduce anti-air reload',
      AA.filter((d) => d.interceptsTier > 0).map((def) =>
        upgradeCard(
          aaIcon(def.id),
          def.roman,
          def.color,
          () => `${aaReload(match.player, def.id, meta).toFixed(2)}s`,
          () => `$${match.player.aaReloadPrice[def.id]}`,
          `-${def.reloadStep}s`,
          () => match.player.money >= match.player.aaReloadPrice[def.id],
          () => {
            const bought = buyAaReload(match.player, def.id, meta);
            if (bought) this.host.sendOnlineAction({ type: 'aa-reload', batteryType: def.id });
            return bought;
          },
          `${def.name} rate of fire`,
        ),
      ),
    );

    mkRow(
      'Unlock missiles in order / reduce launch reload',
      MISSILES.map((def) => {
        const i = def.tier - 1;
        return upgradeCard(
          missileIcon(def.tier),
          def.roman,
          def.color,
          () => `${missileReload(match.player, def.tier, meta).toFixed(2)}s`,
          () =>
            match.player.missileUnlocked[i] ? `$${match.player.missileReloadPrice[i]}` : `$${def.unlockCost}`,
          '',
          () =>
            (match.player.missileUnlocked[i] || canUnlockMissile(match.player, def.tier)) &&
            match.player.money >=
              (match.player.missileUnlocked[i] ? match.player.missileReloadPrice[i] : def.unlockCost),
          () => {
            if (!match.player.missileUnlocked[i] && !canUnlockMissile(match.player, def.tier)) {
              this.toast(`Unlock ${MISSILES[i - 1].name} ${MISSILES[i - 1].roman} first`);
              return false;
            }
            const bought = buyMissileUpgrade(match.player, def.tier, meta) !== false;
            if (bought) this.host.sendOnlineAction({ type: 'missile-upgrade', tier: def.tier });
            return bought;
          },
          `${def.name} — ${def.damage} damage, ${def.speed} m/s`,
        );
      }),
    );

    // The delta labels on the missile row switch between Unlock and -0.1s.
    // Address the row by its index: it stopped being the last one when the
    // radar-intel row was added below it.
    this.upgradeUpdates.push(() => {
      const missileRow = wrap.querySelector('[data-upgrade-row="2"]');
      if (!missileRow) return;
      missileRow.querySelectorAll('.card').forEach((card, i) => {
        const d = card.querySelector('.delta') as HTMLElement;
        const unlocked = match.player.missileUnlocked[i];
        const reachable = canUnlockMissile(match.player, i + 1);
        d.textContent = unlocked ? `-${MISSILES[i].reloadStep}s` : reachable ? 'Unlock' : 'Locked';
        d.style.color = unlocked ? '#1a9c46' : reachable ? '#0d7a35' : '#8a5a1c';
      });
    });

    const intel = el('button', 'card split');
    intel.title = 'Their radar dishes are camouflaged. Buy this once and they are drawn like every other battery.';
    const intelArt = el('div', 'art', aaIcon(0));
    const intelMeta = el('div', 'meta');
    const intelCost = el('div', 'cost');
    const intelDelta = el('div', 'delta', 'Once');
    const intelTier = el('div', 'tier', '?');
    const intelRing = el('div', 'ring');
    intelRing.style.background = AA[0].color;
    intel.append(intelArt, intelMeta, intelTier, intelCost, intelDelta, intelRing);
    intel.addEventListener('click', () => {
      if (match.player.radarIntel) {
        audio.deny();
        this.toast('Enemy radars are already visible');
        return;
      }
      if (buyRadarIntel(match.player)) {
        this.host.sendOnlineAction({ type: 'radar-intel' });
        audio.buy();
        this.toast('Enemy radars revealed');
      } else {
        audio.deny();
        this.toast('Not enough cash');
      }
    });
    this.upgradeUpdates.push(() => {
      const owned = match.player.radarIntel;
      intelMeta.textContent = owned ? 'Revealed' : 'Hidden';
      intelCost.textContent = owned ? 'OWNED' : `$${RADAR_INTEL_COST}`;
      intelDelta.textContent = owned ? 'Active' : 'Once';
      intel.classList.toggle('dim', owned || match.player.money < RADAR_INTEL_COST);
    });
    mkRow('Reveal enemy radar positions', [intel]);

    const legend = el('div', 'legend');
    legend.innerHTML = AA.map(
      (d) =>
        `<div class="li"><span class="sw" style="background:${d.color}"></span>${d.interceptsTier === 0 ? 'Radar' : `${d.name} ${d.roman}`}</div>`,
    ).join('');
    wrap.appendChild(legend);
    const note = el(
      'p',
      'sub',
      'Anti-air tier Ⅰ–Ⅴ only stops the matching missile tier, except THAAD, which is the ' +
        'one system fast enough to also catch a Bunker Buster. Prices rise with every purchase, ' +
        'and everything here resets at the end of the match — permanent upgrades live in the Star Shop.',
    );
    wrap.appendChild(note);

    this.overlay.appendChild(wrap);
    this.highlightUpgradeRow();
  }
}

export { money as formatMoney, clock as formatClock };
export { ICON_CLOCK };
