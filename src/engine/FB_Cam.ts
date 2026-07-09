import { Recipe, ProcessParams, MachineConfig } from '../types';

/**
 * FB100: Rotary Knife Cam Profile (LRK-style camming)
 *
 * Modeled after the SIMATIC S7-1500T "Rotary Knife" standard application
 * (Siemens Industry Online Support, Entry-ID 109757260, library "LRK"):
 * the knife axis is a FOLLOWING AXIS coupled to the material feed axis
 * (the LEADING AXIS) through a cam — exactly like MC_CamIn with a cam
 * built by the LCamHdl library. The cam maps master travel φ (mm of
 * material, one period = the cut length L) to knife angle θ (rad, one
 * period = 2π / number of knives):
 *
 *   SYNC SEGMENT   around the cut point (φ = 0): the blade is inside or
 *                  near the material — its speed is locked to the material.
 *                  'constant' mode: dθ/dφ = k/R  (circumferential speed =
 *                  k × material speed, LRK's velocity ratio).
 *                  'comp' mode: θ = asin(k·φ/R) — the tip's HORIZONTAL
 *                  position tracks the material exactly, which is what
 *                  makes the cut face perfectly straight through thick
 *                  material.
 *   RETURN SEGMENT the rest of the revolution, a 5th-degree polynomial
 *                  (VDI 2143, no velocity or acceleration steps at the
 *                  junctions — the same segment type LCamHdl generates).
 *   STANDSTILL     for cut lengths much longer than the knife
 *                  circumference the polynomial return would have to run
 *                  backwards; instead the knife decelerates to a stop at
 *                  the park position and waits — the LRK does the same.
 *
 * Because the coupling is a POSITION cam (θ as a function of material
 * travel, not of time), the synchronisation — and therefore the cut
 * quality and the piece length — is independent of line speed, including
 * during acceleration and braking ramps. Speed only enters through the
 * knife axis dynamic limits, which is exactly what this test rig is
 * built to explore.
 */

/** One piece of the return stroke. */
export interface CamSeg {
  kind: 'poly' | 'dwell';
  phi0: number;         // master phase where the segment starts (mm)
  S: number;            // master length of the segment (mm)
  c?: number[];         // quintic coefficients over u = (φ−phi0)/S ∈ [0,1]
  theta?: number;       // dwell angle (rad)
}

export interface CamProfile {
  L: number;            // master period = cut length (mm)
  Theta: number;        // slave period = 2π / knives (rad)
  R: number;            // knife tip radius (mm)
  k: number;            // cutting velocity ratio
  mode: 'constant' | 'comp';
  thetaA: number;       // knife angle at the sync window edge (rad, half window)
  sA: number;           // master distance of the half sync window (mm)
  segs: CamSeg[];       // return stroke covering [sA, L−sA]
  dwell: boolean;       // TRUE when the cam contains a standstill phase
  parkPhi: number;      // master phase of the park position (mm)
  parkTheta: number;    // knife angle of the park position (rad) = Θ/2
  alpha: number;        // material contact half-angle (rad) for the recipe thickness
  maxSlope: number;     // max dθ/dφ over the period (rad/mm)
  maxAcc: number;       // max |d²θ/dφ²| over the period (rad/mm²)
  /** Max line speed the knife axis can follow (mm/s), from ωmax and αmax. */
  vFeasible: number;
  /** Predicted face metrics at the recipe thickness (theory, mm). */
  predictSkew: number;
  predictStraight: number;
  warnings: string[];
}

/**
 * Contact half-angle α: the blade tip is inside the material for
 * θ ∈ [−α, +α]. From tip height  y(θ) = y_c − R·cosθ  with the drum
 * center at y_c = R − overcut above the anvil, the tip crosses the
 * material top surface (thickness T) where cosθ = (R − overcut − T)/R.
 */
export function contactHalfAngle(R: number, T: number, overcut: number): number {
  const c = (R - overcut - T) / R;
  if (c >= 1) return 0;
  if (c <= -1) return Math.PI;
  return Math.acos(c);
}

/**
 * Velocity ratio that re-aligns the face BOTTOM with the entry point on
 * thick material in 'constant' mode: skew(k) = R·(sinα − α/k) = 0 at
 * k = α/sinα. (The LRK's "cut with a different velocity" used purposefully.)
 */
export function suggestRatio(alpha: number): number {
  if (alpha <= 0) return 1;
  return alpha / Math.sin(alpha);
}

/**
 * Quintic Hermite coefficients over u ∈ [0,1] with position/velocity/
 * acceleration boundary conditions at both ends (VDI 2143 5th-degree
 * polynomial — the standard cam return segment, same as LCamHdl).
 */
