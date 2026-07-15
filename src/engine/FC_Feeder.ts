import { SimulationEngine } from './SimulationEngine';
import { commitStopDist } from './MotionProfile';

/**
 * FC30: Material Feed Axis (LEADING AXIS / master)
 *
 * The heart of the rotary knife principle: the material NEVER stops for
 * a cut. The feed axis runs continuously at the line speed; the knife
 * (following axis, FC_Knife) is position-coupled to it through the cam.
 * `D` is the feed encoder position in mm — the cam master value.
 *
 * The axis moves like a real servo motor with the configured motor data
 * (config.axVmax / axAmax / axJerk): velocity follows a jerk-limited
 * S-curve using the trajectory math ported from
 * Lehel4321/MotionProfileSolver (see MotionProfile.ts).
 *
 * GRACEFUL STOP: because the knife is cam-coupled to THIS axis, stopping
 * the line automatically stops the knife in sync — pieces cut during the
 * ramp-down still come out at exactly the recipe length (position cam!).
 * The only constraint is WHERE to stop: the line brakes to a standstill
 * exactly on a knife PARK phase (blade away from the material), computed
 * from the S-curve committed stopping distance.
 *
 * ENABLE GATING: no enable checks here — OB1 only calls this block while
 * the machine is running (CuttingMaschine convention).
 */
export function FC_Feeder(db: SimulationEngine, dt: number) {
  const A = db.config.axAmax;
  const J = db.config.axJerk;
  const st = db.state;
  const cam = db.cam;

  // Network 1: Velocity setpoint. Continuous line speed (capped at axis Vmax).
  let vt = db.cruiseSpeed();

  // Network 1b: Graceful stop — arm the park-phase brake target once.
  if (st.stopReq && !st.braking) {
    const dMin = commitStopDist(st.v, st.a, A, J);
    // Smallest park-phase position that is still reachable with an
    // S-curve brake: Dref + parkPhi + m·L  >=  D + dMin
    const m = Math.ceil((st.D + dMin - st.Dref - cam.parkPhi) / cam.L);
    st.brakeD = st.Dref + cam.parkPhi + m * cam.L;
    st.braking = true;
    st.stopCommit = false;
  }

  // Network 1c: Position-controlled braking to the park target. The
  // moment the committed stopping distance covers what is left, the stop
  // LATCHES (stopCommit) and the ramp runs through to standstill in one
  // clean S-curve — bang-bang re-acceleration near the target would end
  // the ramp overbraked and spike the jerk.
  if (st.braking) {
    if (!st.stopCommit && commitStopDist(st.v, st.a, A, J) >= st.brakeD - st.D) {
      st.stopCommit = true;
    }
    if (st.stopCommit) vt = 0;
  }

  // Network 2: Jerk-limited velocity tracking (S-curve) with one-step
  // lookahead: apply +J only if the settle velocity (velocity reached
  // after ramping the acceleration back to zero) stays at or below the
  // setpoint AFTER this scan — so the axis can never overshoot the
  // commanded velocity. Trapezoidal integration keeps the discrete
  // profile on the exact S-curve.
  if (st.v !== vt || st.a !== 0) {
    const aUp = Math.min(A, st.a + J * dt);
    const vUp = st.v + ((st.a + aUp) / 2) * dt;
    const settleUp = vUp + (aUp * Math.abs(aUp)) / (2 * J);
    if (settleUp <= vt) {
      st.a = aUp;
      st.v = vUp;
    } else {
      const aDn = Math.max(-A, st.a - J * dt);
      st.v += ((st.a + aDn) / 2) * dt;
      st.a = aDn;
    }
    // Snap onto the setpoint at ramp end (consumes at most 2 scans'
    // worth of jerk once, then the axis cruises exactly at vt).
    if (Math.abs(st.v - vt) <= J * dt * dt && Math.abs(st.a) <= 1.001 * J * dt) {
      st.v = vt;
      st.a = 0;
    }
    if (st.v < 0) { st.v = 0; st.a = 0; } // the line never runs backwards
  }

  // Network 3: Advance the encoder position. While braking, never
  // overshoot the park target — the knife would leave its park position.
  let dD = st.v * dt;
  if (st.braking) dD = Math.min(dD, Math.max(0, st.brakeD - st.D));
  st.D += dD;
  st.matCut += dD; // campaign total, survives clearSequence (like runTime)

  // Network 4: Standstill reached -> machine idle. STANDSTILL is the
  // completion condition, not the park position: the discrete brake ramp
  // may land a few mm short of brakeD at high line speed (up to ~v·dt/2
  // integration deficit — 3.2 mm at 180 m/min), which is still well
  // inside the park region (< 0.2° of knife angle per mm). Gating on a
  // tight position tolerance instead deadlocks the stop: v = 0 short of
  // target and the latched ramp can never close the gap.
  if (st.braking && st.stopCommit && st.v <= 0.001) {
    st.v = 0;
    st.a = 0;
    st.braking = false;
    st.stopCommit = false;
    st.stopReq = false;
    st.running = false;
    db.notify();
  }
}
