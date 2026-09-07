import assert from 'node:assert/strict';
import { AA, MATCH, WORLD } from '../src/core/config';
import { defaultMeta } from '../src/core/storage';
import { stepMatch } from '../src/game/engine';
import {
  buyAaRadius,
  buyAmmo,
  buyBattery,
  buyBuilding,
  buyMissileUpgrade,
  commitQueue,
  createMatch,
  createOnlineMatch,
  pinTarget,
} from '../src/game/state';
import { applyRemoteAction, parseOnlineAction, type OnlineAction } from '../src/online/actions';
import { applyCitySnapshot, captureCity, parseCitySnapshot } from '../src/online/snapshot';

const alice = createOnlineMatch('Bob', 600);
const bob = createOnlineMatch('Alice', 600);
const fairMeta = defaultMeta();
for (const side of [alice.player, alice.enemy, bob.player, bob.enemy]) side.money = 500;

function fromAlice(local: () => boolean, action: OnlineAction): void {
  assert.equal(local(), true, `Alice could not apply ${action.type} locally`);
  assert.equal(applyRemoteAction(bob, fairMeta, action), true, `Bob could not mirror ${action.type}`);
}

function fromBob(local: () => boolean, action: OnlineAction): void {
  assert.equal(local(), true, `Bob could not apply ${action.type} locally`);
  assert.equal(applyRemoteAction(alice, fairMeta, action), true, `Alice could not mirror ${action.type}`);
}

fromAlice(
  () => buyBuilding(alice, alice.player, 0, 2500),
  { type: 'build-building', buildingType: 0, x: 2500 },
);
fromBob(
  () => buyBuilding(bob, bob.player, 5, 2660),
  { type: 'build-building', buildingType: 5, x: 2660 },
);
fromAlice(
  () => buyBattery(alice.player, 1, 2750),
  { type: 'build-battery', batteryType: 1, x: 2750 },
);

const boughtAmmo = buyAmmo(alice.player, 1, 5);
assert.equal(boughtAmmo, 5);
assert.equal(applyRemoteAction(bob, fairMeta, { type: 'buy-ammo', batteryType: 1, count: boughtAmmo }), true);

fromAlice(
  () => buyAaRadius(alice.player, 1),
  { type: 'aa-radius', batteryType: 1 },
);
fromAlice(
  () => buyMissileUpgrade(alice.player, 2, fairMeta) !== false,
  { type: 'missile-upgrade', tier: 2 },
);
fromAlice(
  () => pinTarget(alice.player, 1, 500) !== null,
  { type: 'pin-target', tier: 1, x: 500 },
);
fromAlice(
  () => commitQueue(alice.player) > 0,
  { type: 'commit-targets' },
);

assert.equal(Math.round(bob.enemy.buildings[0].x), Math.round(WORLD.width - alice.player.buildings[0].x));
assert.equal(Math.round(alice.enemy.buildings[0].x), Math.round(WORLD.width - bob.player.buildings[0].x));
assert.equal(Math.round(bob.enemy.batteries[0].x), Math.round(WORLD.width - alice.player.batteries[0].x));
assert.equal(bob.enemy.ammo[1], alice.player.ammo[1]);
assert.equal(bob.enemy.aaRadiusBonus[1], alice.player.aaRadiusBonus[1]);
assert.equal(bob.enemy.missileUnlocked[1], alice.player.missileUnlocked[1]);
assert.equal(bob.enemy.pending.length, 1);
assert.equal(Math.round(bob.enemy.pending[0].x), WORLD.width - 500);
assert.equal(parseOnlineAction({ type: 'build-building', buildingType: 99, x: 2500 }), null);
assert.equal(parseOnlineAction({ type: 'pin-target', tier: 1, x: Number.NaN }), null);
assert.equal(parseOnlineAction({ type: 'match-over', won: true, cause: 'nonsense' }), null);
assert.equal(parseOnlineAction({ type: 'match-over', won: 'yes', cause: 'time' }), null);
assert.deepEqual(
  parseOnlineAction({ type: 'match-over', won: false, cause: 'resign' }),
  { type: 'match-over', won: false, cause: 'resign' },
);

// ---------------------------------------------------------------------------
// Ending a match. Both browsers run the whole battle, so neither may assume the
// other reached the same conclusion at the same moment.
// ---------------------------------------------------------------------------

/** A match where this side's city is gone and the opponent's is not. */
function levelled(): { mine: ReturnType<typeof createOnlineMatch>; theirs: ReturnType<typeof createOnlineMatch> } {
  const mine = createOnlineMatch('Bob', 600);
  const theirs = createOnlineMatch('Alice', 600);
  for (const match of [mine, theirs]) {
    match.time = MATCH.peaceSeconds + 1;
    match.player.money = 500;
    match.enemy.money = 500;
  }
  // Alice has nothing standing; Bob does. Both copies agree on that much.
  assert(buyBuilding(mine, mine.enemy, 0, 1000));
  assert(buyBuilding(theirs, theirs.player, 0, WORLD.width - 1000));
  return { mine, theirs };
}

