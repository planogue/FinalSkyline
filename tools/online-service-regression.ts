import assert from 'node:assert/strict';
import { defaultMeta } from '../src/core/storage';
import { initialOnlineState, OnlineService, type OnlineMatchTicket } from '../src/online/service';

// Run with esbuild --define:import.meta.env={} so this uses only the mock
// transport and never needs real credentials, a browser, or a remote database.
const timers = new Map<number, { fn: () => void; delay: number }>();
const intervals = new Map<number, () => void>();
let timerId = 0;
Object.assign(globalThis, {
  window: {
    setTimeout(fn: () => void, delay = 0) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
    setInterval(fn: () => void) { intervals.set(++timerId, fn); return timerId; },
    clearInterval(id: number) { intervals.delete(id); },
  },
  localStorage: {
    getItem() { return '1'; },
    setItem() {},
  },
});

const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
async function runTimer(delay: number): Promise<void> {
  const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
  assert(entry, `Expected a retry timer after ${delay}ms`);
  timers.delete(entry[0]);
  entry[1].fn();
  await flush();
}

interface Row { id: number; player_id: string; action: { type: 'pin-target'; tier: number; x: number } }
interface Page { data: Row[] | null; error: { message: string } | null }
const row = (id: number): Row => ({ id, player_id: 'opponent', action: { type: 'pin-target', tier: 1, x: id } });
const ticket = (id: string): OnlineMatchTicket => ({
  matchId: id, durationSeconds: 600, seed: 1, startedAt: new Date().toISOString(),
  opponentId: 'opponent', opponentUsername: 'Opponent',
});

class Channel {
  event = (_payload: { new: Row }) => {};
  status = (_status: string) => {};
  on(_type: string, _filter: unknown, callback: Channel['event']) { this.event = callback; return this; }
  subscribe(callback: Channel['status']) { this.status = callback; return this; }
  emit(value: Row) { this.event({ new: value }); }
}

function fixture() {
  const state = { ...initialOnlineState(), configured: true };
  const actions: number[] = [];
  const rows = new Map<string, Row[]>();
  const queries: { matchId: string; cursor: number }[] = [];
  const channels: Channel[] = [];
  let authCallback = (_event: string, _session: unknown) => {};
  let nextTicket: OnlineMatchTicket | null = null;
  let read: ((matchId: string, cursor: number) => Promise<Page>) | null = null;
  let profileLoads = 0;
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  let changes = 0;
  const rpcHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {};
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'me' } } }, error: null }),
      onAuthStateChange(callback: typeof authCallback) { authCallback = callback; },
      signOut: async () => ({ error: null }),
    },
    schema() {
      return {
        async rpc(fn: string, args?: Record<string, unknown>) {
          rpcCalls.push({ fn, args: args ?? {} });
          const handler = rpcHandlers[fn];
          if (handler) return { data: handler(args ?? {}), error: null };
          // join_queue / queue_status keep their original behaviour.
          return { data: nextTicket, error: null };
        },
      };
    },
    channel() { const channel = new Channel(); channels.push(channel); return channel; },
    removeChannel: async () => 'ok',
    from(table: string) {
      let matchId = '';
      let cursor = 0;
      const query = {
        select() { return query; },
        eq(_column: string, value: string) { matchId = value; return query; },
        gt(_column: string, value: number) { cursor = value; return query; },
        order() { return query; },
        async limit(_count: number): Promise<Page> {
          assert.equal(table, 'match_events');
          queries.push({ matchId, cursor });
          if (read) return read(matchId, cursor);
          // A deliberately lower server max verifies that short pages are
          // not mistaken for the end of the stream.
          return { data: (rows.get(matchId) ?? []).filter((r) => r.id > cursor).slice(0, 200), error: null };
        },
        async single() {
          profileLoads++;
          return { data: {
            user_id: 'me', username: 'Pilot', wins: 0, losses: 0, stars: 0,
            radius_level: Array(6).fill(0), aa_reload_level: Array(6).fill(0),
            missile_reload_level: Array(6).fill(0), best_difficulty: null,
          }, error: null };
        },
      };
      return query;
    },
  };
  const entered: string[] = [];
  const service = new OnlineService(state, defaultMeta(), {
    changed() { changes++; }, matched(value) { entered.push(value.matchId); },
    action(action) { if (action.type === 'pin-target') actions.push(action.x); },
  });
  (service as unknown as { client: unknown }).client = client;
  return {
    service, state, actions, rows, queries, channels, rpcCalls,
    onRpc(fn: string, handler: (args: Record<string, unknown>) => unknown) { rpcHandlers[fn] = handler; },
    entered,
    get changes() { return changes; },
    auth(event: string, id: string | null) { authCallback(event, id ? { user: { id } } : null); },
    setTicket(value: OnlineMatchTicket | null) { nextTicket = value; },
    setRead(value: typeof read) { read = value; },
    get profileLoads() { return profileLoads; },
  };
}

