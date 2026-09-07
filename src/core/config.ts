/**
 * Final Skyline — all tunable game data lives here.
 * Distances are in "metres" which map 1:1 to world units.
 */

export const WORLD = {
  /** Total battlefield width in world units. */
  width: 3700,
  /** Y of the ground line, measured from the top of the world. */
  groundY: 620,
  height: 700,
  /** Player city occupies [cityRight.x0, cityRight.x1]. */
  cityRight: { x0: 1980, x1: 3580 },
  cityLeft: { x0: 120, x1: 1720 },
};

export const MATCH = {
  /** Seconds of peace at the start of a match — nobody may fire. */
  peaceSeconds: 120,
  /**
   * Every N seconds every building limit goes up by one. Short matches scale
   * this down so a 5-minute game still reaches a couple of steps.
   */
  limitStepSeconds: 420, // 7 minutes, at the default 15-minute length
  limitStepFor: (durationSeconds: number): number =>
    !isFinite(durationSeconds) || durationSeconds >= 900 ? 420 : Math.round(durationSeconds / 4),
  /** Max +N added to every building cap over a match. */
  maxLimitSteps: 4,
  /** Income tick length in seconds. */
  incomeIntervalSeconds: 2,
  startingMoney: 50,
  /** Default match length in seconds; overridable from the main menu. */
  durationSeconds: 900, // 15 minutes
  /** With no buildings and no money to rebuild for this long, you lose. */
  wipeoutGraceSeconds: 5,
  /** Length of one day/night cycle in an unlimited match. */
  unlimitedCycleSeconds: 480,
  /**
   * Online only. A win by wipeout is announced by the side that was wiped out,
   * because each browser runs its own copy of the fight and only really knows
   * what happened to its own city. This is how long the other player waits for
   * that word before claiming the win anyway — long enough to cover a slow
   * connection, short enough that a browser closed mid-match does not strand
   * the winner in a match nobody can end.
   */
  opponentSilenceSeconds: 15,
  /**
   * The simulation always advances in steps of exactly this length, however
   * fast the browser is painting. Two players on different machines must tread
   * the same ground or their copies of the battle drift apart — a warhead one
   * of them shot down lands on the other.
   */
  stepSeconds: 1 / 60,
  /** Extra steps a frame may run to make up a short stall, beyond its own share. */
  maxStepsPerFrame: 8,
  /**
   * Online only. How often each player broadcasts the true state of their own
   * city. Whatever the other browser worked out for itself, this is the version
   * that counts: a player is the only one who can say what is still standing on
   * their own land.
   */
  citySyncSeconds: 2,
};

/**
 * Match lengths the online matchmaker keeps a queue for. 0 is the unlimited
 * bucket — the database stores it as 0 because it has no finite length.
 */
export const ONLINE_DURATIONS = [300, 600, 900, 0];

/** Snaps a menu selection onto the queue bucket it will actually search. */
export function onlineDuration(durationSeconds: number): number {
  if (!isFinite(durationSeconds)) return 0;
  return ONLINE_DURATIONS.includes(durationSeconds) ? durationSeconds : 600;
}

