/**
 * RECIPE — product data (DB "Rezept").
 * Everything that describes THE PRODUCT: what is being cut and how.
 * Only changeable while the machine is STOPPED (like on a real machine).
 */
export interface Recipe {
  name: string;
  len: number;        // cut length L (mm) — one knife revolution period of material
  spd: number;        // line speed (mm/s) — the material feed runs CONTINUOUSLY at this speed
  thick: number;      // material thickness (mm), physical maximum 20 mm
  /**
   * How the knife is synchronized to the material inside the sync window
   * (this is THE experiment of this test rig — what makes the cut straight):
   * 'constant' = classic LRK sync: constant angular velocity, blade
   *              CIRCUMFERENTIAL speed = ratio × material speed. On thick
   *              material the cut face comes out visibly angled, because the
   *              HORIZONTAL tip speed drops with cos(θ) away from bottom
   *              dead center while the material keeps moving.
   * 'comp'     = thickness-compensated cam: inside the sync window the cam is
   *              θ(s) = asin(s/R), which makes the tip's HORIZONTAL position
   *              track the material exactly → perfectly straight face at any
   *              thickness (needs more knife dynamics at the window edges).
   */
  syncMode: 'constant' | 'comp';
  /**
   * Cutting velocity ratio (LRK: "cut with same or different velocity").
   * 1.0 = blade circumference speed equals material speed. On thick material
   * a ratio of α/sin(α) (α = contact half-angle) re-aligns the face bottom
   * with the entry point — the AUTO button in the recipe editor computes it.
   * Only used in 'constant' mode; 'comp' is exact by construction.
   */
  ratio: number;
}

/**
 * PROCESS PARAMETERS — operator tuning (DB "Parameter"), changeable any time.
 */
export interface ProcessParams {
  /**
   * Synchronous range of the cam as knife ANGLE (degrees, total window
   * centered on the cut point) — like the LRK's synchronous operation range.
   * Must at least cover the material contact window 2α, otherwise part of
   * the cut happens on the (non-synchronous) return profile and the face
   * gets damaged — the app warns when that is the case.
   */
  syncDeg: number;
  /** Out-feed belt speed gain (× line speed) — pulls a visible gap between cut pieces. */
  outFac: number;
}

/**
 * MACHINE CONFIGURATION — physical build (DB "Maschinendaten").
 * Set at commissioning, only changeable while the machine control is OFF.
 */
export interface MachineConfig {
  knifeR: number;       // knife tip radius (mm) — tip circle circumference = 2πR
  knives: 1 | 2;        // number of blades on the drum (LRK "knifeAmount")
  /** Knife axis servo limits. The cam demands peak dynamics on the return stroke. */
  knifeWmax: number;    // max angular velocity (rad/s)
  knifeAmax: number;    // max angular acceleration (rad/s²)
  /** Following-error monitor of the knife axis (degrees) — drive faults beyond this. */
  folErrLimit: number;
  /** Feed axis servo data (jerk-limited S-curve, ported from MotionProfileSolver). */
  axVmax: number;       // feed axis maximum velocity (mm/s)
  axAmax: number;       // feed axis maximum acceleration (mm/s²)
  axJerk: number;       // feed axis maximum jerk (mm/s³)
  overcut: number;      // how far the tip circle reaches below the anvil line (mm)
  maxThick: number;     // mechanical thickness limit of the machine (20 mm)
}

/** One finished cut — the raw data of the test campaign. */
export interface CutRecord {
  n: number;          // cut number
  t: number;          // machine time of the cut (s)
  len: number;        // actual piece length (mm), interpolated inside the scan
  err: number;        // len − recipe.len (mm)
  trim: boolean;      // first cut after (re)phasing — establishes the reference edge, excluded from stats
  vLine: number;      // line speed at the moment of the cut (mm/s)
  /** Cut face quality — filled in when the blade has fully exited the material. */
  straight: number | null; // max lateral deviation of the face from vertical (mm) — THE straightness number
  skew: number | null;     // lateral offset face bottom vs face top on the down-pass (mm, sign = lean direction)
  drag: number | null;     // loop width between blade down-pass and up-pass at the surface (mm) — blade rubbing the face
  folErrMax: number;  // peak knife following error during this cut window (deg)
}

/** One recorded point of the blade tip travelling through the material (material frame). */
export interface FacePoint {
  d: number;  // depth below the material top surface (mm)
  x: number;  // lateral position relative to the entry point (mm); x=const ⇒ straight face
}

/** Completed tip trace through the material — the physical cut face. */
export interface CutFace {
  pts: FacePoint[];    // full trace: down-pass then up-pass
  downEnd: number;     // index of the deepest point (end of the down-pass)
  straight: number;
  skew: number;
  drag: number;
}

/** A cut-off piece travelling on the out-feed belt. */
export interface Piece {
  left: number;   // rear edge distance past the knife (mm)
  len: number;
  trim: boolean;
}

export interface MachineState {
  /** Machine control enabled ("Steuerung EIN"). Nothing moves while FALSE. */
  controlOn: boolean;
  /** E-Stop button latched (pressed). Release before Control-ON is possible. */
  estop: boolean;
  /** Knife guard door open — START interlocked; opening while running = safety stop. */
  guardOpen: boolean;
  /** Production was interrupted (E-Stop / guard / knife fault) — next Control-ON clears the machine. */
  needsReset: boolean;
  running: boolean;
  /** Graceful stop requested: brake the LINE to a standstill exactly on a knife park phase. */
  stopReq: boolean;
  /** TRUE while the feed axis is position-braking to the park-phase target. */
  braking: boolean;
  /**
   * Latched once the committed S-curve stopping distance reaches the
   * remaining distance to the park target: from then on the stop ramp
   * runs through to standstill (a stop is never un-committed — this is
   * what makes the landing a single clean S-curve).
   */
  stopCommit: boolean;
  brakeD: number;     // feed position where the line reaches standstill (knife parked)
  simTime: number;    // machine time (s) — advances only while running
  runTime: number;    // accumulated production time of the test run (s)

  // --- Feed axis (leading axis / master) ---
  D: number;          // feed encoder position (mm) — total material fed
  v: number;          // actual velocity (mm/s), jerk-limited S-curve
  a: number;          // actual acceleration (mm/s²)

  // --- Knife axis (following axis / slave, cam-coupled) ---
  theta: number;      // actual knife angle (rad, unwrapped)
  omega: number;      // actual angular velocity (rad/s)
  thetaSet: number;   // cam setpoint angle (rad, unwrapped)
  folErr: number;     // following error (rad) = thetaSet − theta
  /** Knife axis following-error fault latched — machine halted, needs acknowledge. */
  knifeFault: boolean;

  // --- Cam coupling bookkeeping ---
  Dref: number;       // master position of cam phase zero (cut point)
  DlastCut: number;   // master position of the previous cut (piece length reference)
  firstCut: boolean;  // next cut is the phasing/trim cut

  // --- Test counters ---
  cuts: number;       // good (non-trim) cuts this run
  trims: number;
}
