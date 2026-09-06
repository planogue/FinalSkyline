import assert from 'node:assert/strict';
import { MATCH, WORLD } from '../src/core/config';
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

console.log('Online mirror test passed: build, defence, ammo, upgrades, targeting, validation, and the end-of-match handshake stay in sync.');
