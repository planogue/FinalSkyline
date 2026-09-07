import { AA, BUILDINGS, MATCH, MISSILES, WORLD, type BotProfile } from '../core/config';
import type { MetaSave } from '../core/types';
import {
  aaCost,
  aaRadius,
  bestDeploySpot,
  buildingLimit,
  buyAaRadius,
  buyAaReload,
  buyAmmo,
  buyBattery,
  buyBuilding,
  buyMissileUpgrade,
  countBuildings,
  difficultyProfile,
  inPeace,
  nextUid,
  type Match,
} from './state';

/** Most of the purse that may go to guns and rockets; the rest rebuilds. */
const MAX_WAR_SHARE = 0.68;

/** Tiers the bot has actually seen the player launch, so it can counter them. */
const seenTiers = new WeakMap<Match, Set<number>>();

export function noteIncomingTier(match: Match, tier: number): void {
  let s = seenTiers.get(match);
  if (!s) {
    s = new Set();
    seenTiers.set(match, s);
  }
  s.add(tier);
}

export function updateBot(match: Match, dt: number, meta: MetaSave): void {
  const p = difficultyProfile(match);
  match.botThinkAcc += dt;
  match.botSalvoAcc += dt;

  // Split the purse up front. Rebuilding under fire is a bottomless money pit,
  // so economy gets an envelope like everything else instead of first refusal.
  const purse = match.enemy.money;
  const atWar = !inPeace(match) && match.time >= MATCH.peaceSeconds + p.firstStrikeDelay;
  let defShare = atWar ? p.defenceBudget : p.defenceBudget * 0.6;
  let offShare = atWar ? p.offenceBudget : 0;
  // The profile shares are appetites, not a budget — normalise them so war
  // spending can never crowd out rebuilding, which is what keeps income alive.
  const war = defShare + offShare;
  if (war > MAX_WAR_SHARE) {
    const scale = MAX_WAR_SHARE / war;
    defShare *= scale;
    offShare *= scale;
  }
  const ecoShare = 1 - defShare - offShare;

  // Launch decisions have their own clock, independent of fumbled build turns.
  // Buy rounds first so construction and upgrades cannot starve an attack.
  if (atWar && match.botSalvoAcc >= p.salvoGap) {
    match.botSalvoAcc = 0;
    offence(match, p, meta, Math.max(MISSILES[0].cost, purse * offShare));
  }
  if (match.botThinkAcc < p.thinkInterval) return;
  match.botThinkAcc = 0;
  if (Math.random() > p.decisionChance) return;
  const built = economy(match, Math.min(match.enemy.money, purse * (atWar ? ecoShare : 1)));
  defence(match, p, meta, Math.min(match.enemy.money, purse * defShare), !built);
}

// ---------------------------------------------------------------------------

function economy(match: Match, budget: number): boolean {
  const bot = match.enemy;

  // Take one affordable building with the best income per dollar,
  // with a mild bias towards the biggest thing it can afford.
  let bestType = -1;
  let bestScore = -Infinity;
  for (let t = 0; t < BUILDINGS.length; t++) {
    const def = BUILDINGS[t];
    if (def.cost > budget) continue;
    if (countBuildings(bot, t) >= buildingLimit(match, t)) continue;
    const score = (def.income / def.cost) * (1 + t * 0.06);
    if (score > bestScore) {
      bestScore = score;
      bestType = t;
    }
  }
  return bestType >= 0 && buyBuilding(match, bot, bestType);
}

function defence(match: Match, p: BotProfile, meta: MetaSave, envelope: number, canBuild: boolean): void {
  const bot = match.enemy;
  let budget = envelope;

  // The two free systems are always worth taking.
  for (const type of [0, 1]) {
    if (canBuild && bot.aaOwned[type] < p.freeDefenceLimit && bot.aaOwned[type] < bot.aaLimit && aaCost(bot, type) === 0) {
      if (buyBattery(bot, type)) canBuild = false;
    }
  }

  const threat = seenTiers.get(match) ?? new Set<number>();
  // Priority order: counter what has actually been fired, then climb the tiers.
  const order = [1, 2, 3, 4, 5].sort((a, b) => {
    const ta = threat.has(a) ? 1 : 0;
    const tb = threat.has(b) ? 1 : 0;
    if (ta !== tb) return tb - ta;
    return a - b;
  });

  for (const tier of order) {
    const type = tier; // AA index N intercepts tier N
    // Build the layer out to full strength as soon as it is affordable. Waiting
    // for proof that a tier is in play means the first salvo lands unopposed.
    while (canBuild && bot.aaOwned[type] < bot.aaLimit) {
      const cost = aaCost(bot, type);
      if (!isFinite(cost) || cost > budget) break;
      const spot = bestDeploySpot(bot, type, aaRadius(bot, type, meta));
      if (spot === null || !buyBattery(bot, type, spot)) break;
      budget -= cost;
      canBuild = false;
    }
    // Stock interceptors for whatever is already deployed. Magazines have to be
    // full *before* the ceasefire lifts — an empty battery is just scenery.
    if (bot.aaOwned[type] > 0) {
      const prepping = MATCH.peaceSeconds - match.time < 75;
      const want = p.ammoTarget * bot.aaOwned[type] * (threat.has(tier) ? 1.5 : prepping ? 1 : 0.6);
      const missing = Math.ceil(want - bot.ammo[type]);
      if (missing > 0) {
        const affordable = Math.floor(budget / AA[type].ammoCost);
        const n = Math.min(missing, affordable);
        if (n > 0) budget -= buyAmmo(bot, type, n) * AA[type].ammoCost;
      }
    }
  }

  // Spare defence cash goes into radius and reload.
  if (p.defenceBudget > 0.3) {
    for (const type of [0, 1, 2, 3, 4, 5]) {
      if (bot.aaOwned[type] === 0) continue;
      if (bot.aaRadiusPrice[type] <= budget && Math.random() < 0.5) {
        const cost = bot.aaRadiusPrice[type];
        if (buyAaRadius(bot, type)) budget -= cost;
      }
      if (type > 0 && bot.aaReloadPrice[type] <= budget && Math.random() < 0.4) {
        const cost = bot.aaReloadPrice[type];
        if (buyAaReload(bot, type, meta)) budget -= cost;
      }
    }
  }
}

