import { AA, BUILDINGS, MATCH, MISSILES, WORLD } from '../core/config';
import type { AaBattery, Building, MetaSave } from '../core/types';
import { standingFraction } from '../game/combat';
import { aaRadius, hash01, launchPadX, type Match } from '../game/state';
import { Camera } from './camera';

export interface SceneOpts {
  /** Rings are drawn while a defence panel is open or the toggle is on. */
  showRings: boolean;
  /** Highlights the enemy city and shows pins while aiming. */
  aiming: boolean;
  aimTier: number;
  /** Cursor position in world x while aiming, or null. */
  aimX: number | null;
  meta: MetaSave;
  /** With a radar you see incoming fire early; without it, only at the last second. */
  hasRadar: boolean;
  /** Bought the intel upgrade, so the opponent's camouflaged radars are drawn. */
  radarIntel: boolean;
  /** Anti-air type being sited by hand, with the cursor position and validity. */
  deploy: { type: number; x: number | null; valid: boolean; radius: number } | null;
  /** Building being positioned on a snapped city plot. */
  buildingDeploy: { type: number; x: number; layer: 0 | 1; valid: boolean } | null;
}

const SKY_DAY = ['#3c4147', '#6d757e', '#b9bfc6', '#d6dade'];
const SKY_NIGHT = ['#0d1119', '#171d29', '#2c3446', '#4a5468'];

export function drawScene(ctx: CanvasRenderingContext2D, match: Match, cam: Camera, opts: SceneOpts): void {
  const night = nightAmount(match);
  ctx.save();

  // Screen shake
  if (match.shake > 0.2) {
    const s = match.shake;
    ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
  }

  drawSky(ctx, cam, night);
  drawCelestial(ctx, cam, match, night);
  drawClouds(ctx, cam, match, night);
  drawHorizon(ctx, cam, night);

  drawLaunchPad(ctx, cam, 'enemy', night);
  drawLaunchPad(ctx, cam, 'player', night);

  for (const side of [match.enemy, match.player]) {
    const highlight = opts.aiming && side.side === 'enemy';
    drawCity(ctx, cam, side.buildings, night, highlight);
    // Their radars are camouflaged until the intel upgrade is bought.
    const visible = side.batteries.filter(
      (b) => !(side.side === 'enemy' && isRadar(b.type) && !opts.radarIntel),
    );
    for (const { battery, offset } of stackLayout(visible)) {
      drawBattery(ctx, cam, battery, night, offset);
    }
  }

  drawGround(ctx, cam, night);

  if (opts.showRings) drawRings(ctx, cam, match, opts.meta);

  drawTrajectoryHints(ctx, cam, match, opts.hasRadar);
  drawMissiles(ctx, cam, match, opts.hasRadar);
  drawInterceptors(ctx, cam, match);
  drawParticles(ctx, cam, match);
  drawPins(ctx, cam, match, opts);
  if (opts.deploy) drawDeployPreview(ctx, cam, opts.deploy);
  if (opts.buildingDeploy) drawBuildingDeployPreview(ctx, cam, opts.buildingDeploy, night);
  drawTexts(ctx, cam, match);

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Sky & scenery
// ---------------------------------------------------------------------------

/** 0 = full day, 1 = full night. Kick-off is daylight, midnight is mid-match. */
export function dayPhase(match: Match): number {
  const period = isFinite(match.duration) && match.duration > 0 ? match.duration : MATCH.unlimitedCycleSeconds;
  return (match.time / period) % 1;
}

export function nightAmount(match: Match): number {
  return Math.min(1, Math.max(0, (1 - Math.cos(dayPhase(match) * Math.PI * 2)) / 2));
}

function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round((pa >> 16) + (((pb >> 16) - (pa >> 16)) * t));
  const g = Math.round(((pa >> 8) & 255) + ((((pb >> 8) & 255) - ((pa >> 8) & 255)) * t));
  const bl = Math.round((pa & 255) + (((pb & 255) - (pa & 255)) * t));
  return `rgb(${r},${g},${bl})`;
}

function drawSky(ctx: CanvasRenderingContext2D, cam: Camera, night: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, cam.groundScreenY());
  for (let i = 0; i < SKY_DAY.length; i++) {
    g.addColorStop(i / (SKY_DAY.length - 1), mix(SKY_DAY[i], SKY_NIGHT[i], night));
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cam.viewW, cam.groundScreenY() + 2);

  if (night > 0.35) {
    const a = (night - 0.35) / 0.65;
    for (let i = 0; i < 90; i++) {
      const sx = hash01(i * 3.1) * cam.viewW;
      const sy = hash01(i * 7.7 + 1) * cam.groundScreenY() * 0.75;
      const tw = 0.5 + 0.5 * Math.sin(i + performance.now() / 900);
      ctx.fillStyle = `rgba(255,255,255,${a * 0.55 * tw})`;
      ctx.fillRect(sx, sy, 1.6, 1.6);
    }
  }
}

