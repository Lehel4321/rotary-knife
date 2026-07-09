/**
 * FC40: Motion Profile Solver (jerk-limited S-curve trajectory math)
 *
 * Ported from Lehel4321/MotionProfileSolver (motion_engine.py /
 * motion_solver_web.html) via Lehel4321/CuttingMaschine — the exact same
 * engine that drives the CableCutter feed belt. Here it drives the
 * MATERIAL FEED AXIS (the leading axis of the rotary knife): the line
 * accelerates and brakes along a 7-phase S-curve instead of jumping
 * between speeds, and the graceful stop uses commitStopDist() to brake
 * the line to standstill exactly on a knife park phase.
 */

export interface TimeParams {
  tj: number; ta: number; tv: number;
  t1: number; t2: number; t3: number; t4: number; t5: number; t6: number; t7: number;
}

export interface MoveProfile {
  shape: number;
  va: number; // velocity where accel ramp becomes jerk-limited (amax²/jmax)
  sa: number; // distance of a full triangular-accel move (2·amax³/jmax²)
  sv: number; // distance to accelerate 0→vmax and decelerate vmax→0 (no cruise)
  tp: TimeParams;
}

/**
 * Classify the trajectory shape for a point-to-point move.
 * Direct port of defineShape(amax, jmax, vmax, s).
 */
export function defineShape(amax: number, jmax: number, vmax: number, s: number) {
  const va = (amax * amax) / jmax;
  const sa = (2 * Math.pow(amax, 3)) / (jmax * jmax);
  const m = vmax * jmax < amax * amax ? 1 : 0;
  const n = 1 - m;
  const sv = vmax * (m * 2 * Math.sqrt(vmax / jmax) + n * (vmax / amax + amax / jmax));
  let sh: number | null = null;
  if (vmax <= va && s >= sa) sh = 1;
  else if (vmax > va && s <= sa) sh = 2;
  else if (vmax <= va && s < sa && s > sv) sh = 3;
  else if (vmax <= va && s < sa && s <= sv) sh = 4;
  else if (vmax > va && s > sa && s > sv) sh = 5;
  else if (vmax > va && s > sa && s <= sv) sh = 6;
  return { sh, va, sa, sv };
}

/**
 * Phase boundary times t1..t7 of the 7-phase S-curve.
 * Direct port of timeParams(vmax, amax, jmax, s, sh).
 */
export function timeParams(vmax: number, amax: number, jmax: number, s: number, sh: number): TimeParams | null {
  let tj: number, ta: number, tv: number;
  if (sh === 1 || sh === 3) { tj = Math.sqrt(vmax / jmax); ta = tj; tv = s / vmax; }
  else if (sh === 2 || sh === 4) { tj = Math.cbrt(s / (2 * jmax)); ta = tj; tv = 2 * tj; }
  else if (sh === 5) { tj = amax / jmax; ta = vmax / amax; tv = s / vmax; }
  else if (sh === 6) {
    tj = amax / jmax;
    ta = 0.5 * (Math.sqrt((4 * s * jmax * jmax + Math.pow(amax, 3)) / (amax * jmax * jmax)) - amax / jmax);
    tv = ta + tj;
  } else return null;
  return { tj, ta, tv, t1: tj, t2: ta, t3: ta + tj, t4: tv, t5: tv + tj, t6: tv + ta, t7: tv + tj + ta };
}

/**
 * Evaluate [jerk, accel, vel, pos] at time t along the 7-phase profile.
 * Direct port of evalAt(j, tp, t).
 */
