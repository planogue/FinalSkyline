import assert from 'node:assert/strict';
import { AA_SITE_SNAP, AA_STACK_LIMIT, BOTS, BUILDINGS, MATCH, META, MISSILES, WORLD, type Difficulty } from '../src/core/config';
import { defaultMeta } from '../src/core/storage';
import { updateBot } from '../src/game/bot';
import { missileAt, spawnMissile, updateDefences, updateInterceptors, updateMissiles } from '../src/game/combat';
import { stepMatch } from '../src/game/engine';
import { buyBattery, buyBuilding, buyMissileUpgrade, canDeployAt, createMatch, launchPadReferenceX, launchPadX, missileReload, pinTarget, commitQueue } from '../src/game/state';

const meta = defaultMeta();

// Any five systems may share one emplacement, whatever their type, and a drop
// near an existing site joins it rather than standing slightly beside it.
const stack = createMatch('easy', 300);
stack.player.money = 100000;
assert(buyBattery(stack.player, 0, 2600));
assert(buyBattery(stack.player, 1, 2600), 'a launcher sites on top of a radar');
assert(buyBattery(stack.player, 0, 2600 + AA_SITE_SNAP - 1), 'a near miss joins the same site');
assert.deepEqual(
  stack.player.batteries.map((b) => b.x),
  [2600, 2600, 2600],
  'a joined battery snaps onto the site it joined',
);
assert(buyBattery(stack.player, 2, 2600));
assert(buyBattery(stack.player, 3, 2600));
assert.equal(stack.player.batteries.length, AA_STACK_LIMIT, 'five systems fit');
assert.equal(canDeployAt(stack.player, 2600, 4), false, 'the sixth is refused');
assert.equal(buyBattery(stack.player, 4, 2600), false);
assert(canDeployAt(stack.player, 2600 + AA_SITE_SNAP + 40, 4), 'a fresh site is still free');
assert(buyBattery(stack.player, 4, 2600 + AA_SITE_SNAP + 40));

// A refused drop costs nothing, and the land still bounds where anything goes.
const spacing = createMatch('easy', 300);
spacing.player.money = 1000;
assert(buyBattery(spacing.player, 1, 2600));
for (const x of [NaN, Infinity, WORLD.cityLeft.x0, WORLD.cityRight.x1 + 400]) {
  assert.equal(canDeployAt(spacing.player, x, 1), false, `Reject invalid site ${x}`);
  assert.equal(buyBattery(spacing.player, 1, x), false);
}
assert.equal(spacing.player.money, 1000, 'Rejected placements must not charge cash');
assert(buyBattery(spacing.player, 1, 2600), 'the second Avenger stacks on the first');
assert.equal(spacing.player.money, 982);
assert.equal(buyBattery(spacing.player, 1, 2600), false, 'still max two of each type');

// Heavier warheads open one at a time, however much cash is on hand.
const ladder = createMatch('easy', 300);
ladder.player.money = 100000;
assert.deepEqual(
  ladder.player.missileUnlocked,
  [true, false, false, false, false, false],
  'only the first tier is open at kick-off',
);
assert.equal(buyMissileUpgrade(ladder.player, 6, meta), false, 'cannot skip to the heaviest');
assert.equal(buyMissileUpgrade(ladder.player, 3, meta), false, 'cannot skip a single step');
assert.equal(ladder.player.money, 100000, 'a refused unlock costs nothing');
for (const tier of [2, 3, 4, 5, 6]) {
  assert.equal(buyMissileUpgrade(ladder.player, tier, meta), 'unlock', `tier ${tier} opens in turn`);
}
assert(ladder.player.missileUnlocked.every(Boolean), 'the whole arsenal opens eventually');

const reload = createMatch('easy', 300);
reload.player.money = 100000;
// The arsenal opens in order, so climb the ladder before testing the top tier.
for (const tier of [2, 3, 4, 5]) assert.equal(buyMissileUpgrade(reload.player, tier, meta), 'unlock');
reload.player.money = 100000;
assert.equal(buyMissileUpgrade(reload.player, 6, meta), 'unlock');
assert.equal(reload.player.money, 100000 - 600);
assert.equal(missileReload(reload.player, 6, meta), 5);
assert.equal(reload.player.missileReloadPrice[5], 300);
assert.equal(buyMissileUpgrade(reload.player, 6, meta), 'reload');
assert.equal(missileReload(reload.player, 6, meta), 4.9);
assert(reload.player.missileReloadPrice[5] > 300);
for (let i = 0; i < 100; i++) buyMissileUpgrade(reload.player, 6, meta);
assert(missileReload(reload.player, 6, meta) >= META.minReload);

