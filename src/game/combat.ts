import {
  AA,
  BUILDINGS,
  INTERCEPTOR_MIN_SPEED,
  INTERCEPTOR_SPEED_FACTOR,
  MIN_INTERCEPT_ALTITUDE,
  MISSILES,
  WORLD,
  canIntercept,
} from '../core/config';
import type { Building, Interceptor, MetaSave, Missile, Particle, SideState } from '../core/types';
import { audio, type ExplosionSurface } from '../core/audio';
import { aaRadius, aaReload, hash01, launchPadX, nextUid, removeBattery, type Match } from './state';

// ---------------------------------------------------------------------------
// Ballistics
// ---------------------------------------------------------------------------

// Even the curved turns stay above the tallest possible skyline.
const CRUISE_Y = Math.min(100, WORLD.groundY - Math.max(...BUILDINGS.map((b) => b.h)) - 140);

/** Peak height of the single-parabola arc used by the light tiers. */
function arcHeight(dist: number): number {
  return Math.min(430, 110 + dist * 0.15);
}

type RouteSpec =
  | { kind: 'arc'; height: number; length: number }
  | { kind: 'cruise'; direction: number; bend: number; rise: number; turn: number; crossing: number; length: number };

/**
 * Tiers I–III fly the original lofted parabola; the heavy tiers launch
 * vertically, cross high and dive straight down onto the marked plot.
 */
function missileRoute(m: Pick<Missile, 'x0' | 'y0' | 'tx' | 'ty' | 'tier'>): RouteSpec {
  const distance = Math.abs(m.tx - m.x0);
  if (MISSILES[m.tier - 1].route === 'arc') {
    const height = arcHeight(distance);
    // Arc-tier progress is parameterised by ground distance, so `length` is
    // only used to derive the flight time; the shape comes from the sine term.
    return { kind: 'arc', height, length: distance + 1.9 * height };
  }
  const direction = Math.sign(m.tx - m.x0);
  const bend = Math.min(100, distance / 2);
  const rise = m.y0 - CRUISE_Y - bend;
  const turn = Math.PI * bend / 2;
  const crossing = distance - bend * 2;
  const fall = m.ty - CRUISE_Y - bend;
  const length = rise + turn * 2 + crossing + fall;
  return { kind: 'cruise', direction, bend, rise, turn, crossing, length };
}

function missileOnRoute(m: Missile, t: number, route: RouteSpec): { x: number; y: number } {
  if (t <= 0) return { x: m.x0, y: m.y0 };
  if (t >= 1) return { x: m.tx, y: m.ty };
  if (route.kind === 'arc') {
    const x = m.x0 + (m.tx - m.x0) * t;
    const base = m.y0 + (m.ty - m.y0) * t;
    return { x, y: base - route.height * Math.sin(Math.PI * t) };
  }
  const { direction, bend, rise, turn, crossing, length } = route;
  let distance = t * length;
  if (distance <= rise) return { x: m.x0, y: m.y0 - distance };
  distance -= rise;
  if (distance < turn) {
    const angle = distance / bend;
    return {
      x: m.x0 + direction * bend * (1 - Math.cos(angle)),
      y: CRUISE_Y + bend * (1 - Math.sin(angle)),
    };
  }
  distance -= turn;
  if (distance <= crossing) return { x: m.x0 + direction * (bend + distance), y: CRUISE_Y };
  distance -= crossing;
  if (distance < turn) {
    const angle = distance / bend;
    return {
      x: m.tx - direction * bend * (1 - Math.sin(angle)),
      y: CRUISE_Y + bend * (1 - Math.cos(angle)),
    };
  }
  distance -= turn;
  return { x: m.tx, y: CRUISE_Y + bend + distance };
}

/**
 * Fractions of the flight where the path changes direction. A long frame must
 * never sweep a straight shortcut across one of them into a building the
 * missile was going to fly over. The smooth parabola has none.
 */
function routeCheckpoints(route: RouteSpec): number[] {
  if (route.kind === 'arc') return [];
  const { rise, turn, crossing, length } = route;
  return [rise, rise + turn, rise + turn + crossing, rise + turn * 2 + crossing].map((d) => d / length);
}

