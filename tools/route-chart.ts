/**
 * Draws every missile tier's flight path straight from the live ballistics, so
 * the two families can be compared at a glance after a change.
 *
 *   npm run chart:routes   ->  route-chart.svg
 */
import { writeFileSync } from 'node:fs';
import { BUILDINGS, MISSILES, WORLD } from '../src/core/config';
import { missileAt, spawnMissile } from '../src/game/combat';
import { createMatch } from '../src/game/state';

const match = createMatch('easy', 900);
const targetX = 520;
const tallest = Math.max(...BUILDINGS.map((b) => b.h));

const paths = MISSILES.map((def) => {
  const missile = spawnMissile(match.player, def.tier, targetX);
  const points: string[] = [];
  for (let step = 0; step <= 400; step++) {
    const p = missileAt(missile, step / 400);
    points.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  }
  return { def, d: `M ${points.join(' L ')}`, flight: missile.flightTime };
});

const legend = paths
  .map(({ def, flight }, i) => {
    const y = 40 + i * 22;
    return `<rect x="60" y="${y - 11}" width="26" height="4" fill="${def.color}" stroke="#000" stroke-width="0.5"/>
    <text x="96" y="${y - 4}" fill="#dfe6ee" font-size="15" font-family="system-ui, sans-serif">
      ${def.roman} · ${def.name} · ${def.speed} m/s · ${flight.toFixed(2)}s · ${def.route}
    </text>`;
  })
  .join('\n');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WORLD.width} ${WORLD.height}" width="${WORLD.width}" height="${WORLD.height}">
  <rect width="${WORLD.width}" height="${WORLD.height}" fill="#151a22"/>
  <rect x="${WORLD.cityLeft.x0}" y="${WORLD.groundY - tallest}" width="${WORLD.cityLeft.x1 - WORLD.cityLeft.x0}" height="${tallest}" fill="#242c38"/>
  <rect x="${WORLD.cityRight.x0}" y="${WORLD.groundY - tallest}" width="${WORLD.cityRight.x1 - WORLD.cityRight.x0}" height="${tallest}" fill="#242c38"/>
  <text x="${WORLD.cityLeft.x0 + 12}" y="${WORLD.groundY - tallest - 10}" fill="#6d7a8a" font-size="15" font-family="system-ui, sans-serif">enemy city (tallest skyline)</text>
  <text x="${WORLD.cityRight.x0 + 12}" y="${WORLD.groundY - tallest - 10}" fill="#6d7a8a" font-size="15" font-family="system-ui, sans-serif">your city</text>
  <line x1="0" y1="${WORLD.groundY}" x2="${WORLD.width}" y2="${WORLD.groundY}" stroke="#3a4553" stroke-width="3"/>
  <line x1="${targetX}" y1="0" x2="${targetX}" y2="${WORLD.groundY}" stroke="#4a5568" stroke-width="1.5" stroke-dasharray="6 6"/>
  ${paths.map(({ def, d }) => `<path d="${d}" fill="none" stroke="${def.color}" stroke-width="3.5" stroke-linecap="round" opacity="0.95"/>`).join('\n  ')}
  ${legend}
</svg>
`;

writeFileSync('route-chart.svg', svg);
console.log('Wrote route-chart.svg');
for (const { def, flight } of paths) {
  console.log(`${def.roman.padEnd(4)} ${def.name.padEnd(15)} ${def.route.padEnd(7)} ${String(def.speed).padStart(5)} m/s   ${flight.toFixed(2)}s`);
}
