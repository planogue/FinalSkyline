import { createClient, type RealtimeChannel, type SupabaseClient, type User } from '@supabase/supabase-js';
import type { MetaSave } from '../core/types';
import { parseOnlineAction, type OnlineAction } from './actions';
import { onlineDuration, onlineDurationLabel } from '../core/config';

export type OnlinePhase = 'loading' | 'disabled' | 'signed-out' | 'ready' | 'queueing' | 'matched' | 'error';

export interface OnlineState {
  configured: boolean;
  phase: OnlinePhase;
  username: string | null;
  wins: number;
  losses: number;
  stars: number;
  message: string;
  /** Confirmed friends and the requests waiting on either side. */
  friends: FriendSummary[];
  /** Match invitations still standing, in both directions. */
  invites: MatchInvite[];
  /** Result of the last friends-panel action, shown under that panel. */
  friendMessage: string;
}

export interface FriendSummary {
  userId: string;
  username: string;
  /** Their last heartbeat is recent enough to call them online. */
  online: boolean;
  status: 'accepted' | 'incoming' | 'outgoing';
}

export interface MatchInvite {
  id: string;
  userId: string;
  username: string;
  /** 0 for an unlimited match. */
  durationSeconds: number;
  direction: 'incoming' | 'outgoing';
  /** ISO timestamp; the client counts down to it. */
  expiresAt: string;
}

export interface OnlineMatchTicket {
  matchId: string;
  durationSeconds: number;
  opponentId: string;
  opponentUsername: string;
  seed: number;
  startedAt: string;
}

interface ProfileRow {
  user_id: string;
  username: string;
  wins: number;
  losses: number;
  stars: number;
  radius_level: number[];
  aa_reload_level: number[];
  missile_reload_level: number[];
  best_difficulty: MetaSave['bestDifficulty'];
}

interface MatchEventRow {
  id: number;
  player_id: string;
  action: unknown;
}

interface OnlineCallbacks {
  changed(): void;
  matched(ticket: OnlineMatchTicket): void;
  action(action: OnlineAction): void;
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const eventPageSize = 500;
const backlogRetryLimit = 3;

export function initialOnlineState(): OnlineState {
  const configured = Boolean(url && publishableKey);
  return {
    configured,
    phase: configured ? 'loading' : 'disabled',
    username: null,
    wins: 0,
    losses: 0,
    stars: 0,
    message: configured ? 'Connecting…' : 'Online play is being connected',
    friends: [],
    invites: [],
    friendMessage: '',
  };
}

/** How often the client tells the server it is still here. */
const heartbeatMs = 30_000;
/** How often the friends panel refreshes while the player sits on the menu. */
const friendsPollMs = 4_000;

export class OnlineService {
  private client: SupabaseClient | null;
  private userId: string | null = null;
  private queueTimer = 0;
  private channel: RealtimeChannel | null = null;
  private activeMatchId: string | null = null;
  private seenEvents = new Set<string>();
  private eventBacklogReady = false;
  private bufferedEvents: MatchEventRow[] = [];
  private lastEventId = 0;
  private matchConnection = 0;
  private backlogLoad = 0;
  private backlogRetryTimer = 0;
  private actionTail: Promise<void> = Promise.resolve();
  private profileLoad = 0;
  private heartbeatTimer = 0;
  private friendsTimer = 0;
  /** Matches already entered this session, so a late poll cannot re-open one. */
  private openedMatches = new Set<string>();

  constructor(
    private state: OnlineState,
    private meta: MetaSave,
    private callbacks: OnlineCallbacks,
  ) {
    this.client = url && publishableKey
      ? createClient(url, publishableKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        })
      : null;
  }

  async init(): Promise<void> {
    if (!this.client) return;
    const { data, error } = await this.client.auth.getSession();
    if (error) {
      this.fail(error.message);
      return;
    }
    await this.handleUser(data.session?.user ?? null);
    this.client.auth.onAuthStateChange((_event, session) => {
      window.setTimeout(() => {
        // Token refreshes and tab focus can emit another sign-in for the same
        // account. Reloading its profile would reset an active queue or match.
        if ((session?.user.id ?? null) !== this.userId) void this.handleUser(session?.user ?? null);
      }, 0);
    });
  }

