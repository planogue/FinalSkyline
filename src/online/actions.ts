import { WORLD } from '../core/config';
import type { MetaSave } from '../core/types';
import { concludeFromOpponent } from '../game/engine';
import {
  buyAaRadius,
  buyAaReload,
  buyAmmo,
  buyBattery,
  buyBuilding,
  buyMissileUpgrade,
  buyRadarIntel,
  buyBarrage,
  clearQueue,
  commitQueue,
  pinTarget,
  unpinLast,
  type Match,
} from '../game/state';

export type OnlineAction =
  | { type: 'build-building'; buildingType: number; x: number }
  | { type: 'build-battery'; batteryType: number; x: number }
  | { type: 'buy-ammo'; batteryType: number; count: number }
  | { type: 'aa-radius'; batteryType: number }
  | { type: 'aa-reload'; batteryType: number }
  | { type: 'missile-upgrade'; tier: number }
  | { type: 'radar-intel' }
  | { type: 'barrage-upgrade' }
  | { type: 'pin-target'; tier: number; x: number }
  | { type: 'unpin-target'; tier?: number }
  | { type: 'clear-targets' }
  | { type: 'commit-targets' }
  /**
   * The sender's match has ended. `won` is from the sender's point of view, so
   * the receiver takes the other half of it. Sent by whoever reaches the end
   * first; a wipeout is only ever announced by the side that was wiped out.
   */
  | { type: 'match-over'; won: boolean; cause: MatchOverCause };

export type MatchOverCause = 'wipeout' | 'time' | 'resign';

const MATCH_OVER_CAUSES: MatchOverCause[] = ['wipeout', 'time', 'resign'];

const intBetween = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

const finiteX = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= -500 && value <= WORLD.width + 500;

/** Treat realtime payloads as untrusted input before they touch simulation state. */
export function parseOnlineAction(value: unknown): OnlineAction | null {
  if (!value || typeof value !== 'object' || !('type' in value)) return null;
  const action = value as Record<string, unknown>;
  switch (action.type) {
    case 'build-building':
      return intBetween(action.buildingType, 0, 8) && finiteX(action.x)
        ? { type: action.type, buildingType: action.buildingType, x: action.x }
        : null;
    case 'build-battery':
      return intBetween(action.batteryType, 0, 5) && finiteX(action.x)
        ? { type: action.type, batteryType: action.batteryType, x: action.x }
        : null;
    case 'buy-ammo':
      return intBetween(action.batteryType, 1, 5) && intBetween(action.count, 1, 100)
        ? { type: action.type, batteryType: action.batteryType, count: action.count }
        : null;
    case 'aa-radius':
    case 'aa-reload':
      return intBetween(action.batteryType, 0, 5)
        ? { type: action.type, batteryType: action.batteryType }
        : null;
    case 'missile-upgrade':
      return intBetween(action.tier, 1, 6) ? { type: action.type, tier: action.tier } : null;
    case 'pin-target':
      return intBetween(action.tier, 1, 6) && finiteX(action.x)
        ? { type: action.type, tier: action.tier, x: action.x }
        : null;
    case 'unpin-target':
      return action.tier === undefined || intBetween(action.tier, 1, 6)
        ? { type: action.type, ...(action.tier === undefined ? {} : { tier: action.tier }) }
        : null;
    case 'match-over':
      return typeof action.won === 'boolean' && MATCH_OVER_CAUSES.includes(action.cause as MatchOverCause)
        ? { type: action.type, won: action.won, cause: action.cause as MatchOverCause }
        : null;
    case 'barrage-upgrade':
    case 'radar-intel':
    case 'clear-targets':
    case 'commit-targets':
      return { type: action.type };
    default:
      return null;
  }
}

/**
 * Both browsers render themselves on the right. Realtime commands are mirrored
 * across the centre line before being applied to the left-side opponent.
 */
export function applyRemoteAction(match: Match, meta: MetaSave, action: OnlineAction): boolean {
  const enemy = match.enemy;
  switch (action.type) {
    case 'build-building':
      return buyBuilding(match, enemy, action.buildingType, WORLD.width - action.x);
    case 'build-battery':
      return buyBattery(enemy, action.batteryType, WORLD.width - action.x);
    case 'buy-ammo':
      return buyAmmo(enemy, action.batteryType, action.count) > 0;
    case 'aa-radius':
      return buyAaRadius(enemy, action.batteryType);
    case 'aa-reload':
      return buyAaReload(enemy, action.batteryType, meta);
    case 'missile-upgrade':
      return buyMissileUpgrade(enemy, action.tier, meta) !== false;
    case 'radar-intel':
      return buyRadarIntel(enemy);
    case 'barrage-upgrade':
      return buyBarrage(enemy);
    case 'pin-target':
      return pinTarget(enemy, action.tier, WORLD.width - action.x) !== null;
    case 'unpin-target':
      return unpinLast(enemy, action.tier);
    case 'clear-targets':
      clearQueue(enemy);
      return true;
    case 'commit-targets':
      return commitQueue(enemy) > 0;
    // Mirrored like everything else: their win is our loss.
    case 'match-over':
      return concludeFromOpponent(match, !action.won, action.cause, meta);
  }
}
