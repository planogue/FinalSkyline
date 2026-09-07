import type { MetaSave } from './types';
/** Ten virtual games at 50% soften early results; three upgrade steps add a level. */
export function playerLevel(meta: MetaSave): number {
  const wins = Math.max(0, meta.wins), losses = Math.max(0, meta.losses);
  const upgrades = [...meta.radiusLevel, ...meta.aaReloadLevel, ...meta.missileReloadLevel]
    .reduce((sum, n) => sum + Math.max(0, n), 0);
  return Math.max(1, Math.floor(10 + 20 * (wins + 5) / (wins + losses + 10) + upgrades / 3));
}
