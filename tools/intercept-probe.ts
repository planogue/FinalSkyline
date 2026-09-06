/**
 * How reliably each anti-air system stops its tier, as a function of how far
 * the battery sits from where the warhead is aimed. Run after changing missile
 * speeds: the top tiers cross the map in under a second, so the margin the
 * interceptor solver has to work with is what decides whether they are
 * answerable at all.
 *
 *   npm run probe:intercept
 */
import { AA, AA_STACK_LIMIT, MISSILES, canIntercept } from '../src/core/config';
import { defaultMeta } from '../src/core/storage';
import assert from 'node:assert/strict';
import { spawnMissile, updateDefences, updateInterceptors, updateMissiles } from '../src/game/combat';
import { buyAmmo, buyBattery, createMatch } from '../src/game/state';

const meta = defaultMeta();

/** One shot: does the defender's single battery stop it? */
function trial(tier: number, aaType: number, offset: number): boolean {
  const match = createMatch('easy', 300);
  const defender = match.enemy;
  const targetX = 700;
  defender.money = 10000;
  if (!buyBattery(defender, aaType, targetX + offset)) return false;
  defender.ammo[aaType] = 20;
  const missile = spawnMissile(match.player, tier, targetX);
  match.missiles.push(missile);
  const dt = 1 / 60;
  for (let t = 0; !missile.dead && t < missile.flightTime + 1; t += dt) {
    updateDefences(match, dt, meta);
    updateInterceptors(match, dt);
    updateMissiles(match, dt);
  }
  return defender.stats.intercepted === 1;
}

// Negative sits the battery behind the impact point, away from the incoming
// fire; positive sits it out towards the launcher.
const offsets = [-200, -100, 0, 100, 200, 300, 400];
const rows: Record<string, string | number>[] = [];

for (const missile of MISSILES) {
  for (const aa of AA) {
    if (!canIntercept(aa, missile.tier)) continue;
    const row: Record<string, string | number> = {
      missile: `${missile.name} ${missile.roman}`,
      speed: missile.speed,
      battery: `${aa.name} ${aa.roman}`,
    };
    for (const offset of offsets) row[`+${offset}m`] = trial(missile.tier, aa.id, offset) ? 'stop' : '—';
    rows.push(row);
  }
}

console.table(rows);

const topTier = MISSILES[MISSILES.length - 1];
const topBattery = AA.find((aa) => canIntercept(aa, topTier.tier));
if (!topBattery) {
  console.error(`FAIL: nothing can engage ${topTier.name}`);
  process.exit(1);
}
const stops = offsets.filter((offset) => trial(topTier.tier, topBattery.id, offset));
console.log(
  `Coverage: ${topBattery.name} stops ${topTier.name} (${topTier.speed} m/s) when sited within ` +
    `${Math.max(...stops)}m of the impact point.`,
);

// ---------------------------------------------------------------------------
// The rest of the anti-air contract, which the table above does not cover.
// ---------------------------------------------------------------------------

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures.push(label);
}

/** Runs a defended engagement and reports what the defence actually did. */
function engage(options: {
  batteries: { type: number; x: number }[];
  ammo?: number;
  shots: { tier: number; x: number }[];
}) {
  const match = createMatch('easy', 300);
  const defender = match.enemy;
  defender.money = 1e6;
  for (const b of options.batteries) {
    if (!buyBattery(defender, b.type, b.x)) throw new Error(`could not site type ${b.type} at ${b.x}`);
  }
  for (const type of new Set(options.batteries.map((b) => b.type))) {
    if (AA[type].interceptsTier > 0) defender.ammo[type] = options.ammo ?? 40;
  }
  for (const shot of options.shots) {
    match.missiles.push(spawnMissile(match.player, shot.tier, shot.x));
  }
  const dt = 1 / 60;
  const longest = Math.max(...match.missiles.map((m) => m.flightTime));
  let peakInterceptors = 0;
  for (let t = 0; t < longest + 1.5; t += dt) {
    updateDefences(match, dt, meta);
    updateInterceptors(match, dt);
    updateMissiles(match, dt);
    peakInterceptors = Math.max(peakInterceptors, match.interceptors.length);
  }
  return {
    intercepted: defender.stats.intercepted,
    hits: match.player.stats.hits,
    ammoLeft: [...defender.ammo],
    peakInterceptors,
    match,
  };
}

