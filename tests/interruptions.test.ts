import { describe, it, expect } from 'vitest';
import { SimulationEngine } from '../src/engine/SimulationEngine';
import { OB1_CyclicUpdate } from '../src/engine/OB1_Main';
import { bladeAngle } from '../src/engine/FB_Cam';

/**
 * Commissioning-style interruption tests: every way an operator (or the
 * safety chain) can interrupt production, and what the machine must look
 * like afterwards — knife back in phase with the line, no cut counted
 * twice, no frozen half-cut counted as good, no latch without a way out,
 * no following-error spike on restart, counters consistent with the log.
 */

const DEG = 180 / Math.PI;

function run(db: SimulationEngine, scans: number) {
  for (let i = 0; i < scans; i++) OB1_CyclicUpdate(db, 0.001);
}

function startMachine(db: SimulationEngine) {
  db.setControlOn();
  db.setRun(true);
}

/** Run until `pred` holds (or fail after `max` scans). */
function runUntil(db: SimulationEngine, pred: () => boolean, max = 20000) {
  for (let i = 0; i < max; i++) {
    if (pred()) return;
    OB1_CyclicUpdate(db, 0.001);
  }
  throw new Error('condition never reached');
}

/** Blade on the down-pass inside the material — before bottom dead center. */
const bladeEnteringMaterial = (db: SimulationEngine) =>
  db.penetrating && bladeAngle(db.state.theta, db.cam.Theta) < -0.05;

/** Blade past bottom dead center, still inside the material (cut fired, face pending). */
const bladeLeavingMaterial = (db: SimulationEngine) =>
  db.penetrating && bladeAngle(db.state.theta, db.cam.Theta) > 0.02;

/** Invariants that must hold after any interruption sequence. */
function expectConsistent(db: SimulationEngine) {
  const st = db.state;
  // counters match the log (log is far below its 400-record cap here)
  expect(st.cuts).toBe(db.log.filter(r => !r.trim).length);
  expect(st.trims).toBe(db.log.filter(r => r.trim).length);
  // record numbers are consecutive — nothing counted twice, nothing skipped
  db.log.forEach((r, i) => expect(r.n).toBe(i + 1));
  // every good piece is at the recipe length
  for (const r of db.log.filter(x => !x.trim)) expect(Math.abs(r.err)).toBeLessThan(0.05);
}

/** Max |following error| (deg) over the next `scans` scans. */
function peakFolErr(db: SimulationEngine, scans: number) {
  let peak = 0;
  for (let i = 0; i < scans; i++) {
    OB1_CyclicUpdate(db, 0.001);
    peak = Math.max(peak, Math.abs(db.state.folErr * DEG));
  }
  return peak;
}

describe('interruptions — E-Stop', () => {
  it('E-Stop with the blade entering the material: no half-cut counted, next cut is a trim, back in phase', () => {
    const db = new SimulationEngine();
    startMachine(db);
    run(db, 2000);
    runUntil(db, () => bladeEnteringMaterial(db));
    const before = { cuts: db.state.cuts, trims: db.state.trims, n: db.log.length };
    db.pressEStop();
    run(db, 50); // nothing moves while latched
    expect(db.state.cuts).toBe(before.cuts);
    expect(db.log.length).toBe(before.n);
    db.releaseEStop();
    db.setControlOn();
    expect(db.state.needsReset).toBe(false);
    expect(db.camPhase()).toBeCloseTo(db.cam.parkPhi, 9);
    expect(Math.abs(bladeAngle(db.state.theta, db.cam.Theta))).toBeGreaterThan(db.contactAlpha());
    db.setRun(true);
    const peak = peakFolErr(db, 4000);
    expect(peak).toBeLessThan(0.1);
    // the first cut after the interruption is a reference (trim) cut
    const after = db.log.slice(before.n);
    expect(after.length).toBeGreaterThan(1);
    expect(after[0].trim).toBe(true);
    expect(after.slice(1).every(r => !r.trim)).toBe(true);
    expectConsistent(db);
  });

  it('E-Stop after bottom dead center: the cut counts once, its face is marked lost', () => {
    const db = new SimulationEngine();
    startMachine(db);
    run(db, 2000);
    runUntil(db, () => bladeLeavingMaterial(db));
    const rec = db.log[db.log.length - 1];
    expect(rec.straight).toBeNull(); // face still being measured
    const cuts = db.state.cuts;
    db.pressEStop();
    db.releaseEStop();
    db.setControlOn();
    expect(rec.lost).toBe(true);
    expect(db.state.cuts).toBe(cuts);
    db.setRun(true);
    run(db, 4000);
    expect(rec.straight).toBeNull(); // a later face never lands on the frozen cut
    expectConsistent(db);
  });

  it('E-Stop during the start ramp, then restart: in phase, no spike', () => {
    const db = new SimulationEngine();
    db.updateConfig({ axAmax: 500, axJerk: 5000 }); // ~2 s ramp
    startMachine(db);
    run(db, 700);
    expect(db.state.v).toBeGreaterThan(0);
    expect(db.state.v).toBeLessThan(db.recipe.spd);
    db.pressEStop();
    expect(db.state.v).toBe(0);
    expect(db.state.a).toBe(0);
    db.releaseEStop();
    startMachine(db);
    expect(peakFolErr(db, 6000)).toBeLessThan(0.1);
    expectConsistent(db);
  });
});