export function missileAt(m: Missile, t: number): { x: number; y: number } {
  return missileOnRoute(m, t, missileRoute(m));
}

export function spawnMissile(state: SideState, tier: number, targetX: number): Missile {
  const def = MISSILES[tier - 1];
  const x0 = launchPadX(state.side);
  const y0 = WORLD.groundY - 14;
  const ty = WORLD.groundY;
  const flightTime = missileRoute({ x0, y0, tx: targetX, ty, tier }).length / def.speed;
  const m: Missile = {
    uid: nextUid(),
    side: state.side,
    tier,
    x: x0,
    y: y0,
    vx: 0,
    vy: -def.speed,
    x0,
    y0,
    tx: targetX,
    ty,
    t: 0,
    flightTime,
    speed: def.speed,
    damage: def.damage,
    blast: def.blast,
    dead: false,
    targetedBy: 0,
    trail: [],
  };
  state.stats.launched++;
  state.shotsUsed[tier - 1]++;
  return m;
}

// ---------------------------------------------------------------------------
// Interception
// ---------------------------------------------------------------------------

/** How fast this battery's rounds fly at a given target. */
function interceptorSpeed(type: number, target: Missile): number {
  const factor = AA[type].speedFactor ?? INTERCEPTOR_SPEED_FACTOR;
  return Math.max(INTERCEPTOR_MIN_SPEED, target.speed * factor);
}

/**
 * Solves for the moment an interceptor launched now would meet `m`.
 * Returns null when the missile lands before the interceptor can reach it.
 *
 * The gap between how far the interceptor still has to fly and how far it can
 * fly in that time starts positive and shrinks strictly — every interceptor is
 * faster than its target — so a bracketed search lands on the single crossing
 * exactly. Iterating `tau = distance / speed` instead only settles when the
 * target is slow; against the top tiers it oscillates and finds nothing.
 */
function solveIntercept(m: Missile, bx: number, by: number, speed: number): { t: number; x: number; y: number } | null {
  const remaining = (1 - m.t) * m.flightTime;
  if (remaining <= 0) return null;
  const gap = (tau: number): number => {
    const p = missileAt(m, m.t + tau / m.flightTime);
    return Math.hypot(p.x - bx, p.y - by) - speed * tau;
  };
  if (gap(remaining) > 0) return null; // it reaches the ground first
  let lo = 0;
  let hi = remaining;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (gap(mid) > 0) lo = mid;
    else hi = mid;
  }
  const future = m.t + hi / m.flightTime;
  if (future >= 0.94) return null;
  const p = missileAt(m, future);
  // Too low to be worth a shot — the warhead is already on top of the city.
  if (p.y > WORLD.groundY - MIN_INTERCEPT_ALTITUDE) return null;
  return { t: hi, x: p.x, y: p.y };
}

function spawnInterceptor(
  match: Match,
  state: SideState,
  type: number,
  bx: number,
  by: number,
  target: Missile,
  speed: number,
  aimX: number,
  aimY: number,
): void {
  const ang = Math.atan2(aimY - by, aimX - bx);
  const it: Interceptor = {
    uid: nextUid(),
    side: state.side,
    type,
    x: bx,
    y: by,
    vx: Math.cos(ang) * speed,
    vy: Math.sin(ang) * speed,
    speed,
    targetUid: target.uid,
    life: 9,
    dead: false,
    trail: [],
  };
  match.interceptors.push(it);
  target.targetedBy++;
  state.ammo[type]--;
}