export function evalAt(j: number, tp: TimeParams, t: number): [number, number, number, number] {
  const { t1, t2, t3, t4, t5, t6 } = tp;
  const a1 = j * t1, v1 = 0.5 * j * t1 * t1, p1 = (j * t1 * t1 * t1) / 6;
  const v2 = v1 + a1 * (t2 - t1), p2 = p1 + v1 * (t2 - t1) + 0.5 * a1 * (t2 - t1) ** 2, a2 = a1;
  const v3 = v2 + a2 * (t3 - t2) - 0.5 * j * (t3 - t2) ** 2;
  const p3 = p2 + v2 * (t3 - t2) + 0.5 * a2 * (t3 - t2) ** 2 - (j * (t3 - t2) ** 3) / 6;
  const v4 = v3, p4 = p3 + v3 * (t4 - t3);
  const a5 = -j * (t5 - t4), v5 = v4 - 0.5 * j * (t5 - t4) ** 2;
  const p5 = p4 + v4 * (t5 - t4) - (j * (t5 - t4) ** 3) / 6;
  const v6 = v5 + a5 * (t6 - t5), p6 = p5 + v5 * (t6 - t5) + 0.5 * a5 * (t6 - t5) ** 2, a6 = a5;
  let dt: number;
  if (t <= t1) return [j, j * t, 0.5 * j * t * t, (j * t * t * t) / 6];
  if (t <= t2) return [0, a1, v1 + a1 * (t - t1), p1 + v1 * (t - t1) + 0.5 * a1 * (t - t1) ** 2];
  if (t <= t3) { dt = t - t2; return [-j, a2 - j * dt, v2 + a2 * dt - 0.5 * j * dt * dt, p2 + v2 * dt + 0.5 * a2 * dt * dt - (j * dt ** 3) / 6]; }
  if (t <= t4) return [0, 0, v3, p3 + v3 * (t - t3)];
  if (t <= t5) { dt = t - t4; return [-j, -j * dt, v4 - 0.5 * j * dt * dt, p4 + v4 * dt - (j * dt ** 3) / 6]; }
  if (t <= t6) { dt = t - t5; return [0, a5, v5 + a5 * dt, p5 + v5 * dt + 0.5 * a5 * dt * dt]; }
  dt = t - t6; return [j, a6 + j * dt, v6 + a6 * dt + 0.5 * j * dt * dt, p6 + v6 * dt + 0.5 * a6 * dt * dt + (j * dt ** 3) / 6];
}

/**
 * Full point-to-point move solution for distance s with limits
 * (vmax, amax, jmax). Port of computeMotor() without the chart arrays.
 */
export function computeMove(s: number, vmax: number, amax: number, jmax: number): MoveProfile | null {
  if (!(s > 0 && vmax > 0 && amax > 0 && jmax > 0)) return null;
  const { sh, va, sa, sv } = defineShape(amax, jmax, vmax, s);
  if (sh === null) return null;
  const tp = timeParams(vmax, amax, jmax, s, sh);
  if (!tp || !isFinite(tp.t7) || tp.t7 <= 0) return null;
  return { shape: sh, va, sa, sv, tp };
}

/**
 * Jerk-limited stopping distance from speed v to standstill.
 *   triangular decel (v·j <  a²): d = v·√(v/j)
 *   trapezoidal decel (v·j >= a²): d = v/2 · (v/a + a/j)
 */
export function stopDistance(v: number, amax: number, jmax: number): number {
  if (v <= 0) return 0;
  if (amax <= 0 || jmax <= 0) return Infinity;
  if (v * jmax < amax * amax) return v * Math.sqrt(v / jmax);
  return (v / 2) * (v / amax + amax / jmax);
}

/** Jerk-limited stopping time from speed v to standstill (same phases as stopDistance). */
export function stopTime(v: number, amax: number, jmax: number): number {
  if (v <= 0) return 0;
  if (amax <= 0 || jmax <= 0) return Infinity;
  if (v * jmax < amax * amax) return 2 * Math.sqrt(v / jmax);
  return v / amax + amax / jmax;
}

/**
 * Committed stopping distance from the current axis state (v, a): the
 * jerk limit means the current acceleration first has to be ramped to
 * zero — the axis gains a·|a|/2j of speed and covers distance meanwhile
 * — before the full S-ramp to standstill can complete. Equal to
 * stopDistance(v) when a = 0.
 */
export function commitStopDist(v: number, a: number, amax: number, jmax: number): number {
  if (jmax <= 0 || amax <= 0) return Infinity;
  const tR = Math.abs(a) / jmax;
  const vAfter = Math.max(0, v + (a * Math.abs(a)) / (2 * jmax));
  const dR = ((Math.max(v, 0) + vAfter) / 2) * tR;
  return dR + stopDistance(vAfter, amax, jmax);
}
