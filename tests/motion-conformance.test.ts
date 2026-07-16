import { describe, it, expect } from 'vitest';
import { SimulationEngine, SCAN_TIME } from '../src/engine/SimulationEngine';
import { OB1_CyclicUpdate } from '../src/engine/OB1_Main';
import { computeMove, evalAt, commitStopDist } from '../src/engine/MotionProfile';
import { evalCam } from '../src/engine/FB_Cam';

/**
 * MOTION-PROFILE CONFORMANCE — "every motor follows its motion profile".
 *
 * Not just limit adherence: the FEED AXIS trajectory is compared
 * point-by-point against the ANALYTIC MotionProfileSolver profile
 * (evalAt of the 7-phase S-curve), and the KNIFE AXIS angular velocity
 * is compared against the cam gearing law ω = dθ/dφ · v on EVERY scan
 * of a complete run — start ramp, steady production, graceful stop.
 */

function start(db: SimulationEngine) {
  db.setControlOn();
  db.setRun(true);
}

describe('feed axis follows the MotionProfileSolver S-curve exactly', () => {
  const drives: Array<[string, number, number]> = [
    ['default drive (triangular accel: cruise < A²/J)', 30000, 300000],
    ['soft drive (trapezoidal accel: cruise > A²/J)', 500, 5000],
  ];

  for (const [name, A, J] of drives) {
    it(name, () => {
      const db = new SimulationEngine();
      db.updateConfig({ axAmax: A, axJerk: J });
      const cruise = db.cruiseSpeed();
      // Analytic reference: the accel phase [0, t3] of a long solver move
      // at the same limits IS the pure 0→cruise ramp.
      const mv = computeMove(1e9, cruise, A, J)!;
      const t3 = mv.tp.t3;

      start(db);
      let maxVDev = 0, maxPDev = 0, rampEnd = -1;
      const scans = Math.ceil(t3 / SCAN_TIME) + 50;
      for (let k = 1; k <= scans; k++) {
        OB1_CyclicUpdate(db, SCAN_TIME);
        const t = k * SCAN_TIME;
        if (t <= t3) {
          const [, , vRef, pRef] = evalAt(J, mv.tp, t);
          maxVDev = Math.max(maxVDev, Math.abs(db.state.v - vRef));
          maxPDev = Math.max(maxPDev, Math.abs(db.state.D - pRef));
        }
        if (rampEnd < 0 && db.state.v >= cruise - 1e-9) rampEnd = k;
      }
      // Velocity tracks the analytic S-curve within one scan's worth of
      // jerk; position within the accumulated half-scan integration skew.
      expect(maxVDev).toBeLessThanOrEqual(2 * J * SCAN_TIME * SCAN_TIME + 0.01);
      expect(maxPDev).toBeLessThanOrEqual(cruise * SCAN_TIME + 0.5);
      // The ramp completes exactly when the solver says (±3 scans)
      expect(Math.abs(rampEnd * SCAN_TIME - t3)).toBeLessThanOrEqual(3 * SCAN_TIME);
    });
  }

  it('graceful stop lands EXACTLY on the park target, distance matches the solver', () => {
    for (const spd of [1000, 2000, 3000]) {
      const db = new SimulationEngine();
      db.updateConfig({ knifeWmax: 200, knifeAmax: 20000 });
      db.updateRecipe({ spd });
      start(db);
      for (let i = 0; i < 4000; i++) OB1_CyclicUpdate(db, SCAN_TIME);
      db.requestStop();
      // catch the commit scan
      let D0 = -1, v0 = 0, a0 = 0;
      for (let i = 0; i < 40000 && db.state.running; i++) {
        const wasCommitted = db.state.stopCommit;
        OB1_CyclicUpdate(db, SCAN_TIME);
        if (!wasCommitted && db.state.stopCommit && D0 < 0) {
          D0 = db.state.D; v0 = db.state.v; a0 = db.state.a;
        }
      }
      expect(db.state.running).toBe(false);
      expect(D0).toBeGreaterThanOrEqual(0);
      // THE criterion: with the fractional-jerk tracker + trapezoidal
      // position integration the axis lands dead on the park target
      expect(Math.abs(db.state.brakeD - db.state.D)).toBeLessThanOrEqual(0.01);
      // and the braked distance matches the solver's committed stopping
      // distance up to the one-scan commit quantization (the commit
      // decision fires at scan resolution while commitStopDist grows by
      // ~v·dt per scan)
      const braked = db.state.D - D0;
      const analytic = commitStopDist(v0, a0, db.config.axAmax, db.config.axJerk);
      // (v0/a0 are post-scan values while the commit decision used the
      // pre-scan state — allow the resulting few scans of bookkeeping)
      expect(Math.abs(braked - analytic)).toBeLessThanOrEqual(3 * v0 * SCAN_TIME + 2);
    }
  });
});

describe('knife axis follows the cam gearing law on every scan', () => {
  const cases: Array<[string, Parameters<SimulationEngine['updateRecipe']>[0], number]> = [
    ['default 400mm constant', {}, 80],
    ['COMP 20mm', { thick: 20, syncMode: 'comp' }, 80],
    ['long cut 1500mm (standstill cam)', { len: 1500 }, 70],
    ['250mm two-blade', { len: 250, thick: 5 }, 44],
  ];

  for (const [name, recipe, syncDeg] of cases) {
    it(name, () => {
      const db = new SimulationEngine();
      if (name.includes('two-blade')) db.updateConfig({ knives: 2 });
      db.updateParams({ syncDeg });
      db.updateRecipe(recipe);
      start(db);

      let worstExcess = -Infinity;
      let wMin = Infinity;
      const total = 12000;
      const stopAt = 9000;
      for (let k = 0; k < total; k++) {
        if (k === stopAt) db.requestStop();
        const running = db.state.running;
        OB1_CyclicUpdate(db, SCAN_TIME);
        if (!running || !db.state.running) continue;
        const st = db.state;
        wMin = Math.min(wMin, st.omega);
        // The final ~5 mm of a stop pins the master at the park target —
        // the cam law intentionally freezes there while the knife glides
        // its last fraction of a degree to standstill (forward only).
        if (st.braking && st.brakeD - st.D < 5) continue;
        const cam = db.cam;
        const [, slope] = evalCam(cam, db.camPhase());
        const wLaw = slope * st.v;
        // one scan of the cam's own dynamics: angular accel demand from
        // curvature (ddθ·v²) plus master-accel feed-through (dθ·|a|)
        const tol = (cam.maxAcc * st.v * st.v + cam.maxSlope * Math.abs(st.a)) * SCAN_TIME + 0.02;
        worstExcess = Math.max(worstExcess, Math.abs(st.omega - wLaw) - tol);
      }
      // the knife's angular velocity never deviates from the cam law by
      // more than one scan of the law's own rate of change...
      expect(worstExcess).toBeLessThanOrEqual(0);
      // ...and NEVER rotates backwards, including the stop landing
      expect(wMin).toBeGreaterThanOrEqual(0);
      expect(db.state.knifeFault).toBe(false);
      expect(db.state.running).toBe(false); // the stop completed
      // and the produced pieces prove it: exact length everywhere
      for (const r of db.log.filter(x => !x.trim)) expect(Math.abs(r.err)).toBeLessThan(0.05);
    });
  }
});