const launch = createMatch('easy', 300);
launch.player.money = 10000;
buyBuilding(launch, launch.player, 8);
buyBuilding(launch, launch.enemy, 0);
// Tiers open one at a time, so climb to the top before firing one.
for (const tier of [2, 3, 4, 5, 6]) assert.equal(buyMissileUpgrade(launch.player, tier, meta), 'unlock');
pinTarget(launch.player, 6, 500);
pinTarget(launch.player, 6, 500);
commitQueue(launch.player);
launch.time = MATCH.peaceSeconds;
stepMatch(launch, 0.01, meta);
assert.equal(launch.player.stats.launched, 1);
for (let i = 0; i < 49; i++) stepMatch(launch, 0.1, meta);
assert.equal(launch.player.stats.launched, 1);
stepMatch(launch, 0.11, meta);
assert.equal(launch.player.stats.launched, 2, 'Second Bunker Buster launches after five seconds');

// Launchers sit behind their own city, so a rocket rises over its own skyline
// before crossing. Moving them there must not have added a second to any shot:
// flight times are still measured from the old pad in front of the city, and
// the longer route is flown at a correspondingly higher real speed.
assert(launchPadX('player') > WORLD.cityRight.x1, 'The player launches from behind its city');
assert(launchPadX('enemy') < WORLD.cityLeft.x0, 'The enemy launches from behind its city');
assert.equal(
  launchPadX('player') + launchPadX('enemy'),
  WORLD.width,
  'The pads mirror across the centre line, which online play depends on',
);
for (const tier of MISSILES.map((m) => m.tier)) {
  const timing = createMatch('easy', 300);
  const shot = spawnMissile(timing.player, tier, 700);
  const def = MISSILES[tier - 1];
  const straightLine = Math.abs(700 - launchPadReferenceX('player'));
  // Same duration as the front-of-city pad would have produced.
  assert(
    shot.flightTime > straightLine / def.speed * 0.9 &&
      shot.flightTime < straightLine / def.speed * 1.8,
    `Tier ${tier} keeps its old flight time`,
  );
  assert(shot.speed > def.speed, `Tier ${tier} flies its longer route faster`);
  assert(shot.x0 > WORLD.cityRight.x1, `Tier ${tier} starts behind the city`);
}

// The heavy tiers climb clean out of the top of the world and dive back onto
// the exact pin. Normal frames and one full-flight frame must both reach the
// mark, including a pin near the edge of a roof, and neither may clip a tower.
const LOFTED_TIERS = MISSILES.filter((m) => m.route === 'lofted').map((m) => m.tier);
const ARC_TIERS = MISSILES.filter((m) => m.route === 'arc').map((m) => m.tier);
assert(LOFTED_TIERS.length > 0 && ARC_TIERS.length > 0, 'Both flight paths are in use');

