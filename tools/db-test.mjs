/**
 * Runs every Supabase migration against a real Postgres and exercises the
 * account, matchmaking, friends, presence and invitation RPCs the way two
 * browsers would — including the paths that are awkward to reach by hand, such
 * as an invitation lapsing and two players inviting each other at once.
 *
 *   npm install --no-save embedded-postgres pg
 *   npm run test:db
 *
 * The two packages are deliberately NOT devDependencies: embedded-postgres
 * downloads a Postgres build, which has no business running on every deploy.
 */
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let EmbeddedPostgres;
let pg;
try {
  ({ default: EmbeddedPostgres } = await import('embedded-postgres'));
  ({ default: pg } = await import('pg'));
} catch {
  console.error('This check needs a throwaway Postgres. Install it first:');
  console.error('  npm install --no-save embedded-postgres pg');
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(HERE, '..', 'supabase', 'migrations');
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'final-skyline-db-'));
const PORT = 55444;

// Enough of the Supabase platform for the migrations to run: the roles they
// grant to, the auth schema they key off, and auth.uid() driven by a session
// setting so we can act as either player.
const SCAFFOLD = `
create extension if not exists pgcrypto;

do $$
declare r text;
begin
  foreach r in array array['anon','authenticated','service_role','authenticator','supabase_admin']
  loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;

create schema if not exists auth;
create schema if not exists graphql_public;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  is_anonymous boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('test.user_id', true), '')::uuid
$$;

do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
`;

const pgsql = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: false,
  // The Windows default locale makes initdb pick WIN1252, which then rejects
  // the UTF-8 in the migrations.
  initdbFlags: ['-E', 'UTF8', '--locale=C'],
});

