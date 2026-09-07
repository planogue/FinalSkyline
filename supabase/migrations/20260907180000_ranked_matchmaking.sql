-- Skill is smoothed with ten virtual games; permanent upgrades add power.
alter table public.matchmaking_queue add column if not exists last_seen timestamptz not null default now();
alter table public.matchmaking_queue add column if not exists player_level integer not null default 20;
create index if not exists matchmaking_queue_live_idx on public.matchmaking_queue(last_seen);

create or replace function private.match_level(p public.profiles)
returns integer language sql immutable set search_path = '' as $$
 select greatest(1, floor(10 + 20.0 * (p.wins::numeric + 5) / (p.wins::numeric + p.losses + 10)
 + (select coalesce(sum(greatest(0,n)),0) from unnest(p.radius_level || p.aa_reload_level || p.missile_reload_level) n) / 3.0)::integer);
$$;
revoke all on function private.match_level(public.profiles) from public, anon, authenticated;

create or replace function private.match_waiting(caller uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare mine public.matchmaking_queue%rowtype; opponent uuid;
begin
 perform pg_catalog.pg_advisory_xact_lock(731907::bigint);
 delete from public.matchmaking_queue where last_seen < now() - interval '20 seconds';
 select * into mine from public.matchmaking_queue where user_id = caller;
 if not found then return; end if;
 select q.user_id into opponent from public.matchmaking_queue q
 where q.user_id <> caller and q.duration_seconds = mine.duration_seconds
 and (extract(epoch from now()-least(q.joined_at,mine.joined_at)) >= 120
   or abs(q.player_level-mine.player_level) <= 3 + 3 * floor(extract(epoch from now()-least(q.joined_at,mine.joined_at))/15))
 order by abs(q.player_level-mine.player_level), q.joined_at, q.user_id
 for update skip locked limit 1;
 if opponent is null then return; end if;
 delete from public.matchmaking_queue where user_id in (caller,opponent);
 insert into public.matches(player_one,player_two,duration_seconds) values(opponent,caller,mine.duration_seconds);
end;
$$;
revoke all on function private.match_waiting(uuid) from public, anon, authenticated;

create or replace function api.queue_status()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  found public.matches%rowtype;
  opponent uuid;
  opponent_name text;
begin
  if caller is null then
    raise exception 'Sign in before checking the queue';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(731907::bigint);
  update public.matchmaking_queue set last_seen = now() where user_id = caller;
  perform private.match_waiting(caller);
  if exists (select 1 from public.matchmaking_queue q where q.user_id = caller) then return null; end if;

  select m.* into found
  from public.matches m
  where caller in (m.player_one, m.player_two)
    and m.status = 'playing'
  order by m.started_at desc
  limit 1;
  if found.id is null then return null; end if;

  opponent := case when found.player_one = caller then found.player_two else found.player_one end;
  select p.username into opponent_name from public.profiles p where p.user_id = opponent;
  return jsonb_build_object(
    'matchId', found.id,
    'durationSeconds', found.duration_seconds,
    'seed', found.seed,
    'startedAt', found.started_at,
    'opponentId', opponent,
    'opponentUsername', opponent_name
  );
end;
$$;


create or replace function api.join_queue(p_duration_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare caller uuid := (select auth.uid()); level integer; ticket jsonb;
begin
 if caller is null then raise exception 'Sign in before joining the queue'; end if;
 if p_duration_seconds is null or p_duration_seconds not in (0,300,600,900) then raise exception 'Invalid match duration'; end if;
 perform pg_catalog.pg_advisory_xact_lock(731907::bigint);
 -- An already matched caller must receive the same ticket rather than match twice.
 ticket := api.queue_status();
 if ticket is not null then return ticket; end if;
 select private.match_level(p) into level from public.profiles p where p.user_id=caller;
 if level is null then raise exception 'Player profile is missing'; end if;
 insert into public.matchmaking_queue(user_id,duration_seconds,player_level,last_seen)
 values(caller,p_duration_seconds,level,now())
 on conflict(user_id) do update set
 joined_at=case when matchmaking_queue.duration_seconds=excluded.duration_seconds then matchmaking_queue.joined_at else now() end,
 duration_seconds=excluded.duration_seconds, player_level=excluded.player_level,last_seen=now();
 return api.queue_status();
end;
$$;

-- Only publish an aggregate. Queued identities remain private.
create or replace function api.queue_population()
returns integer language sql stable security definer set search_path = '' as $$
 select count(*)::integer from public.matchmaking_queue where last_seen >= now()-interval '20 seconds';
$$;
revoke all on function api.queue_population() from public;
grant usage on schema api to anon;
grant execute on function api.queue_population() to anon, authenticated;
revoke insert,update,delete on public.matchmaking_queue from authenticated;
revoke all on function api.join_queue(integer), api.queue_status() from public,anon;
grant execute on function api.join_queue(integer), api.queue_status() to authenticated;
notify pgrst, 'reload schema';
