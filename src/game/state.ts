import {
  AA,
  AA_MAX_PER_TYPE,
  AA_SITE_SNAP,
  AA_STACK_LIMIT,
  BUILDINGS,
  BOTS,
  BOT_NAMES,
  MATCH,
  META,
  MISSILES,
  RADAR_INTEL_COST,
  UPGRADE_COST_CAP_MULT,
  UPGRADE_COST_GROWTH,
  WORLD,
  type Difficulty,
} from '../core/config';
import type {
  AaBattery,
  Building,
  FloatingText,
  Interceptor,
  MetaSave,
  Missile,
  Particle,
  Phase,
  QueuedShot,
  Side,
  SideState,
} from '../core/types';

let uidCounter = 1;
export const nextUid = (): number => uidCounter++;

export interface Match {
  mode: 'bot' | 'online';
  phase: Phase;
  difficulty: Difficulty;
  /** Seconds elapsed since the match started. */
  time: number;
  duration: number;
  /** Seconds between building-cap increases, scaled to the match length. */
  limitStep: number;
  /** Accumulator for the 2-second income tick. */
  incomeAcc: number;
  player: SideState;
  enemy: SideState;
  missiles: Missile[];
  interceptors: Interceptor[];
  particles: Particle[];
  texts: FloatingText[];
  /** Screen shake magnitude, decays every frame. */
  shake: number;
  /** Bot bookkeeping. */
  botThinkAcc: number;
  botSalvoAcc: number;
  result: null | {
    won: boolean;
    stars: number;
    playerValue: number;
    enemyValue: number;
    reason: string;
    /** Set when the opponent's client called it, so we do not echo it back. */
    fromOpponent?: boolean;
  };
  /** Set once the peace-timer siren has played. */
  peaceAnnounced: boolean;
  lastLimitStep: number;
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

/** Deterministic pseudo-random in [0,1) from an integer seed. */
export function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const SLOTS_PER_LAYER = 40;

/** Candidate plots across one layer of a side's land. */
function citySlots(side: Side, layer: 0 | 1): { x: number }[] {
  const zone = side === 'player' ? WORLD.cityRight : WORLD.cityLeft;
  const width = zone.x1 - zone.x0;
  const step = width / SLOTS_PER_LAYER;
  const inset = layer === 0 ? step * 0.5 : 0;
  const out: { x: number }[] = [];
  for (let i = 0; i < SLOTS_PER_LAYER; i++) {
    out.push({ x: zone.x0 + inset + (i / (SLOTS_PER_LAYER - 1)) * (width - inset * 2) });
  }
  return out;
}

export function buildingLayer(type: number): 0 | 1 {
  return type >= 4 ? 0 : 1;
}

export interface BuildingPlacement {
  x: number;
  layer: 0 | 1;
  clears: Building | null;
}

/** Snap a pointer position to the nearest usable plot for this building type. */
export function buildingPlacementAt(state: SideState, type: number, x: number): BuildingPlacement | null {
  const zone = state.side === 'player' ? WORLD.cityRight : WORLD.cityLeft;
  if (x < zone.x0 || x > zone.x1) return null;
  const layer = buildingLayer(type);
  const slot = citySlots(state.side, layer).reduce((best, candidate) =>
    Math.abs(candidate.x - x) < Math.abs(best.x - x) ? candidate : best,
  );
  const occupant = state.buildings.find(
    (building) => building.layer === layer && Math.round(building.x) === Math.round(slot.x),
  );
  if (occupant && !occupant.destroyed) return null;
  return { x: slot.x, layer, clears: occupant ?? null };
}

/**
 * Picks a random free plot in the side's own land. Tall types live on the back
 * layer and short ones at the front purely so the skyline never hides itself;
 * within a layer the position is genuinely random.
 */
function pickSlot(state: SideState, type: number): { x: number; layer: 0 | 1; clears: Building | null } {
  const layer = buildingLayer(type);
  const slots = citySlots(state.side, layer);
  const occupied = new Map<number, Building>();
  for (const b of state.buildings) {
    if (b.layer !== layer) continue;
    occupied.set(Math.round(b.x), b);
  }

  const free = slots.filter((sl) => !occupied.has(Math.round(sl.x)));
  if (free.length) {
    const pick = free[Math.floor(Math.random() * free.length)];
    return { x: pick.x, layer, clears: null };
  }

  // Every plot is taken; build on a levelled one and clear its rubble.
  const rubbled = slots
    .map((sl) => occupied.get(Math.round(sl.x)))
    .filter((b): b is Building => !!b && b.destroyed);
  if (rubbled.length) {
    const pick = rubbled[Math.floor(Math.random() * rubbled.length)];
    return { x: pick.x, layer, clears: pick };
  }
  const any = slots[Math.floor(Math.random() * slots.length)];
  return { x: any.x, layer, clears: null };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function makeSide(side: Side, name: string): SideState {
  return {
    side,
    name,
    money: MATCH.startingMoney,
    buildings: [],
    batteries: [],
    aaOwned: AA.map(() => 0),
    ammo: AA.map(() => 0),
    aaRadiusBonus: AA.map(() => 0),
    aaReloadBonus: AA.map(() => 0),
    aaRadiusPrice: AA.map((d) => d.radiusUpgradeCost),
    aaReloadPrice: AA.map((d) => d.reloadUpgradeCost),
    missileUnlocked: MISSILES.map((m) => m.unlockCost === 0),
    missileReloadBonus: MISSILES.map(() => 0),
    missileReloadPrice: MISSILES.map((m) => m.reloadUpgradeCost),
    launchCooldown: MISSILES.map(() => 0),
    shotsUsed: MISSILES.map(() => 0),
    radarIntel: false,
    pending: [],
    queued: [],
    wipeoutTimer: 0,
    stats: { launched: 0, intercepted: 0, hits: 0, destroyedBuildings: 0, destroyedBatteries: 0, valueDestroyed: 0, spent: 0, earned: 0 },
  };
}

export function createMatch(difficulty: Difficulty, durationSeconds: number): Match {
  const botName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
  return {
    mode: 'bot',
    phase: 'playing',
    difficulty,
    time: 0,
    duration: durationSeconds,
    limitStep: MATCH.limitStepFor(durationSeconds),
    incomeAcc: 0,
    player: makeSide('player', 'You'),
    enemy: makeSide('enemy', botName),
    missiles: [],
    interceptors: [],
    particles: [],
    texts: [],
    shake: 0,
    botThinkAcc: 0,
    botSalvoAcc: 0,
    result: null,
    peaceAnnounced: false,
    lastLimitStep: 0,
  };
}

/** Creates the mirrored local view used by both players in an online match. */
export function createOnlineMatch(opponentName: string, durationSeconds: number, elapsedSeconds = 0): Match {
  const match = createMatch('medium', durationSeconds);
  match.mode = 'online';
  match.enemy.name = opponentName;
  match.time = Math.max(0, Math.min(durationSeconds - 0.1, elapsedSeconds));
  match.incomeAcc = match.time % MATCH.incomeIntervalSeconds;
  match.lastLimitStep = limitSteps(match);
  return match;
}

// ---------------------------------------------------------------------------
// Derived values (meta upgrades only ever apply to the human player)
// ---------------------------------------------------------------------------

export function buildingLimit(match: Match, type: number): number {
  return BUILDINGS[type].baseLimit + limitSteps(match);
}

export function limitSteps(match: Match): number {
  return Math.min(MATCH.maxLimitSteps, Math.floor(match.time / match.limitStep));
}

export function secondsToNextLimit(match: Match): number {
  const steps = Math.floor(match.time / match.limitStep);
  if (steps >= MATCH.maxLimitSteps) return Infinity;
  return (steps + 1) * match.limitStep - match.time;
}

export function aaRadius(state: SideState, type: number, meta: MetaSave): number {
  const bonus = state.side === 'player' ? meta.radiusLevel[type] * META.radiusStep : 0;
  return AA[type].baseRadius + state.aaRadiusBonus[type] + bonus;
}

export function aaReload(state: SideState, type: number, meta: MetaSave): number {
  const bonus = state.side === 'player' ? meta.aaReloadLevel[type] * META.aaReloadStep : 0;
  return Math.max(META.minReload, AA[type].baseReload - state.aaReloadBonus[type] - bonus);
}

export function missileReload(state: SideState, tier: number, meta: MetaSave): number {
  const i = tier - 1;
  const bonus = state.side === 'player' ? meta.missileReloadLevel[i] * META.missileReloadStep : 0;
  return Math.max(META.minReload, MISSILES[i].reload - state.missileReloadBonus[i] - bonus);
}

/** Sum of the build cost of every standing building — drives the health bar. */
export function cityValue(state: SideState): number {
  let v = 0;
  for (const b of state.buildings) if (!b.destroyed) v += BUILDINGS[b.type].cost;
  return v;
}

export function incomePerTick(state: SideState): number {
  let v = 0;
  for (const b of state.buildings) if (!b.destroyed) v += BUILDINGS[b.type].income;
  return v;
}

export function aaCost(state: SideState, type: number): number {
  const owned = state.aaOwned[type];
  if (owned >= AA_MAX_PER_TYPE) return Infinity;
  return AA[type].costs[Math.min(owned, AA[type].costs.length - 1)];
}

export function hasRadar(state: SideState): boolean {
  return state.aaOwned[0] > 0;
}

/**
 * Enemy radar dishes are camouflaged until this is bought. It is a one-off,
 * unlike the repeatable radius and reload upgrades, so it has no price ramp.
 */
export function buyRadarIntel(state: SideState): boolean {
  if (state.radarIntel) return false;
  if (state.money < RADAR_INTEL_COST) return false;
  state.money -= RADAR_INTEL_COST;
  state.stats.spent += RADAR_INTEL_COST;
  state.radarIntel = true;
  return true;
}

// ---------------------------------------------------------------------------
// Purchases — all return true when the money actually changed hands
// ---------------------------------------------------------------------------

/** Standing buildings of a type — destroyed ones free their slot in the cap. */
export function countBuildings(state: SideState, type: number): number {
  let n = 0;
  for (const b of state.buildings) if (b.type === type && !b.destroyed) n++;
  return n;
}

export function buyBuilding(match: Match, state: SideState, type: number, x?: number): boolean {
  const def = BUILDINGS[type];
  if (countBuildings(state, type) >= buildingLimit(match, type)) return false;
  if (state.money < def.cost) return false;
  const slot = x === undefined ? pickSlot(state, type) : buildingPlacementAt(state, type, x);
  if (!slot) return false;
  state.money -= def.cost;
  state.stats.spent += def.cost;
  if (slot.clears) state.buildings.splice(state.buildings.indexOf(slot.clears), 1);
  const b: Building = {
    uid: nextUid(),
    type,
    side: state.side,
    x: slot.x,
    layer: slot.layer,
    hp: def.hp,
    maxHp: def.hp,
    destroyed: false,
    collapse: 0,
    shake: 0,
    smokeAcc: 0,
    seed: Math.floor(Math.random() * 100000),
  };
  state.buildings.push(b);
  // Keep back-layer buildings first so painting order stays correct.
  state.buildings.sort((p, q) => p.layer - q.layer);
  return true;
}

/** Land a side may site anti-air on. */
export function deployZone(side: Side): { x0: number; x1: number } {
  const zone = side === 'player' ? WORLD.cityRight : WORLD.cityLeft;
  return side === 'player'
    ? { x0: zone.x0 - AA_DEPLOY_MARGIN, x1: zone.x1 }
    : { x0: zone.x0, x1: zone.x1 + AA_DEPLOY_MARGIN };
}

const AA_DEPLOY_MARGIN = 150;

/**
 * Batteries share an emplacement rather than needing room of their own: drop
 * one near an existing site and it joins that site, stacked up to
 * AA_STACK_LIMIT deep. A tight cluster of layered systems is a real thing to
 * want, and the renderer fans a shared site out so nothing hides behind
 * anything else.
 */
export function deploySiteX(state: SideState, x: number): number {
  let best: number | null = null;
  let bestGap = AA_SITE_SNAP;
  for (const b of state.batteries) {
    const gap = Math.abs(b.x - x);
    if (gap <= bestGap) {
      bestGap = gap;
      best = b.x;
    }
  }
  return best ?? x;
}

/** How many systems already stand on the emplacement nearest to x. */
export function stackedAt(state: SideState, x: number): number {
  const site = deploySiteX(state, x);
  return state.batteries.filter((b) => b.x === site).length;
}

export function canDeployAt(state: SideState, x: number, _type?: number): boolean {
  const zone = deployZone(state.side);
  if (!Number.isFinite(x) || x < zone.x0 || x > zone.x1) return false;
  return stackedAt(state, x) < AA_STACK_LIMIT;
}

/**
 * Nothing forbids a tighter cluster any more, but a side placing batteries for
 * itself still spreads them out by this much — scattering cover across the
 * city beats piling it all onto one plot.
 */
export const AA_MIN_SPACING = 56;

/** Places a battery at x. Pass no x for a random spot in the side's own land. */
export function buyBattery(state: SideState, type: number, x?: number): boolean {
  const cost = aaCost(state, type);
  if (!isFinite(cost) || state.money < cost) return false;
  const dropped = x === undefined ? randomDeploySpot(state, type) : x;
  if (dropped === null) return false;
  if (!canDeployAt(state, dropped, type)) return false;
  const at = deploySiteX(state, dropped);
  state.money -= cost;
  state.stats.spent += cost;
  state.aaOwned[type]++;
  const battery: AaBattery = {
    uid: nextUid(),
    type,
    side: state.side,
    x: at,
    hp: AA[type].hp,
    maxHp: AA[type].hp,
    cooldown: 0,
    aim: state.side === 'player' ? -Math.PI * 0.72 : -Math.PI * 0.28,
    recoil: 0,
    shake: 0,
    seed: Math.floor(Math.random() * 100000),
  };
  state.batteries.push(battery);
  return true;
}

/**
 * Where a computer opponent should site a battery: the spot whose coverage
 * takes in the most building value that this tier's existing batteries miss.
 * Scattering them at random leaves holes an attacker walks straight through.
 */
export function bestDeploySpot(state: SideState, type: number, radius: number): number | null {
  const zone = deployZone(state.side);
  const alive = state.buildings.filter((b) => !b.destroyed);
  const sameTier = state.batteries.filter((b) => b.type === type);
  let best: number | null = null;
  let bestScore = -Infinity;
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const x = zone.x0 + ((zone.x1 - zone.x0) * i) / steps;
    if (!canDeployAt(state, x, type) || !spreadOut(state, x)) continue;
    let score = 0;
    for (const b of alive) {
      const d = Math.abs(b.x - x);
      if (d > radius) continue;
      // Value already inside another battery of this tier counts for much less.
      const covered = sameTier.some((o) => Math.abs(b.x - o.x) <= radius);
      score += BUILDINGS[b.type].cost * (covered ? 0.15 : 1);
    }
    // With nothing built yet, favour the middle of the plot.
    if (!alive.length) score = -Math.abs(x - (zone.x0 + zone.x1) / 2);
    if (score > bestScore) {
      bestScore = score;
      best = x;
    }
  }
  return best ?? randomDeploySpot(state, type);
}

function randomDeploySpot(state: SideState, type: number): number | null {
  const zone = deployZone(state.side);
  // Prefer somewhere clear; fall back to sharing a site once the land is full.
  for (let i = 0; i < 60; i++) {
    const x = zone.x0 + Math.random() * (zone.x1 - zone.x0);
    if (spreadOut(state, x) && canDeployAt(state, x, type)) return x;
  }
  for (let i = 0; i < 60; i++) {
    const x = zone.x0 + Math.random() * (zone.x1 - zone.x0);
    if (canDeployAt(state, x, type)) return x;
  }
  return null;
}

function spreadOut(state: SideState, x: number): boolean {
  return state.batteries.every((b) => Math.abs(b.x - x) >= AA_MIN_SPACING);
}

/** Called when a battery is blown up: it frees its slot so it can be replaced. */
export function removeBattery(state: SideState, uid: number): void {
  const i = state.batteries.findIndex((b) => b.uid === uid);
  if (i < 0) return;
  const [dead] = state.batteries.splice(i, 1);
  state.aaOwned[dead.type] = Math.max(0, state.aaOwned[dead.type] - 1);
}

export function buyAmmo(state: SideState, type: number, count: number): number {
  const def = AA[type];
  if (def.interceptsTier === 0) return 0;
  let bought = 0;
  for (let i = 0; i < count; i++) {
    if (state.ammo[type] >= def.ammoCap) break;
    if (state.money < def.ammoCost) break;
    state.money -= def.ammoCost;
    state.stats.spent += def.ammoCost;
    state.ammo[type]++;
    bought++;
  }
  return bought;
}

/** Next price for a repeatable in-match upgrade, capped so it stays payable. */
function bumpPrice(price: number, base: number): number {
  return Math.min(Math.ceil(base * UPGRADE_COST_CAP_MULT), Math.ceil(price * UPGRADE_COST_GROWTH));
}

export function buyAaRadius(state: SideState, type: number): boolean {
  const price = state.aaRadiusPrice[type];
  if (state.money < price) return false;
  state.money -= price;
  state.stats.spent += price;
  state.aaRadiusBonus[type] += AA[type].radiusStep;
  state.aaRadiusPrice[type] = bumpPrice(price, AA[type].radiusUpgradeCost);
  return true;
}

export function buyAaReload(state: SideState, type: number, meta: MetaSave): boolean {
  if (AA[type].interceptsTier === 0) return false;
  if (aaReload(state, type, meta) <= META.minReload) return false;
  const price = state.aaReloadPrice[type];
  if (state.money < price) return false;
  state.money -= price;
  state.stats.spent += price;
  state.aaReloadBonus[type] += AA[type].reloadStep;
  state.aaReloadPrice[type] = bumpPrice(price, AA[type].reloadUpgradeCost);
  return true;
}

/**
 * The tier that has to be unlocked before this one, or null for the first.
 * The arsenal opens up a step at a time rather than letting a saved-up player
 * skip straight to the heaviest warhead.
 */
export function unlockPrerequisite(tier: number): number | null {
  return tier <= 1 ? null : tier - 1;
}

export function canUnlockMissile(state: SideState, tier: number): boolean {
  const previous = unlockPrerequisite(tier);
  return previous === null || state.missileUnlocked[previous - 1];
}

/** Unlocks the tier if locked, otherwise buys a reload reduction. */
export function buyMissileUpgrade(state: SideState, tier: number, meta: MetaSave): 'unlock' | 'reload' | false {
  const i = tier - 1;
  const def = MISSILES[i];
  if (!state.missileUnlocked[i]) {
    if (!canUnlockMissile(state, tier)) return false;
    if (state.money < def.unlockCost) return false;
    state.money -= def.unlockCost;
    state.stats.spent += def.unlockCost;
    state.missileUnlocked[i] = true;
    return 'unlock';
  }
  if (missileReload(state, tier, meta) <= META.minReload) return false;
  const price = state.missileReloadPrice[i];
  if (state.money < price) return false;
  state.money -= price;
  state.stats.spent += price;
  state.missileReloadBonus[i] += def.reloadStep;
  state.missileReloadPrice[i] = bumpPrice(price, def.reloadUpgradeCost);
  return 'reload';
}

// ---------------------------------------------------------------------------
// Targeting queue
// ---------------------------------------------------------------------------

export function shotsRemaining(state: SideState, tier: number): number {
  const def = MISSILES[tier - 1];
  if (def.perMatchLimit === 0) return Infinity;
  const committed = state.queued.filter((q) => q.tier === tier).length + state.pending.filter((q) => q.tier === tier).length;
  return def.perMatchLimit - state.shotsUsed[tier - 1] - committed;
}

export function pinTarget(state: SideState, tier: number, x: number): QueuedShot | null {
  const def = MISSILES[tier - 1];
  if (!state.missileUnlocked[tier - 1]) return null;
  if (shotsRemaining(state, tier) <= 0) return null;
  if (state.money < def.cost) return null;
  state.money -= def.cost;
  state.stats.spent += def.cost;
  const shot: QueuedShot = { uid: nextUid(), tier, x, cost: def.cost };
  state.queued.push(shot);
  return shot;
}

export function unpinLast(state: SideState, tier?: number): boolean {
  for (let i = state.queued.length - 1; i >= 0; i--) {
    if (tier === undefined || state.queued[i].tier === tier) {
      const [shot] = state.queued.splice(i, 1);
      state.money += shot.cost;
      state.stats.spent -= shot.cost;
      return true;
    }
  }
  return false;
}

export function clearQueue(state: SideState): void {
  for (const q of state.queued) {
    state.money += q.cost;
    state.stats.spent -= q.cost;
  }
  state.queued.length = 0;
}

/** Commits every pinned target; they then launch as each tier's launcher reloads. */
export function commitQueue(state: SideState): number {
  const n = state.queued.length;
  state.pending.push(...state.queued);
  state.queued.length = 0;
  return n;
}

// ---------------------------------------------------------------------------
// Match-level helpers
// ---------------------------------------------------------------------------

export function inPeace(match: Match): boolean {
  return match.time < MATCH.peaceSeconds;
}

export function opposing(match: Match, side: Side): SideState {
  return side === 'player' ? match.enemy : match.player;
}

export function ownSide(match: Match, side: Side): SideState {
  return side === 'player' ? match.player : match.enemy;
}

/**
 * x of the launch pad for a side — behind its own city, on the far side from
 * the enemy, so rockets rise over their own skyline instead of in front of it.
 */
export function launchPadX(side: Side): number {
  return side === 'player' ? WORLD.cityRight.x1 + PAD_SETBACK : WORLD.cityLeft.x0 - PAD_SETBACK;
}

/**
 * Where the pad used to sit, in front of the city. Flight times are still
 * measured from here so moving the launchers back did not slow every rocket
 * down — the longer route is flown in the same number of seconds.
 */
export function launchPadReferenceX(side: Side): number {
  return side === 'player' ? WORLD.cityRight.x0 - PAD_SETBACK : WORLD.cityLeft.x1 + PAD_SETBACK;
}

const PAD_SETBACK = 90;

export function difficultyProfile(match: Match) {
  return BOTS[match.difficulty];
}