for (const attackingSide of ['player', 'enemy'] as const) {
  for (const tier of LOFTED_TIERS) {
    for (const aim of ['roof', 'street'] as const) {
      for (const frameMode of ['normal', 'full-flight'] as const) {
        const match = createMatch('easy', 300);
        const attacker = match[attackingSide];
        const defender = attackingSide === 'player' ? match.enemy : match.player;
        const mirrorX = (x: number) => attackingSide === 'player' ? x : WORLD.width - x;
        defender.money = 10000;
        for (const x of [1200, 850, 300]) assert(buyBuilding(match, defender, 8, mirrorX(x)));
        const [front, middle, rear] = defender.buildings;
        // A steep dive comes in at an angle, so a pin on the far lip of a roof
        // is reached by dropping past the tower rather than onto it. Aim at the
        // tower itself to test a direct hit.
        const targetX = aim === 'roof' ? rear.x : mirrorX(145);
        const missile = spawnMissile(attacker, tier, targetX);
        match.missiles.push(missile);
        assert(missileAt(missile, 0.03).y < missile.y0 - 40, 'A lofted shot climbs immediately');
        assert(missileAt(missile, 0.3).y < 0, 'and is out of the world within the first third');
        // The apex sits far above the world, so the middle of the flight is out
        // of sight at either zoom level.
        assert(missileAt(missile, 0.5).y < -600, 'The apex leaves the screen entirely');
        assert(missileAt(missile, 0.7).y < 0, 'and it is still up there most of the way');
        const late = missileAt(missile, 0.97);
        assert(late.y > 0 && late.y < WORLD.groundY, 'It is back inside the world to dive');
        assert(missileAt(missile, 0.99).y > late.y, 'The dive moves downward');
        // Coming down like a meteorite: far steeper than it is wide.
        const drop = missileAt(missile, 1).y - late.y;
        const drift = Math.abs(missileAt(missile, 1).x - late.x);
        assert(drop > drift * 1.5, `The dive is a plunge, not a glide (${drop} vs ${drift})`);
        assert.deepEqual(missileAt(missile, 1), { x: targetX, y: WORLD.groundY });
        // Nothing but the tower it was aimed at may be in the way. Checking the
        // real footprints rather than a slab of the city lets the dive finish
        // inside its target's own outline, which is where it is supposed to.
        const aimed = aim === 'roof' ? rear : null;
        for (let step = 0; step <= 600; step++) {
          const point = missileAt(missile, step / 600);
          for (const tower of defender.buildings) {
            if (tower === aimed) continue;
            const half = BUILDINGS[tower.type].w / 2;
            if (point.x < tower.x - half || point.x > tower.x + half) continue;
            assert(
              point.y < WORLD.groundY - BUILDINGS[tower.type].h,
              `Clear the tower at ${tower.x} on the way to ${targetX}`,
            );
          }
        }
        const dt = frameMode === 'normal' ? 1 / 30 : missile.flightTime * 1.1;
        for (let elapsed = 0; !missile.dead && elapsed < missile.flightTime + dt; elapsed += dt) {
          updateMissiles(match, dt);
        }
        assert(missile.dead, `${attackingSide} tier ${tier} must complete ${frameMode} flight`);
        assert.equal(attacker.stats.hits, 1, 'Exactly one impact per missile');
        assert.equal(front.hp, front.maxHp, 'The front tower does not steal the impact');
        assert.equal(middle.hp, middle.maxHp, 'The middle tower does not steal the impact');
        if (aim === 'roof') {
          assert.equal(rear.hp, Math.max(0, rear.maxHp - missile.damage), 'The marked tower takes the direct hit');
          const half = BUILDINGS[rear.type].w / 2;
          assert(
            missile.x >= rear.x - half && missile.x <= rear.x + half,
            'and the burst lands inside its own footprint',
          );
        } else {
          assert.equal(missile.x, targetX, 'A clear street pin keeps the exact marked x');
          assert.equal(missile.y, WORLD.groundY, 'A clear street pin lands on the ground');
          assert.equal(rear.hp, rear.maxHp, 'A tower before the street pin stays intact');
        }
      }
    }
  }
}

// The light tiers fly the original lofted parabola. It comes down along a
// shallow line rather than a vertical dive, so it reaches an unobstructed pin
// exactly and detonates on the first thing standing in its path otherwise.
for (const attackingSide of ['player', 'enemy'] as const) {
  for (const tier of ARC_TIERS) {
    for (const aim of ['roof', 'street'] as const) {
      for (const frameMode of ['normal', 'full-flight'] as const) {
        const match = createMatch('easy', 300);
        const attacker = match[attackingSide];
        const defender = attackingSide === 'player' ? match.enemy : match.player;
        const mirrorX = (x: number) => attackingSide === 'player' ? x : WORLD.width - x;
        defender.money = 10000;
        // Nothing between the launcher and the pin: the near edge of the city.
        assert(buyBuilding(match, defender, 8, mirrorX(1200)));
        const [tower] = defender.buildings;
        const targetX = aim === 'roof' ? tower.x : mirrorX(1290);
        const missile = spawnMissile(attacker, tier, targetX);
        match.missiles.push(missile);
        assert(missileAt(missile, 0.03).y < missile.y0, 'Arc missiles climb immediately');
        assert(missileAt(missile, 0.5).y < missileAt(missile, 0.03).y, 'The arc keeps rising to its apex');
        assert(missileAt(missile, 0.97).y > missileAt(missile, 0.5).y, 'The arc descends onto the pin');
        assert.deepEqual(missileAt(missile, 1), { x: targetX, y: WORLD.groundY });

        const dt = frameMode === 'normal' ? 1 / 30 : missile.flightTime * 1.1;
        for (let elapsed = 0; !missile.dead && elapsed < missile.flightTime + dt; elapsed += dt) {
          updateMissiles(match, dt);
        }
        assert(missile.dead, `${attackingSide} tier ${tier} must complete ${frameMode} flight`);
        assert.equal(attacker.stats.hits, 1, 'Exactly one impact per missile');
        if (aim === 'roof') {
          assert(tower.hp < tower.maxHp, 'An unobstructed arc still flattens what it was aimed at');
        } else {
          assert.equal(missile.x, targetX, 'A clear street pin keeps the exact marked x');
          assert.equal(missile.y, WORLD.groundY, 'A clear street pin lands on the ground');
        }
      }
    }
  }
}