function run(match: ReturnType<typeof createOnlineMatch>, seconds: number): void {
  for (let t = 0; t < seconds; t += 0.1) stepMatch(match, 0.1, fairMeta);
}

// The side that was wiped out calls it, and calls it against itself.
{
  const { mine: alice2 } = levelled();
  run(alice2, MATCH.wipeoutGraceSeconds + 1);
  assert(alice2.result, 'a side whose city is gone ends its own match');
  assert.equal(alice2.result?.won, false, 'and it is a defeat');
  assert.equal(alice2.result?.fromOpponent, undefined, 'decided here, so it gets announced');
}

// The other side does NOT claim the win off its own copy of their city. That
// assumption is what left one player on a victory screen while the other
// played on.
{
  const { theirs: bob2 } = levelled();
  run(bob2, MATCH.wipeoutGraceSeconds + 1);
  assert.equal(bob2.result, null, 'a winner waits to be told rather than assuming');
  assert.equal(bob2.phase, 'playing');

  // Their announcement finishes it, mirrored.
  assert.equal(applyRemoteAction(bob2, fairMeta, { type: 'match-over', won: false, cause: 'wipeout' }), true);
  assert.equal(bob2.result?.won, true, 'their defeat is our victory');
  assert.equal(bob2.result?.fromOpponent, true, 'and it is not echoed back');
  assert.equal(bob2.phase, 'over');
}

// If the word never comes — a closed browser, a dead connection — the win is
// claimed anyway rather than stranding the match forever.
{
  const { theirs: bob3 } = levelled();
  run(bob3, MATCH.wipeoutGraceSeconds + MATCH.opponentSilenceSeconds + 1);
  assert(bob3.result, 'silence does not strand the winner');
  assert.equal(bob3.result?.won, true);
  assert.equal(bob3.result?.fromOpponent, undefined, 'claimed here, so it gets announced');
}

// A timed match ends on the clock for both, but the damage totals each browser
// tallied need not agree, so the same rule applies: concede at once, wait to be
// congratulated. Otherwise both players can walk away with a win.
{
  const loser = createOnlineMatch('Bob', 300);
  const winner = createOnlineMatch('Alice', 300);
  for (const match of [loser, winner]) {
    match.player.money = 500;
    match.enemy.money = 500;
    match.time = 299;
  }
  // Bob did the damage, so Alice's copy calls it a defeat and Bob's a victory.
  assert(buyBuilding(loser, loser.player, 0, 2500));
  assert(buyBuilding(winner, winner.enemy, 0, 1200));
  loser.enemy.stats.valueDestroyed = 50;
  winner.player.stats.valueDestroyed = 50;

  run(loser, 2);
  assert.equal(loser.result?.won, false, 'the loser calls it on the clock');

  run(winner, 2);
  assert.equal(winner.result, null, 'the winner does not, yet');
  assert.equal(applyRemoteAction(winner, fairMeta, { type: 'match-over', won: false, cause: 'time' }), true);
  assert.equal(winner.result?.won, true);
  assert.match(winner.result?.reason ?? '', /most damage/);
}

// A bot match is unaffected: nobody is on the other end to wait for.
{
  const solo = createMatch('easy', 300);
  solo.time = MATCH.peaceSeconds + 1;
  solo.player.money = 500;
  assert(buyBuilding(solo, solo.player, 0, 2500));
  // Leave the bot broke, or it simply puts a block back up.
  solo.enemy.money = 0;
  run(solo, MATCH.wipeoutGraceSeconds + 1);
  assert.equal(solo.result?.won, true, 'a bot whose city is gone loses immediately');
}

// Walking away hands the other player the match.
{
  const abandoned = createOnlineMatch('Bob', 600);
  assert.equal(applyRemoteAction(abandoned, fairMeta, { type: 'match-over', won: false, cause: 'resign' }), true);
  assert.equal(abandoned.result?.won, true);
  assert.match(abandoned.result?.reason ?? '', /left the match/);
}

// A ruling that arrives after this side has already finished changes nothing.
{
  const settled = createOnlineMatch('Bob', 600);
  assert.equal(applyRemoteAction(settled, fairMeta, { type: 'match-over', won: true, cause: 'time' }), true);
  const first = { ...settled.result! };
  assert.equal(applyRemoteAction(settled, fairMeta, { type: 'match-over', won: false, cause: 'wipeout' }), false);
  assert.deepEqual({ ...settled.result! }, first, 'the first ruling stands');
}

// ---------------------------------------------------------------------------
// City snapshots. A player is the only one who can say what is left of their
// own land, so their word replaces whatever the other browser worked out.
// ---------------------------------------------------------------------------

