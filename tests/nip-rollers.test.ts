import { describe, it, expect } from 'vitest';
import { nipTickAngle } from '../src/components/MachineCanvas';

/**
 * The in-feed nip rollers drive the material. Their drawn rotation must match
 * the physics: at the nip, the roller face and the material move TOGETHER
 * (+x, the feed direction) — the animation used to run both rollers backwards.
 *
 * The check is done on the rendered geometry: take the rim point that sits at
 * the nip, advance the feed by a small dD, and look at where that point went.
 */

const Rpx = 20;   // drawn roller radius (px)
const Rmm = 40;   // roller radius in machine units (mm)
const dD = 1e-6;  // small feed advance (mm) — small enough that the rim's curvature is negligible

/** Canvas position of the rim point at roller-frame angle `phi` (y points DOWN). */
function rimPoint(D: number, phi: number, dir: 1 | -1) {
  const a = nipTickAngle(D, Rmm, dir) + phi;
  return { x: Rpx * Math.cos(a), y: Rpx * Math.sin(a) };
}

/** Screen velocity (per mm of feed) of the rim point currently at the nip. */
function contactVelocity(dir: 1 | -1) {
  // The nip is on the material side of the roller: the LOWER roller (dir=+1)
  // touches it at its 12 o'clock (screen-up = −y), the UPPER roller at 6 o'clock.
  const nipPhi = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
  // Roller-frame offset that puts a rim point exactly at the nip at D = 0.
  const phi = nipPhi - nipTickAngle(0, Rmm, dir);
  const p0 = rimPoint(0, phi, dir);
  const p1 = rimPoint(dD, phi, dir);
  return { vx: (p1.x - p0.x) / dD, vy: (p1.y - p0.y) / dD };
}

describe('in-feed nip rollers', () => {
  it('drives the material forward: both rollers move +x at the nip', () => {
    expect(contactVelocity(1).vx).toBeGreaterThan(0);   // lower roller
    expect(contactVelocity(-1).vx).toBeGreaterThan(0);  // upper roller
  });

  it('rolls without slipping: rim speed at the nip equals the feed speed', () => {
    const scale = Rpx / Rmm; // px per mm — the material advances this fast on screen
    for (const dir of [1, -1] as const) {
      const { vx, vy } = contactVelocity(dir);
      expect(vx).toBeCloseTo(scale, 6);
      expect(vy).toBeCloseTo(0, 6); // pure tangential motion along the material
    }
  });

  it('counter-rotates the pair, as a nip does', () => {
    const omega = (dir: 1 | -1) => (nipTickAngle(dD, Rmm, dir) - nipTickAngle(0, Rmm, dir)) / dD;
    expect(omega(1)).toBeGreaterThan(0);   // lower roller clockwise on screen
    expect(omega(-1)).toBeLessThan(0);     // upper roller counter-clockwise
  });
});
