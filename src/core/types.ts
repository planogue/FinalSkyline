import type { Difficulty } from './config';

export type Side = 'player' | 'enemy';

export interface Building {
  uid: number;
  type: number;
  side: Side;
  /** World x of the building's horizontal centre. */
  x: number;
  /** Back row buildings are drawn behind and darker. */
  layer: 0 | 1;
  hp: number;
  maxHp: number;
  /** Set once hp hits 0; the rubble stays on the map. */
  destroyed: boolean;
  /** Seconds since destruction, for the collapse animation. */
  collapse: number;
  /** Shake amount from a recent near miss. */
  shake: number;
  /** Drives the smoke plume that a damaged building keeps putting out. */
  smokeAcc: number;
  /** Deterministic per-building window seed. */
  seed: number;
}

export interface AaBattery {
  uid: number;
  type: number; // index into AA
  side: Side;
  x: number;
  hp: number;
  maxHp: number;
  /** Shake from a recent near miss. */
  shake: number;
  /** Seconds until this battery can fire again. */
  cooldown: number;
  /** Barrel angle in radians, for the turret animation. */
  aim: number;
  /** Recoil animation timer. */
  recoil: number;
  seed: number;
}

export interface Missile {
  uid: number;
  side: Side; // who fired it
  tier: number; // 1..6
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Launch and target points, used to shape the ballistic arc. */
  x0: number;
  y0: number;
  tx: number;
  ty: number;
  /** 0..1 progress along the arc. */
  t: number;
  /** Total flight time in seconds. */
  flightTime: number;
  speed: number;
  damage: number;
  blast: number;
  dead: boolean;
  /** Set when an interceptor has already been committed to this missile. */
  targetedBy: number;
  trail: { x: number; y: number; a: number }[];
}

export interface Interceptor {
  uid: number;
  side: Side;
  type: number; // AA index
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  targetUid: number;
  life: number;
  dead: boolean;
  trail: { x: number; y: number; a: number }[];
}

export type ParticleKind = 'spark' | 'smoke' | 'fire' | 'debris' | 'ring' | 'flash';

export interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  gravity: number;
  rot?: number;
  vrot?: number;
}

export interface FloatingText {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
  maxLife: number;
}

/** A target the player has pinned but not yet launched. */
export interface QueuedShot {
  uid: number;
  tier: number;
  x: number;
  cost: number;
}

export interface SideState {
  side: Side;
  name: string;
  money: number;
  buildings: Building[];
  batteries: AaBattery[];
  /** Owned count per AA type. */
  aaOwned: number[];
  /** Interceptor rounds in stock per AA type. */
  ammo: number[];
  /** Extra radius bought during this match, per AA type. */
  aaRadiusBonus: number[];
  /** Reload seconds shaved during this match, per AA type. */
  aaReloadBonus: number[];
  /** Live price of the next in-match radius / reload upgrade. */
  aaRadiusPrice: number[];
  aaReloadPrice: number[];
  /** Which attack tiers are unlocked. */
  missileUnlocked: boolean[];
  /** Reload seconds shaved this match, per attack tier. */
  missileReloadBonus: number[];
  missileReloadPrice: number[];
  /** Seconds until each attack tier can launch again. */
  launchCooldown: number[];
  /** Shots of each tier already used, for per-match limits. */
  shotsUsed: number[];
  /** Bought the intel upgrade that reveals the opponent's camouflaged radars. */
  radarIntel: boolean;
  /** Pending launches waiting for their tier's launcher to free up. */
  pending: QueuedShot[];
  /** Targets pinned but not yet committed with Fight. */
  queued: QueuedShot[];
  /** Seconds this side has been unable to field a single building. */
  wipeoutTimer: number;
  /** Running totals for the post-match summary. */
  stats: {
    launched: number;
    intercepted: number;
    hits: number;
    destroyedBuildings: number;
    destroyedBatteries: number;
    /** Build value of enemy property this side has flattened. */
    valueDestroyed: number;
    spent: number;
    earned: number;
  };
}

export type Phase = 'menu' | 'playing' | 'paused' | 'over';

export type PanelId = 'none' | 'upgrades' | 'buildings' | 'antiair' | 'abm' | 'icbm';

export interface MetaSave {
  stars: number;
  /** Star-shop levels. */
  radiusLevel: number[]; // per AA type (6)
  aaReloadLevel: number[]; // per AA type 1..5 (index 0 unused)
  missileReloadLevel: number[]; // per missile tier (6)
  wins: number;
  losses: number;
  muted: boolean;
  bestDifficulty: Difficulty | null;
}
