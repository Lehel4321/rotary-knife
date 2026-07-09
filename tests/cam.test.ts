import { describe, it, expect } from 'vitest';
import { buildCam, evalCam, camSetpoint, hermite5, evalPoly, contactHalfAngle, suggestRatio } from '../src/engine/FB_Cam';
import { SimulationEngine } from '../src/engine/SimulationEngine';
import { OB1_CyclicUpdate } from '../src/engine/OB1_Main';
import { Recipe, ProcessParams, MachineConfig } from '../src/types';

const recipe = (over: Partial<Recipe> = {}): Recipe => ({
  name: 'T', len: 400, spd: 1000, thick: 10, syncMode: 'constant', ratio: 1.0, ...over,
});
const params = (over: Partial<ProcessParams> = {}): ProcessParams => ({ syncDeg: 70, outFac: 1.15, ...over });
const config = (over: Partial<MachineConfig> = {}): MachineConfig => ({
  knifeR: 100, knives: 1, knifeWmax: 40, knifeAmax: 800, folErrLimit: 5,
  axVmax: 3000, axAmax: 30000, axJerk: 300000, overcut: 0.3, maxThick: 20, ...over,
});

describe('quintic Hermite segment (VDI 2143 5th-degree polynomial)', () => {
  it('satisfies all six boundary conditions', () => {
    const c = hermite5(0.5, 1.2, -0.7, 3.1, 0.4, 0.9);
    const [p0, v0, a0] = evalPoly(c, 0);
    const [p1, v1, a1] = evalPoly(c, 1);
    expect(p0).toBeCloseTo(0.5, 9);
    expect(v0).toBeCloseTo(1.2, 9);
    expect(a0).toBeCloseTo(-0.7, 9);
    expect(p1).toBeCloseTo(3.1, 9);
    expect(v1).toBeCloseTo(0.4, 9);
    expect(a1).toBeCloseTo(0.9, 9);
  });
});