function drawCelestial(ctx: CanvasRenderingContext2D, cam: Camera, match: Match, night: number): void {
  const p = dayPhase(match);
  const r = Math.max(13, cam.viewW * 0.02);
  // The sun owns the first half of the cycle, the moon the second.
  drawOrb(ctx, cam, p * 2, 1 - night, r, 'sun');
  drawOrb(ctx, cam, (p - 0.5) * 2, night, r, 'moon');
}

function drawOrb(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  phase: number,
  alpha: number,
  r: number,
  kind: 'sun' | 'moon',
): void {
  if (alpha <= 0.02) return;
  const q = ((phase % 2) + 2) % 2;
  if (q > 1) return; // below the horizon
  const cx = cam.viewW * (0.08 + q * 0.84);
  const cy = cam.groundScreenY() * (1 - Math.sin(Math.PI * q) * 0.72) - r * 1.4;
  ctx.save();
  ctx.globalAlpha = Math.min(1, alpha);
  const glow = kind === 'sun' ? 'rgba(255,200,70,' : 'rgba(214,228,255,';
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 3.6);
  g.addColorStop(0, `${glow}0.85)`);
  g.addColorStop(0.4, `${glow}0.28)`);
  g.addColorStop(1, `${glow}0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 3.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = kind === 'sun' ? '#ffd447' : '#e8eefb';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  if (kind === 'moon') {
    ctx.fillStyle = 'rgba(178,190,214,0.7)';
    for (let i = 0; i < 4; i++) {
      const a = hash01(i * 5.3) * 6.28;
      const d = hash01(i * 9.1) * r * 0.6;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * (0.12 + hash01(i * 2.7) * 0.16), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

const CLOUD_COUNT = 26;

function drawClouds(ctx: CanvasRenderingContext2D, cam: Camera, match: Match, night: number): void {
  ctx.fillStyle = mix('#6e7b8c', '#2a3244', night);
  const drift = match.time * 7;
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const depth = 0.35 + hash01(i * 3.7) * 0.5; // parallax
    const baseX = hash01(i * 11.3) * WORLD.width * 1.2 - WORLD.width * 0.1;
    const wx = baseX + drift * depth;
    const sx = (wx - cam.x * depth) * cam.scale + cam.viewW / 2;
    const wrapped = ((sx % (cam.viewW + 600)) + cam.viewW + 600) % (cam.viewW + 600) - 300;
    const sy = cam.groundScreenY() * (0.05 + hash01(i * 5.1) * 0.6);
    const s = (0.5 + hash01(i * 8.9) * 1.1) * Math.max(0.5, cam.scale * 1.6) * 34;
    ctx.globalAlpha = 0.55 + depth * 0.35;
    cloudPuff(ctx, wrapped, sy, s, i);
    ctx.globalAlpha = 1;
  }
}

function cloudPuff(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, seed: number): void {
  ctx.beginPath();
  const lobes = 4;
  for (let i = 0; i < lobes; i++) {
    const lx = x + (i - (lobes - 1) / 2) * s * 0.58;
    const ly = y - hash01(seed * 3 + i) * s * 0.28;
    const lr = s * (0.34 + hash01(seed * 5 + i) * 0.3);
    ctx.moveTo(lx + lr, ly);
    ctx.arc(lx, ly, lr, 0, Math.PI * 2);
  }
  ctx.rect(x - s * 1.1, y, s * 2.2, s * 0.34);
  ctx.fill();
}

function drawHorizon(ctx: CanvasRenderingContext2D, cam: Camera, night: number): void {
  const gy = cam.groundScreenY();
  const g = ctx.createLinearGradient(0, gy - 60 * cam.scale, 0, gy);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(1, night > 0.5 ? 'rgba(70,84,110,0.35)' : 'rgba(255,255,255,0.28)');
  ctx.fillStyle = g;
  ctx.fillRect(0, gy - 60 * cam.scale, cam.viewW, 60 * cam.scale);
}

function drawGround(ctx: CanvasRenderingContext2D, cam: Camera, night: number): void {
  const gy = cam.groundScreenY();
  const g = ctx.createLinearGradient(0, gy, 0, cam.viewH);
  g.addColorStop(0, mix('#4a4f56', '#20242e', night));
  g.addColorStop(1, mix('#2b2f35', '#12151c', night));
  ctx.fillStyle = g;
  ctx.fillRect(0, gy, cam.viewW, cam.viewH - gy);
  ctx.fillStyle = mix('#5b616a', '#2c3340', night);
  ctx.fillRect(0, gy - 1, cam.viewW, 2);

  // Scrubland between the cities.
  const [x0, x1] = cam.visibleRange(120);
  ctx.fillStyle = mix('#3f444b', '#1b1f27', night);
  for (let i = Math.floor(x0 / 60); i < Math.ceil(x1 / 60); i++) {
    const wx = i * 60 + hash01(i * 2.3) * 40;
    if (inCity(wx)) continue;
    const sx = cam.toScreenX(wx);
    const s = (3 + hash01(i * 7.1) * 5) * cam.scale;
    if (s < 0.6) continue;
    ctx.beginPath();
    ctx.arc(sx, gy - s * 0.4, s, Math.PI, 0);
    ctx.fill();
  }
}

function inCity(x: number): boolean {
  return (
    (x > WORLD.cityLeft.x0 - 60 && x < WORLD.cityLeft.x1 + 60) ||
    (x > WORLD.cityRight.x0 - 60 && x < WORLD.cityRight.x1 + 60)
  );
}

function drawLaunchPad(ctx: CanvasRenderingContext2D, cam: Camera, side: 'player' | 'enemy', night: number): void {
  const wx = launchPadX(side);
  const sx = cam.toScreenX(wx);
  if (sx < -80 || sx > cam.viewW + 80) return;
  const gy = cam.groundScreenY();
  const s = cam.scale;
  ctx.fillStyle = mix('#41474f', '#1d222b', night);
  ctx.fillRect(sx - 26 * s, gy - 12 * s, 52 * s, 12 * s);
  ctx.fillStyle = mix('#565d67', '#262c36', night);
  ctx.fillRect(sx - 18 * s, gy - 20 * s, 36 * s, 9 * s);
  // Rail, angled towards the enemy.
  const dir = side === 'player' ? -1 : 1;
  ctx.save();
  ctx.translate(sx, gy - 18 * s);
  ctx.rotate(dir * 0.62);
  ctx.fillStyle = mix('#6b737e', '#333a46', night);
  ctx.fillRect(-3 * s, -30 * s, 6 * s, 32 * s);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Cities
// ---------------------------------------------------------------------------

function drawCity(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  buildings: Building[],
  night: number,
  highlight: boolean,
): void {
  const [x0, x1] = cam.visibleRange(160);
  for (const layer of [0, 1] as const) {
    for (const b of buildings) {
      if (b.layer !== layer) continue;
      if (b.x < x0 || b.x > x1) continue;
      drawBuilding(ctx, cam, b, night, highlight);
    }
  }
}

function drawBuilding(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  b: Building,
  night: number,
  highlight: boolean,
): void {
  const def = BUILDINGS[b.type];
  const s = cam.scale;
  const gy = cam.groundScreenY();
  const back = b.layer === 0;
  const w = def.w * s;
  let x = cam.toScreenX(b.x);
  let y = gy - (back ? 4 * s : 0);

  const ratio = b.maxHp > 0 ? Math.max(0, b.hp / b.maxHp) : 0;
  // A battered tower loses its upper floors rather than just changing colour.
  const standing = standingFraction(b);
  let h = def.h * standing * s;
  const fullH = def.h * s;

  if (b.destroyed) {
    const t = b.collapse;
    h *= Math.max(0, 1 - t) * 0.9;
    if (t >= 1) {
      drawRubble(ctx, x, gy, def.w * s, night, b.seed);
      return;
    }
  }
  if (b.shake > 0) {
    x += (Math.random() - 0.5) * b.shake * 7 * s;
    y += (Math.random() - 0.5) * b.shake * 3 * s;
  }

  const body = back ? mix('#39414b', '#1c222e', night) : mix('#232a33', '#11151d', night);
  const edge = back ? mix('#454e59', '#242b39', night) : mix('#2e3641', '#171d27', night);
  const broken = ratio < 0.995 && !b.destroyed;

  ctx.save();
  if (highlight) {
    ctx.shadowColor = 'rgba(255,110,90,0.55)';
    ctx.shadowBlur = 16;
  }
  ctx.fillStyle = body;
  ctx.fillRect(x - w / 2, y - h, w, h);
  ctx.fillStyle = edge;
  ctx.fillRect(x - w / 2, y - h, Math.max(1, w * 0.14), h);
  ctx.restore();

  if (broken) drawBrokenTop(ctx, x, y - h, w, s, b.seed, body, night);
  else drawRoof(ctx, def.roof, x, y - h, w, s, body, edge);

  // Windows — only across the floors that are still there.
  if (h > 8 && w > 4) {
    const litBase = 0.18 + night * 0.62;
    const rows = Math.max(1, Math.round(def.windowRows * standing));
    const cols = def.windowCols;
    const pad = w * 0.16;
    const cw = (w - pad * 2) / cols;
    const ch = (h - h * 0.1) / rows;
    const ww = Math.max(0.8, cw * 0.55);
    const wh = Math.max(0.8, ch * 0.45);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const seed = b.seed + r * 31 + c * 7;
        const roll = hash01(seed);
        // The top floors of a damaged block go dark before the lower ones.
        const floorAlive = 1 - r / rows < ratio + 0.15;
        const lit = floorAlive && roll < litBase;
        const wx = x - w / 2 + pad + c * cw + (cw - ww) / 2;
        const wy = y - h + h * 0.06 + r * ch + (ch - wh) / 2;
        if (lit) {
          ctx.fillStyle = night > 0.4 ? 'rgba(255,224,150,0.92)' : 'rgba(200,220,240,0.55)';
        } else {
          ctx.fillStyle = floorAlive ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.42)';
        }
        ctx.fillRect(wx, wy, ww, wh);
      }
    }
  }

  // Scorch marks once it has taken a beating.
  if (ratio < 0.75 && !b.destroyed) {
    ctx.fillStyle = `rgba(12,10,10,${(1 - ratio) * 0.5})`;
    const marks = Math.ceil((1 - ratio) * 5);
    for (let i = 0; i < marks; i++) {
      const mx = x - w / 2 + hash01(b.seed + i * 13) * w;
      const my = y - h + hash01(b.seed + i * 29) * h;
      ctx.beginPath();
      ctx.ellipse(mx, my, w * 0.22, h * 0.06, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Damage bar, floated above where the roof used to be.
  if (!b.destroyed && ratio < 0.999 && s > 0.35) {
    const bw = w * 1.05;
    const by = Math.min(y - h - 8 * s, y - fullH * 0.35);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - bw / 2, by, bw, 3.2 * s);
    ctx.fillStyle = ratio > 0.5 ? '#69d97f' : ratio > 0.25 ? '#ffc341' : '#ff5a4d';
    ctx.fillRect(x - bw / 2, by, bw * ratio, 3.2 * s);
  }
}

/** Jagged concrete stump left where a warhead took the top off a tower. */
function drawBrokenTop(
  ctx: CanvasRenderingContext2D,
  x: number,
  top: number,
  w: number,
  s: number,
  seed: number,
  body: string,
  night: number,
): void {
  const teeth = 5;
  const bite = Math.max(1.5, 7 * s);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(x - w / 2, top + bite);
  for (let i = 0; i <= teeth; i++) {
    const f = i / teeth;
    const px = x - w / 2 + f * w;
    const py = top + hash01(seed + i * 19) * bite * 1.6;
    ctx.lineTo(px, py);
  }
  ctx.lineTo(x + w / 2, top + bite);
  ctx.closePath();
  ctx.fill();

  // Exposed floor slabs and bent rebar.
  ctx.strokeStyle = mix('#5b636e', '#2f3744', night);
  ctx.lineWidth = Math.max(0.6, 1.1 * s);
  for (let i = 0; i < 3; i++) {
    const px = x - w * 0.3 + hash01(seed + i * 7) * w * 0.6;
    const py = top + hash01(seed + i * 11) * bite;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + (hash01(seed + i * 3) - 0.5) * 6 * s, py - 5 * s);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(x - w / 2, top + bite * 0.4, w, Math.max(0.8, 2 * s));
}

function drawRoof(
  ctx: CanvasRenderingContext2D,
  roof: string,
  x: number,
  top: number,
  w: number,
  s: number,
  body: string,
  edge: string,
): void {
  ctx.fillStyle = body;
  switch (roof) {
    case 'step':
      ctx.fillRect(x - w * 0.32, top - 6 * s, w * 0.64, 6 * s);
      ctx.fillRect(x - w * 0.16, top - 11 * s, w * 0.32, 5 * s);
      break;
    case 'slant':
      ctx.beginPath();
      ctx.moveTo(x - w / 2, top);
      ctx.lineTo(x + w / 2, top);
      ctx.lineTo(x + w / 2, top - 14 * s);
      ctx.closePath();
      ctx.fill();
      break;
    case 'antenna':
      ctx.fillRect(x - w * 0.28, top - 5 * s, w * 0.56, 5 * s);
      ctx.fillStyle = edge;
      ctx.fillRect(x - 1 * s, top - 24 * s, 2 * s, 20 * s);
      break;
    case 'spire':
      ctx.beginPath();
      ctx.moveTo(x - w * 0.3, top);
      ctx.lineTo(x + w * 0.3, top);
      ctx.lineTo(x, top - 34 * s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = edge;
      ctx.fillRect(x - 0.9 * s, top - 46 * s, 1.8 * s, 14 * s);
      break;
    default:
      ctx.fillRect(x - w * 0.54, top - 2.5 * s, w * 1.08, 2.5 * s);
  }
}

function drawRubble(ctx: CanvasRenderingContext2D, x: number, gy: number, w: number, night: number, seed: number): void {
  ctx.fillStyle = mix('#31373f', '#171b23', night);
  const h = Math.max(2, w * 0.24);
  ctx.beginPath();
  ctx.moveTo(x - w * 0.6, gy);
  for (let i = 0; i <= 6; i++) {
    const f = i / 6;
    const px = x - w * 0.6 + f * w * 1.2;
    const py = gy - h * (0.35 + hash01(seed + i * 17) * 0.75) * Math.sin(Math.PI * f);
    ctx.lineTo(px, py);
  }
  ctx.lineTo(x + w * 0.6, gy);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = mix('#3d444d', '#20252f', night);
  for (let i = 0; i < 4; i++) {
    const px = x + (hash01(seed + i * 41) - 0.5) * w;
    const py = gy - hash01(seed + i * 53) * h * 0.7;
    const sz = Math.max(1, w * 0.08);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(hash01(seed + i * 61) * 1.2 - 0.6);
    ctx.fillRect(-sz / 2, -sz / 2, sz, sz * 0.7);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Batteries
// ---------------------------------------------------------------------------

function isRadar(type: number): boolean {
  return AA[type].interceptsTier === 0;
}

/** World units a stacked emplacement fans out by, so nothing is fully hidden. */
const STACK_SPREAD = 15;

/**
 * A radar takes no room of its own, so several systems can share one plot.
 * Fan a shared plot out a little and paint the dishes last: a radar drawn
 * under a launcher box would otherwise disappear completely.
 */
function stackLayout(batteries: AaBattery[]): { battery: AaBattery; offset: number }[] {
  const perPlot = new Map<number, number>();
  // Placement snaps a stacked battery onto the exact x of the site it joined,
  // so grouping on the rounded position collects a whole emplacement.
  for (const b of batteries) {
    const key = Math.round(b.x);
    perPlot.set(key, (perPlot.get(key) ?? 0) + 1);
  }
  const placed = new Map<number, number>();
  const ordered = [...batteries].sort(
    (a, b) => Number(isRadar(a.type)) - Number(isRadar(b.type)),
  );
  return ordered.map((battery) => {
    const key = Math.round(battery.x);
    const total = perPlot.get(key) ?? 1;
    const index = placed.get(key) ?? 0;
    placed.set(key, index + 1);
    return { battery, offset: total > 1 ? (index - (total - 1) / 2) * STACK_SPREAD : 0 };
  });
}

function drawBattery(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  b: AaBattery,
  night: number,
  offsetX = 0,
): void {
  const s = cam.scale;
  const x = cam.toScreenX(b.x) + offsetX * s;
  if (x < -60 || x > cam.viewW + 60) return;
  const gy = cam.groundScreenY();
  const def = AA[b.type];
  const metal = mix('#79828e', '#3d4756', night);
  const dark = mix('#4b535e', '#242b36', night);

  ctx.save();
  const jitter = b.shake > 0 ? b.shake * 6 * s : 0;
  ctx.translate(x + (Math.random() - 0.5) * jitter, gy + (Math.random() - 0.5) * jitter * 0.4);
  ctx.scale(1.4, 1.4);

  // Tracked chassis
  ctx.fillStyle = dark;
  ctx.fillRect(-13 * s, -7 * s, 26 * s, 7 * s);
  ctx.fillStyle = metal;
  ctx.fillRect(-11 * s, -12 * s, 22 * s, 6 * s);
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.arc(-8 * s + i * 8 * s, -3 * s, 2.4 * s, 0, Math.PI * 2);
    ctx.fill();
  }

  if (def.interceptsTier === 0) {
    // Radar: a slowly sweeping dish.
    const spin = performance.now() / 1000 + hash01(b.seed) * 6.28;
    ctx.save();
    ctx.translate(0, -13 * s);
    ctx.fillStyle = metal;
    ctx.fillRect(-1.6 * s, -6 * s, 3.2 * s, 6 * s);
    ctx.translate(0, -6 * s);
    const tilt = Math.cos(spin) * 0.9;
    ctx.scale(Math.max(0.18, Math.abs(Math.cos(spin * 0.5))), 1);
    ctx.rotate(-0.5 + tilt * 0.12);
    ctx.fillStyle = def.color;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.ellipse(0, 0, 9 * s, 5.5 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.ellipse(0, 0, 6.5 * s, 3.6 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else {
    // Launcher box on a rotating mount.
    ctx.save();
    ctx.translate(0, -13 * s);
    ctx.rotate(b.aim + Math.PI / 2);
    const recoil = b.recoil * 3 * s;
    ctx.fillStyle = metal;
    ctx.fillRect(-6 * s, -16 * s + recoil, 12 * s, 18 * s);
    ctx.fillStyle = dark;
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(-4.5 * s + i * 3.2 * s, -15 * s + recoil, 2.2 * s, 15 * s);
    }
    ctx.fillStyle = def.color;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(-6 * s, -17.5 * s + recoil, 12 * s, 2 * s);
    ctx.globalAlpha = 1;
    ctx.restore();
  }
  ctx.restore();

  // Tier pip so you can tell the batteries apart at a glance.
  if (s > 0.45 && def.roman) {
    ctx.fillStyle = def.color;
    ctx.font = `bold ${Math.max(8, 9 * s)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(def.roman, x, gy - 38 * s);
  }

  // Damage read-out — batteries can now be shot to pieces.
  const ratio = b.maxHp > 0 ? b.hp / b.maxHp : 1;
  if (ratio < 0.999) {
    const bw = Math.max(16, 30 * s);
    const by = gy - 46 * s;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - bw / 2, by, bw, Math.max(2.5, 3.2 * s));
    ctx.fillStyle = ratio > 0.5 ? '#69d97f' : ratio > 0.25 ? '#ffc341' : '#ff5a4d';
    ctx.fillRect(x - bw / 2, by, bw * ratio, Math.max(2.5, 3.2 * s));
  }
}