export function updateDefences(match: Match, dt: number, meta: MetaSave): void {
  for (const state of [match.player, match.enemy]) {
    for (const b of state.batteries) {
      const def = AA[b.type];
      if (b.cooldown > 0) b.cooldown -= dt;
      if (b.recoil > 0) b.recoil = Math.max(0, b.recoil - dt * 3.2);
      if (b.shake > 0) b.shake = Math.max(0, b.shake - dt * 1.6);
      if (def.interceptsTier === 0) continue; // radar never fires

      const radius = aaRadius(state, b.type, meta);
      const by = WORLD.groundY - 16;

      // Keep the barrel tracking the nearest threat even while reloading.
      let best: { m: Missile; sol: { t: number; x: number; y: number } } | null = null;
      for (const m of match.missiles) {
        if (m.dead || m.side === state.side) continue;
        if (!canIntercept(def, m.tier)) continue;
        if (m.targetedBy > 0) continue;
        const speed = interceptorSpeed(b.type, m);
        const sol = solveIntercept(m, b.x, by, speed);
        if (!sol) continue;
        if (Math.hypot(sol.x - b.x, sol.y - by) > radius) continue;
        if (!best || sol.t < best.sol.t) best = { m, sol };
      }

      if (best) {
        b.aim = Math.atan2(best.sol.y - by, best.sol.x - b.x);
        if (b.cooldown <= 0 && state.ammo[b.type] > 0) {
          const speed = interceptorSpeed(b.type, best.m);
          spawnInterceptor(match, state, b.type, b.x, by, best.m, speed, best.sol.x, best.sol.y);
          b.cooldown = aaReload(state, b.type, meta);
          b.recoil = 1;
          audio.interceptorLaunch(panFor(match, b.x));
          puff(match, b.x, by, def.color);
        }
      } else {
        // Idle sweep, so batteries never look frozen.
        const rest = state.side === 'player' ? -Math.PI * 0.72 : -Math.PI * 0.28;
        const sweep = Math.sin(match.time * 0.6 + hash01(b.seed) * 6.28) * 0.16;
        b.aim += (rest + sweep - b.aim) * Math.min(1, dt * 2.4);
      }
    }
  }
}

export function updateInterceptors(match: Match, dt: number): void {
  for (const it of match.interceptors) {
    if (it.dead) continue;
    it.life -= dt;
    if (it.life <= 0) {
      it.dead = true;
      continue;
    }
    const target = match.missiles.find((m) => m.uid === it.targetUid && !m.dead);
    if (!target) {
      // Its quarry is already gone; let it burn out with a small flourish.
      it.life = Math.min(it.life, 0.35);
      it.x += it.vx * dt;
      it.y += it.vy * dt;
      pushTrail(it.trail, it.x, it.y, 10);
      continue;
    }

    // Re-lead every frame so a fast missile still gets tracked.
    const sol = solveIntercept(target, it.x, it.y, it.speed);
    const aimX = sol ? sol.x : target.x;
    const aimY = sol ? sol.y : target.y;
    const ang = Math.atan2(aimY - it.y, aimX - it.x);
    const turn = 7.5 * dt;
    const cur = Math.atan2(it.vy, it.vx);
    let delta = ang - cur;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const na = cur + Math.max(-turn, Math.min(turn, delta));
    it.vx = Math.cos(na) * it.speed;
    it.vy = Math.sin(na) * it.speed;
    it.x += it.vx * dt;
    it.y += it.vy * dt;
    pushTrail(it.trail, it.x, it.y, 12);

    if (Math.hypot(target.x - it.x, target.y - it.y) < 16 + it.speed * dt) {
      it.dead = true;
      target.dead = true;
      const owner = it.side === 'player' ? match.player : match.enemy;
      owner.stats.intercepted++;
      interceptBurst(match, target.x, target.y, AA[it.type].color);
      audio.intercept(panFor(match, target.x));
      match.shake = Math.max(match.shake, 3);
    }

    if (it.y > WORLD.groundY || it.x < -200 || it.x > WORLD.width + 200) it.dead = true;
  }
  match.interceptors = match.interceptors.filter((i) => !i.dead);
}

// ---------------------------------------------------------------------------
// Missile flight + impact
// ---------------------------------------------------------------------------

/**
 * How much of a building is still standing, 0..1. A battered tower loses its
 * upper floors, so the silhouette a missile can strike shrinks with the damage.
 */
export function standingFraction(b: Building): number {
  const ratio = b.maxHp > 0 ? Math.max(0, b.hp / b.maxHp) : 0;
  return 1 - (1 - ratio) * TOP_LOSS;
}