describe('cam profile construction (LRK principle)', () => {
  const cases: Array<[string, Recipe, ProcessParams, MachineConfig]> = [
    ['default 400mm constant', recipe(), params(), config()],
    ['short cut 220mm', recipe({ len: 220 }), params(), config()],
    ['long cut 3000mm (dwell)', recipe({ len: 3000 }), params(), config()],
    ['compensated 20mm material', recipe({ thick: 20, syncMode: 'comp' }), params({ syncDeg: 80 }), config()],
    ['two knives', recipe({ len: 250 }), params({ syncDeg: 40 }), config({ knives: 2 })],
    ['ratio 107%', recipe({ ratio: 1.07 }), params(), config()],
  ];

  for (const [name, r, p, c] of cases) {
    it(`${name}: continuous, monotone, one Θ per period`, () => {
      const cam = buildCam(r, p, c);
      const N = 4000;
      let prev = evalCam(cam, 0);
      // θ(0) = 0 at the cut point
      expect(prev[0]).toBeCloseTo(0, 9);
      for (let i = 1; i <= N; i++) {
        const phi = (i / N) * cam.L;
        const cur = evalCam(cam, phi - 1e-9);
        // C0 continuity and forward-only rotation
        expect(cur[0]).toBeGreaterThanOrEqual(prev[0] - 1e-7);
        // C1: finite-difference slope matches the analytic slope
        const fd = (cur[0] - prev[0]) / (cam.L / N);
        const mid = evalCam(cam, phi - 0.5 * (cam.L / N));
        expect(Math.abs(fd - mid[1])).toBeLessThan(Math.max(0.02 * Math.abs(mid[1]), 2e-4));
        prev = cur;
      }
      // Full period advances the knife exactly one blade pitch
      expect(prev[0]).toBeCloseTo(cam.Theta, 5);
      // Unwrapped setpoint is periodic: +L ⇒ +Θ
      const a = camSetpoint(cam, 123.4);
      const b = camSetpoint(cam, 123.4 + cam.L);
      expect(b.theta - a.theta).toBeCloseTo(cam.Theta, 8);
      expect(b.slope).toBeCloseTo(a.slope, 8);
    });
  }

  it('constant mode: exact velocity plateau k/R inside the sync window', () => {
    const cam = buildCam(recipe({ ratio: 1.05 }), params(), config());
    for (const phi of [0, cam.sA * 0.3, cam.L - cam.sA * 0.7]) {
      expect(evalCam(cam, phi)[1]).toBeCloseTo(1.05 / 100, 12);
    }
  });

  it('comp mode: tip horizontal position tracks the material exactly', () => {
    const cam = buildCam(recipe({ thick: 20, syncMode: 'comp' }), params({ syncDeg: 80 }), config());
    for (let i = -10; i <= 10; i++) {
      const phi = (i / 10) * cam.sA * 0.999;
      const [th] = evalCam(cam, phi);
      const thWrapped = phi < 0 ? th - cam.Theta : th;
      // R·sin(θ) = φ  ⇒ the blade tip moves horizontally WITH the material
      expect(100 * Math.sin(thWrapped)).toBeCloseTo(phi, 6);
    }
  });

  it('long cuts get a standstill (park) phase, short cuts do not', () => {
    const camLong = buildCam(recipe({ len: 3000 }), params(), config());
    expect(camLong.dwell).toBe(true);
    const dwellSeg = camLong.segs.find(s => s.kind === 'dwell')!;
    expect(dwellSeg.theta).toBeCloseTo(Math.PI, 9); // park = Θ/2 opposite the cut
    const camShort = buildCam(recipe(), params(), config());
    expect(camShort.dwell).toBe(false);
  });

  it('suggested velocity ratio α/sin(α) zeroes the predicted face skew', () => {
    const alpha = contactHalfAngle(100, 20, 0.3);
    const k = suggestRatio(alpha);
    const cam = buildCam(recipe({ thick: 20, ratio: k }), params({ syncDeg: 80 }), config());
    expect(cam.predictSkew).toBeCloseTo(0, 6);
    // and k = 1 does NOT (thick material, constant ω ⇒ leaning face)
    const cam1 = buildCam(recipe({ thick: 20, ratio: 1 }), params({ syncDeg: 80 }), config());
    expect(Math.abs(cam1.predictSkew)).toBeGreaterThan(1);
  });

  it('feasible line speed scales with the knife axis limits', () => {
    const lo = buildCam(recipe(), params(), config({ knifeWmax: 20, knifeAmax: 400 }));
    const hi = buildCam(recipe(), params(), config({ knifeWmax: 80, knifeAmax: 3200 }));
    expect(lo.vFeasible).toBeGreaterThan(0);
    expect(hi.vFeasible).toBeGreaterThan(lo.vFeasible * 1.5);
  });

  it('warns when the sync window does not cover the blade contact window', () => {
    const cam = buildCam(recipe({ thick: 20 }), params({ syncDeg: 60 }), config());
    expect(cam.warnings.some(w => w.includes('SYNC WINDOW'))).toBe(true);
    const camOk = buildCam(recipe({ thick: 20 }), params({ syncDeg: 80 }), config());
    expect(camOk.warnings.some(w => w.includes('SYNC WINDOW'))).toBe(false);
  });
});

/** Run the machine headless for a number of 1 ms scans. */
function run(db: SimulationEngine, scans: number) {
  for (let i = 0; i < scans; i++) OB1_CyclicUpdate(db, 0.001);
}

function startMachine(db: SimulationEngine) {
  db.setControlOn();
  db.setRun(true);
}

