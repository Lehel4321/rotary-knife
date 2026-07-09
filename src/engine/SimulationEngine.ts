import { Recipe, ProcessParams, MachineConfig, MachineState, Piece, CutRecord, CutFace, FacePoint } from '../types';
import { CamProfile, buildCam, contactHalfAngle, suggestRatio } from './FB_Cam';
import { OB1_CyclicUpdate } from './OB1_Main';

/**
 * Fixed PLC scan time in seconds (1 ms). OB1 is always executed with
 * exactly this dt — never with the raw frame time (deterministic
 * machine, CuttingMaschine convention).
 */
export const SCAN_TIME = 0.001;

/** Unit conversion for the operator-facing line speed: 60 m/min = 1000 mm/s. */
export const MM_S_PER_M_MIN = 1000 / 60;
export const toMMin = (mmPerSec: number) => mmPerSec / MM_S_PER_M_MIN;
export const toMmSec = (mPerMin: number) => mPerMin * MM_S_PER_M_MIN;

/** Scope ring buffer size: 1 kHz × 6 s of machine time. */
const SCOPE_CAP = 6000;

/**
 * DB1: Global Machine Data Block (and HMI Bridge)
 *
 * Same two roles as in Lehel4321/CuttingMaschine:
 * 1. The Global Data Block for the "PLC" — all configuration, tags and
 *    buffers; `this` is passed to OB1 and the FCs.
 * 2. The HMI API for React — subscribe/notify plus the operator commands.
 *
 * Configuration levels (like on a real machine):
 * | Block  | Contains                          | Changeable        |
 * |--------|-----------------------------------|-------------------|
 * | recipe | product (length, speed, material) | machine stopped   |
 * | params | process tuning (sync window)      | machine stopped   |
 * | config | physical build (knife, servos)    | control OFF       |
 */
export class SimulationEngine {
  // --- Data Block: RECIPE (product data) ---
  public recipe: Recipe = {
    name: 'TEST-400', len: 400, spd: 1000, thick: 10,
    syncMode: 'constant', ratio: 1.0,
  }; // 1000 mm/s = 60 m/min

  // --- Data Block: PROCESS PARAMETERS ---
  public params: ProcessParams = { syncDeg: 70, outFac: 1.15 };

  // --- Data Block: MACHINE CONFIGURATION (physical build) ---
  public config: MachineConfig = {
    knifeR: 100, knives: 1,
    knifeWmax: 40, knifeAmax: 800, folErrLimit: 5,
    axVmax: 3000, axAmax: 30000, axJerk: 300000,
    overcut: 0.3, maxThick: 20,
  };

  // --- Data Block: Runtime State Tags ---
  public state: MachineState = {
    controlOn: false, estop: false, guardOpen: false, needsReset: false,
    running: false, stopReq: false, braking: false, stopCommit: false, brakeD: 0,
    simTime: 0, runTime: 0,
    D: 0, v: 0, a: 0,
    theta: 0, omega: 0, thetaSet: 0, folErr: 0, knifeFault: false,
    Dref: 0, DlastCut: 0, firstCut: true,
    cuts: 0, trims: 0,
  };

  // --- Data Block: Cam profile (rebuilt on recipe/params/config change) ---
  public cam: CamProfile;

  // --- Data Block: Buffers ---
  public pieces: Piece[] = [];
  public log: CutRecord[] = [];
  public face: CutFace | null = null;
  /** Live blade-in-material trace (FC_Cut writes, canvas reads). */
  public trace = { active: false, D0: 0, pts: [] as FacePoint[], folErrMax: 0 };
  /** Scan snapshot for sub-scan cut interpolation. */
  public prev = { D: 0, theta: 0 };
  public lastCutIdx = 0;
  public penetrating = false;
  public scopeCut = false;

  // --- Data Block: Scope ring buffer (1 kHz machine-time recording) ---
  public scope = {
    cap: SCOPE_CAP, n: 0, i: 0,
    t: new Float32Array(SCOPE_CAP),
    vMat: new Float32Array(SCOPE_CAP),
    vTip: new Float32Array(SCOPE_CAP),
    errDeg: new Float32Array(SCOPE_CAP),
    pen: new Uint8Array(SCOPE_CAP),
    cut: new Uint8Array(SCOPE_CAP),
  };

  /**
   * HMI animation time scale (NOT machine data): 1 = real time,
   * 0.1 = slow motion to watch the blade pass through the material.
   * All statistics run on machine time and are unaffected.
   */
  public slowMo = 1.0;