let client;
const failures = [];
function check(label, condition, detail = '') {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label} ${detail}`);
    failures.push(label);
  }
}

async function actAs(userId) {
  await client.query(`select set_config('test.user_id', $1, false)`, [userId ?? '']);
}
async function rpc(fn, args = []) {
  const params = args.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await client.query(`select ${fn}(${params}) as result`, args);
  return rows[0].result;
}

try {
  console.log('initdb + start...');
  await pgsql.initialise();
  await pgsql.start();
  await pgsql.createDatabase('skyline');

  client = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'postgres', database: 'skyline' });
  await client.connect();

  await client.query(SCAFFOLD);

  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    process.stdout.write(`migration ${file} ... `);
    await client.query(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
    console.log('ok');
  }

  // --- two players -------------------------------------------------------
  const mk = async (name) => {
    const { rows } = await client.query(
      `insert into auth.users (raw_user_meta_data) values (jsonb_build_object('username', $1::text)) returning id`,
      [name],
    );
    return rows[0].id;
  };
  const ada = await mk('Ada');
  const bo = await mk('Boris');

  const names = await client.query('select user_id, username from public.profiles order by username');
  check('profiles created by trigger', names.rowCount === 2, JSON.stringify(names.rows));

  // An account whose metadata carries a display name rather than a username.
  const { rows: g } = await client.query(
    `insert into auth.users (raw_user_meta_data) values ('{"name":"Cole Barnes"}'::jsonb) returning id`,
  );
  const cole = g[0].id;
  const coleName = (await client.query('select username from public.profiles where user_id = $1', [cole])).rows[0].username;
  check('a display name is cleaned into a username', coleName === 'ColeBarnes', coleName);

  // Guest account.
  const { rows: gu } = await client.query(
    `insert into auth.users (raw_user_meta_data, is_anonymous) values ('{}'::jsonb, true) returning id`,
  );
  const guestName = (await client.query('select username from public.profiles where user_id = $1', [gu[0].id])).rows[0].username;
  check('guest gets a guest_ name', /^guest_[0-9a-f]{8}$/.test(guestName), guestName);

  // --- presence ----------------------------------------------------------
  await actAs(ada);
  await rpc('api.heartbeat');
  await actAs(bo);
  await rpc('api.heartbeat');

  // --- friend requests ---------------------------------------------------
  await actAs(ada);
  let r = await rpc('api.add_friend', ['Boris']);
  check('add_friend sends a request', r.ok === true, JSON.stringify(r));
  r = await rpc('api.add_friend', ['boris']);
  check('a second request is refused', r.ok === false && /Already waiting/.test(r.message), JSON.stringify(r));
  check('the lookup ignores case', !/No commander/.test(r.message), JSON.stringify(r));
  r = await rpc('api.add_friend', ['Ada']);
  check('cannot add yourself', r.ok === false && /yourself/.test(r.message), JSON.stringify(r));
  r = await rpc('api.add_friend', ['Nobody']);
  check('unknown name reports cleanly', r.ok === false && /No commander/.test(r.message), JSON.stringify(r));

  let state = await rpc('api.friends_state');
  check('Ada sees an outgoing request', state.friends.length === 1 && state.friends[0].status === 'outgoing', JSON.stringify(state.friends));

  await actAs(bo);
  state = await rpc('api.friends_state');
  check('Bo sees it as incoming', state.friends[0]?.status === 'incoming', JSON.stringify(state.friends));
  check('Ada reads as online', state.friends[0]?.online === true, JSON.stringify(state.friends));

  // Inviting a non-friend is refused.
  r = await rpc('api.send_invite', [ada, 600]);
  check('cannot invite a non-friend', r.ok === false, JSON.stringify(r));

  r = await rpc('api.respond_friend', [ada, true]);
  check('Bo accepts', r.ok === true, JSON.stringify(r));
  state = await rpc('api.friends_state');
  check('now accepted both ways', state.friends[0]?.status === 'accepted', JSON.stringify(state.friends));

  // --- invitations -------------------------------------------------------
  await actAs(ada);
  r = await rpc('api.send_invite', [bo, 900]);
  check('invite sent', r.ok === true, JSON.stringify(r));
  const inviteId = r.invite.id;

  state = await rpc('api.friends_state');
  check('inviter sees it outgoing', state.invites[0]?.direction === 'outgoing', JSON.stringify(state.invites));
  check('the window is 90 seconds', Math.round(state.inviteSeconds) === 90, String(state.inviteSeconds));
  const window = (Date.parse(state.invites[0].expiresAt) - Date.now()) / 1000;
  check('expiry is ~90s out', window > 80 && window <= 91, String(window));

  await actAs(bo);
  state = await rpc('api.friends_state');
  check('invitee sees it incoming', state.invites[0]?.direction === 'incoming', JSON.stringify(state.invites));

  // Crossing invitations are refused rather than making two matches.
  r = await rpc('api.send_invite', [ada, 300]);
  check('crossed invite refused', r.ok === false, JSON.stringify(r));

  r = await rpc('api.respond_invite', [inviteId, true]);
  check('accepting returns a ticket', r.ok === true && !!r.match, JSON.stringify(r));
  check('ticket names the opponent', r.match?.opponentUsername === 'Ada', JSON.stringify(r.match));
  check('ticket keeps the chosen length', r.match?.durationSeconds === 900, JSON.stringify(r.match));

  r = await rpc('api.respond_invite', [inviteId, true]);
  check('an invite cannot be accepted twice', r.ok === false, JSON.stringify(r));

  // The inviter picks the same match up from their poll.
  const acceptedMatchId = (await rpc('api.friends_state')).match?.matchId;
  await actAs(ada);
  state = await rpc('api.friends_state');
  check('inviter is handed the same match', !!acceptedMatchId && state.match?.matchId === acceptedMatchId, JSON.stringify(state.match));
  check('inviter ticket names Boris', state.match?.opponentUsername === 'Boris', JSON.stringify(state.match));
  check('the invite is no longer pending', state.invites.length === 0, JSON.stringify(state.invites));

  const matches = await client.query(`select count(*)::int as n from public.matches`);
  check('exactly one match was created', matches.rows[0].n === 1, JSON.stringify(matches.rows));

  // --- expiry ------------------------------------------------------------
  await actAs(ada);
  r = await rpc('api.send_invite', [bo, 0]);
  check('unlimited invite allowed', r.ok === true, JSON.stringify(r));
  const staleId = r.invite.id;
  await client.query(`update public.match_invites set expires_at = now() - interval '1 second' where id = $1`, [staleId]);
  state = await rpc('api.friends_state');
  check('a lapsed invite drops out of the panel', state.invites.length === 0, JSON.stringify(state.invites));
  await actAs(bo);
  r = await rpc('api.respond_invite', [staleId, true]);
  check('a lapsed invite cannot be accepted', r.ok === false, JSON.stringify(r));

  // --- presence goes stale ----------------------------------------------
  await client.query(`update public.profiles set last_seen_at = now() - interval '5 minutes' where user_id = $1`, [ada]);
  await actAs(bo);
  state = await rpc('api.friends_state');
  check('a silent friend reads as offline', state.friends[0]?.online === false, JSON.stringify(state.friends));

  // --- removing ----------------------------------------------------------
  r = await rpc('api.remove_friend', [ada]);
  check('friend removed', r.ok === true, JSON.stringify(r));
  state = await rpc('api.friends_state');
  check('list is empty again', state.friends.length === 0, JSON.stringify(state.friends));

  // --- unlimited queue bucket from the previous migration ----------------
  await client.query("update public.matches set status='completed' where status='playing'");
  await actAs(ada);
  const q = await rpc('api.join_queue', [0]);
  check('unlimited queue accepted', q === null, JSON.stringify(q));
  await actAs(bo);
  const q2 = await rpc('api.join_queue', [0]);
  check('unlimited queue pairs players', q2?.durationSeconds === 0, JSON.stringify(q2));

  // --- anon has no way in ------------------------------------------------
  const anonGrants = await client.query(
    `select count(*)::int as n from information_schema.role_routine_grants
     where grantee = 'anon' and specific_schema = 'api' and routine_name <> 'queue_population'`,
  );
  check('anon cannot call the api schema', anonGrants.rows[0].n === 0, JSON.stringify(anonGrants.rows));

  const tableGrants = await client.query(
    `select count(*)::int as n from information_schema.role_table_grants
     where grantee in ('anon','authenticated') and table_name in ('friendships','match_invites')`,
  );
  check('friend tables are RPC-only', tableGrants.rows[0].n === 0, JSON.stringify(tableGrants.rows));
} catch (error) {
  console.error('\nERROR:', error.message);
  failures.push(error.message);
} finally {
  try { await client?.end(); } catch {}
  try { await pgsql.stop(); } catch {}
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* Windows may still hold a handle */ }
}

console.log(failures.length ? `\nFAILED (${failures.length}): ${failures.join(', ')}` : '\nALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