/** At zero hit points a building has lost this share of its height. */
export const TOP_LOSS = 0.45;

/**
 * First building the segment from (ax,ay) to (bx,by) runs into, if any.
 * Sampled rather than solved analytically — the fast tiers cover a lot of
 * ground per frame and would otherwise tunnel straight through a tower.
 */
function sweepBuildings(
  defender: SideState,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { building: Building; x: number; y: number } | null {
  const dist = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(2, Math.ceil(dist / 6));
  const lo = Math.min(ax, bx) - 30;
  const hi = Math.max(ax, bx) + 30;
  const candidates = defender.buildings.filter((b) => !b.destroyed && b.x > lo && b.x < hi);
  if (!candidates.length) return null;

  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    const px = ax + (bx - ax) * f;
    const py = ay + (by - ay) * f;
    for (const b of candidates) {
      const def = BUILDINGS[b.type];
      const half = def.w / 2;
      if (px < b.x - half || px > b.x + half) continue;
      const top = WORLD.groundY - def.h * standingFraction(b);
      if (py < top || py > WORLD.groundY) continue;
      return { building: b, x: px, y: py };
    }
  }
  return null;
}

export function updateMissiles(match: Match, dt: number): void {
  if (dt <= 0) return;
  for (const m of match.missiles) {
    if (m.dead) continue;
    const route = missileRoute(m);
    const previousT = m.t;
    const prev = missileOnRoute(m, previousT, route);
    m.t += dt / m.flightTime;
    const now = missileOnRoute(m, Math.min(1, m.t), route);
    m.vx = (now.x - prev.x) / dt;
    m.vy = (now.y - prev.y) / dt;
    m.x = now.x;
    m.y = now.y;
    pushTrail(m.trail, m.x, m.y, 26);
    // Engine smoke for the heavier tiers.
    if (m.tier >= 3 && Math.random() < dt * 26) {
      match.particles.push(smoke(m.x, m.y, 4 + m.tier));
    }

    // Split at every route boundary: a long frame must never sweep a diagonal
    // shortcut from launch/crossing into a building before the marked target.
    // Rounded-turn chords are safe here because the turns stay above all roofs.
    const defender = m.side === 'player' ? match.enemy : match.player;
    const checkpoints = routeCheckpoints(route).filter((t) => t > previousT && t < Math.min(1, m.t));
    // The top tiers cross the map in under a second, so a single frame can span
    // a whole city block. Sub-sample so they cannot tunnel past a tower.
    const span = Math.min(1, m.t) - previousT;
    const substeps = Math.min(12, Math.ceil((span * route.length) / 40));
    for (let i = 1; i < substeps; i++) checkpoints.push(previousT + (span * i) / substeps);
    checkpoints.sort((a, b) => a - b);
    checkpoints.push(Math.min(1, m.t));
    let from = prev;
    let struck: ReturnType<typeof sweepBuildings> = null;
    for (const t of checkpoints) {
      const to = missileOnRoute(m, t, route);
      struck = sweepBuildings(defender, from.x, from.y, to.x, to.y);
      if (struck) break;
      from = to;
    }
    if (struck) {
      m.dead = true;
      m.x = struck.x;
      m.y = struck.y;
      impact(match, m, struck.x, struck.y, struck.building);
      continue;
    }

    if (m.t >= 1) {
      m.dead = true;
      impact(match, m, m.tx, WORLD.groundY, null);
    }
  }
  match.missiles = match.missiles.filter((m) => !m.dead);
}

/** Damaged buildings keep smoking, which is most of the "it took a hit" read. */
export function updateBuildingSmoke(match: Match, dt: number): void {
  for (const side of [match.player, match.enemy]) {
    for (const b of side.buildings) {
      if (b.destroyed) continue;
      const ratio = b.maxHp > 0 ? b.hp / b.maxHp : 1;
      if (ratio > 0.82) continue;
      const def = BUILDINGS[b.type];
      // The worse the damage, the thicker the plume.
      b.smokeAcc += dt * (1 - ratio) * 5.5;
      while (b.smokeAcc >= 1) {
        b.smokeAcc -= 1;
        const top = WORLD.groundY - def.h * standingFraction(b);
        const p = smoke(b.x + (Math.random() - 0.5) * def.w * 0.8, top + Math.random() * 8, 5 + Math.random() * 7);
        p.vy -= 14;
        p.life *= 1.5;
        p.maxLife *= 1.5;
        match.particles.push(p);
      }
    }
  }
}