  constructor() {
    this.cam = buildCam(this.recipe, this.params, this.config);
    this.rephase();
  }

  // --- HMI Event System ---
  private listeners: Set<() => void> = new Set();
  public subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  public notify() { this.listeners.forEach(l => l()); }

  // --- Machine Properties ---

  /** Line cruise speed: recipe speed capped at the feed axis Vmax. */
  public cruiseSpeed() { return Math.min(this.recipe.spd, this.config.axVmax); }

  /** Max line speed the whole machine can cut at (knife dynamics + feed axis). */
  public vFeasibleLine() { return Math.min(this.cam.vFeasible, this.config.axVmax); }

  /** Blade contact half-angle at the current recipe thickness (rad). */
  public contactAlpha() { return contactHalfAngle(this.config.knifeR, this.recipe.thick, this.config.overcut); }

  /** Velocity ratio that aligns face bottom with entry at this thickness. */
  public suggestedRatio() { return suggestRatio(this.contactAlpha()); }

  /** Nominal cut rate at the commanded line speed (cuts/min). */
  public nominalRate() { return (60 * this.cruiseSpeed()) / this.recipe.len; }

  /** Length of material currently past the knife (the forming piece). */
  public tipLen() { return this.state.D - this.state.DlastCut; }

  /**
   * Aggregated test-campaign statistics over the logged (non-trim) cuts —
   * the "how fast / how long / how exact" numbers this rig exists for.
   */
  public getStats() {
    const good = this.log.filter(r => !r.trim);
    const n = good.length;
    let meanErr = 0, stdErr = 0, maxAbsErr = 0;
    let meanStraight = 0, maxStraight = 0, nFace = 0;
    for (const r of good) {
      meanErr += r.err;
      if (Math.abs(r.err) > maxAbsErr) maxAbsErr = Math.abs(r.err);
      if (r.straight !== null) { meanStraight += r.straight; nFace++; if (r.straight > maxStraight) maxStraight = r.straight; }
    }
    if (n > 0) meanErr /= n;
    if (nFace > 0) meanStraight /= nFace;
    for (const r of good) stdErr += (r.err - meanErr) ** 2;
    stdErr = n > 1 ? Math.sqrt(stdErr / (n - 1)) : 0;
    // Measured rate over the most recent cuts (timestamps, machine time)
    const recent = good.slice(-20);
    const rate = recent.length >= 2
      ? (60 * (recent.length - 1)) / (recent[recent.length - 1].t - recent[0].t)
      : 0;
    // Most recent cut whose face has been measured (the blade exits the
    // material a moment after the cut fires, so the newest record may
    // still be pending)
    let lastFace = null as (typeof good)[number] | null;
    for (let i = good.length - 1; i >= 0; i--) {
      if (good[i].straight !== null) { lastFace = good[i]; break; }
    }
    return { n, meanErr, stdErr, maxAbsErr, meanStraight, maxStraight, rate, last: good[good.length - 1] ?? null, lastFace };
  }

  /** Scope recording — called once per OB1 scan (1 kHz machine time). */
  public pushScope() {
    const s = this.scope;
    s.t[s.i] = this.state.simTime;
    s.vMat[s.i] = this.state.v;
    s.vTip[s.i] = this.state.omega * this.config.knifeR;
    s.errDeg[s.i] = (this.state.folErr * 180) / Math.PI;
    s.pen[s.i] = this.penetrating ? 1 : 0;
    s.cut[s.i] = this.scopeCut ? 1 : 0;
    s.i = (s.i + 1) % s.cap;
    if (s.n < s.cap) s.n++;
  }

  // --- Scan Cycle Accumulator (real time -> fixed 1 ms scans) ---
  private scanAcc = 0;

  /**
   * Called once per animation frame with the REAL elapsed time. Scaled
   * by the slow-motion factor, then converted into N fixed 1 ms OB1
   * scans (fixed-timestep accumulator).
   */
  public update(dtReal: number) {
    if (dtReal > 0.05) dtReal = 0.05; // watchdog: inactive tab / lag spike
    if (!this.state.controlOn || !this.state.running) { this.scanAcc = 0; return; }
    this.scanAcc += dtReal * this.slowMo;
    while (this.scanAcc >= SCAN_TIME) {
      OB1_CyclicUpdate(this, SCAN_TIME);
      this.scanAcc -= SCAN_TIME;
    }
  }