const match = fixture();
await match.service.init();
await match.service.joinQueue(600);
assert.equal(match.state.phase, 'queueing');
for (const event of ['SIGNED_IN', 'TOKEN_REFRESHED']) {
  match.auth(event, 'me');
  await runTimer(0);
  assert.equal(match.state.phase, 'queueing', `${event} must preserve the queue`);
}
assert.equal(match.profileLoads, 1, 'Same-user auth events must not reload progress');
await match.service.cancelQueue();
match.setTicket(ticket('match-a'));
match.rows.set('match-a', Array.from({ length: 1505 }, (_, i) => row(i + 1)));
await match.service.joinQueue(600);
const channel = match.channels[0];
channel.status('SUBSCRIBED');
channel.emit(row(1505));
await flush();
assert.deepEqual(match.actions, Array.from({ length: 1505 }, (_, i) => i + 1), 'Paginate all events and deduplicate buffered live delivery');
assert(match.queries.length > 2, 'The history must span more than the default 1000-row API max');
match.auth('TOKEN_REFRESHED', 'me');
await runTimer(0);
assert.equal(match.state.phase, 'matched', 'Refreshing auth must preserve the match');

channel.status('CHANNEL_ERROR');
match.rows.get('match-a')!.push(row(1506), row(1507));
channel.emit(row(1507));
const beforeReconnect = match.queries.length;
channel.status('SUBSCRIBED');
await flush();
assert.equal(match.queries[beforeReconnect].cursor, 1505, 'Reconnect should fetch only after the last consumed event');
assert.deepEqual(match.actions.slice(-2), [1506, 1507], 'Catch-up must precede buffered live events');
assert.equal(match.actions.length, 1507, 'Reconnect must not replay previous commands');
await match.service.disconnectMatch();
channel.emit(row(1508));
assert.equal(match.actions.length, 1507, 'Disconnected channel callbacks must be ignored');

const retry = fixture();
await retry.service.init();
retry.setTicket(ticket('retry'));
retry.rows.set('retry', [row(1), row(2)]);
retry.setRead(async () => ({ data: null, error: { message: 'Temporary network failure' } }));
await retry.service.joinQueue(600);
retry.channels[0].status('SUBSCRIBED');
retry.channels[0].emit(row(2));
await flush();
assert.deepEqual(retry.actions, [], 'Keep commands buffered until catch-up succeeds');
retry.setRead(null);
await runTimer(1000);
assert.deepEqual(retry.actions, [1, 2], 'A successful retry should recover history and buffered commands once');

retry.channels[0].status('CHANNEL_ERROR');
retry.setRead(async () => ({ data: null, error: { message: 'Offline' } }));
retry.channels[0].status('SUBSCRIBED');
await flush();
for (const delay of [1000, 2000, 4000]) await runTimer(delay);
assert.equal(timers.size, 0, 'Retries must stop after the bounded retry limit');
assert.match(retry.state.message, /Match sync failed/);
retry.channels[0].status('SUBSCRIBED');
await flush();
assert.equal(timers.size, 1);
await retry.service.disconnectMatch();
assert.equal(timers.size, 0, 'Disconnect must clear a scheduled backlog retry');

const stale = fixture();
await stale.service.init();
stale.setTicket(ticket('old'));
let finishPage: (value: Page) => void = () => {};
stale.setRead(() => new Promise((resolve) => { finishPage = resolve; }));
await stale.service.joinQueue(600);
const oldChannel = stale.channels[0];
oldChannel.status('SUBSCRIBED');
await flush();
await stale.service.disconnectMatch();
stale.setRead(null);
stale.setTicket(ticket('new'));
stale.rows.set('new', [row(10)]);
await stale.service.joinQueue(600);
stale.channels[1].status('SUBSCRIBED');
await flush();
finishPage({ data: [row(1)], error: null });
oldChannel.emit(row(2));
oldChannel.status('CHANNEL_ERROR');
await flush();
assert.deepEqual(stale.actions, [10], 'An old request/channel must not send actions into a new match');
assert.equal(stale.state.message, 'Match connected', 'An old channel must not overwrite the new connection state');
stale.auth('SIGNED_OUT', null);
await runTimer(0);
stale.channels[1].emit(row(11));
assert.deepEqual(stale.actions, [10], 'Signing out must invalidate match callbacks');
assert.equal(stale.state.phase, 'signed-out');