function impact(match: Match, m: Missile, ix: number, iy: number, direct: Building | null): void {
  const defender = m.side === 'player' ? match.enemy : match.player;
  const attacker = m.side === 'player' ? match.player : match.enemy;
  attacker.stats.hits++;

  // What it went off against decides how the blast sounds: a tower shears and
  // rains glass, a launcher tears and cooks off its rounds, the street thuds.
  const surface: ExplosionSurface = direct
    ? 'building'
    : defender.batteries.some((bat) => Math.abs(bat.x - ix) <= AA_HALF_WIDTH + m.blast * 0.5)
      ? 'antiair'
      : 'ground';
  audio.explosion(m.tier, surface, panFor(match, ix));
  explosionBurst(match, ix, iy, m.blast, m.tier);
  match.shake = Math.max(match.shake, 5 + m.tier * 3.5);

  // Anti-air is a legitimate target now — a direct hit takes a battery out.
  // A burst high up a tower barely troubles the guns at street level.
  const height = Math.max(0, WORLD.groundY - iy);
  const airburst = Math.max(0, 1 - height / Math.max(1, m.blast * 1.6));
  let batteriesKilled = 0;
  for (const bat of [...defender.batteries]) {
    const dx = Math.max(0, Math.abs(bat.x - ix) - AA_HALF_WIDTH);
    if (dx > m.blast) continue;
    const falloff = dx <= 0 ? 1 : 1 - dx / m.blast;
    bat.hp -= m.damage * (0.15 + 0.85 * falloff * falloff) * airburst;
    bat.shake = Math.max(bat.shake, 0.4 + falloff * 0.5);
    if (bat.hp <= 0) {
      batteryWreck(match, bat);
      removeBattery(defender, bat.uid);
      defender.stats.destroyedBatteries++;
      batteriesKilled++;
    }
  }

  let killed = 0;
  for (const b of defender.buildings) {
    if (b.destroyed) continue;
    const def = BUILDINGS[b.type];
    const half = def.w / 2;
    const dx = Math.max(0, Math.abs(b.x - ix) - half);
    if (b !== direct && dx > m.blast) continue;
    const falloff = b === direct ? 1 : dx <= 0 ? 1 : 1 - dx / m.blast;
    // A neighbour is only splashed by a burst near its own height.
    const reach = b === direct ? 1 : Math.max(0, 1 - Math.max(0, iy - WORLD.groundY + def.h) / Math.max(1, m.blast * 2));
    const dmg = m.damage * (0.18 + 0.82 * falloff * falloff) * (b === direct ? 1 : reach);
    if (dmg <= 0) continue;
    b.hp -= dmg;
    b.shake = Math.max(b.shake, 0.35 + falloff * 0.5);
    if (b.hp <= 0) {
      b.hp = 0;
      b.destroyed = true;
      b.collapse = 0;
      killed++;
      defender.stats.destroyedBuildings++;
      attacker.stats.valueDestroyed += def.cost;
      collapseBurst(match, b);
    }
  }
  if (killed > 0) {
    audio.collapse(panFor(match, ix));
    match.shake = Math.max(match.shake, 9);
  }

  const label =
    batteriesKilled > 0
      ? `-${batteriesKilled} anti-air`
      : killed > 0
        ? `-${killed} ${killed === 1 ? 'building' : 'buildings'}`
        : `${MISSILES[m.tier - 1].roman} hit`;
  match.texts.push({
    x: ix,
    y: Math.min(WORLD.groundY - 40, iy - 24),
    text: label,
    color: killed > 0 || batteriesKilled > 0 ? '#ff6b5e' : '#ffd980',
    life: 1.6,
    maxLife: 1.6,
  });
}

