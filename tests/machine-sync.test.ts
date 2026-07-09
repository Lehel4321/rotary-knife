import { describe, it, expect } from 'vitest';
import { SimulationEngine, SCAN_TIME } from '../src/engine/SimulationEngine';
import { OB1_CyclicUpdate } from '../src/engine/OB1_Main';
import { stopTime } from '../src/engine/MotionProfile';

/**
 * MACHINE-LEVEL VERIFICATION: the motors must run exactly the way the
 * MotionProfileSolver math commands, on every scan, in every recipe.
 *
 * A per-scan monitor rides along the whole production run and checks:
 *
 *  FEED AXIS (leading, S-curve from MotionProfileSolver):
 *   - velocity never exceeds the motor's Vmax
 *   - acceleration never exceeds Amax
 *   - jerk never exceeds the motor's jerk limit (the snap-to-setpoint at
 *     ramp end may consume up to 2 scans' worth in one scan — same
 *     convention as the CuttingMaschine feeder — hence the 2.1× bound)
 *   - the 0→cruise ramp takes exactly the time the solver predicts
 *
 *  KNIFE AXIS (following, cam-coupled):
 *   - |ω| never exceeds ωmax, |Δω| per scan never exceeds αmax·dt
 *   - the knife NEVER rotates backwards
 *   - THE SYNC CONTRACT: while the blade is inside the material the
 *     angular velocity equals the cam gearing law
 *       constant mode: ω = k/R · v_material
 *       comp mode:     ω = k/(R·cosθ) · v_material
 */

interface Monitor {
  vMaxSeen: number; aMaxSeen: number; jerkMaxSeen: number;
  wMaxSeen: number; dwMaxSeen: number; wMinSeen: number;
  syncErrMax: number; rampScans: number | null;
}

function runMonitored(db: SimulationEngine, scans: number): Monitor {
  const m: Monitor = { vMaxSeen: 0, aMaxSeen: 0, jerkMaxSeen: 0, wMaxSeen: 0, dwMaxSeen: 0, wMinSeen: Infinity, syncErrMax: 0, rampScans: null };
  let prevA = db.state.a, prevW = db.state.omega, prevRunning = db.state.running;
  const cruise = db.cruiseSpeed();
  for (let i = 0; i < scans; i++) {
    OB1_CyclicUpdate(db, SCAN_TIME);
    const st = db.state;
    if (!st.running || !prevRunning) {
      // drives-off transitions (stop reached, fault) are step changes by
      // design (power removal) — the profile monitor only judges running scans
      prevA = st.a; prevW = st.omega; prevRunning = st.running;
      continue;
    }
    m.vMaxSeen = Math.max(m.vMaxSeen, st.v);
    m.aMaxSeen = Math.max(m.aMaxSeen, Math.abs(st.a));
    m.jerkMaxSeen = Math.max(m.jerkMaxSeen, Math.abs(st.a - prevA) / SCAN_TIME);
    m.wMaxSeen = Math.max(m.wMaxSeen, Math.abs(st.omega));
    m.dwMaxSeen = Math.max(m.dwMaxSeen, Math.abs(st.omega - prevW) / SCAN_TIME);
    m.wMinSeen = Math.min(m.wMinSeen, st.omega);
    if (m.rampScans === null && st.v >= cruise - 1e-9) m.rampScans = i + 1;
    // Sync contract while the blade is inside the material
    if (db.penetrating) {
      const cam = db.cam;
      const thB = st.theta - cam.Theta * Math.round(st.theta / cam.Theta);
      const wLaw = cam.mode === 'comp'
        ? (cam.k / (cam.R * Math.cos(thB))) * st.v
        : (cam.k / cam.R) * st.v;
      m.syncErrMax = Math.max(m.syncErrMax, Math.abs(st.omega - wLaw));
    }
    prevA = st.a; prevW = st.omega; prevRunning = st.running;
  }
  return m;
}

function makeMachine(over: {
  len?: number; spd?: number; thick?: number; syncMode?: 'constant' | 'comp'; ratio?: number;
  syncDeg?: number; knives?: 1 | 2; axAmax?: number; axJerk?: number; feasFrac?: number;
}) {
  const db = new SimulationEngine();
  db.updateConfig({ knives: over.knives ?? 1, axAmax: over.axAmax ?? 30000, axJerk: over.axJerk ?? 300000 });
  db.updateParams({ syncDeg: over.syncDeg ?? 80 });
  db.updateRecipe({
    len: over.len ?? 400, thick: over.thick ?? 10,
    syncMode: over.syncMode ?? 'constant', ratio: over.ratio ?? 1.0,
    spd: over.spd || 1000,
  });
  if (over.spd === 0) {
    // spd 0 is the sentinel: run at a fraction of the knife-feasible
    // maximum for this cam — must be set BEFORE starting (interlock)
    db.updateRecipe({ spd: Math.floor(db.vFeasibleLine() * (over.feasFrac ?? 0.8)) });
  }
  db.setControlOn();
  db.setRun(true);
  return db;
}

