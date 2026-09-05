-- Friends, presence, and direct match invitations.
--
-- Everything here is reached through security-definer RPCs in the `api` schema
-- rather than table grants: a player needs to see a friend's username and
-- whether they are online, which the profiles policy deliberately does not
-- allow, and nothing else about that account should leak on the way past.

-- --------------------------------------------------------------------------
-- Presence
-- --------------------------------------------------------------------------

alter table public.profiles
  add column if not exists last_seen_at timestamptz not null default now();

create index if not exists profiles_last_seen_idx on public.profiles (last_seen_at desc);

-- How stale a heartbeat may be before a player reads as offline. The client
-- beats every 30 seconds, so this tolerates two missed beats.
create or replace function private.presence_window()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '75 seconds' $$;

-- --------------------------------------------------------------------------
-- Friendships: one row per pair, held in a canonical order
-- --------------------------------------------------------------------------

create table public.friendships (
  user_low uuid not null references auth.users(id) on delete cascade,
  user_high uuid not null references auth.users(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_low, user_high),
  constraint friendship_pair_ordered check (user_low < user_high),
  constraint friendship_requester_is_member check (requested_by in (user_low, user_high))
);

create index friendships_user_high_idx on public.friendships (user_high);
create index friendships_requested_by_idx on public.friendships (requested_by);

create trigger friendships_set_updated_at
before update on public.friendships
for each row execute function private.set_updated_at();

-- --------------------------------------------------------------------------
-- Direct match invitations
-- --------------------------------------------------------------------------