// ---------------------------------------------------------------------------
// Particles
// ---------------------------------------------------------------------------

function pushTrail(trail: { x: number; y: number; a: number }[], x: number, y: number, max: number): void {
  trail.push({ x, y, a: 1 });
  if (trail.length > max) trail.shift();
  for (let i = 0; i < trail.length; i++) trail[i].a = i / trail.length;
}

function smoke(x: number, y: number, size: number): Particle {
  return {
    kind: 'smoke',
    x,
    y,
    vx: (Math.random() - 0.5) * 22,
    vy: (Math.random() - 0.5) * 18 - 6,
    life: 1.1 + Math.random() * 0.7,
    maxLife: 1.8,
    size,
    color: 'rgba(190,196,205,1)',
    gravity: -6,
  };
}

function puff(match: Match, x: number, y: number, color: string): void {
  for (let i = 0; i < 10; i++) {
    match.particles.push({
      kind: 'spark',
      x,
      y,
      vx: (Math.random() - 0.5) * 130,
      vy: -Math.random() * 120,
      life: 0.3 + Math.random() * 0.25,
      maxLife: 0.55,
      size: 2 + Math.random() * 2,
      color,
      gravity: 240,
    });
  }
  match.particles.push({ kind: 'flash', x, y, vx: 0, vy: 0, life: 0.12, maxLife: 0.12, size: 26, color, gravity: 0 });
}

function interceptBurst(match: Match, x: number, y: number, color: string): void {
  match.particles.push({ kind: 'ring', x, y, vx: 0, vy: 0, life: 0.5, maxLife: 0.5, size: 8, color, gravity: 0 });
  match.particles.push({ kind: 'flash', x, y, vx: 0, vy: 0, life: 0.16, maxLife: 0.16, size: 46, color: '#ffffff', gravity: 0 });
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 60 + Math.random() * 220;
    match.particles.push({
      kind: 'spark',
      x,
      y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life: 0.35 + Math.random() * 0.5,
      maxLife: 0.85,
      size: 1.6 + Math.random() * 2.4,
      color: i % 3 === 0 ? '#fff2c4' : color,
      gravity: 210,
    });
  }
  for (let i = 0; i < 8; i++) match.particles.push(smoke(x, y, 5 + Math.random() * 6));
}

function explosionBurst(match: Match, x: number, y: number, blast: number, tier: number): void {
  const n = 26 + tier * 14;
  match.particles.push({ kind: 'flash', x, y: y - 10, vx: 0, vy: 0, life: 0.2, maxLife: 0.2, size: blast * 1.5, color: '#fff6d2', gravity: 0 });
  match.particles.push({ kind: 'ring', x, y: y - 6, vx: 0, vy: 0, life: 0.6, maxLife: 0.6, size: blast * 0.4, color: '#ffb03a', gravity: 0 });
  for (let i = 0; i < n; i++) {
    const a = -Math.PI * 0.5 + (Math.random() - 0.5) * Math.PI * 1.5;
    const s = 60 + Math.random() * (140 + tier * 90);
    match.particles.push({
      kind: 'fire',
      x: x + (Math.random() - 0.5) * blast * 0.5,
      y: y - Math.random() * 14,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life: 0.4 + Math.random() * 0.7,
      maxLife: 1.1,
      size: 4 + Math.random() * (6 + tier * 2.5),
      color: pick(['#ffe07a', '#ffa22b', '#ff5f2e', '#d43a1a']),
      gravity: 190,
    });
  }
  for (let i = 0; i < 12 + tier * 5; i++) {
    match.particles.push({
      kind: 'debris',
      x,
      y: y - 8,
      vx: (Math.random() - 0.5) * (220 + tier * 90),
      vy: -80 - Math.random() * (200 + tier * 80),
      life: 0.8 + Math.random() * 0.9,
      maxLife: 1.7,
      size: 2 + Math.random() * 4,
      color: '#4a4f57',
      gravity: 520,
      rot: Math.random() * 6.28,
      vrot: (Math.random() - 0.5) * 14,
    });
  }
  for (let i = 0; i < 16 + tier * 6; i++) match.particles.push(smoke(x + (Math.random() - 0.5) * blast, y - Math.random() * 40, 8 + Math.random() * 14));
}

