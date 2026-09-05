/**
 * How reliably each anti-air system stops its tier, as a function of how far
 * the battery sits from where the warhead is aimed. Run after changing missile
 * speeds: the top tiers cross the map in under a second, so the margin the
 * interceptor solver has to work with is what decides whether they are
 * answerable at all.
 *
 *   npm run probe:intercept
 */
import { AA, MISSILES, canIntercept } from '../src/core/config';
import { defaultMeta } from '../src/core/storage';
import { spawnMissile, updateDefences, updateInterceptors, updateMissiles } from '../src/game/combat';
import { buyBattery, createMatch } from '../src/game/state';

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
if (!stops.length) {
  console.error(`FAIL: ${topBattery.name} never stops ${topTier.name} at ${topTier.speed} m/s`);
  process.exit(1);
}
console.log(
  `PASS: ${topBattery.name} stops ${topTier.name} (${topTier.speed} m/s) when sited within ` +
    `${Math.max(...stops)}m of the impact point.`,
);