  async signUp(username: string, email: string, password: string): Promise<void> {
    if (!this.client) return;
    const cleanName = username.trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(cleanName)) {
      this.set({ phase: 'signed-out', message: 'Username: 3–20 letters, numbers, or underscores' });
      return;
    }
    if (password.length < 8) {
      this.set({ phase: 'signed-out', message: 'Use at least 8 characters for your password' });
      return;
    }
    this.set({ phase: 'loading', message: 'Creating account…' });
    const address = email.trim();
    const { data, error } = await this.client.auth.signUp({
      email: address,
      password,
      options: { data: { username: cleanName }, emailRedirectTo: window.location.origin },
    });
    if (error) {
      this.set({ phase: 'signed-out', message: error.message });
      return;
    }
    if (data.session && data.user) {
      await this.handleUser(data.user);
      return;
    }
    // No session came back, which means the project still has email
    // confirmation switched on. Sign in with the credentials just used rather
    // than sending the player away to their inbox.
    const signedIn = await this.client.auth.signInWithPassword({ email: address, password });
    if (signedIn.data.user && !signedIn.error) {
      await this.handleUser(signedIn.data.user);
      return;
    }
    this.set({
      phase: 'signed-out',
      message:
        'Account made, but this project still requires email confirmation. ' +
        'Turn "Confirm email" off in Supabase Auth, or play as a guest.',
    });
  }

  /** A throwaway account: play online with no credentials at all. */
  async signInAsGuest(): Promise<void> {
    if (!this.client) return;
    this.set({ phase: 'loading', message: 'Setting up a guest commander…' });
    const { data, error } = await this.client.auth.signInAnonymously();
    if (error) {
      this.set({
        phase: 'signed-out',
        message: /anonymous.*disabled|not enabled/i.test(error.message)
          ? 'Guest play is not enabled on this project yet'
          : error.message,
      });
      return;
    }
    await this.handleUser(data.user);
  }

  async signIn(email: string, password: string): Promise<void> {
    if (!this.client) return;
    this.set({ phase: 'loading', message: 'Signing in…' });
    const { data, error } = await this.client.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      this.set({ phase: 'signed-out', message: error.message });
      return;
    }
    await this.handleUser(data.user);
  }

  async signOut(): Promise<void> {
    if (!this.client) return;
    await this.cancelQueue();
    await this.disconnectMatch();
    const { error } = await this.client.auth.signOut();
    if (error) {
      this.fail(error.message);
      return;
    }
    this.userId = null;
    this.stopSocialLoops();
    this.set({
      phase: 'signed-out',
      username: null,
      wins: 0,
      losses: 0,
      stars: 0,
      message: 'Signed out',
      friends: [],
      invites: [],
      friendMessage: '',
    });
  }

  async joinQueue(durationSeconds: number): Promise<void> {
    if (!this.client || !this.userId || this.state.phase === 'queueing') return;
    const duration = onlineDuration(durationSeconds);
    this.set({ phase: 'queueing', message: `Searching for an ${onlineDurationLabel(duration)} match…` });
    const { data, error } = await this.client.schema('api').rpc('join_queue', {
      p_duration_seconds: duration,
    });
    if (error) {
      this.fail(this.onlineError(error.message));
      return;
    }
    if (data) {
      await this.openMatch(data);
      return;
    }
    window.clearInterval(this.queueTimer);
    this.queueTimer = window.setInterval(() => void this.pollQueue(), 1500);
  }

  async cancelQueue(): Promise<void> {
    window.clearInterval(this.queueTimer);
    this.queueTimer = 0;
    if (!this.client || !this.userId) return;
    if (this.state.phase === 'queueing') await this.client.schema('api').rpc('leave_queue');
    if (this.state.phase === 'queueing') this.set({ phase: 'ready', message: 'Queue cancelled' });
  }

  sendAction(action: OnlineAction): Promise<void> {
    if (!this.client || !this.userId || !this.activeMatchId) return Promise.resolve();
    const client = this.client;
    const playerId = this.userId;
    const matchId = this.activeMatchId;
    // Pin → clear/commit order matters. A single promise chain prevents separate
    // network requests from reaching the database in a different order.
    this.actionTail = this.actionTail.then(async () => {
      if (this.activeMatchId !== matchId) return;
      const { error } = await client.from('match_events').insert({
        match_id: matchId,
        player_id: playerId,
        action,
      });
      if (error) this.set({ message: `Connection warning: ${error.message}` });
    });
    return this.actionTail;
  }

  async reportResult(won: boolean, stars: number): Promise<void> {
    if (!this.client || !this.activeMatchId) return;
    const matchId = this.activeMatchId;
    await this.actionTail;
    const { error } = await this.client.schema('api').rpc('report_match_result', {
      p_match_id: matchId,
      p_won: won,
      p_stars: stars,
    });
    if (!error) await this.loadProfile();
    await this.disconnectMatch();
    if (error) this.set({ message: `Could not save match result online: ${error.message}` });
  }

  async syncProgress(meta = this.meta): Promise<void> {
    if (!this.client || !this.userId || this.state.phase === 'signed-out') return;
    const payload = {
      wins: Math.max(0, Math.floor(meta.wins)),
      losses: Math.max(0, Math.floor(meta.losses)),
      stars: Math.max(0, Math.floor(meta.stars)),
      radius_level: fitLevels(meta.radiusLevel, 6, 20),
      aa_reload_level: fitLevels(meta.aaReloadLevel, 6, 12),
      missile_reload_level: fitLevels(meta.missileReloadLevel, 6, 12),
      best_difficulty: meta.bestDifficulty,
    };
    const { error } = await this.client.from('profiles').update(payload).eq('user_id', this.userId);
    if (error) {
      this.set({ message: `Progress saved on this device; cloud sync failed: ${error.message}` });
      return;
    }
    this.set({ wins: payload.wins, losses: payload.losses, stars: payload.stars });
  }

  async disconnectMatch(): Promise<void> {
    const channel = this.channel;
    // Invalidate callbacks before waiting for the network unsubscribe.
    this.matchConnection++;
    this.backlogLoad++;
    window.clearTimeout(this.backlogRetryTimer);
    this.backlogRetryTimer = 0;
    this.channel = null;
    this.activeMatchId = null;
    this.lastEventId = 0;
    this.seenEvents.clear();
    this.eventBacklogReady = false;
    this.bufferedEvents = [];
    if (this.userId && this.state.phase === 'matched') this.set({ phase: 'ready', message: 'Ready for another match' });
    if (this.client && channel) await this.client.removeChannel(channel);
  }

  private async pollQueue(): Promise<void> {
    if (!this.client || this.state.phase !== 'queueing') return;
    const { data, error } = await this.client.schema('api').rpc('queue_status');
    if (this.state.phase !== 'queueing') return;
    if (error) {
      window.clearInterval(this.queueTimer);
      this.fail(this.onlineError(error.message));
      return;
    }
    if (data) await this.openMatch(data);
  }

  private async openMatch(raw: unknown): Promise<void> {
    const ticket = parseTicket(raw);
    if (!ticket || !this.client || !this.userId) {
      this.fail('The match server returned an invalid ticket');
      return;
    }
    if (this.activeMatchId === ticket.matchId) return;
    if (this.channel || this.activeMatchId) await this.disconnectMatch();
    const connection = ++this.matchConnection;
    window.clearInterval(this.queueTimer);
    this.queueTimer = 0;
    this.activeMatchId = ticket.matchId;
    this.lastEventId = 0;
    this.seenEvents.clear();
    this.eventBacklogReady = false;
    this.bufferedEvents = [];
    this.actionTail = Promise.resolve();
    this.openedMatches.add(ticket.matchId);
    this.set({ phase: 'matched', message: `Matched with ${ticket.opponentUsername}`, invites: [] });
    this.callbacks.matched(ticket);

    this.channel = this.client
      .channel(`final-skyline:${ticket.matchId}:${this.userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'match_events', filter: `match_id=eq.${ticket.matchId}` },
        (payload) => {
          if (connection === this.matchConnection) this.queueEvent(payload.new);
        },
      )
      .subscribe((status) => {
        if (connection !== this.matchConnection) return;
        if (status === 'SUBSCRIBED') void this.loadEventBacklog(ticket.matchId);
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.eventBacklogReady = false;
          this.backlogLoad++;
          window.clearTimeout(this.backlogRetryTimer);
          this.backlogRetryTimer = 0;
          this.set({ message: 'Realtime connection interrupted — reconnecting…' });
        }
      });
  }

  private async loadEventBacklog(matchId: string, retry = 0): Promise<void> {
    if (!this.client || this.activeMatchId !== matchId) return;
    const load = ++this.backlogLoad;
    const connection = this.matchConnection;
    const current = () => this.activeMatchId === matchId && connection === this.matchConnection && load === this.backlogLoad;
    window.clearTimeout(this.backlogRetryTimer);
    this.backlogRetryTimer = 0;
    this.eventBacklogReady = false;
    let cursor = this.lastEventId;
    const rows: MatchEventRow[] = [];
    try {
      // Continue until an empty page, including projects whose API row limit
      // is smaller than our requested page size. Resume after consumed events.
      while (current()) {
        const { data, error } = await this.client
          .from('match_events')
          .select('id, player_id, action')
          .eq('match_id', matchId)
          .gt('id', cursor)
          .order('id', { ascending: true })
          .limit(eventPageSize);
        if (!current()) return;
        if (error) throw new Error(error.message);
        if (!data?.length) break;
        rows.push(...data);
        cursor = Number(data[data.length - 1].id);
      }
    } catch (error) {
      if (!current()) return;
      const message = error instanceof Error ? error.message : 'Network request failed';
      if (retry < backlogRetryLimit) {
        this.set({ message: `Catching up match events — retrying: ${message}` });
        this.backlogRetryTimer = window.setTimeout(() => {
          if (current()) void this.loadEventBacklog(matchId, retry + 1);
        }, 1000 * 2 ** retry);
      } else {
        this.set({ message: `Match sync failed: ${message}. Return to the menu and reconnect.` });
      }
      return;
    }
    if (!current()) return;
    const ordered = [...rows, ...this.bufferedEvents]
      .sort((a, b) => Number(a.id) - Number(b.id));
    this.bufferedEvents = [];
    this.eventBacklogReady = true;
    for (const row of ordered) {
      if (!current()) return;
      this.consumeEvent(row);
    }
    if (current()) this.set({ message: 'Match connected' });
  }

  private queueEvent(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const row = raw as MatchEventRow;
    if (!this.eventBacklogReady) {
      this.bufferedEvents.push(row);
      return;
    }
    this.consumeEvent(row);
  }

  private consumeEvent(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const row = raw as MatchEventRow;
    this.lastEventId = Math.max(this.lastEventId, Number(row.id) || 0);
    const id = String(row.id);
    if (this.seenEvents.has(id)) return;
    this.seenEvents.add(id);
    if (row.player_id === this.userId) return;
    const action = parseOnlineAction(row.action);
    if (action) this.callbacks.action(action);
  }

  private async handleUser(user: User | null): Promise<void> {
    const token = ++this.profileLoad;
    if (this.userId !== (user?.id ?? null)) {
      window.clearInterval(this.queueTimer);
      this.queueTimer = 0;
      this.stopSocialLoops();
      await this.disconnectMatch();
      if (token !== this.profileLoad) return;
    }
    if (!user) {
      this.userId = null;
      this.stopSocialLoops();
      this.set({
        phase: 'signed-out',
        username: null,
        wins: 0,
        losses: 0,
        stars: 0,
        message: 'Sign in or make an account to play online',
        friends: [],
        invites: [],
        friendMessage: '',
      });
      return;
    }
    this.userId = user.id;
    this.set({ phase: 'loading', message: 'Loading your commander…' });
    await this.loadProfile(token);
  }

  private async loadProfile(expectedToken = this.profileLoad): Promise<void> {
    if (!this.client || !this.userId) return;
    const userId = this.userId;
    const { data, error } = await this.client
      .from('profiles')
      .select('user_id, username, wins, losses, stars, radius_level, aa_reload_level, missile_reload_level, best_difficulty')
      .eq('user_id', userId)
      .single();
    if (expectedToken !== this.profileLoad || userId !== this.userId) return;
    if (error) {
      this.fail(error.message);
      return;
    }
    const profile = data as ProfileRow;
    const syncKey = `final-skyline:cloud-synced:${userId}`;
    const hasLocalProgress = this.meta.wins > 0 || this.meta.losses > 0 || this.meta.stars > 0 ||
      [...this.meta.radiusLevel, ...this.meta.aaReloadLevel, ...this.meta.missileReloadLevel].some((n) => n > 0);
    const remoteIsFresh = profile.wins === 0 && profile.losses === 0 && profile.stars === 0 &&
      [...profile.radius_level, ...profile.aa_reload_level, ...profile.missile_reload_level].every((n) => n === 0);

    if (!localStorage.getItem(syncKey) && hasLocalProgress && remoteIsFresh) {
      localStorage.setItem(syncKey, '1');
      await this.syncProgress(this.meta);
    } else {
      applyProfile(this.meta, profile);
      localStorage.setItem(syncKey, '1');
    }
    this.set({
      phase: 'ready',
      username: profile.username,
      wins: this.meta.wins,
      losses: this.meta.losses,
      stars: this.meta.stars,
      message: 'Ready to queue',
    });
    this.startSocialLoops();
  }

  // ------------------------------------------------------------- friends

  /** Presence heartbeat plus the friends/invitations poll. */
  private startSocialLoops(): void {
    this.stopSocialLoops();
    void this.beat();
    void this.refreshFriends();
    this.heartbeatTimer = window.setInterval(() => void this.beat(), heartbeatMs);
    this.friendsTimer = window.setInterval(() => void this.refreshFriends(), friendsPollMs);
  }

  private stopSocialLoops(): void {
    window.clearInterval(this.heartbeatTimer);
    window.clearInterval(this.friendsTimer);
    this.heartbeatTimer = 0;
    this.friendsTimer = 0;
  }

  private async beat(): Promise<void> {
    if (!this.client || !this.userId) return;
    // A failed heartbeat only makes this player look offline to friends for a
    // while; it is not worth interrupting them over.
    await this.client.schema('api').rpc('heartbeat');
  }

  /** One round trip for the whole panel: friends, invitations, and any match. */
  private async refreshFriends(): Promise<void> {
    if (!this.client || !this.userId) return;
    // Nothing social to poll for while a battle is on screen.
    if (this.activeMatchId) return;
    const { data, error } = await this.client.schema('api').rpc('friends_state');
    if (error || !this.userId) return;
    const state = (data ?? {}) as {
      friends?: unknown;
      invites?: unknown;
      match?: unknown;
    };
    this.set({
      friends: parseFriends(state.friends),
      invites: parseInvites(state.invites),
    });
    const ticket = parseTicket(state.match);
    // The other side accepted; drop into the match they just created.
    if (ticket && !this.openedMatches.has(ticket.matchId)) await this.openMatch(state.match);
  }

  async addFriend(username: string): Promise<void> {
    await this.friendAction(
      () => this.client!.schema('api').rpc('add_friend', { p_username: username.trim() }),
      'Enter a commander name first',
      username.trim().length > 0,
    );
  }

  async respondFriend(userId: string, accept: boolean): Promise<void> {
    await this.friendAction(() =>
      this.client!.schema('api').rpc('respond_friend', { p_user: userId, p_accept: accept }),
    );
  }

  async removeFriend(userId: string): Promise<void> {
    await this.friendAction(() => this.client!.schema('api').rpc('remove_friend', { p_user: userId }));
  }

  async sendInvite(userId: string, durationSeconds: number): Promise<void> {
    await this.friendAction(() =>
      this.client!.schema('api').rpc('send_invite', {
        p_to: userId,
        p_duration_seconds: onlineDuration(durationSeconds),
      }),
    );
  }

  async cancelInvite(inviteId: string): Promise<void> {
    await this.friendAction(() => this.client!.schema('api').rpc('cancel_invite', { p_invite: inviteId }));
  }

  /** Accepting starts the match for both players; declining just clears it. */
  async respondInvite(inviteId: string, accept: boolean): Promise<void> {
    if (!this.client || !this.userId) return;
    const { data, error } = await this.client
      .schema('api')
      .rpc('respond_invite', { p_invite: inviteId, p_accept: accept });
    if (error) {
      this.set({ friendMessage: this.onlineError(error.message) });
      return;
    }
    const result = (data ?? {}) as { message?: string; match?: unknown };
    this.set({ friendMessage: typeof result.message === 'string' ? result.message : '' });
    if (accept && result.match) {
      window.clearInterval(this.queueTimer);
      this.queueTimer = 0;
      await this.openMatch(result.match);
      return;
    }
    await this.refreshFriends();
  }

  /** Shared plumbing: run an RPC, surface its message, refresh the panel. */
  private async friendAction(
    call: () => PromiseLike<{ data: unknown; error: { message: string } | null }>,
    guardMessage = '',
    allowed = true,
  ): Promise<void> {
    if (!this.client || !this.userId) return;
    if (!allowed) {
      this.set({ friendMessage: guardMessage });
      return;
    }
    const { data, error } = await call();
    if (error) {
      this.set({ friendMessage: this.onlineError(error.message) });
      return;
    }
    const result = (data ?? {}) as { message?: string };
    this.set({ friendMessage: typeof result.message === 'string' ? result.message : '' });
    await this.refreshFriends();
  }

  private set(patch: Partial<OnlineState>): void {
    // The friends poll fires every few seconds and usually finds nothing new.
    // Rebuilding the menu on every one of those would fight the player's typing.
    const changed = Object.entries(patch).some(([key, value]) => {
      const current = (this.state as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value) || Array.isArray(current)) {
        return JSON.stringify(current) !== JSON.stringify(value);
      }
      return current !== value;
    });
    Object.assign(this.state, patch);
    if (changed) this.callbacks.changed();
  }

  private fail(message: string): void {
    this.set({ phase: 'error', message });
  }

  private onlineError(message: string): string {
    if (/schema.*api|invalid schema/i.test(message)) {
      return 'Online database is not fully configured yet (the api schema must be exposed)';
    }
    return message;
  }
}

/** Rows come back from an RPC as loose JSON; take only what has the right shape. */
function parseFriends(value: unknown): FriendSummary[] {
  if (!Array.isArray(value)) return [];
  const out: FriendSummary[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const friend = row as Record<string, unknown>;
    const status = friend.status;
    if (typeof friend.userId !== 'string' || typeof friend.username !== 'string') continue;
    if (status !== 'accepted' && status !== 'incoming' && status !== 'outgoing') continue;
    out.push({
      userId: friend.userId,
      username: friend.username,
      online: friend.online === true,
      status,
    });
  }
  return out;
}

function parseInvites(value: unknown): MatchInvite[] {
  if (!Array.isArray(value)) return [];
  const out: MatchInvite[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const invite = row as Record<string, unknown>;
    const direction = invite.direction;
    if (typeof invite.id !== 'string' || typeof invite.userId !== 'string') continue;
    if (typeof invite.username !== 'string' || typeof invite.expiresAt !== 'string') continue;
    if (direction !== 'incoming' && direction !== 'outgoing') continue;
    if (typeof invite.durationSeconds !== 'number') continue;
    out.push({
      id: invite.id,
      userId: invite.userId,
      username: invite.username,
      durationSeconds: invite.durationSeconds,
      direction,
      expiresAt: invite.expiresAt,
    });
  }
  return out;
}

function parseTicket(value: unknown): OnlineMatchTicket | null {
  if (!value || typeof value !== 'object') return null;
  const ticket = value as Record<string, unknown>;
  if (
    typeof ticket.matchId !== 'string' ||
    typeof ticket.durationSeconds !== 'number' ||
    typeof ticket.opponentId !== 'string' ||
    typeof ticket.opponentUsername !== 'string' ||
    typeof ticket.startedAt !== 'string'
  ) return null;
  return {
    matchId: ticket.matchId,
    // The server stores an unlimited match as 0; the simulation wants Infinity.
    durationSeconds: ticket.durationSeconds === 0 ? Infinity : ticket.durationSeconds,
    opponentId: ticket.opponentId,
    opponentUsername: ticket.opponentUsername,
    seed: typeof ticket.seed === 'number' ? ticket.seed : Number(ticket.seed) || 0,
    startedAt: ticket.startedAt,
  };
}

function fitLevels(values: number[], size: number, max: number): number[] {
  return Array.from({ length: size }, (_, i) => Math.max(0, Math.min(max, Math.floor(values[i] ?? 0))));
}

function applyProfile(meta: MetaSave, profile: ProfileRow): void {
  meta.wins = profile.wins;
  meta.losses = profile.losses;
  meta.stars = profile.stars;
  meta.radiusLevel = fitLevels(profile.radius_level, 6, 20);
  meta.aaReloadLevel = fitLevels(profile.aa_reload_level, 6, 12);
  meta.missileReloadLevel = fitLevels(profile.missile_reload_level, 6, 12);
  meta.bestDifficulty = profile.best_difficulty;
}