  // --- Cam management ---

  private rebuildCam() {
    this.cam = buildCam(this.recipe, this.params, this.config);
  }

  /**
   * Re-phase the knife to the cam: knife to the PARK position, cam zero
   * reference anchored so the current master position sits exactly on
   * the park phase. The next cut is the phasing TRIM cut (creates the
   * reference edge — the LRK's "first cut").
   */
  private rephase() {
    const st = this.state;
    st.theta = this.cam.parkTheta;
    st.omega = 0;
    st.thetaSet = st.theta;
    st.folErr = 0;
    st.Dref = st.D - this.cam.parkPhi;
    st.DlastCut = st.D;
    st.firstCut = true;
    this.lastCutIdx = Math.floor(st.theta / this.cam.Theta);
    this.prev.D = st.D;
    this.prev.theta = st.theta;
    this.trace.active = false;
    this.trace.pts = [];
    this.penetrating = false;
  }

  /**
   * Clear the machine after an interruption (E-Stop, guard, knife fault):
   * fresh material at the knife, knife re-phased to park. The test
   * statistics and the log are KEPT — a real machine does not forget its
   * shift counters on an E-Stop.
   */
  private clearSequence() {
    const st = this.state;
    st.D = 0; st.v = 0; st.a = 0;
    st.stopReq = false; st.braking = false; st.brakeD = 0;
    st.knifeFault = false;
    this.pieces = [];
    this.face = null;
    this.scanAcc = 0;
    this.rephase();
  }

  // --- HMI Commands: SAFETY (basic safety control functions) ---

  /**
   * Green illuminated push button "Control ON" (Steuerung EIN).
   * Interlock: refused while the E-Stop is latched or the guard is open.
   * After an interruption (needsReset) the machine is cleared here.
   */
  public setControlOn() {
    if (this.state.estop) return;      // E-Stop chain open -> refuse
    if (this.state.guardOpen) return;  // guard open -> refuse
    if (this.state.controlOn) return;
    if (this.state.needsReset) {
      this.clearSequence();
      this.state.needsReset = false;
    }
    this.state.controlOn = true;
    this.notify();
  }

  public setControlOff() {
    if (!this.state.controlOn) return;
    if (this.state.running) this.state.needsReset = true;
    this.state.controlOn = false;
    this.state.running = false;
    this.state.stopReq = false;
    this.state.braking = false;
    this.state.v = 0; this.state.a = 0; this.state.omega = 0;
    this.notify();
  }

  /** E-Stop PRESSED (latches). Category 0: drive power gone instantly. */
  public pressEStop() {
    if (this.state.estop) return;
    if (this.state.running) this.state.needsReset = true;
    this.state.estop = true;
    this.state.controlOn = false;
    this.state.running = false;
    this.state.stopReq = false;
    this.state.braking = false;
    this.state.v = 0; this.state.a = 0; this.state.omega = 0;
    this.notify();
  }

  /** E-Stop RELEASED (twisted out). Control stays OFF until Control-ON. */
  public releaseEStop() {
    if (!this.state.estop) return;
    this.state.estop = false;
    this.notify();
  }

  /**
   * Guard door of the knife enclosure. Opening it while the machine runs
   * trips an immediate safety stop (category 0 — this is a knife).
   */
  public toggleGuard() {
    this.state.guardOpen = !this.state.guardOpen;
    if (this.state.guardOpen && this.state.running) {
      this.state.running = false;
      this.state.needsReset = true;
      this.state.stopReq = false;
      this.state.braking = false;
      this.state.v = 0; this.state.a = 0; this.state.omega = 0;
    }
    this.notify();
  }

  // --- HMI Commands: START / STOP ---

  /**
   * START. Interlocks: control ON, guard closed, no latched knife fault.
   * Restarting after a graceful stop keeps the cam phase — the piece in
   * progress still comes out at exactly the recipe length.
   */
  public setRun(on: boolean) {
    if (on && (!this.state.controlOn || this.state.guardOpen || this.state.knifeFault)) return;
    if (!on) {
      // Hard stop (internal/tests): drives off where they are
      this.state.running = false;
      this.state.stopReq = false;
      this.state.braking = false;
      this.state.v = 0; this.state.a = 0; this.state.omega = 0;
      this.notify();
      return;
    }
    this.state.running = true;
    this.state.stopReq = false;
    this.state.braking = false;
    this.notify();
  }