// ---------------------------------------------------------------------------
// Friends, presence and invitations
// ---------------------------------------------------------------------------

const social = fixture();
let friendsState: Record<string, unknown> = { friends: [], invites: [], match: null };
social.onRpc('friends_state', () => friendsState);
social.onRpc('heartbeat', () => null);
await social.service.init();
await flush();

assert(
  social.rpcCalls.some((call) => call.fn === 'heartbeat'),
  'Signing in starts the presence heartbeat',
);
assert(
  social.rpcCalls.some((call) => call.fn === 'friends_state'),
  'Signing in loads the friends panel',
);

// A friend list and one invitation in each direction.
const soon = new Date(Date.now() + 90_000).toISOString();
friendsState = {
  friends: [
    { userId: 'ada', username: 'Ada', online: true, status: 'accepted' },
    { userId: 'bo', username: 'Boris', online: false, status: 'accepted' },
    { userId: 'cy', username: 'Cyrus', online: true, status: 'incoming' },
    // Malformed rows must be dropped rather than crashing the panel.
    { userId: 'dud', username: 'Dud', online: true, status: 'nonsense' },
    { username: 'no id' },
    null,
  ],
  invites: [
    { id: 'inv-1', userId: 'ada', username: 'Ada', durationSeconds: 900, direction: 'incoming', expiresAt: soon },
    { id: 'inv-2', userId: 'bo', username: 'Boris', durationSeconds: 0, direction: 'outgoing', expiresAt: soon },
    { id: 'bad', direction: 'sideways' },
  ],
  match: null,
};
await social.service.addFriend('Ada');
await flush();
assert.equal(social.state.friends.length, 3, 'Only well-formed friends are kept');
assert.deepEqual(
  social.state.friends.map((f) => f.status),
  ['accepted', 'accepted', 'incoming'],
  'Friendship states survive the round trip',
);
assert.equal(social.state.friends[0].online, true, 'Presence survives the round trip');
assert.equal(social.state.invites.length, 2, 'Only well-formed invitations are kept');
assert.equal(social.state.invites[0].durationSeconds, 900);
assert.equal(social.state.invites[1].durationSeconds, 0, 'An unlimited invitation stays unlimited');

// An unchanged poll must not wake the UI, or it would fight the player typing.
const settled = social.changes;
await flush();
assert.equal(social.changes, settled, 'A poll that finds nothing new redraws nothing');

// Declining leaves the player on the menu.
social.onRpc('respond_invite', () => ({ ok: true, message: 'Invitation declined' }));
await social.service.respondInvite('inv-1', false);
await flush();
assert.equal(social.entered.length, 0, 'Declining an invitation starts no match');

// Accepting drops straight into the match the server just created.
social.onRpc('respond_invite', () => ({ ok: true, message: 'Match starting', match: ticket('invited') }));
await social.service.respondInvite('inv-1', true);
await flush();
assert.deepEqual(social.entered, ['invited'], 'Accepting an invitation enters the match');

// The inviter is handed the same match by their own poll.
const inviter = fixture();
let inviterState: Record<string, unknown> = { friends: [], invites: [], match: null };
inviter.onRpc('friends_state', () => inviterState);
inviter.onRpc('heartbeat', () => null);
await inviter.service.init();
await flush();
assert.equal(inviter.entered.length, 0, 'Nothing to join yet');
inviterState = { friends: [], invites: [], match: ticket('accepted-by-friend') };
await inviter.service.addFriend('anyone');
await flush();
assert.deepEqual(inviter.entered, ['accepted-by-friend'], 'The inviter joins when the invite is accepted');
// The same ticket coming round again must not restart the match.
await inviter.service.addFriend('anyone');
await flush();
assert.deepEqual(inviter.entered, ['accepted-by-friend'], 'A repeated ticket does not re-enter the match');

// Signing out puts the panel away and stops the loops.
await social.service.signOut();
await flush();
assert.deepEqual(social.state.friends, [], 'Signing out clears the friend list');
assert.deepEqual(social.state.invites, [], 'Signing out clears invitations');

console.log('PASS: same-user auth, paginated catch-up, reconnect ordering/deduplication, bounded retry recovery, stale match cleanup, and the friends/invitation flow.');
