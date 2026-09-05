-- Two changes to online play:
--   1. Unlimited matches get their own matchmaking bucket, stored as 0
--      seconds because they have no finite length.
--   2. Guest (anonymous) accounts sign in without ever supplying a username, so
--      the profile trigger must be able to name them itself.

-- --------------------------------------------------------------------------
-- 1. Duration buckets: 300 / 600 / 900 / 0 (unlimited)
-- --------------------------------------------------------------------------

-- Drop by discovered name: the original constraints were unnamed, so their
-- generated names are not guaranteed across environments.
do $$
declare
  target record;
begin
  for target in
    select rel.relname as table_name, con.conname as constraint_name
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname in ('matchmaking_queue', 'matches')
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%duration_seconds%'
  loop
    execute format('alter table public.%I drop constraint %I', target.table_name, target.constraint_name);
  end loop;
end;
$$;

alter table public.matchmaking_queue
  add constraint matchmaking_queue_duration_seconds_check
  check (duration_seconds in (0, 300, 600, 900));

alter table public.matches
  add constraint matches_duration_seconds_check
  check (duration_seconds in (0, 300, 600, 900));

create or replace function api.join_queue(p_duration_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  opponent uuid;
  made public.matches%rowtype;
  opponent_name text;
begin
  if caller is null then
    raise exception 'Sign in before joining the queue';
  end if;
  if p_duration_seconds not in (0, 300, 600, 900) then
    raise exception 'Online matches must be 5, 10, 15 minutes, or unlimited';
  end if;

  -- Serialize queue joins within a duration bucket. Without this, two players
  -- arriving on the same millisecond can both miss each other and both wait.
  -- The unlimited bucket is 0, which is a valid advisory-lock key.
  perform pg_catalog.pg_advisory_xact_lock(p_duration_seconds::bigint);

  delete from public.matchmaking_queue where joined_at < now() - interval '10 minutes';
  delete from public.matchmaking_queue where user_id = caller;

  select q.user_id
  into opponent
  from public.matchmaking_queue q
  where q.user_id <> caller and q.duration_seconds = p_duration_seconds
  order by q.joined_at
  for update skip locked
  limit 1;

  if opponent is null then
    insert into public.matchmaking_queue (user_id, duration_seconds)
    values (caller, p_duration_seconds);
    return null;
  end if;

  delete from public.matchmaking_queue where user_id in (caller, opponent);
  insert into public.matches (player_one, player_two, duration_seconds)
  values (opponent, caller, p_duration_seconds)
  returning * into made;

  select p.username into opponent_name from public.profiles p where p.user_id = opponent;
  return jsonb_build_object(
    'matchId', made.id,
    'durationSeconds', made.duration_seconds,
    'seed', made.seed,
    'startedAt', made.started_at,
    'opponentId', opponent,
    'opponentUsername', opponent_name
  );
end;
$$;

-- --------------------------------------------------------------------------
-- 2. Name accounts that arrive without a username of their own
-- --------------------------------------------------------------------------

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested text := trim(coalesce(new.raw_user_meta_data ->> 'username', ''));
  candidate text;
  suffix text := left(replace(new.id::text, '-', ''), 8);
begin
  if requested !~ '^[A-Za-z0-9_]{3,20}$' then
    -- Fall back to any display name the provider sent; a guest sends nothing.
    requested := trim(coalesce(
      new.raw_user_meta_data ->> 'name',
      new.raw_user_meta_data ->> 'full_name',
      ''
    ));
    -- Strip anything the username check would reject, e.g. "Ada Ghali" -> "AdaGhali".
    requested := regexp_replace(requested, '[^A-Za-z0-9_]', '', 'g');
  end if;

  if requested ~ '^[A-Za-z0-9_]{3,20}$' then
    candidate := requested;
  elsif new.is_anonymous then
    candidate := 'guest_' || suffix;
  else
    candidate := 'pilot_' || suffix;
  end if;

  -- A duplicate requested name gets a stable short suffix instead of making
  -- sign-up fail with an opaque database error.
  if exists (select 1 from public.profiles p where lower(p.username) = lower(candidate)) then
    candidate := left(candidate, 15) || '_' || left(suffix, 4);
  end if;

  insert into public.profiles (user_id, username) values (new.id, candidate);
  return new;
end;
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated;

notify pgrst, 'reload schema';