/** Ghost turret and coverage ring while the player is siting a new battery. */
function drawDeployPreview(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  deploy: { type: number; x: number | null; valid: boolean; radius: number },
): void {
  if (deploy.x === null) return;
  const def = AA[deploy.type];
  const x = cam.toScreenX(deploy.x);
  const gy = cam.groundScreenY();
  const ok = deploy.valid;
  const color = ok ? def.color : '#ff5a4d';

  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.4, 2 * cam.scale);
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  ctx.arc(x, gy - 16 * cam.scale, deploy.radius * cam.scale, Math.PI, 0);
  ctx.stroke();
  ctx.setLineDash([]);

  // Footprint marker
  ctx.globalAlpha = ok ? 0.9 : 0.7;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, gy - 2, Math.max(12, 22 * cam.scale), Math.max(4, 7 * cam.scale), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#0d1016';
  ctx.font = `bold ${Math.max(10, 12 * cam.scale)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(ok ? def.roman || 'R' : '✕', x, gy + Math.max(3, 3 * cam.scale));

  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.2, 1.8 * cam.scale);
  ctx.beginPath();
  ctx.moveTo(x, gy - 10 * cam.scale);
  ctx.lineTo(x, gy - 44 * cam.scale);
  ctx.stroke();
  ctx.restore();
}

/** Translucent building and footprint while the player chooses a plot. */
function drawBuildingDeployPreview(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  deploy: { type: number; x: number; layer: 0 | 1; valid: boolean },
  night: number,
): void {
  const def = BUILDINGS[deploy.type];
  const color = deploy.valid ? '#59e07a' : '#ff5a4d';
  const preview: Building = {
    uid: -1,
    type: deploy.type,
    side: 'player',
    x: deploy.x,
    layer: deploy.layer,
    hp: def.hp,
    maxHp: def.hp,
    destroyed: false,
    collapse: 0,
    shake: 0,
    smokeAcc: 0,
    seed: 17,
  };

  ctx.save();
  ctx.globalAlpha = deploy.valid ? 0.62 : 0.35;
  drawBuilding(ctx, cam, preview, night, false);
  ctx.globalAlpha = 0.95;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, 2 * cam.scale);
  ctx.setLineDash([6, 4]);
  const x = cam.toScreenX(deploy.x);
  const gy = cam.groundScreenY();
  ctx.strokeRect(x - (def.w * cam.scale) / 2, gy - def.h * cam.scale, def.w * cam.scale, def.h * cam.scale);
  ctx.setLineDash([]);
  ctx.restore();
}

function drawRings(ctx: CanvasRenderingContext2D, cam: Camera, match: Match, meta: MetaSave): void {
  const gy = cam.groundScreenY();
  ctx.save();
  ctx.lineWidth = Math.max(1, 1.6 * cam.scale);
  for (const b of match.player.batteries) {
    const def = AA[b.type];
    const r = aaRadius(match.player, b.type, meta) * cam.scale;
    const x = cam.toScreenX(b.x);
    if (x + r < -20 || x - r > cam.viewW + 20) continue;
    ctx.strokeStyle = def.color;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.arc(x, gy - 16 * cam.scale, r, Math.PI, 0);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Ordnance
// ---------------------------------------------------------------------------

function drawMissiles(ctx: CanvasRenderingContext2D, cam: Camera, match: Match, hasRadar: boolean): void {
  for (const m of match.missiles) {
    const def = MISSILES[m.tier - 1];
    // Un-radared players only get an off-screen warning once it is nearly on them.
    const tracked = hasRadar || m.side === 'player' || (1 - m.t) * m.flightTime < 3;
    // Smoke trail
    ctx.lineCap = 'round';
    for (let i = 1; i < m.trail.length; i++) {
      const a = m.trail[i];
      const p = m.trail[i - 1];
      ctx.strokeStyle = `rgba(226,230,236,${a.a * 0.5})`;
      ctx.lineWidth = Math.max(0.6, (1 + a.a * 3.4) * cam.scale);
      ctx.beginPath();
      ctx.moveTo(cam.toScreenX(p.x), cam.toScreenY(p.y));
      ctx.lineTo(cam.toScreenX(a.x), cam.toScreenY(a.y));
      ctx.stroke();
    }

    const x = cam.toScreenX(m.x);
    const y = cam.toScreenY(m.y);
    const ang = Math.atan2(m.vy, m.vx);
    const L = Math.max(5, def.length * cam.scale);
    const W = Math.max(2, def.length * 0.34 * cam.scale);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    // Exhaust flame
    const flick = 0.7 + Math.random() * 0.6;
    const fg = ctx.createLinearGradient(-L * 1.6 * flick, 0, -L * 0.45, 0);
    fg.addColorStop(0, 'rgba(255,120,20,0)');
    fg.addColorStop(0.5, 'rgba(255,160,40,0.85)');
    fg.addColorStop(1, 'rgba(255,240,190,1)');
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-L * 0.45, -W * 0.4);
    ctx.lineTo(-L * 1.7 * flick, 0);
    ctx.lineTo(-L * 0.45, W * 0.4);
    ctx.closePath();
    ctx.fill();
    // Body
    ctx.fillStyle = def.color;
    ctx.beginPath();
    ctx.moveTo(L * 0.6, 0);
    ctx.lineTo(L * 0.12, -W / 2);
    ctx.lineTo(-L * 0.5, -W / 2);
    ctx.lineTo(-L * 0.5, W / 2);
    ctx.lineTo(L * 0.12, W / 2);
    ctx.closePath();
    ctx.fill();
    // Fins
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.moveTo(-L * 0.5, -W / 2);
    ctx.lineTo(-L * 0.72, -W * 1.1);
    ctx.lineTo(-L * 0.4, -W / 2);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-L * 0.5, W / 2);
    ctx.lineTo(-L * 0.72, W * 1.1);
    ctx.lineTo(-L * 0.4, W / 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Warning marker when it flies off the top of the view.
    if (y < 0 && tracked) {
      ctx.fillStyle = m.side === 'enemy' ? '#ff5a4d' : '#59a7ff';
      ctx.beginPath();
      ctx.moveTo(x, 6);
      ctx.lineTo(x - 6, 16);
      ctx.lineTo(x + 6, 16);
      ctx.closePath();
      ctx.fill();
    }
  }
}

function drawInterceptors(ctx: CanvasRenderingContext2D, cam: Camera, match: Match): void {
  for (const it of match.interceptors) {
    const color = AA[it.type].color;
    for (let i = 1; i < it.trail.length; i++) {
      const a = it.trail[i];
      const p = it.trail[i - 1];
      ctx.strokeStyle = withAlpha(color, a.a * 0.85);
      ctx.lineWidth = Math.max(0.6, (0.6 + a.a * 2.2) * cam.scale);
      ctx.beginPath();
      ctx.moveTo(cam.toScreenX(p.x), cam.toScreenY(p.y));
      ctx.lineTo(cam.toScreenX(a.x), cam.toScreenY(a.y));
      ctx.stroke();
    }
    const x = cam.toScreenX(it.x);
    const y = cam.toScreenY(it.y);
    const ang = Math.atan2(it.vy, it.vx);
    const L = Math.max(4, 12 * cam.scale);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.fillStyle = '#fdfdff';
    ctx.beginPath();
    ctx.moveTo(L * 0.6, 0);
    ctx.lineTo(-L * 0.5, -L * 0.2);
    ctx.lineTo(-L * 0.5, L * 0.2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillRect(-L * 0.7, -L * 0.12, L * 0.3, L * 0.24);
    ctx.restore();
  }
}

function drawParticles(ctx: CanvasRenderingContext2D, cam: Camera, match: Match): void {
  const s = cam.scale;
  for (const p of match.particles) {
    const x = cam.toScreenX(p.x);
    const y = cam.toScreenY(p.y);
    if (x < -120 || x > cam.viewW + 120) continue;
    const t = Math.max(0, p.life / p.maxLife);
    switch (p.kind) {
      case 'flash': {
        const r = p.size * s * (1.6 - t);
        const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(1, r));
        g.addColorStop(0, withAlpha(p.color, t));
        g.addColorStop(1, withAlpha(p.color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1, r), 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'ring': {
        const r = p.size * s * (1 + (1 - t) * 5);
        ctx.strokeStyle = withAlpha(p.color, t * 0.7);
        ctx.lineWidth = Math.max(0.8, 2.5 * s * t);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'smoke': {
        ctx.fillStyle = withAlpha(p.color, t * 0.32);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.8, p.size * s), 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'debris': {
        ctx.save();
        ctx.translate(x, y);
        if (p.rot !== undefined) ctx.rotate(p.rot);
        ctx.fillStyle = withAlpha(p.color, Math.min(1, t * 1.6));
        const sz = Math.max(0.8, p.size * s);
        ctx.fillRect(-sz / 2, -sz / 2, sz, sz * 0.75);
        ctx.restore();
        break;
      }
      default: {
        ctx.fillStyle = withAlpha(p.color, Math.min(1, t * 1.5));
        const sz = Math.max(0.7, p.size * s * (0.5 + t * 0.7));
        ctx.beginPath();
        ctx.arc(x, y, sz, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function drawTrajectoryHints(ctx: CanvasRenderingContext2D, cam: Camera, match: Match, hasRadar: boolean): void {
  // Incoming threat markers on the ground where enemy fire will land.
  // Radar is what buys you the early warning: without it the ring appears late.
  const window = hasRadar ? 6 : 1.6;
  ctx.save();
  for (const m of match.missiles) {
    if (m.side !== 'enemy') continue;
    const remaining = (1 - m.t) * m.flightTime;
    if (remaining > window) continue;
    const x = cam.toScreenX(m.tx);
    const gy = cam.groundScreenY();
    const pulse = 0.4 + 0.6 * Math.abs(Math.sin(performance.now() / 140));
    const r = Math.max(6, MISSILES[m.tier - 1].blast * cam.scale);
    ctx.strokeStyle = `rgba(255,70,60,${pulse * 0.9})`;
    ctx.lineWidth = Math.max(1, 2 * cam.scale);
    ctx.beginPath();
    ctx.ellipse(x, gy - 2, r, r * 0.3, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(x, gy - 2, r * (1 - remaining / window), r * 0.3 * (1 - remaining / window), 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPins(ctx: CanvasRenderingContext2D, cam: Camera, match: Match, opts: SceneOpts): void {
  const gy = cam.groundScreenY();
  const pins = [...match.player.queued, ...match.player.pending];
  for (const q of pins) {
    const def = MISSILES[q.tier - 1];
    const x = cam.toScreenX(q.x);
    const committed = match.player.pending.includes(q);
    ctx.save();
    ctx.globalAlpha = committed ? 0.55 : 1;
    ctx.strokeStyle = '#ffcf4d';
    ctx.fillStyle = 'rgba(255,207,77,0.18)';
    ctx.lineWidth = 2;
    const r = Math.max(8, def.blast * cam.scale);
    ctx.beginPath();
    ctx.ellipse(x, gy - 2, r, r * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, gy - 8);
    ctx.lineTo(x, gy - 34);
    ctx.stroke();
    ctx.fillStyle = '#ffcf4d';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(def.roman, x, gy - 38);
    ctx.restore();
  }

  if (opts.aiming && opts.aimX !== null) {
    const def = MISSILES[opts.aimTier - 1];
    const x = cam.toScreenX(opts.aimX);
    const r = Math.max(8, def.blast * cam.scale);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(x, gy - 2, r, r * 0.32, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, gy - 4);
    ctx.stroke();
    ctx.restore();
  }
}

function drawTexts(ctx: CanvasRenderingContext2D, cam: Camera, match: Match): void {
  ctx.save();
  ctx.textAlign = 'center';
  for (const t of match.texts) {
    const a = Math.min(1, t.life / (t.maxLife * 0.4));
    ctx.globalAlpha = a;
    ctx.font = `bold ${Math.max(13, 15 * cam.scale)}px system-ui, sans-serif`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    const x = cam.toScreenX(t.x);
    const y = cam.toScreenY(t.y);
    ctx.strokeText(t.text, x, y);
    ctx.fillStyle = t.color;
    ctx.fillText(t.text, x, y);
  }
  ctx.restore();
}

function withAlpha(color: string, a: number): string {
  const clamped = Math.max(0, Math.min(1, a));
  if (color.startsWith('rgba')) return color.replace(/,\s*[\d.]+\)$/, `,${clamped})`);
  if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', `,${clamped})`);
  if (color.startsWith('#')) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${clamped})`;
  }
  return color;
}