  /**
   * Operator Stop: GRACEFUL — the line brakes with the S-curve to a
   * standstill exactly on a knife park phase (blade out of the material,
   * pieces cut during the ramp still at recipe length). E-Stop is the
   * instant halt.
   */
  public requestStop() {
    if (!this.state.running || this.state.stopReq) return;
    this.state.stopReq = true;
    this.notify();
  }

  /** Acknowledge a latched knife following-error fault (machine cleared). */
  public ackKnifeFault() {
    if (!this.state.knifeFault) return;
    this.clearSequence();
    this.state.needsReset = false;
    this.notify();
  }

  /** Master reset: clears the machine AND the whole test campaign. */
  public reset() {
    this.state.running = false;
    this.state.needsReset = false;
    this.state.knifeFault = false;
    this.state.stopReq = false;
    this.state.braking = false;
    this.state.simTime = 0;
    this.state.runTime = 0;
    this.state.cuts = 0;
    this.state.trims = 0;
    this.log = [];
    this.scope.n = 0; this.scope.i = 0;
    this.state.D = 0; this.state.v = 0; this.state.a = 0;
    this.pieces = [];
    this.face = null;
    this.scanAcc = 0;
    this.rebuildCam();
    this.rephase();
    this.notify();
  }

  // --- RECIPE / PARAMS / CONFIG (with interlocks) ---

  /**
   * Change product data. INTERLOCK: refused while running. Rebuilds the
   * cam and re-phases the knife (the next cut is a new reference edge).
   */
  public updateRecipe(updates: Partial<Recipe>): boolean {
    if (this.state.running) return false;
    const prev = this.recipe;
    const num = (v: number | undefined, fallback: number, min: number, max: number) =>
      Number.isFinite(v) && (v as number) > 0 ? Math.min(max, Math.max(min, v as number)) : fallback;
    this.recipe = { ...prev, ...updates };
    this.recipe.name = (this.recipe.name || 'TEST').toUpperCase().slice(0, 24);
    this.recipe.len = num(this.recipe.len, prev.len, 50, 5000);
    this.recipe.spd = num(this.recipe.spd, prev.spd, 10, 10000);
    this.recipe.thick = num(this.recipe.thick, prev.thick, 0.5, this.config.maxThick);
    this.recipe.ratio = num(this.recipe.ratio, prev.ratio, 0.8, 1.3);
    if (this.recipe.syncMode !== 'constant' && this.recipe.syncMode !== 'comp') this.recipe.syncMode = 'constant';
    this.rebuildCam();
    this.rephase();
    this.notify();
    return true;
  }

  /** Process tuning. INTERLOCK: refused while running (the sync window reshapes the cam). */
  public updateParams(updates: Partial<ProcessParams>): boolean {
    if (this.state.running) return false;
    this.params = { ...this.params, ...updates };
    this.params.syncDeg = Math.min(140, Math.max(10, this.params.syncDeg || 70));
    this.params.outFac = Math.min(3, Math.max(1, this.params.outFac || 1.15));
    this.rebuildCam();
    this.rephase();
    this.notify();
    return true;
  }

  /** Physical machine build. INTERLOCK: refused while the control is ON. */
  public updateConfig(updates: Partial<MachineConfig>): boolean {
    if (this.state.controlOn) return false;
    this.config = { ...this.config, ...updates };
    const c = this.config;
    c.knifeR = Math.min(400, Math.max(40, c.knifeR || 100));
    c.knives = c.knives === 2 ? 2 : 1;
    c.knifeWmax = Math.min(200, Math.max(2, c.knifeWmax || 40));
    c.knifeAmax = Math.min(20000, Math.max(20, c.knifeAmax || 800));
    c.folErrLimit = Math.min(30, Math.max(0.5, c.folErrLimit || 5));
    c.axVmax = Math.max(10, c.axVmax || 3000);
    c.axAmax = Math.max(100, c.axAmax || 30000);
    c.axJerk = Math.max(1000, c.axJerk || 300000);
    c.overcut = Math.min(2, Math.max(0, Number.isFinite(c.overcut) ? c.overcut : 0.3));
    c.maxThick = 20; // mechanical limit of this machine
    if (this.recipe.thick > c.maxThick) this.recipe.thick = c.maxThick;
    this.rebuildCam();
    this.rephase();
    this.notify();
    return true;
  }
}

export const engine = new SimulationEngine();