function offence(match: Match, p: BotProfile, meta: MetaSave, envelope: number): void {
  const bot = match.enemy;
  if (inPeace(match)) return;
  if (match.time < MATCH.peaceSeconds + p.firstStrikeDelay) return;

  // Respect the profile's offence envelope. Previously this forced every bot,
  // including Easy, to keep its cheap launcher permanently busy.
  let budget = Math.min(bot.money, envelope);
  if (budget < MISSILES[0].cost) return;

  if (bot.pending.length > p.salvoMax * 2) return;

  const rounds = p.salvoMin + Math.floor(Math.random() * (p.salvoMax - p.salvoMin + 1));
  for (let i = 0; i < rounds; i++) {
    const tier = chooseAttackTier(match, p, budget);
    if (tier === 0) break;
    const def = MISSILES[tier - 1];
    bot.money -= def.cost;
    bot.stats.spent += def.cost;
    budget -= def.cost;
    bot.pending.push({ uid: nextUid(), tier, x: chooseTarget(match, p), cost: def.cost });
  }

  // Only spend the remaining attack budget on upgrades.
  for (let tier = 2; tier <= p.maxTier; tier++) {
    const def = MISSILES[tier - 1];
    if (bot.missileUnlocked[tier - 1]) continue;
    if (def.unlockCost <= budget * 0.8) {
      if (buyMissileUpgrade(bot, tier, meta) === 'unlock') budget -= def.unlockCost;
    }
    break; // only ever unlock one step at a time
  }

  // Occasionally shave reload on its best unlocked tier.
  if (Math.random() < 0.35) {
    const best = bestTier(bot, p);
    if (best > 0 && bot.missileReloadPrice[best - 1] <= budget * 0.4) {
      const cost = bot.missileReloadPrice[best - 1];
      if (buyMissileUpgrade(bot, best, meta) === 'reload') budget -= cost;
    }
  }

}

function bestTier(state: Match['enemy'], p: BotProfile): number {
  for (let tier = Math.min(p.maxTier, MISSILES.length); tier >= 1; tier--) {
    if (state.missileUnlocked[tier - 1]) return tier;
  }
  return 0;
}

function chooseAttackTier(match: Match, p: BotProfile, budget: number): number {
  const bot = match.enemy;
  const player = match.player;
  const options: { tier: number; score: number }[] = [];
  for (let tier = 1; tier <= Math.min(p.maxTier, MISSILES.length); tier++) {
    const def = MISSILES[tier - 1];
    if (!bot.missileUnlocked[tier - 1]) continue;
    if (def.cost > budget) continue;
    const waiting = bot.pending.filter((q) => q.tier === tier).length;
    if (def.perMatchLimit > 0 && bot.shotsUsed[tier - 1] + waiting >= def.perMatchLimit) continue;
    // Damage per dollar, boosted when the player has no way to stop this tier.
    let score = def.damage / def.cost;
    // Prefer a launcher that is not already stacked with waiting rounds.
    score /= 1 + waiting * 0.8;
    const defended = player.aaOwned[tier] > 0 && player.ammo[tier] > 0;
    if (!defended && !def.unstoppable) score *= 1 + p.smartTargeting * 1.6;
    if (def.unstoppable) score *= 1.4;
    score *= 0.8 + Math.random() * 0.4;
    options.push({ tier, score });
  }
  if (!options.length) return 0;
  options.sort((a, b) => b.score - a.score);
  // Weaker bots do not always take the best option.
  const idx = Math.random() < p.smartTargeting ? 0 : Math.floor(Math.random() * options.length);
  return options[idx].tier;
}

function chooseTarget(match: Match, p: BotProfile): number {
  const player = match.player;
  const alive = player.buildings.filter((b) => !b.destroyed);
  const zone = WORLD.cityRight;
  let x: number;

  // Suppress the air defence first when it is smart enough to think of it.
  if (player.batteries.length && Math.random() < p.smartTargeting * 0.09) {
    const bat = player.batteries[Math.floor(Math.random() * player.batteries.length)];
    return Math.max(zone.x0 - 160, Math.min(zone.x1 + 60, bat.x + (Math.random() - 0.5) * p.aimError));
  }

  if (alive.length && Math.random() < p.smartTargeting) {
    // Aim at the densest, most valuable pocket of the skyline.
    let best = alive[0];
    let bestScore = -Infinity;
    for (const b of alive) {
      let score = BUILDINGS[b.type].cost;
      for (const o of alive) {
        if (o === b) continue;
        const d = Math.abs(o.x - b.x);
        if (d < 70) score += BUILDINGS[o.type].cost * (1 - d / 70) * 0.7;
      }
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    x = best.x;
  } else if (alive.length) {
    x = alive[Math.floor(Math.random() * alive.length)].x;
  } else {
    x = zone.x0 + Math.random() * (zone.x1 - zone.x0);
  }
  x += (Math.random() - 0.5) * 2 * p.aimError;
  return Math.max(zone.x0 - 60, Math.min(zone.x1 + 60, x));
}
