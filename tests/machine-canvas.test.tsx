// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MachineCanvas } from '../src/components/MachineCanvas';
import { engine } from '../src/engine/SimulationEngine';

/**
 * End-to-end check of the machine animation: the component is mounted with a
 * recording 2D context, two frames are drawn with the feed advanced in
 * between, and the IN-FEED NIP ROLLERS are read back out of the draw calls.
 *
 * The bug this pins: both rollers used to turn backwards — the roller face at
 * the nip travelled against the material it is supposed to be pulling in.
 */

const W = 1600, H = 430;
// Machine-view mapping inside MachineCanvas (axis −620…980 mm across the width).
const SC = W / 1600;
const NIP_X = (-380 + 620) * SC; // in-feed roller centre (px)
const NIP_R = 20;                // roller radius (px)

type Seg = { x0: number; y0: number; x1: number; y1: number };

/** Minimal recording CanvasRenderingContext2D — remembers the drawn line segments. */
function recordingCtx() {
  const segs: Seg[] = [];
  let cur = { x: 0, y: 0 };
  const ctx = {
    strokeStyle: '', fillStyle: '', lineWidth: 1, font: '', textAlign: '',
    setTransform() {}, clearRect() {}, save() {}, restore() {}, setLineDash() {},
    beginPath() {}, closePath() {}, stroke() {}, fill() {},
    fillRect() {}, strokeRect() {}, fillText() {}, arc() {}, rect() {}, clip() {},
    moveTo(x: number, y: number) { cur = { x, y }; },
    lineTo(x: number, y: number) { segs.push({ x0: cur.x, y0: cur.y, x1: x, y1: y }); cur = { x, y }; },
  };
  return { ctx, segs };
}

/** The rotation ticks: the two lines drawn from a nip-roller centre outwards. */
function nipTicks(segs: Seg[]) {
  const ticks = segs.filter(s => {
    const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    return Math.abs(s.x0 - NIP_X) < 0.5 && Math.abs(len - NIP_R) < 0.5;
  });
  const angle = (s: Seg) => Math.atan2(s.y1 - s.y0, s.x1 - s.x0);
  const sorted = [...ticks].sort((a, b) => a.y0 - b.y0); // smaller y = higher on screen
  return { count: ticks.length, upper: angle(sorted[0]), lower: angle(sorted[sorted.length - 1]) };
}

describe('machine canvas — in-feed nip rollers', () => {
  let frame: FrameRequestCallback | null = null;
  let rec: ReturnType<typeof recordingCtx>;

  beforeEach(() => {
    rec = recordingCtx();
    frame = null;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frame = cb; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(rec.ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: W, height: H, x: 0, y: 0, top: 0, left: 0, right: W, bottom: H, toJSON: () => ({}) });
    Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', { value: W, configurable: true });
    Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', { value: H, configurable: true });
    engine.reset();
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  /** Draw one frame at feed position D and read the roller ticks back out. */
  const frameAt = (D: number) => {
    engine.state.D = D;
    rec.segs.length = 0;
    frame!(0);
    return nipTicks(rec.segs);
  };

  it('draws both rollers', () => {
    render(<MachineCanvas />);
    expect(frameAt(5).count).toBe(2);
  });

  it('turns the rollers so their faces pull the material FORWARD', () => {
    render(<MachineCanvas />);
    // Two frames, one millimetre of material apart. (D = 5 mm, not 0, keeps the
    // upper roller's tick away from the ±π seam of atan2.)
    const a = frameAt(5);
    const b = frameAt(6);

    // Screen y points down, so a growing angle is CLOCKWISE on screen.
    // Lower roller: material rides on its 12 o'clock → must turn clockwise.
    expect(b.lower - a.lower).toBeGreaterThan(0);
    // Upper roller: material rides on its 6 o'clock → must turn counter-clockwise.
    expect(b.upper - a.upper).toBeLessThan(0);
    // A nip counter-rotates: the two rollers never turn the same way.
    expect(Math.sign(b.lower - a.lower)).not.toBe(Math.sign(b.upper - a.upper));
  });

  it('rolls without slip: one revolution of the roller feeds its circumference', () => {
    render(<MachineCanvas />);
    const nipRmm = NIP_R / SC;              // roller radius in machine units
    const dD = 1;                            // mm of material
    const a = frameAt(5), b = frameAt(5 + dD);
    // |dθ| = dD / R  ⇒  the rim travels exactly as far as the material.
    expect(Math.abs(b.lower - a.lower)).toBeCloseTo(dD / nipRmm, 6);
    expect(Math.abs(b.upper - a.upper)).toBeCloseTo(dD / nipRmm, 6);
  });

  it('holds the rollers still when the line is not moving', () => {
    render(<MachineCanvas />);
    const a = frameAt(5), b = frameAt(5);
    expect(b.lower).toBeCloseTo(a.lower, 9);
    expect(b.upper).toBeCloseTo(a.upper, 9);
  });
});