describe('machine integration (headless production run)', () => {
  it('cuts pieces at exactly the recipe length, first cut is the trim', () => {
    const db = new SimulationEngine();
    startMachine(db);
    run(db, 20000); // 20 s machine time at 1000 mm/s ⇒ ~49 pieces of 400 mm
    expect(db.state.trims).toBe(1);
    expect(db.state.cuts).toBeGreaterThan(40);
    const good = db.log.filter(r => !r.trim);
    for (const r of good) expect(Math.abs(r.err)).toBeLessThan(0.05); // ±0.05 mm
    // trim piece = park phase distance, shorter than a full piece
    expect(db.log[0].trim).toBe(true);
    expect(db.log[0].len).toBeLessThan(db.recipe.len);
  });

  it('constant-ω sync on thick material shows the predicted face lean; comp mode cuts straight', () => {
    const db = new SimulationEngine();
    db.updateRecipe({ thick: 20 });
    db.updateParams({ syncDeg: 80 });
    startMachine(db);
    run(db, 5000);
    const faceConst = db.getStats();
    expect(faceConst.meanStraight).toBeGreaterThan(2); // theory ≈ 4.3 mm at R=100
    expect(faceConst.meanStraight).toBeCloseTo(db.cam.predictStraight, 0);

    const db2 = new SimulationEngine();
    db2.updateRecipe({ thick: 20, syncMode: 'comp' });
    db2.updateParams({ syncDeg: 80 });
    startMachine(db2);
    run(db2, 5000);
    expect(db2.getStats().meanStraight).toBeLessThan(0.05); // straight to 5/100 mm
  });

  it('graceful stop parks the blade outside the material and keeps piece lengths exact', () => {
    const db = new SimulationEngine();
    startMachine(db);
    run(db, 3000);
    db.requestStop();
    run(db, 8000);
    expect(db.state.running).toBe(false);
    expect(db.state.v).toBe(0);
    // blade parked away from bottom dead center
    const thB = Math.abs(db.state.theta - db.cam.Theta * Math.round(db.state.theta / db.cam.Theta));
    expect(thB).toBeGreaterThan(db.contactAlpha());
    // restart keeps the phase: still no length error on any piece
    db.setRun(true);
    run(db, 6000);
    for (const r of db.log.filter(x => !x.trim)) expect(Math.abs(r.err)).toBeLessThan(0.05);
    expect(db.state.trims).toBe(1); // no second trim after a graceful stop
  });

  it('E-Stop trips instantly, requires reset, Control-ON clears the machine', () => {
    const db = new SimulationEngine();
    startMachine(db);
    run(db, 2000);
    db.pressEStop();
    expect(db.state.running).toBe(false);
    expect(db.state.controlOn).toBe(false);
    expect(db.state.needsReset).toBe(true);
    db.setControlOn(); // refused: E-Stop still latched
    expect(db.state.controlOn).toBe(false);
    db.releaseEStop();
    db.setControlOn();
    expect(db.state.controlOn).toBe(true);
    expect(db.state.needsReset).toBe(false);
    expect(db.state.D).toBe(0); // machine cleared
    const cutsKept = db.state.cuts;
    expect(cutsKept).toBeGreaterThan(0); // statistics survive the E-Stop
  });

  it('guard door open interlocks START and trips a running machine', () => {
    const db = new SimulationEngine();
    db.toggleGuard(); // open
    db.setControlOn();
    expect(db.state.controlOn).toBe(false); // refused while open
    db.toggleGuard(); // close
    startMachine(db);
    run(db, 1000);
    db.toggleGuard(); // open while running -> immediate safety stop
    expect(db.state.running).toBe(false);
    expect(db.state.needsReset).toBe(true);
  });

  it('overspeed beyond the knife dynamics trips the following-error fault', () => {
    const db = new SimulationEngine();
    db.updateConfig({ knifeWmax: 15, knifeAmax: 150 }); // weak knife drive
    db.updateRecipe({ spd: 2500 }); // 150 m/min, far beyond feasible
    expect(db.recipe.spd).toBeGreaterThan(db.vFeasibleLine());
    startMachine(db);
    run(db, 20000);
    expect(db.state.knifeFault).toBe(true);
    expect(db.state.running).toBe(false);
    // acknowledge clears the fault and the machine can start again
    db.ackKnifeFault();
    expect(db.state.knifeFault).toBe(false);
    db.setRun(true);
    expect(db.state.running).toBe(true);
  });

  it('piece length stays exact even while the line accelerates (position cam)', () => {
    const db = new SimulationEngine();
    db.updateConfig({ axAmax: 500, axJerk: 5000 }); // slow ramp (~2 s): several cuts during accel
    startMachine(db);
    run(db, 6000);
    const duringRamp = db.log.filter(r => !r.trim && r.vLine < db.recipe.spd * 0.95);
    expect(duringRamp.length).toBeGreaterThan(0);
    for (const r of duringRamp) expect(Math.abs(r.err)).toBeLessThan(0.05);
  });
});
