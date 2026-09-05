/**
 * Headless check on what the scene actually paints, using a recording stub in
 * place of a real 2D context. It exists for one rule that is easy to break and
 * impossible to unit-test any other way: the opponent's radars must stay off
 * the screen until the intel upgrade is bought, while every other battery —
 * and the player's own radar — is drawn as usual.
 *
 *   npm run probe:render
 */
import assert from 'node:assert/strict';
import { WORLD } from '../src/core/config';
import { defaultMeta } from '../src/core/storage';
import { buyBattery, buyRadarIntel, createMatch } from '../src/game/state';
import { Camera } from '../src/render/camera';
import { drawScene } from '../src/render/scene';

/** Every translate() the scene performs, which is how each battery is sited. */
type Recorder = { translations: { x: number; y: number }[] };

function stubContext(record: Recorder): CanvasRenderingContext2D {
  const gradient = { addColorStop() {} };
  const target: Record<string, unknown> = {
    translations: record.translations,
    translate(x: number, y: number) {
      record.translations.push({ x, y });
    },
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    measureText: () => ({ width: 0 }),
  };
  // Everything else the renderer touches is a no-op sink.
  return new Proxy(target, {
    get(obj, key) {
      if (key in obj) return obj[key as string];
      return () => undefined;
    },
    set(obj, key, value) {
      obj[key as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

const meta = defaultMeta();

function paintedAt(radarIntel: boolean, worldX: number): boolean {
  const match = createMatch('easy', 300);
  match.enemy.money = 10000;
  match.player.money = 10000;
  assert(buyBattery(match.enemy, 0, worldX), 'enemy radar sited');
  assert(buyBattery(match.enemy, 3, worldX + 300), 'enemy launcher sited');
  assert(buyBattery(match.player, 0, WORLD.cityRight.x0 + 100), 'player radar sited');
  if (radarIntel) assert(buyRadarIntel(match.player));

  const camera = new Camera();
  camera.resize(1600, 900, 150);
  camera.setMode('wide');
  camera.update(10);

  const record: Recorder = { translations: [] };
  drawScene(stubContext(record), match, camera, {
    showRings: false,
    aiming: false,
    aimTier: 1,
    aimX: null,
    meta,
    hasRadar: true,
    radarIntel: match.player.radarIntel,
    deploy: null,
    buildingDeploy: null,
  });

  const screenX = camera.toScreenX(worldX);
  const painted = record.translations.some((t) => Math.abs(t.x - screenX) < 1);
  // Sanity: the visible batteries must always show up, or the probe is lying.
  for (const visible of [worldX + 300, WORLD.cityRight.x0 + 100]) {
    const at = camera.toScreenX(visible);
    assert(
      record.translations.some((t) => Math.abs(t.x - at) < 1),
      `Expected a battery painted at world ${visible}`,
    );
  }
  return painted;
}

const site = WORLD.cityLeft.x0 + 400;
assert.equal(paintedAt(false, site), false, 'Enemy radars stay hidden without the intel upgrade');
assert.equal(paintedAt(true, site), true, 'The intel upgrade reveals enemy radars');

console.log('PASS: enemy radars are concealed until the intel upgrade is bought.');
