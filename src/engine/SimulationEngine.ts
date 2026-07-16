import { Recipe, ProcessParams, MachineConfig, MachineState, Piece, CutRecord, CutFace, FacePoint } from '../types';
import { CamProfile, buildCam, contactHalfAngle, suggestRatio } from './FB_Cam';
import { OB1_CyclicUpdate } from './OB1_Main';
import { MM_S_PER_M_MIN, toMMin, toMmSec } from './units';

// Re-exported so existing consumers keep one import site for engine + units
export { MM_S_PER_M_MIN, toMMin, toMmSec };

/**
 * Fixed PLC scan time in seconds (1 ms). OB1 is always executed with
 * exactly this dt — never with the raw frame time (deterministic
 * machine, CuttingMaschine convention).
 */
export const SCAN_TIME = 0.001;

/** Scope ring buffer size: 1 kHz × 6 s of machine time. */
const SCOPE_CAP = 6000;

/**
 * Setpoint validation: a finite value is clamped to [min, max]; anything
 * else (empty field → NaN) KEEPS the previous value. Every recipe /
 * params / config field goes through this — an invalid entry must never
 * snap a setting to an unrelated hardcoded default.
 */
const num = (v: number | undefined, prev: number, min: number, max: number) =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, v as number)) : prev;

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
    cuts: 0, trims: 0, matCut: 0,
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
  // The time axis is Float64: with Float32 the 1 ms sample spacing falls
  // below the float resolution after ~2.5 h of machine time and the
  // scope time base aliases — endurance runs are exactly this rig's job.
  public scope = {
    cap: SCOPE_CAP, n: 0, i: 0,
    t: new Float64Array(SCOPE_CAP),
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

  /** Current cam master phase φ ∈ [0, L) — the cut fires at φ = 0. */
  public camPhase() {
    const L = this.cam.L;
    return (((this.state.D - this.state.Dref) % L) + L) % L;
  }

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

  /** Identity of the cam CURVE — everything that defines θ(φ) geometrically. */
  private camKey() {
    const c = this.cam;
    return JSON.stringify([c.L, c.Theta, c.mode, c.k, c.R, c.thetaA, c.sA, c.parkPhi, c.dwell]);
  }

  /**
   * Rebuild the cam and re-phase the knife ONLY if the curve actually
   * changed. Editing the line speed, the thickness or the recipe name
   * must never cost a re-phase (and therefore a TRIM cut) — only changes
   * to the cut geometry (length, mode, ratio, sync window, drum) do.
   */
  private applyCamChange() {
    const before = this.camKey();
    this.rebuildCam();
    if (this.camKey() !== before) this.rephase();
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
    st.stopReq = false; st.braking = false; st.stopCommit = false; st.brakeD = 0;
    st.knifeFault = false;
    this.pieces = [];
    this.face = null;
    this.scanAcc = 0;
    // A cut whose face was still being measured can never complete now
    // (the blade froze inside the material and the machine is cleared) —
    // mark it so the log shows "n/a" instead of "measuring…" forever.
    for (let i = this.log.length - 1; i >= 0 && i >= this.log.length - 3; i--) {
      const r = this.log[i];
      if (r.straight === null) r.lost = true;
    }
    this.rephase();
  }

  /**
   * Category-0 drive stop — the ONE place that takes both drives off and
   * clears every motion latch. Every trip path (E-Stop, guard, control
   * off, hard stop, knife fault, safety backstop) calls this; a latch
   * added here is cleared on all of them at once.
   */
  public safeStop(markReset: boolean) {
    const st = this.state;
    if (markReset && st.running) st.needsReset = true;
    st.running = false;
    st.stopReq = false;
    st.braking = false;
    st.stopCommit = false;
    st.v = 0;
    st.a = 0;
    st.omega = 0;
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
    this.safeStop(true);
    this.state.controlOn = false;
    this.notify();
  }

  /** E-Stop PRESSED (latches). Category 0: drive power gone instantly. */
  public pressEStop() {
    if (this.state.estop) return;
    this.safeStop(true);
    this.state.estop = true;
    this.state.controlOn = false;
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
    if (this.state.guardOpen && this.state.running) this.safeStop(true);
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
      this.safeStop(false);
      this.notify();
      return;
    }
    this.state.running = true;
    this.state.stopReq = false;
    this.state.braking = false;
    this.state.stopCommit = false;
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
    this.safeStop(false);
    this.state.needsReset = false;
    this.state.knifeFault = false;
    this.state.brakeD = 0;
    this.state.simTime = 0;
    this.state.runTime = 0;
    this.state.cuts = 0;
    this.state.trims = 0;
    this.state.matCut = 0;
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
   * Change product data. INTERLOCK: refused while running. An unchanged
   * result is a no-op; a changed CAM CURVE (length, mode, ratio) also
   * re-phases the knife (the next cut is a new reference edge).
   */
  public updateRecipe(updates: Partial<Recipe>): boolean {
    if (this.state.running) return false;
    const prev = this.recipe;
    const next = { ...prev, ...updates };
    next.name = (next.name || 'TEST').toUpperCase().slice(0, 24);
    next.len = num(next.len, prev.len, 50, 5000);
    next.spd = num(next.spd, prev.spd, 10, 10000);
    next.thick = num(next.thick, prev.thick, 0.5, this.config.maxThick);
    next.ratio = num(next.ratio, prev.ratio, 0.8, 1.3);
    if (next.syncMode !== 'constant' && next.syncMode !== 'comp') next.syncMode = 'constant';
    if (JSON.stringify(next) === JSON.stringify(prev)) return true; // no actual change
    this.recipe = next;
    this.applyCamChange();
    this.notify();
    return true;
  }

  /** Process tuning. INTERLOCK: refused while running (the sync window reshapes the cam). */
  public updateParams(updates: Partial<ProcessParams>): boolean {
    if (this.state.running) return false;
    const prev = this.params;
    const next = { ...prev, ...updates };
    next.syncDeg = num(next.syncDeg, prev.syncDeg, 10, 140);
    next.outFac = num(next.outFac, prev.outFac, 1, 3);
    if (JSON.stringify(next) === JSON.stringify(prev)) return true;
    this.params = next;
    this.applyCamChange();
    this.notify();
    return true;
  }

  /** Physical machine build. INTERLOCK: refused while the control is ON. */
  public updateConfig(updates: Partial<MachineConfig>): boolean {
    if (this.state.controlOn) return false;
    const prev = this.config;
    const c = { ...prev, ...updates };
    c.knifeR = num(c.knifeR, prev.knifeR, 40, 400);
    c.knives = c.knives === 2 ? 2 : 1;
    c.knifeWmax = num(c.knifeWmax, prev.knifeWmax, 2, 200);
    c.knifeAmax = num(c.knifeAmax, prev.knifeAmax, 20, 20000);
    c.folErrLimit = num(c.folErrLimit, prev.folErrLimit, 0.5, 30);
    c.axVmax = num(c.axVmax, prev.axVmax, 10, 1e6);
    c.axAmax = num(c.axAmax, prev.axAmax, 100, 1e8);
    c.axJerk = num(c.axJerk, prev.axJerk, 1000, 1e10);
    c.overcut = num(c.overcut, prev.overcut, 0, 2);
    c.maxThick = 20; // mechanical limit of this machine
    if (JSON.stringify(c) === JSON.stringify(prev)) return true;
    this.config = c;
    if (this.recipe.thick > c.maxThick) this.recipe.thick = c.maxThick;
    this.applyCamChange();
    this.notify();
    return true;
  }
}

export const engine = new SimulationEngine();