// The arc clears a distant skyline but comes down along a shallow line, so a
// tower standing just in front of the pin takes the hit instead. That trade-off
// is what separates the light tiers from the overhead heavy ones.
{
  const match = createMatch('easy', 300);
  const defender = match.enemy;
  defender.money = 10000;
  assert(buyBuilding(match, defender, 8, 405));
  assert(buyBuilding(match, defender, 8, 315));
  const [screen, deep] = defender.buildings;
  const missile = spawnMissile(match.player, ARC_TIERS[0], deep.x);
  match.missiles.push(missile);
  for (let elapsed = 0; !missile.dead && elapsed < missile.flightTime + 1; elapsed += 1 / 60) {
    updateMissiles(match, 1 / 60);
  }
  assert(missile.dead, 'The screened arc shot still resolves');
  assert(screen.hp < screen.maxHp, 'The intervening tower takes an arc-tier hit');
  assert.equal(deep.hp, deep.maxHp, 'The deep target is shielded from arc tiers');
}

// The interceptor predictor must follow the same overhead route and vertical dive.
for (const attackingSide of ['player', 'enemy'] as const) {
  const match = createMatch('easy', 300);
  const defender = attackingSide === 'player' ? match.enemy : match.player;
  const targetX = attackingSide === 'player' ? 500 : WORLD.width - 500;
  assert(buyBattery(defender, 1, targetX));
  defender.ammo[1] = 5;
  const missile = spawnMissile(match[attackingSide], 1, targetX);
  match.missiles.push(missile);
  for (let elapsed = 0; !missile.dead && elapsed < missile.flightTime + 1; elapsed += 1 / 60) {
    updateDefences(match, 1 / 60, meta);
    updateInterceptors(match, 1 / 60);
    updateMissiles(match, 1 / 60);
  }
  assert.equal(defender.stats.intercepted, 1, 'A loaded battery can intercept the new terminal descent');
  assert.equal(match[attackingSide].stats.hits, 0, 'Intercepted rockets never impact');
}

const random = Math.random;
const rows: Record<string, number | string>[] = [];
try {
  for (const difficulty of ['easy', 'medium', 'hard'] as Difficulty[]) {
    for (let seed = 1; seed <= 3; seed++) {
      let state = seed;
      Math.random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
      const match = createMatch(difficulty, 300);
      match.player.money = 10000;
      buyBuilding(match, match.player, 8);
      // Keep a passive target alive while measuring normal bot income and spending.
      match.player.buildings[0].hp = match.player.buildings[0].maxHp = 1e9;
      let first = 0;
      let last = 0;
      let maxGap = 0;
      let previousShots = 0;
      for (let frame = 0; frame < 300 * 20; frame++) {
        const before = match.enemy.buildings.length + match.enemy.batteries.length;
        stepMatch(match, 0.05, meta);
        const after = match.enemy.buildings.length + match.enemy.batteries.length;
        assert(after - before <= 1, `${difficulty} must construct at most one unit per frame`);
        if (match.enemy.stats.launched > previousShots) {
          if (!first) first = match.time;
          if (last) maxGap = Math.max(maxGap, match.time - last);
          last = match.time;
          previousShots = match.enemy.stats.launched;
        }
      }
      assert(first <= MATCH.peaceSeconds + BOTS[difficulty].firstStrikeDelay + 0.2, `${difficulty} first strike at ${first}`);
      assert(first >= MATCH.peaceSeconds, 'No attacks during ceasefire');
      assert(maxGap <= BOTS[difficulty].salvoGap + 0.2, `${difficulty} attack gap was ${maxGap}`);
      assert(match.enemy.stats.launched >= 18, `${difficulty} should attack regularly`);
      rows.push({ difficulty, seed, first: first.toFixed(1), maxGap: maxGap.toFixed(1), shots: match.enemy.stats.launched });
    }
  }

  // Even a completely fumbled economy tick must not fumble a funded attack.
  const match = createMatch('easy', 300);
  match.time = MATCH.peaceSeconds + BOTS.easy.firstStrikeDelay;
  match.enemy.money = 100;
  Math.random = () => 0.99;
  updateBot(match, BOTS.easy.salvoGap, meta);
  assert.equal(match.enemy.pending.length, 1);
} finally {
  Math.random = random;
}
console.table(rows);
console.log('PASS: stacked emplacements, purchase costs, reload floor, five-second launches, precise overhead trajectories, interception, single construction, and regular attacks.');