export function hermite5(P0: number, V0: number, A0: number, P1: number, V1: number, A1: number): number[] {
  const d = P1 - P0;
  return [
    P0,
    V0,
    A0 / 2,
    10 * d - 6 * V0 - 4 * V1 - 1.5 * A0 + 0.5 * A1,
    -15 * d + 8 * V0 + 7 * V1 + 1.5 * A0 - A1,
    6 * d - 3 * V0 - 3 * V1 - 0.5 * A0 + 0.5 * A1,
  ];
}

/** Evaluate quintic and its first two derivatives (in u). */
export function evalPoly(c: number[], u: number): [number, number, number] {
  const p = c[0] + u * (c[1] + u * (c[2] + u * (c[3] + u * (c[4] + u * c[5]))));
  const dp = c[1] + u * (2 * c[2] + u * (3 * c[3] + u * (4 * c[4] + u * 5 * c[5])));
  const ddp = 2 * c[2] + u * (6 * c[3] + u * (12 * c[4] + u * 20 * c[5]));
  return [p, dp, ddp];
}

/** Sync segment evaluation, φrel ∈ [−sA, +sA] around the cut point. Returns [θ, dθ/dφ, d²θ/dφ²]. */
function evalSync(cam: Pick<CamProfile, 'mode' | 'k' | 'R'>, phiRel: number): [number, number, number] {
  const { k, R } = cam;
  if (cam.mode === 'constant') {
    return [(k / R) * phiRel, k / R, 0];
  }
  // 'comp': θ = asin(k·φ/R) — tip horizontal position R·sinθ = k·φ tracks the material
  const x = Math.max(-0.999999, Math.min(0.999999, (k * phiRel) / R));
  const cx = Math.sqrt(1 - x * x);
  return [Math.asin(x), k / (R * cx), (k * k * x) / (R * R * cx * cx * cx)];
}

/** Numerically check that a poly segment never runs the knife backwards. */
function polyMonotone(c: number[], S: number): boolean {
  for (let i = 0; i <= 256; i++) {
    if (evalPoly(c, i / 256)[1] / S < -1e-9) return false;
  }
  return true;
}

