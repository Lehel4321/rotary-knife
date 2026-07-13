import { describe, it, expect, beforeEach } from 'vitest';
import { SimulationEngine } from '../src/engine/SimulationEngine';
import { FC_Outfeed } from '../src/engine/FC_Outfeed';

/**
 * The out-feed belt is geared to the line: outFac × the line's ACTUAL speed.
 * It therefore ramps up with the line and brakes with it — it does not run at
 * the recipe setpoint while the line is still accelerating or already braking.
 */
describe('out-feed belt', () => {
  let db: SimulationEngine;

  beforeEach(() => {
    db = new SimulationEngine();
    db.params.outFac = 1.5;
    db.pieces = [{ left: 0, len: 400, trim: false }];
  });

  it('transports a piece at outFac × the line speed', () => {
    db.state.v = 1000;                 // mm/s
    FC_Outfeed(db, 0.1);
    expect(db.pieces[0].left).toBeCloseTo(1000 * 1.5 * 0.1, 9);
  });

  it('opens a gap: the belt outruns the material by the gain', () => {
    db.state.v = 1000;
    FC_Outfeed(db, 1);
    const web = 1000 * 1;              // the web fed one second of material
    expect(db.pieces[0].left).toBeGreaterThan(web);
  });

  it('slows with the line while braking, instead of running at the setpoint', () => {
    db.recipe.spd = 1000;              // commanded cruise speed
    db.state.v = 100;                  // but the line is nearly stopped
    FC_Outfeed(db, 0.1);
    expect(db.pieces[0].left).toBeCloseTo(100 * 1.5 * 0.1, 9);
    expect(db.pieces[0].left).toBeLessThan(1000 * 1.5 * 0.1); // not the setpoint
  });

  it('holds the pieces still when the line stands still', () => {
    db.state.v = 0;
    FC_Outfeed(db, 0.5);
    expect(db.pieces[0].left).toBe(0);
  });

  it('purges pieces once they have left the machine', () => {
    db.pieces = [{ left: 2600, len: 400, trim: false }, { left: 100, len: 400, trim: false }];
    db.state.v = 1000;
    FC_Outfeed(db, 0.001);
    expect(db.pieces).toHaveLength(1);
    expect(db.pieces[0].left).toBeLessThan(2500);
  });
});
