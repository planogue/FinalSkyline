/**
 * Each browser runs the whole battle, so each one's copy of the *opponent's*
 * city is only ever guesswork: two machines painting at different rates sample
 * a missile's flight differently, and a warhead one of them shot down lands on
 * the other. Left alone that gap widens all match, until the two players are
 * fighting visibly different wars.
 *
 * So a player periodically states the truth about their own land — what is
 * standing, how battered it is, what defends it, what it can afford — and the
 * other browser takes their word for it over its own arithmetic. Nobody is
 * better placed to say what is left of your city than you are.
 *
 * The wire format is deliberately terse: tuples of plain numbers rather than
 * named fields, because this goes out every couple of seconds for the length of
 * a match.
 */
import { AA, BUILDINGS, WORLD } from '../core/config';
import type { Building, SideState } from '../core/types';
import { nextUid } from '../game/state';

/** `[type, x, hp as a percentage]`. */
type Unit = [number, number, number];

export interface CitySnapshot {
  /** Buildings, levelled ones included — their rubble still holds the plot. */
  b: Unit[];
  /** Anti-air, in the order it was sited. */
  a: Unit[];
  /** Interceptor rounds in stock, per system. */
  r: number[];
  /** Cash, which gates whether their next command can be believed. */
  m: number;
}

const MAX_UNITS = 120;

export function captureCity(state: SideState): CitySnapshot {
  return {
    b: state.buildings.map((b) => [b.type, Math.round(b.x), percent(b.hp, b.maxHp)]),
    a: state.batteries.map((b) => [b.type, Math.round(b.x), percent(b.hp, b.maxHp)]),
    r: state.ammo.map((n) => Math.max(0, Math.round(n))),
    m: Math.round(state.money),
  };
}

function percent(hp: number, maxHp: number): number {
  if (maxHp <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((hp / maxHp) * 100)));
}

/** Treat anything off the wire as hostile until it has proved its shape. */
export function parseCitySnapshot(value: unknown): CitySnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const b = parseUnits(raw.b, BUILDINGS.length);
  const a = parseUnits(raw.a, AA.length);
  if (!b || !a) return null;
  if (!Array.isArray(raw.r) || raw.r.length !== AA.length) return null;
  const r = raw.r.map((n) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0));
  if (typeof raw.m !== 'number' || !Number.isFinite(raw.m)) return null;
  return { b, a, r, m: Math.max(0, Math.round(raw.m)) };
}

function parseUnits(value: unknown, types: number): Unit[] | null {
  if (!Array.isArray(value) || value.length > MAX_UNITS) return null;
  const out: Unit[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 3) return null;
    const [type, x, hp] = entry;
    if (!Number.isInteger(type) || type < 0 || type >= types) return null;
    if (typeof x !== 'number' || !Number.isFinite(x) || x < -500 || x > WORLD.width + 500) return null;
    if (typeof hp !== 'number' || !Number.isFinite(hp) || hp < 0 || hp > 100) return null;
    out.push([type, x, hp]);
  }
  return out;
}

/**
 * Bring our copy of their city into line with what they say it is. Existing
 * pieces are reused where they match, so a tower keeps its window seed and its
 * collapse animation instead of blinking; only what actually differs moves.
 */
export function applyCitySnapshot(state: SideState, snapshot: CitySnapshot): void {
  const mirror = (x: number) => WORLD.width - x;

  state.buildings = reconcile(
    state.buildings,
    snapshot.b,
    mirror,
    (type, x) => makeBuilding(state, type, x),
    (building, hp) => {
      building.hp = hp;
      const destroyed = hp <= 0;
      // Only start the collapse once, or it replays on every snapshot.
      if (destroyed && !building.destroyed) building.collapse = 0;
      building.destroyed = destroyed;
    },
    (b) => BUILDINGS[b.type].hp,
  );
  // Back-layer buildings paint first, and the snapshot says nothing about order.
  state.buildings.sort((p, q) => p.layer - q.layer);

  state.batteries = reconcile(
    state.batteries,
    snapshot.a,
    mirror,
    (type, x) => ({
      uid: nextUid(),
      type,
      side: state.side,
      x,
      hp: AA[type].hp,
      maxHp: AA[type].hp,
      cooldown: 0,
      aim: state.side === 'player' ? -Math.PI * 0.72 : -Math.PI * 0.28,
      recoil: 0,
      shake: 0,
      seed: Math.floor(Math.random() * 100000),
    }),
    (battery, hp) => {
      battery.hp = hp;
    },
    (b) => AA[b.type].hp,
  );

  state.aaOwned = AA.map((def) => state.batteries.filter((b) => b.type === def.id).length);
  state.ammo = snapshot.r.slice(0, AA.length);
  state.money = snapshot.m;
}

function makeBuilding(state: SideState, type: number, x: number): Building {
  const def = BUILDINGS[type];
  return {
    uid: nextUid(),
    type,
    side: state.side,
    x,
    layer: type >= 4 ? 0 : 1,
    hp: def.hp,
    maxHp: def.hp,
    destroyed: false,
    collapse: 0,
    shake: 0,
    smokeAcc: 0,
    seed: Math.floor(Math.random() * 100000),
  };
}

/**
 * Match what we have against what they sent, keyed on type and position, and
 * take from that pool before building anything new. Duplicates fall out for
 * free: several systems can share one emplacement, so the same key legitimately
 * appears more than once.
 */
function reconcile<T extends { type: number; x: number }>(
  existing: T[],
  incoming: Unit[],
  mirror: (x: number) => number,
  create: (type: number, x: number) => T,
  setHp: (unit: T, hp: number, maxHp: number) => void,
  maxHpOf: (unit: T) => number,
): T[] {
  const pool = new Map<string, T[]>();
  for (const unit of existing) {
    const key = `${unit.type}@${Math.round(unit.x)}`;
    const bucket = pool.get(key);
    if (bucket) bucket.push(unit);
    else pool.set(key, [unit]);
  }

  const out: T[] = [];
  for (const [type, x, hp] of incoming) {
    const at = mirror(x);
    const key = `${type}@${Math.round(at)}`;
    const unit = pool.get(key)?.shift() ?? create(type, at);
    const maxHp = maxHpOf(unit);
    setHp(unit, (hp / 100) * maxHp, maxHp);
    out.push(unit);
  }
  return out;
}