/** Rough half-width of a battery footprint, used for splash hit tests. */
export const AA_HALF_WIDTH = 20;

function batteryWreck(match: Match, bat: { x: number; type: number }): void {
  const color = AA[bat.type].color;
  const y = WORLD.groundY - 10;
  match.particles.push({ kind: 'flash', x: bat.x, y, vx: 0, vy: 0, life: 0.2, maxLife: 0.2, size: 40, color: '#fff0c0', gravity: 0 });
  match.particles.push({ kind: 'ring', x: bat.x, y, vx: 0, vy: 0, life: 0.55, maxLife: 0.55, size: 12, color, gravity: 0 });
  for (let i = 0; i < 26; i++) {
    const a = -Math.PI * 0.5 + (Math.random() - 0.5) * Math.PI * 1.4;
    const sp = 90 + Math.random() * 260;
    match.particles.push({
      kind: 'debris',
      x: bat.x + (Math.random() - 0.5) * 24,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: 0.8 + Math.random(),
      maxLife: 1.8,
      size: 2 + Math.random() * 4,
      color: i % 4 === 0 ? color : '#4a515b',
      gravity: 520,
      rot: Math.random() * 6.28,
      vrot: (Math.random() - 0.5) * 14,
    });
  }
  for (let i = 0; i < 12; i++) match.particles.push(smoke(bat.x + (Math.random() - 0.5) * 26, y, 8 + Math.random() * 10));
}

function collapseBurst(match: Match, b: Building): void {
  const def = BUILDINGS[b.type];
  for (let i = 0; i < 14 + def.h / 8; i++) {
    match.particles.push({
      kind: 'debris',
      x: b.x + (Math.random() - 0.5) * def.w,
      y: WORLD.groundY - Math.random() * def.h,
      vx: (Math.random() - 0.5) * 160,
      vy: -Math.random() * 130,
      life: 1 + Math.random(),
      maxLife: 2,
      size: 2 + Math.random() * 5,
      color: pick(['#3c424b', '#525a64', '#2c3138']),
      gravity: 560,
      rot: Math.random() * 6.28,
      vrot: (Math.random() - 0.5) * 12,
    });
  }
  for (let i = 0; i < 18; i++) {
    match.particles.push({
      kind: 'smoke',
      x: b.x + (Math.random() - 0.5) * def.w * 1.4,
      y: WORLD.groundY - Math.random() * def.h * 0.7,
      vx: (Math.random() - 0.5) * 40,
      vy: -10 - Math.random() * 30,
      life: 1.4 + Math.random() * 1.4,
      maxLife: 2.8,
      size: 10 + Math.random() * 18,
      color: 'rgba(150,155,163,1)',
      gravity: -14,
    });
  }
}

export function updateParticles(match: Match, dt: number): void {
  for (const p of match.particles) {
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += p.gravity * dt;
    if (p.kind === 'debris') {
      p.vx *= 1 - dt * 0.6;
      if (p.rot !== undefined && p.vrot !== undefined) p.rot += p.vrot * dt;
      if (p.y > WORLD.groundY) {
        p.y = WORLD.groundY;
        p.vy *= -0.28;
        p.vx *= 0.55;
        if (p.vrot !== undefined) p.vrot *= 0.5;
      }
    }
    if (p.kind === 'smoke') {
      p.vx *= 1 - dt * 0.8;
      p.size += dt * 12;
    }
  }
  match.particles = match.particles.filter((p) => p.life > 0);
  if (match.particles.length > 1600) match.particles.splice(0, match.particles.length - 1600);

  for (const t of match.texts) {
    t.life -= dt;
    t.y -= dt * 26;
  }
  match.texts = match.texts.filter((t) => t.life > 0);
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Stereo pan from a world x, relative to the middle of the battlefield. */
export function panFor(_match: Match, x: number): number {
  return Math.max(-1, Math.min(1, (x / WORLD.width) * 2 - 1)) * 0.7;
}