export function onlineDurationLabel(duration: number): string {
  return duration === 0 ? 'Unlimited' : `${duration / 60} min`;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export interface BuildingDef {
  id: number;
  name: string;
  cost: number;
  /** Money produced every income tick (2s). */
  income: number;
  hp: number;
  /** Base cap; raised by MATCH.limitStepSeconds. */
  baseLimit: number;
  /** Drawing footprint. */
  w: number;
  h: number;
  /** Rows of windows drawn on the facade. */
  windowRows: number;
  windowCols: number;
  /** Roof silhouette style. */
  roof: 'flat' | 'step' | 'spire' | 'antenna' | 'slant';
}

export const BUILDINGS: BuildingDef[] = [
  { id: 0, name: 'Shop Row',    cost: 2,  income: 0.2, hp: 15,  baseLimit: 6, w: 46, h: 34,  windowRows: 2, windowCols: 4, roof: 'flat' },
  { id: 1, name: 'Apartments',  cost: 4,  income: 0.45, hp: 30,  baseLimit: 6, w: 44, h: 54,  windowRows: 4, windowCols: 4, roof: 'flat' },
  { id: 2, name: 'Office Block',cost: 6,  income: 0.7, hp: 45,  baseLimit: 5, w: 42, h: 76,  windowRows: 6, windowCols: 4, roof: 'step' },
  { id: 3, name: 'Tower',       cost: 10, income: 1.2, hp: 60,  baseLimit: 5, w: 38, h: 104, windowRows: 8, windowCols: 3, roof: 'flat' },
  { id: 4, name: 'High Rise',   cost: 16, income: 2.0, hp: 90,  baseLimit: 4, w: 40, h: 136, windowRows: 10, windowCols: 3, roof: 'step' },
  { id: 5, name: 'Plaza Tower', cost: 24, income: 3.1, hp: 135, baseLimit: 4, w: 44, h: 172, windowRows: 12, windowCols: 3, roof: 'slant' },
  { id: 6, name: 'Skytower',    cost: 34, income: 4.5, hp: 240, baseLimit: 3, w: 46, h: 214, windowRows: 14, windowCols: 3, roof: 'antenna' },
  { id: 7, name: 'Landmark',    cost: 46, income: 6.2, hp: 360, baseLimit: 3, w: 44, h: 262, windowRows: 17, windowCols: 3, roof: 'spire' },
  { id: 8, name: 'Megatower',   cost: 60, income: 8.2, hp: 600, baseLimit: 3, w: 42, h: 320, windowRows: 21, windowCols: 3, roof: 'spire' },
];

// ---------------------------------------------------------------------------
// Attack missiles (ICBM)
// ---------------------------------------------------------------------------

export interface MissileDef {
  tier: number; // 1..6
  name: string;
  roman: string;
  /** Cost to queue one shot. */
  cost: number;
  /** Base reload in seconds between shots of this tier. */
  reload: number;
  /** World units per second along the flight arc. */
  speed: number;
  damage: number;
  /** Blast radius; buildings inside take falloff damage. */
  blast: number;
  /** Cost in dollars to unlock during a match. 0 = unlocked from the start. */
  unlockCost: number;
  /** In-match purchase that shaves reload; cost grows each time. */
  reloadUpgradeCost: number;
  reloadStep: number;
  /** No same-tier battery exists; only a system listing this tier in `alsoIntercepts` can touch it. */
  unstoppable?: boolean;
  /**
   * Flight path. 'arc' is the original single parabola, kept low enough to
   * stay in shot the whole way. 'lofted' is a hard climb to an apex far above
   * the top of the screen and a steep dive back onto the target — the heavy
   * tiers leave the view entirely and come down like a meteorite.
   */
  route: 'arc' | 'lofted';
  /** Hard cap of shots per match (0 = unlimited). */
  perMatchLimit: number;
  color: string;
  length: number;
}

export const MISSILES: MissileDef[] = [
  { tier: 1, name: 'Scud',      roman: 'I',   cost: 1.5, reload: 5.0, speed: 255, damage: 15,   blast: 16, unlockCost: 0,   reloadUpgradeCost: 5,   reloadStep: 0.1, perMatchLimit: 0, color: '#c8d2dc', length: 15, route: 'arc' },
  { tier: 2, name: 'Tochka',    roman: 'II',  cost: 4,   reload: 5.0, speed: 340, damage: 45,   blast: 22, unlockCost: 10,  reloadUpgradeCost: 10,  reloadStep: 0.1, perMatchLimit: 0, color: '#a9c6a2', length: 18, route: 'arc' },
  { tier: 3, name: 'Iskander',  roman: 'III', cost: 8,   reload: 5.0, speed: 460, damage: 120,  blast: 30, unlockCost: 30,  reloadUpgradeCost: 22,  reloadStep: 0.1, perMatchLimit: 0, color: '#8fa8bf', length: 22, route: 'arc' },
  { tier: 4, name: 'Topol',     roman: 'IV',  cost: 15,  reload: 5.0, speed: 560, damage: 300,  blast: 40, unlockCost: 80,  reloadUpgradeCost: 40,  reloadStep: 0.1, perMatchLimit: 0, color: '#d8d8d8', length: 26, route: 'lofted' },
  { tier: 5, name: 'Satan II',  roman: 'V',   cost: 30,  reload: 5.0, speed: 1500, damage: 700, blast: 55, unlockCost: 120, reloadUpgradeCost: 65,  reloadStep: 0.1, perMatchLimit: 0, color: '#3f4750', length: 30, route: 'lofted' },
  { tier: 6, name: 'Bunker Buster', roman: 'VI', cost: 80, reload: 5.0, speed: 3600, damage: 1500, blast: 95, unlockCost: 600, reloadUpgradeCost: 300, reloadStep: 0.1, unstoppable: true, perMatchLimit: 0, color: '#6d6a4f', length: 34, route: 'lofted' },
];

// ---------------------------------------------------------------------------
// Anti-air systems — index 0 is the radar, 1..5 intercept missile tiers 1..5
// ---------------------------------------------------------------------------

export interface AaDef {
  id: number;
  name: string;
  roman: string;
  /** Missile tier this system can intercept. 0 = radar, intercepts nothing. */
  interceptsTier: number;
  /** Cost of the 1st and 2nd unit. */
  costs: [number, number];
  baseRadius: number;
  /** Seconds between interceptor launches from one battery. */
  baseReload: number;
  /** In-match radius upgrade. */
  radiusUpgradeCost: number;
  radiusStep: number;
  /** In-match reload upgrade (radar has none). */
  reloadUpgradeCost: number;
  reloadStep: number;
  /** Cost of one interceptor round for this battery. */
  ammoCost: number;
  ammoCap: number;
  /** Batteries are destructible; heavier systems are better armoured. */
  hp: number;
  /** Unique ring / tracer colour (requirement 6). */
  color: string;
  /**
   * Extra missile tiers this system can engage on top of `interceptsTier`.
   * Only the heaviest battery gets one, so the top attack tier stays rare but
   * not literally unanswerable.
   */
  alsoIntercepts?: number[];
  /** Interceptor speed as a multiple of the target's; defaults to INTERCEPTOR_SPEED_FACTOR. */
  speedFactor?: number;
}

export const AA: AaDef[] = [
  { id: 0, name: 'Radar',   roman: '',    interceptsTier: 0, costs: [0, 30],  baseRadius: 260, baseReload: 0,   radiusUpgradeCost: 11, radiusStep: 10, reloadUpgradeCost: 0,  reloadStep: 0,    ammoCost: 0,  ammoCap: 0, hp: 220, color: '#7de3ff' },
  { id: 1, name: 'Avenger', roman: 'I',   interceptsTier: 1, costs: [0, 18],  baseRadius: 175, baseReload: 5.0, radiusUpgradeCost: 14, radiusStep: 5,  reloadUpgradeCost: 4,  reloadStep: 0.05, ammoCost: 2,  ammoCap: 100, hp: 260, color: '#ffd23f' },
  { id: 2, name: 'Hawk',    roman: 'II',  interceptsTier: 2, costs: [25, 40], baseRadius: 205, baseReload: 5.0, radiusUpgradeCost: 12, radiusStep: 5,  reloadUpgradeCost: 6,  reloadStep: 0.05, ammoCost: 4,  ammoCap: 100, hp: 330, color: '#59e07a' },
  { id: 3, name: 'Patriot', roman: 'III', interceptsTier: 3, costs: [35, 55], baseRadius: 250, baseReload: 5.0, radiusUpgradeCost: 17, radiusStep: 5,  reloadUpgradeCost: 8,  reloadStep: 0.05, ammoCost: 7,  ammoCap: 100, hp: 410, color: '#ff8b3d' },
  { id: 4, name: 'S-400',   roman: 'IV',  interceptsTier: 4, costs: [50, 80], baseRadius: 310, baseReload: 5.0, radiusUpgradeCost: 22, radiusStep: 5,  reloadUpgradeCost: 14, reloadStep: 0.05, ammoCost: 13, ammoCap: 100, hp: 520, color: '#c46bff' },
  { id: 5, name: 'THAAD',   roman: 'V',   interceptsTier: 5, costs: [70, 110],baseRadius: 390, baseReload: 5.0, radiusUpgradeCost: 26, radiusStep: 5,  reloadUpgradeCost: 18, reloadStep: 0.05, ammoCost: 26, ammoCap: 100, hp: 650, color: '#ff5470', alsoIntercepts: [6], speedFactor: 2.6 },
];

/**
 * Apex of a lofted shot, in world y. Well above the top of the world, so the
 * warhead is out of sight for the middle of its flight in either zoom level.
 */
export const LOFT_APEX_Y = -1400;

/**
 * Where along the ground run the apex sits. Well past halfway, so the dive is
 * far steeper than the climb and the warhead comes down near-vertically —
 * steeply enough to drop past a neighbouring tower onto the plot beside it.
 */
export const LOFT_APEX_SHARE = 0.8;

/**
 * A lofted shot leaves the pad straight up before tipping over, so it clears
 * the launching side's own skyline instead of flying through it.
 */
export const LOFT_RISE = 360;

export const AA_MAX_PER_TYPE = 2;

/** Whether an anti-air system is allowed to engage a given missile tier. */
export function canIntercept(def: AaDef, tier: number): boolean {
  if (def.interceptsTier === 0) return false;
  return def.interceptsTier === tier || (def.alsoIntercepts?.includes(tier) ?? false);
}

/**
 * Enemy radar dishes are camouflaged until this in-match upgrade is bought.
 * A one-off purchase, unlike the repeatable radius and reload upgrades.
 */
export const RADAR_INTEL_COST = 1500;

/** Interceptor flight speed as a multiple of the incoming missile's speed. */
export const INTERCEPTOR_SPEED_FACTOR = 1.4;
export const INTERCEPTOR_MIN_SPEED = 480;
/**
 * A battery will not take a shot it can only complete below this height — the
 * reason missiles aimed at thinly covered parts of a city get through. It is
 * the ceiling for a warhead dropping vertically; a shallow arc coming in on a
 * long, flat approach is judged against a proportionally lower one, or a
 * short-range battery could not defend the plot it is standing on.
 */
export const MIN_INTERCEPT_ALTITUDE = 95;

/** Share of that ceiling that applies however flat the approach is. */
export const FLAT_APPROACH_ALTITUDE_SHARE = 0.35;

/**
 * A shot must resolve at least this long before the warhead lands. Measured in
 * seconds rather than as a share of the flight, so it means the same thing for
 * a Scud loafing across the map and for a Bunker Buster covering it in 0.75s.
 */
export const MIN_INTERCEPT_LEAD = 0.04;

/**
 * Every repeat purchase of an in-match upgrade multiplies its price by this,
 * up to UPGRADE_COST_CAP_MULT times the opening price — without the cap the
 * late-match tiers priced themselves out of reach.
 */
export const UPGRADE_COST_GROWTH = 1.16;
export const UPGRADE_COST_CAP_MULT = 8;
/** Repeat purchases of a *building* do not get more expensive (matches the original). */

// ---------------------------------------------------------------------------
// Meta progression (stars, spent in the main-menu shop)
// ---------------------------------------------------------------------------

export const META = {
  /** Stars awarded for a win / a loss. */
  winStars: 3,
  lossStars: 1,
  /** Extra stars for a dominant win, scaled by final city-value share. */
  dominanceBonus: 3,
  /** Star shop. */
  radiusStep: 5, // +5 m per level
  radiusMaxLevel: 20,
  radiusCost: (level: number) => 2 + level * 2,
  missileReloadStep: 0.25, // -0.25 s per level
  missileReloadMaxLevel: 12,
  missileReloadCost: (level: number) => 3 + level * 3,
  aaReloadStep: 0.1, // -0.1 s per level
  aaReloadMaxLevel: 12,
  aaReloadCost: (level: number) => 3 + level * 2,
  /** Reload can never drop below this. */
  minReload: 0.6,
};

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface BotProfile {
  label: string;
  blurb: string;
  /** Multiplier on income. */
  incomeMult: number;
  /** Seconds between bot decisions. */
  thinkInterval: number;
  /** Chance a decision tick is used instead of being fumbled. */
  decisionChance: number;
  /** Share of spare cash the bot is willing to sink into defence. */
  defenceBudget: number;
  /** Share of spare cash spent on offence once the peace ends. */
  offenceBudget: number;
  /** How many missiles it fires per salvo. */
  salvoMin: number;
  salvoMax: number;
  /** Minimum seconds between salvos. */
  salvoGap: number;
  /** Aiming error in world units — lower is deadlier. */
  aimError: number;
  /** 0..1 — probability it picks your most valuable building as a target. */
  smartTargeting: number;
  /** Highest missile tier it will ever unlock. */
  maxTier: number;
  /** Seconds after peace ends before its first salvo. */
  firstStrikeDelay: number;
  /** How eagerly it stocks interceptors (rounds it aims to keep per battery). */
  ammoTarget: number;
  /** Maximum number of each free opening defence it claims. */
  freeDefenceLimit: number;
}

export const BOTS: Record<Difficulty, BotProfile> = {
  easy: {
    label: 'Easy',
    blurb: 'Builds steadily, fires light missiles, aims badly.',
    incomeMult: 0.65,
    thinkInterval: 2.5,
    decisionChance: 0.8,
    defenceBudget: 0.12,
    offenceBudget: 0.16,
    salvoMin: 1,
    salvoMax: 1,
    salvoGap: 8,
    aimError: 175,
    smartTargeting: 0,
    maxTier: 1,
    firstStrikeDelay: 10,
    ammoTarget: 2,
    freeDefenceLimit: 1,
  },
  medium: {
    label: 'Medium',
    blurb: 'Balanced economy, keeps a real air defence up.',
    incomeMult: 1.0,
    thinkInterval: 1.8,
    decisionChance: 0.9,
    defenceBudget: 0.38,
    offenceBudget: 0.48,
    salvoMin: 2,
    salvoMax: 5,
    salvoGap: 5,
    aimError: 34,
    smartTargeting: 0.5,
    maxTier: 5,
    firstStrikeDelay: 4,
    ammoTarget: 18,
    freeDefenceLimit: 2,
  },
  hard: {
    label: 'Hard',
    blurb: 'Rushes economy, layered defence, hunts your best towers.',
    incomeMult: 1.3,
    thinkInterval: 0.9,
    decisionChance: 1,
    defenceBudget: 0.42,
    offenceBudget: 0.7,
    salvoMin: 5,
    salvoMax: 12,
    salvoGap: 3,
    aimError: 12,
    smartTargeting: 0.9,
    maxTier: 6,
    firstStrikeDelay: 2,
    ammoTarget: 32,
    freeDefenceLimit: 2,
  },
};

export const BOT_NAMES = [
  'Larry Turner', 'Ivan Petrov', 'Cole Barnes', 'Mira Vasquez', 'Dain Okoro',
  'Kaya Lindqvist', 'Ruslan Aliyev', 'Nadia Farouk', 'Tomas Reyes', 'Ada Ghali',
];

export const BARRAGE = { cost: 2000, interval: 150, rockets: 24, shotInterval: 0.5, travelSeconds: 12, elevationSeconds: 1.5 } as const;