// An empty magazine is a silent battery, not a free kill.
{
  const dry = engage({ batteries: [{ type: 1, x: 700 }], ammo: 0, shots: [{ tier: 1, x: 700 }] });
  check('an empty battery never fires', dry.intercepted === 0 && dry.peakInterceptors === 0);
  check('and the warhead gets through', dry.hits === 1);
}

// Every round that leaves the rail is paid for out of stock.
{
  const paid = engage({ batteries: [{ type: 1, x: 700 }], ammo: 5, shots: [{ tier: 1, x: 700 }] });
  check('a kill costs exactly one round', paid.intercepted === 1 && paid.ammoLeft[1] === 4, `left ${paid.ammoLeft[1]}`);
}

// A battery ignores tiers it cannot touch, rather than wasting its magazine.
for (const def of AA.filter((a) => a.interceptsTier > 0)) {
  const wrong = MISSILES.find((m) => !canIntercept(def, m.tier));
  if (!wrong) continue;
  const idle = engage({ batteries: [{ type: def.id, x: 700 }], shots: [{ tier: wrong.tier, x: 700 }] });
  check(
    `${def.name} holds fire against tier ${wrong.roman}`,
    idle.intercepted === 0 && idle.ammoLeft[def.id] === 40,
    `spent ${40 - idle.ammoLeft[def.id]}`,
  );
}

// Two batteries covering the same warhead must not both spend a round on it.
{
  const pair = engage({
    batteries: [{ type: 1, x: 640 }, { type: 1, x: 760 }],
    shots: [{ tier: 1, x: 700 }],
  });
  check(
    'two batteries do not double up on one warhead',
    pair.intercepted === 1 && pair.ammoLeft[1] === 39,
    `spent ${40 - pair.ammoLeft[1]}`,
  );
}

// A salvo is shared out: one battery per warhead, all engaged at once.
{
  const salvo = engage({
    batteries: [{ type: 1, x: 620 }, { type: 1, x: 780 }],
    shots: [{ tier: 1, x: 640 }, { tier: 1, x: 760 }],
  });
  check('two batteries stop two warheads', salvo.intercepted === 2, `stopped ${salvo.intercepted}`);
  // Two kills for two rounds: the salvo is shared out rather than one battery
  // emptying itself into a warhead the other was already handling.
  check('for exactly two rounds', salvo.ammoLeft[1] === 38, `spent ${40 - salvo.ammoLeft[1]}`);
  check('and nothing got through', salvo.hits === 0, `hits ${salvo.hits}`);
}

// A full stack of layered systems defends its own plot against every tier.
{
  const site = 700;
  const layered = [
    { type: 0, x: site },
    { type: 1, x: site },
    { type: 2, x: site },
    { type: 3, x: site },
    { type: 4, x: site },
  ];
  check('a five-deep emplacement is legal', layered.length === AA_STACK_LIMIT);
  for (const tier of [1, 2, 3, 4]) {
    const stacked = engage({ batteries: layered, shots: [{ tier, x: site }] });
    check(`the stack stops tier ${MISSILES[tier - 1].roman}`, stacked.intercepted === 1);
  }
  const unmatched = engage({ batteries: layered, shots: [{ tier: 5, x: site }] });
  check('but not a tier it has no launcher for', unmatched.intercepted === 0 && unmatched.hits === 1);
}

// Both sides run the same code path.
{
  const match = createMatch('easy', 300);
  match.player.money = 1e6;
  assert(buyBattery(match.player, 1, 3000));
  match.player.ammo[1] = 10;
  match.missiles.push(spawnMissile(match.enemy, 1, 3000));
  for (let t = 0; t < 20; t += 1 / 60) {
    updateDefences(match, 1 / 60, meta);
    updateInterceptors(match, 1 / 60);
    updateMissiles(match, 1 / 60);
  }
  check('the player side intercepts too', match.player.stats.intercepted === 1);
}

if (!stops.length) {
  console.error(`FAIL: ${topBattery.name} never stops ${topTier.name} at ${topTier.speed} m/s`);
  process.exit(1);
}
if (failures.length) {
  console.error(`\nFAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nPASS: coverage, magazines, tier discipline, salvo sharing, stacked emplacements, both sides.');