export function buildCam(recipe: Recipe, params: ProcessParams, config: MachineConfig): CamProfile {
  const warnings: string[] = [];
  const R = config.knifeR;
  const K = config.knives;
  const Theta = (2 * Math.PI) / K;
  const L = recipe.len;
  const k = recipe.syncMode === 'comp' ? 1 : recipe.ratio;
  const alpha = contactHalfAngle(R, recipe.thick, config.overcut);

  // --- Sync window: half-angle θ_A and its master distance s_A ---
  let thetaA = ((params.syncDeg / 2) * Math.PI) / 180;
  // The window must stay clear of the park position and (comp mode) of ±90°.
  const thetaCap = Math.min(0.45 * Theta, 0.44 * Math.PI);
  if (thetaA > thetaCap) thetaA = thetaCap;
  const syncMasterDist = (a: number) => (recipe.syncMode === 'comp' ? (R * Math.sin(a)) / k : (a * R) / k);
  let sA = syncMasterDist(thetaA);
  // The sync window plus a usable return stroke must fit into one cut length.
  const maxSA = 0.4 * L;
  if (sA > maxSA) {
    while (thetaA > 0.02 && syncMasterDist(thetaA) > maxSA) thetaA *= 0.95;
    sA = syncMasterDist(thetaA);
    warnings.push(
      `CUT LENGTH TOO SHORT for the ${params.syncDeg}° sync window — window reduced to ${((2 * thetaA * 180) / Math.PI).toFixed(0)}°`,
    );
  }
  if (thetaA < alpha) {
    warnings.push(
      `SYNC WINDOW ${((2 * thetaA * 180) / Math.PI).toFixed(0)}° < blade contact ${((2 * alpha * 180) / Math.PI).toFixed(0)}° — the blade leaves sync INSIDE the material, the cut face will be damaged`,
    );
  }

  // Boundary conditions at the sync window edge (position continuity of
  // velocity AND acceleration — the return polynomial matches both).
  const [, vA, aA] = evalSync({ mode: recipe.syncMode, k, R }, sA);

  // --- Return stroke: single quintic, or quintic–standstill–quintic ---
  const S = L - 2 * sA;
  const P0 = thetaA, P1 = Theta - thetaA;
  const segs: CamSeg[] = [];
  let dwell = false;
  let parkPhi = L / 2;

  const plain = hermite5(P0, vA * S, aA * S * S, P1, vA * S, -aA * S * S);
  if (polyMonotone(plain, S)) {
    segs.push({ kind: 'poly', phi0: sA, S, c: plain });
  } else {
    // Long cut: the single polynomial would rotate the knife backwards.
    // Decelerate to the park position, stand still, accelerate back in.
    dwell = true;
    const dTh = Theta / 2 - thetaA;
    let Sm = Math.min((2 * dTh) / vA, S / 2 - 1e-9);
    let q1 = hermite5(P0, vA * Sm, aA * Sm * Sm, Theta / 2, 0, 0);
    let q2 = hermite5(Theta / 2, 0, 0, P1, vA * Sm, -aA * Sm * Sm);
    for (let i = 0; i < 6 && (!polyMonotone(q1, Sm) || !polyMonotone(q2, Sm)); i++) {
      Sm *= 0.8;
      q1 = hermite5(P0, vA * Sm, aA * Sm * Sm, Theta / 2, 0, 0);
      q2 = hermite5(Theta / 2, 0, 0, P1, vA * Sm, -aA * Sm * Sm);
    }
    const Sd = S - 2 * Sm;
    segs.push({ kind: 'poly', phi0: sA, S: Sm, c: q1 });
    segs.push({ kind: 'dwell', phi0: sA + Sm, S: Sd, theta: Theta / 2 });
    segs.push({ kind: 'poly', phi0: sA + Sm + Sd, S: Sm, c: q2 });
    parkPhi = sA + Sm + Sd / 2;
  }

  const cam: CamProfile = {
    L, Theta, R, k, mode: recipe.syncMode, thetaA, sA, segs, dwell,
    parkPhi, parkTheta: Theta / 2, alpha,
    maxSlope: 0, maxAcc: 0, vFeasible: 0,
    predictSkew: 0, predictStraight: 0, warnings,
  };

  // --- Dynamics demand and feasible line speed ---
  // Steady line speed v: knife ω = dθ/dφ·v, knife α = d²θ/dφ²·v².
  let maxSlope = 0, maxAcc = 0;
  for (let i = 0; i < 1024; i++) {
    const [, dth, ddth] = evalCam(cam, (i / 1024) * L);
    if (Math.abs(dth) > maxSlope) maxSlope = Math.abs(dth);
    if (Math.abs(ddth) > maxAcc) maxAcc = Math.abs(ddth);
  }
  cam.maxSlope = maxSlope;
  cam.maxAcc = maxAcc;
  cam.vFeasible = Math.min(
    maxSlope > 1e-12 ? config.knifeWmax / maxSlope : Infinity,
    maxAcc > 1e-12 ? Math.sqrt(config.knifeAmax / maxAcc) : Infinity,
  );
  if (recipe.spd > cam.vFeasible + 1e-9) {
    warnings.push(
      `LINE SPEED ${(recipe.spd * 0.06).toFixed(0)} m/min EXCEEDS the knife axis limit ${(cam.vFeasible * 0.06).toFixed(0)} m/min — expect following error and bad cuts`,
    );
  }

  // --- Theory prediction of the cut face at this thickness ---
  // Down-pass tip position relative to the material, θ from −α to 0:
  // constant mode  x_rel(θ) = R·sinθ − (R/k)(θ+α); comp mode ≡ 0.
  if (recipe.syncMode === 'constant' && alpha > 0) {
    let lo = 0, hi = 0;
    for (let i = 0; i <= 64; i++) {
      const th = -alpha + (i / 64) * alpha;
      // deviation from the entry point: x_rel(θ) − x_rel(−α)
      const dev = R * Math.sin(th) - (R / k) * (th + alpha) + R * Math.sin(alpha);
      lo = Math.min(lo, dev); hi = Math.max(hi, dev);
    }
    cam.predictSkew = R * (Math.sin(alpha) - alpha / k);
    cam.predictStraight = hi - lo;
  }
  return cam;
}

/** Evaluate the cam at master phase φ (any value, wrapped into [0,L)). Returns [θ, dθ/dφ, d²θ/dφ²]. */
export function evalCam(cam: CamProfile, phi: number): [number, number, number] {
  const L = cam.L;
  let p = phi % L;
  if (p < 0) p += L;
  if (p <= cam.sA) {
    // Exit half of the sync window (just after the cut)
    return evalSync(cam, p);
  }
  if (p >= L - cam.sA) {
    // Entry half of the sync window (approaching the next cut)
    const [th, dth, ddth] = evalSync(cam, p - L);
    return [cam.Theta + th, dth, ddth];
  }
  for (const seg of cam.segs) {
    if (p <= seg.phi0 + seg.S + 1e-9) {
      if (seg.kind === 'dwell') return [seg.theta!, 0, 0];
      const u = Math.max(0, Math.min(1, (p - seg.phi0) / seg.S));
      const [pp, dp, ddp] = evalPoly(seg.c!, u);
      return [pp, dp / seg.S, ddp / (seg.S * seg.S)];
    }
  }
  // Numerically at the very end of the period
  return [cam.Theta, cam.k / cam.R, 0];
}

/**
 * Unwrapped knife setpoint for master position s (mm past the cam zero
 * reference). Slave advances exactly one Θ per master period L.
 */
export function camSetpoint(cam: CamProfile, s: number): { theta: number; slope: number; acc: number } {
  const n = Math.floor(s / cam.L);
  const [th, dth, ddth] = evalCam(cam, s - n * cam.L);
  return { theta: n * cam.Theta + th, slope: dth, acc: ddth };
}