{
  const home = createOnlineMatch('Bob', 600);
  const away = createOnlineMatch('Alice', 600);
  home.player.money = 5000;
  assert(buyBuilding(home, home.player, 8, 2500));
  assert(buyBuilding(home, home.player, 0, 2620));
  assert(buyBattery(home.player, 3, 2750));
  assert(buyBattery(home.player, 0, 2850), 'a radar uses a separate emplacement');
  assert.equal(buyAmmo(home.player, 3, 7), 7);
  home.player.buildings[1].hp = home.player.buildings[1].maxHp * 0.5;

  const wire = parseCitySnapshot(JSON.parse(JSON.stringify(captureCity(home.player))));
  assert(wire, 'a captured city survives the wire');
  applyCitySnapshot(away.enemy, wire!);

  assert.equal(away.enemy.buildings.length, 2);
  // Buildings snap to a plot, so compare against where it actually went.
  const tower = home.player.buildings.find((b) => b.type === 8)!;
  assert.equal(
    Math.round(away.enemy.buildings.find((b) => b.type === 8)!.x),
    Math.round(WORLD.width - Math.round(tower.x)),
    'positions arrive mirrored',
  );
  assert.equal(away.enemy.batteries.length, 2, 'both systems survive synchronization');
  assert.equal(away.enemy.aaOwned[3], 1);
  assert.equal(away.enemy.aaOwned[0], 1);
  assert.equal(away.enemy.ammo[3], 7, 'magazines come across');
  assert.equal(away.enemy.money, Math.round(home.player.money), 'so does the cash that gates their orders');
  const half = away.enemy.buildings.find((b) => b.type === 0)!;
  assert(Math.abs(half.hp / half.maxHp - 0.5) < 0.02, 'and the damage they have taken');

  // A second snapshot must not rebuild what is already there, or every tower
  // would blink its windows and restart its collapse twice a second.
  const seeds = away.enemy.buildings.map((b) => b.seed);
  const uids = away.enemy.buildings.map((b) => b.uid);
  applyCitySnapshot(away.enemy, parseCitySnapshot(JSON.parse(JSON.stringify(captureCity(home.player))))!);
  assert.deepEqual(away.enemy.buildings.map((b) => b.seed), seeds, 'existing towers are reused');
  assert.deepEqual(away.enemy.buildings.map((b) => b.uid), uids);

  // What they say is gone, is gone — even if this browser thought otherwise.
  home.player.buildings[0].hp = 0;
  home.player.buildings[0].destroyed = true;
  applyCitySnapshot(away.enemy, parseCitySnapshot(JSON.parse(JSON.stringify(captureCity(home.player))))!);
  assert.equal(away.enemy.buildings.find((b) => b.type === 8)!.destroyed, true, 'their ruins are ruins here too');
  assert.equal(
    away.enemy.buildings.filter((b) => !b.destroyed).length,
    1,
    'and the rubble still holds its plot',
  );

  // Selling the story short: anything the other side no longer has, goes.
  home.player.batteries.length = 0;
  applyCitySnapshot(away.enemy, parseCitySnapshot(JSON.parse(JSON.stringify(captureCity(home.player))))!);
  assert.equal(away.enemy.batteries.length, 0, 'batteries they lost are removed');
  assert.deepEqual(away.enemy.aaOwned, AA.map(() => 0), 'and stop counting against their cap');
}

// Nothing off the wire is trusted until it has proved its shape.
for (const junk of [
  null,
  'city',
  {},
  { b: [], a: [], r: [0, 0, 0, 0, 0, 0] },
  { b: [[99, 100, 50]], a: [], r: [0, 0, 0, 0, 0, 0], m: 0 },
  { b: [[0, 100, 500]], a: [], r: [0, 0, 0, 0, 0, 0], m: 0 },
  { b: [[0, Number.NaN, 50]], a: [], r: [0, 0, 0, 0, 0, 0], m: 0 },
  { b: [], a: [], r: [0, 0, 0], m: 0 },
  { b: Array.from({ length: 500 }, () => [0, 100, 50]), a: [], r: [0, 0, 0, 0, 0, 0], m: 0 },
]) {
  assert.equal(parseCitySnapshot(junk), null, `rejected: ${JSON.stringify(junk)?.slice(0, 40)}`);
}

console.log('Online mirror test passed: build, defence, ammo, upgrades, targeting, validation, city snapshots, and the end-of-match handshake stay in sync.');

const support = createOnlineMatch('support',600);
support.enemy.money=10000;
assert.deepEqual(parseOnlineAction({type:'barrage-upgrade'}),{type:'barrage-upgrade'});
assert(applyRemoteAction(support,fairMeta,{type:'barrage-upgrade'}));
assert(support.enemy.barrageOwned);
assert(!support.player.barrageOwned);
assert.equal(support.enemy.money,8000);
assert(!applyRemoteAction(support,fairMeta,{type:'barrage-upgrade'}));
assert(parseOnlineAction({type:'buy-ammo',batteryType:2,count:100}));
assert(!parseOnlineAction({type:'buy-ammo',batteryType:2,count:101}));
assert(applyRemoteAction(support,fairMeta,{type:'buy-ammo',batteryType:2,count:100}));
assert.equal(support.enemy.ammo[2],100);
console.log('PASS: online barrage purchase and 100-round orders');