describe('motor limit adherence + sync contract across the recipe space', () => {
  const combos: Array<[string, Parameters<typeof makeMachine>[0]]> = [
    ['400mm constant 10mm @60m/min', {}],
    ['400mm constant 20mm k=auto', { thick: 20, ratio: 1.073 }],
    ['400mm COMP 20mm', { thick: 20, syncMode: 'comp' }],
    ['200mm short cut @80% feasible', { len: 200, spd: 0, syncDeg: 60 }],
    ['1500mm long cut (standstill cam)', { len: 1500 }],
    ['2 blades, 5mm material, 250mm', { knives: 2, len: 250, thick: 5, syncDeg: 44 }],
    ['slow ramp drive (cuts during accel)', { axAmax: 500, axJerk: 5000 }],
    ['90% of feasible speed', { spd: 0, feasFrac: 0.9 }],
  ];

  for (const [name, over] of combos) {
    it(name, () => {
      const db = makeMachine(over);
      const cfg = db.config;
      const m = runMonitored(db, 15000); // 15 s machine time

      // The machine actually produced
      expect(db.state.knifeFault).toBe(false);
      expect(db.state.cuts).toBeGreaterThan(3);

      // FEED AXIS obeys the MotionProfileSolver motor data on every scan
      expect(m.vMaxSeen).toBeLessThanOrEqual(db.cruiseSpeed() * (1 + 1e-9));
      expect(m.aMaxSeen).toBeLessThanOrEqual(cfg.axAmax * (1 + 1e-9));
      expect(m.jerkMaxSeen).toBeLessThanOrEqual(cfg.axJerk * 2.1);

      // Ramp 0→cruise takes exactly the solver-predicted time (±3 scans)
      const predicted = stopTime(db.cruiseSpeed(), cfg.axAmax, cfg.axJerk) / SCAN_TIME;
      expect(m.rampScans).not.toBeNull();
      expect(Math.abs(m.rampScans! - predicted)).toBeLessThanOrEqual(3);

      // KNIFE AXIS respects its servo limits, never reverses
      expect(m.wMaxSeen).toBeLessThanOrEqual(cfg.knifeWmax * (1 + 1e-9));
      expect(m.dwMaxSeen).toBeLessThanOrEqual(cfg.knifeAmax * (1 + 1e-9));
      expect(m.wMinSeen).toBeGreaterThanOrEqual(-1e-9);

      // SYNC CONTRACT: inside the material the knife follows the cam
      // gearing law derived from the material velocity. Tolerance = one
      // scan of the cam's own acceleration demand at this line speed
      // (the servo is discrete, ω is the average over the scan).
      const wTol = db.cam.maxAcc * db.cruiseSpeed() ** 2 * SCAN_TIME + 0.005;
      expect(m.syncErrMax).toBeLessThanOrEqual(wTol);

      // Every piece at recipe length
      for (const r of db.log.filter(x => !x.trim)) {
        expect(Math.abs(r.err)).toBeLessThan(0.05);
      }
      // Counting is consistent
      expect(db.state.cuts).toBe(db.log.filter(x => !x.trim).length);
      expect(db.state.trims).toBe(db.log.filter(x => x.trim).length);

      // Graceful stop: line brakes with the S-curve onto a park phase
      db.requestStop();
      const m2 = runMonitored(db, 20000);
      expect(db.state.running).toBe(false);
      expect(db.state.v).toBe(0);
      expect(m2.aMaxSeen).toBeLessThanOrEqual(cfg.axAmax * (1 + 1e-9));
      expect(m2.jerkMaxSeen).toBeLessThanOrEqual(cfg.axJerk * 2.1);
      // blade parked outside the material
      const thB = Math.abs(db.state.theta - db.cam.Theta * Math.round(db.state.theta / db.cam.Theta));
      expect(thB).toBeGreaterThan(db.contactAlpha());
    });
  }

  it('straightness physics: measured face matches the cam prediction (constant mode, 20mm)', () => {
    const db = makeMachine({ thick: 20, ratio: 1.0 });
    runMonitored(db, 8000);
    const s = db.getStats();
    expect(s.meanStraight).toBeGreaterThan(1);
    // within 15 % of the analytic prediction R·max|sinθ − θ| profile
    expect(Math.abs(s.meanStraight - db.cam.predictStraight) / db.cam.predictStraight).toBeLessThan(0.15);
  });

  it('deterministic: two identical runs produce identical logs', () => {
    const a = makeMachine({ thick: 20, syncMode: 'comp' });
    const b = makeMachine({ thick: 20, syncMode: 'comp' });
    for (let i = 0; i < 6000; i++) { OB1_CyclicUpdate(a, SCAN_TIME); OB1_CyclicUpdate(b, SCAN_TIME); }
    expect(a.log.length).toBe(b.log.length);
    for (let i = 0; i < a.log.length; i++) {
      expect(a.log[i].len).toBe(b.log[i].len);
      expect(a.log[i].straight).toBe(b.log[i].straight);
    }
  });
});