describe('interruptions — graceful stop / restart', () => {
  it('Stop during the start ramp parks out of the material and resumes without a trim', () => {
    const db = new SimulationEngine();
    db.updateConfig({ axAmax: 500, axJerk: 5000 });
    startMachine(db);
    run(db, 600);
    db.requestStop();
    run(db, 10000);
    expect(db.state.running).toBe(false);
    expect(Math.abs(bladeAngle(db.state.theta, db.cam.Theta))).toBeGreaterThan(db.contactAlpha());
    const trims = db.state.trims;
    db.setRun(true);
    expect(peakFolErr(db, 6000)).toBeLessThan(0.1);
    expect(db.state.trims).toBe(trims);
    expectConsistent(db);
  });

  it('Stop, Control Off, Control On, Start keeps the phase (no clear after a graceful stop)', () => {
    const db = new SimulationEngine();
    startMachine(db);
    run(db, 3000);
    db.requestStop();
    run(db, 8000);
    const D = db.state.D;
    db.setControlOff();
    expect(db.state.needsReset).toBe(false);
    db.setControlOn();
    expect(db.state.D).toBe(D);
    db.setRun(true);
    run(db, 3000);
    expect(db.state.trims).toBe(1);
    expectConsistent(db);
  });

  it('recipe change is refused while running and re-phases with exactly one trim after a stop', () => {
    const db = new SimulationEngine();
    startMachine(db);
    run(db, 3000);
    expect(db.updateRecipe({ len: 600 })).toBe(false);
    expect(db.recipe.len).toBe(400);
    db.requestStop();
    run(db, 8000);
    expect(db.updateRecipe({ len: 600 })).toBe(true);
    expect(db.camPhase()).toBeCloseTo(db.cam.parkPhi, 9);
    const n = db.log.length;
    db.setRun(true);
    expect(peakFolErr(db, 4000)).toBeLessThan(0.1);
    const after = db.log.slice(n);
    expect(after[0].trim).toBe(true);
    for (const r of after.slice(1)) {
      expect(r.trim).toBe(false);
      expect(Math.abs(r.len - 600)).toBeLessThan(0.05);
    }
    expect(db.state.trims).toBe(2);
    expectConsistent(db);
  });
});

describe('interruptions — Control Off / faults / guard', () => {
  it('Control Off while moving requires the clear on the next Control On', () => {
    const db = new SimulationEngine();
    startMachine(db);
    run(db, 2000);
    db.setControlOff();
    expect(db.state.running).toBe(false);
    expect(db.state.needsReset).toBe(true);
    db.setRun(true); // refused: control is off
    expect(db.state.running).toBe(false);
    startMachine(db);
    expect(db.state.needsReset).toBe(false);
    expect(peakFolErr(db, 4000)).toBeLessThan(0.1);
    expectConsistent(db);
  });

  it('knife fault latches, START is interlocked, acknowledge clears it and restarts in phase', () => {
    const db = new SimulationEngine();
    db.updateConfig({ knifeWmax: 15, knifeAmax: 150 });
    db.updateRecipe({ spd: 2500 });
    startMachine(db);
    runUntil(db, () => db.state.knifeFault, 30000);
    db.setRun(true);
    expect(db.state.running).toBe(false);
    db.ackKnifeFault();
    expect(db.state.knifeFault).toBe(false);
    expect(db.state.needsReset).toBe(false);
    expect(db.state.folErr).toBe(0);
    db.updateRecipe({ spd: 300 }); // back inside the feasible range
    db.setRun(true);
    expect(db.state.running).toBe(true);
    // The restart behaves exactly like a cold start with the same data —
    // no extra following error left over from the faulted run.
    const fresh = new SimulationEngine();
    fresh.updateConfig({ knifeWmax: 15, knifeAmax: 150 });
    fresh.updateRecipe({ spd: 300 });
    startMachine(fresh);
    expect(peakFolErr(db, 6000)).toBeLessThanOrEqual(peakFolErr(fresh, 6000) + 1e-9);
    expect(db.state.knifeFault).toBe(false);
  });

  it('guard trip with the blade in the material cannot be resumed with START', () => {
    const db = new SimulationEngine();
    startMachine(db);
    run(db, 2000);
    runUntil(db, () => bladeEnteringMaterial(db));
    const cuts = db.state.cuts;
    const n = db.log.length;
    db.toggleGuard(); // open while running -> category-0 trip
    expect(db.state.running).toBe(false);
    expect(db.state.needsReset).toBe(true);
    db.toggleGuard(); // close
    // The blade froze inside the material: START alone must not resume
    // the frozen cut and count it as a good piece.
    db.setRun(true);
    run(db, 1000);
    expect(db.state.cuts).toBe(cuts);
    expect(db.log.length).toBe(n);
    // The documented way out: Control ON clears and re-phases.
    db.setControlOff();
    db.setControlOn();
    expect(db.state.needsReset).toBe(false);
    expect(db.camPhase()).toBeCloseTo(db.cam.parkPhi, 9);
    db.setRun(true);
    run(db, 4000);
    expect(db.log[n].trim).toBe(true);
    expectConsistent(db);
  });

  it('a guard trip leaves no stale reset latch to ambush a later graceful stop', () => {
    const db = new SimulationEngine();
    startMachine(db);
    run(db, 2000);
    db.toggleGuard();
    db.toggleGuard();
    // recover the documented way
    if (!db.state.controlOn) db.setControlOn();
    db.setRun(true);
    run(db, 3000);
    db.requestStop();
    run(db, 8000);
    const D = db.state.D;
    const trims = db.state.trims;
    // a graceful stop is resumable: Control Off/On must NOT clear the machine
    db.setControlOff();
    db.setControlOn();
    expect(db.state.needsReset).toBe(false);
    expect(db.state.D).toBe(D);
    db.setRun(true);
    run(db, 3000);
    expect(db.state.trims).toBe(trims);
    expectConsistent(db);
  });
});