create table public.match_invites (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references auth.users(id) on delete cascade,
  to_user uuid not null references auth.users(id) on delete cascade,
  duration_seconds integer not null check (duration_seconds in (0, 300, 600, 900)),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  match_id uuid references public.matches(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint match_invites_two_players check (from_user <> to_user)
);

create index match_invites_to_idx on public.match_invites (to_user, status, created_at desc);
create index match_invites_from_idx on public.match_invites (from_user, status, created_at desc);
create index match_invites_match_id_idx on public.match_invites (match_id);

-- An invitation stands for 90 seconds and then lapses.
create or replace function private.invite_window()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '90 seconds' $$;

alter table public.friendships enable row level security;
alter table public.match_invites enable row level security;
revoke all on public.friendships from anon, authenticated;
revoke all on public.match_invites from anon, authenticated;

-- --------------------------------------------------------------------------
-- Helpers
-- --------------------------------------------------------------------------

/** Retires invitations nobody answered inside the window. */
create or replace function private.expire_invites()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.match_invites
  set status = 'expired'
  where status = 'pending' and expires_at <= now();
$$;

/** The ticket shape both matchmaking and invitations hand back to the client. */
create or replace function private.match_ticket(p_match public.matches, p_caller uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  opponent uuid := case when p_match.player_one = p_caller then p_match.player_two else p_match.player_one end;
  opponent_name text;
begin
  select p.username into opponent_name from public.profiles p where p.user_id = opponent;
  return jsonb_build_object(
    'matchId', p_match.id,
    'durationSeconds', p_match.duration_seconds,
    'seed', p_match.seed,
    'startedAt', p_match.started_at,
    'opponentId', opponent,
    'opponentUsername', opponent_name
  );
end;
$$;

-- --------------------------------------------------------------------------
-- Presence heartbeat
-- --------------------------------------------------------------------------

create or replace function api.heartbeat()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.profiles set last_seen_at = now() where user_id = (select auth.uid());
$$;

-- --------------------------------------------------------------------------
-- Friend list management
-- --------------------------------------------------------------------------

create or replace function api.add_friend(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  target uuid;
  target_name text;
  low uuid;
  high uuid;
  existing public.friendships%rowtype;
begin
  if caller is null then raise exception 'Sign in first'; end if;

  select p.user_id, p.username into target, target_name
  from public.profiles p
  where lower(p.username) = lower(trim(p_username));

  if target is null then
    return jsonb_build_object('ok', false, 'message', 'No commander by that name');
  end if;
  if target = caller then
    return jsonb_build_object('ok', false, 'message', 'You cannot add yourself');
  end if;

  low := least(caller, target);
  high := greatest(caller, target);
  select * into existing from public.friendships f where f.user_low = low and f.user_high = high;

  if existing.user_low is null then
    insert into public.friendships (user_low, user_high, requested_by)
    values (low, high, caller);
    return jsonb_build_object('ok', true, 'message', format('Request sent to %s', target_name));
  end if;

  if existing.status = 'accepted' then
    return jsonb_build_object('ok', false, 'message', format('%s is already a friend', target_name));
  end if;

  -- They asked first; treat a second request as accepting theirs.
  if existing.requested_by = target then
    update public.friendships set status = 'accepted'
    where user_low = low and user_high = high;
    return jsonb_build_object('ok', true, 'message', format('%s is now a friend', target_name));
  end if;

  return jsonb_build_object('ok', false, 'message', format('Already waiting on %s', target_name));
end;
$$;

create or replace function api.respond_friend(p_user uuid, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  low uuid := least(caller, p_user);
  high uuid := greatest(caller, p_user);
  existing public.friendships%rowtype;
begin
  if caller is null then raise exception 'Sign in first'; end if;
  select * into existing from public.friendships f where f.user_low = low and f.user_high = high;
  if existing.user_low is null or existing.status <> 'pending' or existing.requested_by = caller then
    return jsonb_build_object('ok', false, 'message', 'No request from that commander');
  end if;

  if p_accept then
    update public.friendships set status = 'accepted' where user_low = low and user_high = high;
    return jsonb_build_object('ok', true, 'message', 'Friend added');
  end if;
  delete from public.friendships where user_low = low and user_high = high;
  return jsonb_build_object('ok', true, 'message', 'Request declined');
end;
$$;

create or replace function api.remove_friend(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null then raise exception 'Sign in first'; end if;
  delete from public.friendships
  where user_low = least(caller, p_user) and user_high = greatest(caller, p_user);
  -- Nothing to play together any more.
  update public.match_invites
  set status = 'cancelled'
  where status = 'pending'
    and ((from_user = caller and to_user = p_user) or (from_user = p_user and to_user = caller));
  return jsonb_build_object('ok', true, 'message', 'Friend removed');
end;
$$;

-- --------------------------------------------------------------------------
-- One round trip for the whole friends panel
-- --------------------------------------------------------------------------

create or replace function api.friends_state()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  friends jsonb;
  invites jsonb;
  ticket jsonb := null;
  joined public.matches%rowtype;
begin
  if caller is null then raise exception 'Sign in first'; end if;
  perform private.expire_invites();

  select coalesce(jsonb_agg(entry order by entry ->> 'username'), '[]'::jsonb)
  into friends
  from (
    select jsonb_build_object(
      'userId', other.user_id,
      'username', other.username,
      'online', other.last_seen_at > now() - private.presence_window(),
      'status', case
        when f.status = 'accepted' then 'accepted'
        when f.requested_by = caller then 'outgoing'
        else 'incoming'
      end
    ) as entry
    from public.friendships f
    join public.profiles other
      on other.user_id = case when f.user_low = caller then f.user_high else f.user_low end
    where caller in (f.user_low, f.user_high)
  ) rows;

  select coalesce(jsonb_agg(entry order by entry ->> 'expiresAt'), '[]'::jsonb)
  into invites
  from (
    select jsonb_build_object(
      'id', i.id,
      'userId', case when i.from_user = caller then i.to_user else i.from_user end,
      'username', other.username,
      'durationSeconds', i.duration_seconds,
      'direction', case when i.from_user = caller then 'outgoing' else 'incoming' end,
      'expiresAt', i.expires_at
    ) as entry
    from public.match_invites i
    join public.profiles other
      on other.user_id = case when i.from_user = caller then i.to_user else i.from_user end
    where i.status = 'pending' and caller in (i.from_user, i.to_user)
  ) rows;

  -- An invitation the other side has just accepted: hand back the ticket so
  -- the inviter drops into the same match without touching the queue.
  select m.* into joined
  from public.match_invites i
  join public.matches m on m.id = i.match_id
  where i.status = 'accepted'
    and caller in (i.from_user, i.to_user)
    and m.status = 'playing'
    and m.started_at > now() - interval '3 minutes'
  order by m.started_at desc
  limit 1;

  if joined.id is not null then
    ticket := private.match_ticket(joined, caller);
  end if;

  return jsonb_build_object(
    'friends', friends,
    'invites', invites,
    'match', ticket,
    'inviteSeconds', extract(epoch from private.invite_window())
  );
end;
$$;

-- --------------------------------------------------------------------------
-- Invitations
-- --------------------------------------------------------------------------

create or replace function api.send_invite(p_to uuid, p_duration_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  target_name text;
  made public.match_invites%rowtype;
begin
  if caller is null then raise exception 'Sign in first'; end if;
  if p_duration_seconds not in (0, 300, 600, 900) then
    raise exception 'Matches must be 5, 10, 15 minutes, or unlimited';
  end if;
  if not exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and f.user_low = least(caller, p_to)
      and f.user_high = greatest(caller, p_to)
  ) then
    return jsonb_build_object('ok', false, 'message', 'You can only invite friends');
  end if;

  perform private.expire_invites();

  -- Their invitation is already on the table; do not cross in the post.
  if exists (
    select 1 from public.match_invites i
    where i.status = 'pending' and i.from_user = p_to and i.to_user = caller
  ) then
    return jsonb_build_object('ok', false, 'message', 'They have already invited you — answer that instead');
  end if;

  update public.match_invites
  set status = 'cancelled'
  where status = 'pending' and from_user = caller and to_user = p_to;

  insert into public.match_invites (from_user, to_user, duration_seconds, expires_at)
  values (caller, p_to, p_duration_seconds, now() + private.invite_window())
  returning * into made;

  select p.username into target_name from public.profiles p where p.user_id = p_to;
  return jsonb_build_object(
    'ok', true,
    'message', format('Invited %s', target_name),
    'invite', jsonb_build_object(
      'id', made.id,
      'userId', p_to,
      'username', target_name,
      'durationSeconds', made.duration_seconds,
      'direction', 'outgoing',
      'expiresAt', made.expires_at
    )
  );
end;
$$;

create or replace function api.cancel_invite(p_invite uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null then raise exception 'Sign in first'; end if;
  update public.match_invites
  set status = 'cancelled'
  where id = p_invite and status = 'pending' and caller in (from_user, to_user);
  return jsonb_build_object('ok', true, 'message', 'Invitation withdrawn');
end;
$$;

create or replace function api.respond_invite(p_invite uuid, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  invite public.match_invites%rowtype;
  made public.matches%rowtype;
begin
  if caller is null then raise exception 'Sign in first'; end if;

  -- Lock the row: both sides poll, and only one match may come of one invite.
  select * into invite
  from public.match_invites
  where id = p_invite and to_user = caller
  for update;

  if invite.id is null then
    return jsonb_build_object('ok', false, 'message', 'That invitation is gone');
  end if;
  if invite.status <> 'pending' then
    return jsonb_build_object('ok', false, 'message', 'That invitation was already answered');
  end if;
  if invite.expires_at <= now() then
    update public.match_invites set status = 'expired' where id = invite.id;
    return jsonb_build_object('ok', false, 'message', 'That invitation ran out');
  end if;

  if not p_accept then
    update public.match_invites set status = 'declined' where id = invite.id;
    return jsonb_build_object('ok', true, 'message', 'Invitation declined');
  end if;

  -- Neither player should be sitting in the open queue once they pair up.
  delete from public.matchmaking_queue where user_id in (invite.from_user, invite.to_user);

  insert into public.matches (player_one, player_two, duration_seconds)
  values (invite.from_user, invite.to_user, invite.duration_seconds)
  returning * into made;

  update public.match_invites
  set status = 'accepted', match_id = made.id
  where id = invite.id;

  return jsonb_build_object('ok', true, 'message', 'Match starting', 'match', private.match_ticket(made, caller));
end;
$$;

-- --------------------------------------------------------------------------
-- Grants: the RPCs are the only way in
-- --------------------------------------------------------------------------

revoke all on function private.expire_invites() from public, anon, authenticated;
revoke all on function private.invite_window() from public, anon, authenticated;
revoke all on function private.presence_window() from public, anon, authenticated;
revoke all on function private.match_ticket(public.matches, uuid) from public, anon, authenticated;

revoke all on function api.heartbeat() from public, anon;
revoke all on function api.add_friend(text) from public, anon;
revoke all on function api.respond_friend(uuid, boolean) from public, anon;
revoke all on function api.remove_friend(uuid) from public, anon;
revoke all on function api.friends_state() from public, anon;
revoke all on function api.send_invite(uuid, integer) from public, anon;
revoke all on function api.cancel_invite(uuid) from public, anon;
revoke all on function api.respond_invite(uuid, boolean) from public, anon;

grant execute on function api.heartbeat() to authenticated;
grant execute on function api.add_friend(text) to authenticated;
grant execute on function api.respond_friend(uuid, boolean) to authenticated;
grant execute on function api.remove_friend(uuid) to authenticated;
grant execute on function api.friends_state() to authenticated;
grant execute on function api.send_invite(uuid, integer) to authenticated;
grant execute on function api.cancel_invite(uuid) to authenticated;
grant execute on function api.respond_invite(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
